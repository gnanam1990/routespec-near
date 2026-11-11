/**
 * Single-writer SQLite journal connection (NFR-05, DATA-MODEL.md section 5). See ADR-0004.
 *
 * - One process holds the writer lock file (`<db>.writer.lock`); a second writer fails closed
 *   with RS_WRITER_LOCKED. A lock left by a dead process (crash) is detected and taken over.
 * - WAL journal, foreign keys ON, `busy_timeout` configured, `synchronous=FULL` (each commit
 *   fsyncs the WAL; committed transactions survive process crash and power loss subject to the
 *   storage device honouring flushes).
 * - Every mutation runs through `transact()` with `BEGIN IMMEDIATE`; nested transactions are
 *   rejected. An optional fault injector can terminate or throw at `beforeCommit`/`afterCommit`.
 * - SQLITE_FULL / SQLITE_IOERR put the journal into a storage-fault state: the transaction is
 *   rolled back, nothing is acknowledged, and every later transaction fails closed until
 *   `resumeAfterStorageFault()` (in the store) verifies integrity and fences active work.
 * - Unknown newer schema → read-only recovery mode; checksum drift → refuse to open.
 */
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { RouteSpecError, isRouteSpecError, type ErrorCode } from '@routespec/contracts';
import {
  APPLICATION_ID,
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  migrationChecksum,
  type Migration,
} from './migrations/index.ts';

export type FaultPoint = 'beforeCommit' | 'afterCommit';
export type FaultInjector = (point: FaultPoint, label: string) => void;

export interface Clock {
  nowMs(): number;
}

export const systemClock: Clock = Object.freeze({ nowMs: () => Date.now() });

export interface OpenOptions {
  /** Database file path. Use a real file: WAL and crash semantics are the point. */
  readonly path: string;
  readonly busyTimeoutMs?: number;
  readonly faultInjector?: FaultInjector;
  /** Optional hard cap on database pages (resource bound; also exercises SQLITE_FULL in tests). */
  readonly maxPageCount?: number;
  /** Migrations to apply (defaults to all known). Tests may stop at an older version. */
  readonly migrations?: readonly Migration[];
  /** Open without the writer lock, read-only. */
  readonly readOnly?: boolean;
}

export type JournalMode = 'WRITABLE' | 'READ_ONLY_RECOVERY' | 'READ_ONLY';

export const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

const KNOWN_CODES = new Set<string>([
  'RS_IMMUTABLE_RECORD',
  'RS_TERMINAL_IMMUTABLE',
  'RS_LIFECYCLE_TRANSITION_INVALID',
  'RS_STALE_FENCING_EPOCH',
  'RS_REVISION_CONFLICT',
  'RS_EVIDENCE_ALREADY_CONSUMED',
  'RS_ALLOCATION_INVALID',
]);

interface SqliteError extends Error {
  code?: string;
  errcode?: number;
  errstr?: string;
}

/** Map a node:sqlite error to a typed RouteSpec error without echoing bound values. */
export function mapSqliteError(error: unknown): RouteSpecError {
  if (isRouteSpecError(error)) return error;
  const e = error as SqliteError;
  const message = typeof e?.message === 'string' ? e.message : '';
  const primary = typeof e?.errcode === 'number' ? e.errcode & 0xff : -1;
  for (const code of KNOWN_CODES) {
    if (message.includes(code)) {
      return new RouteSpecError(code as ErrorCode, 'The journal rejected the write.', {
        details: { constraint: code },
      });
    }
  }
  if (primary === 13)
    return new RouteSpecError('RS_STORAGE_FULL', 'Database or disk is full; write not acknowledged.');
  if (primary === 5 || primary === 6) {
    return new RouteSpecError(
      'RS_STORAGE_BUSY',
      'Journal busy beyond busy_timeout; write not acknowledged.',
      {
        recoverable: true,
      },
    );
  }
  if (primary === 10)
    return new RouteSpecError('RS_STORAGE_UNAVAILABLE', 'Journal I/O error; write not acknowledged.');
  if (primary === 11 || primary === 26)
    return new RouteSpecError('RS_STORAGE_CORRUPT', 'Journal file is corrupt or not a database.');
  if (message.startsWith('UNIQUE constraint failed') || message.includes('PRIMARY KEY')) {
    const table = /failed: ([a-z_]+)\./.exec(message)?.[1] ?? 'unknown';
    return new RouteSpecError('RS_DUPLICATE', 'A record with this identity already exists.', {
      details: { table },
    });
  }
  if (message.includes('FOREIGN KEY constraint failed')) {
    return new RouteSpecError(
      'RS_IDENTITY_MISMATCH',
      'Referenced identity does not exist or is inconsistent.',
    );
  }
  if (message.includes('CHECK constraint failed')) {
    return new RouteSpecError('RS_SCHEMA_INVALID', 'The journal rejected a value outside its closed domain.');
  }
  if (message.includes('NOT NULL constraint failed')) {
    return new RouteSpecError('RS_SCHEMA_INVALID', 'A mandatory journal field is missing.');
  }
  return new RouteSpecError('RS_INTERNAL', 'Unexpected journal error.', {
    details: { sqliteCode: primary },
  });
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

class WriterLock {
  readonly path: string;
  private readonly token = randomUUID();
  private held = false;

  constructor(dbPath: string) {
    this.path = `${dbPath}.writer.lock`;
  }

  acquire(): void {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(this.path, 'wx');
        writeSync(fd, JSON.stringify({ pid: process.pid, token: this.token }));
        closeSync(fd);
        this.held = true;
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        let pid = -1;
        try {
          pid = (JSON.parse(readFileSync(this.path, 'utf8')) as { pid: number }).pid;
        } catch {
          pid = -1; // unreadable/partial lock file from a crash during write
        }
        if (pid > 0 && pid !== process.pid && processAlive(pid)) {
          throw new RouteSpecError(
            'RS_WRITER_LOCKED',
            'Another live process holds the journal writer lock.',
            {
              details: { holderPid: pid },
            },
          );
        }
        if (pid === process.pid) {
          throw new RouteSpecError('RS_WRITER_LOCKED', 'This process already holds the journal writer lock.');
        }
        unlinkSync(this.path); // stale lock from a dead process
      }
    }
    throw new RouteSpecError('RS_WRITER_LOCKED', 'Could not acquire the journal writer lock.');
  }

  release(): void {
    if (!this.held) return;
    try {
      const current = JSON.parse(readFileSync(this.path, 'utf8')) as { token: string };
      if (current.token === this.token) unlinkSync(this.path);
    } catch {
      // lock already gone
    }
    this.held = false;
  }
}

export class JournalDb {
  readonly path: string;
  readonly mode: JournalMode;
  readonly schemaVersion: number;
  private readonly db: DatabaseSync;
  private readonly lock: WriterLock | null;
  private readonly faultInjector: FaultInjector | undefined;
  private inTransaction = false;
  private storageFault: ErrorCode | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  private constructor(args: {
    path: string;
    mode: JournalMode;
    schemaVersion: number;
    db: DatabaseSync;
    lock: WriterLock | null;
    faultInjector: FaultInjector | undefined;
  }) {
    this.path = args.path;
    this.mode = args.mode;
    this.schemaVersion = args.schemaVersion;
    this.db = args.db;
    this.lock = args.lock;
    this.faultInjector = args.faultInjector;
  }

  static open(options: OpenOptions): JournalDb {
    const migrations = options.migrations ?? MIGRATIONS;
    if (options.readOnly) {
      const db = new DatabaseSync(options.path, { readOnly: true });
      const version = JournalDb.inspectVersion(db, migrations, false);
      return new JournalDb({
        path: options.path,
        mode: 'READ_ONLY',
        schemaVersion: version,
        db,
        lock: null,
        faultInjector: undefined,
      });
    }
    const lock = new WriterLock(options.path);
    lock.acquire();
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(options.path);
      db.exec(`PRAGMA busy_timeout = ${Math.trunc(options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS)}`);
      const appId = (db.prepare('PRAGMA application_id').get() as { application_id: number }).application_id;
      const userTables = (
        db
          .prepare(
            "SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
          )
          .get() as { n: number }
      ).n;
      if (appId !== 0 && appId !== APPLICATION_ID) {
        throw new RouteSpecError(
          'RS_STORAGE_CORRUPT',
          'File is not a RouteSpec journal (application_id mismatch).',
        );
      }
      if (appId === 0 && userTables > 0) {
        throw new RouteSpecError(
          'RS_STORAGE_CORRUPT',
          'File contains a foreign schema; refusing to adopt it.',
        );
      }
      const known = JournalDb.inspectVersion(db, migrations, true);
      if (known > migrations.length) {
        // Unknown newer schema: reopen strictly read-only for recovery/export; never guess.
        db.close();
        lock.release();
        const ro = new DatabaseSync(options.path, { readOnly: true });
        return new JournalDb({
          path: options.path,
          mode: 'READ_ONLY_RECOVERY',
          schemaVersion: known,
          db: ro,
          lock: null,
          faultInjector: undefined,
        });
      }
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = FULL');
      db.exec('PRAGMA foreign_keys = ON');
      if (options.maxPageCount !== undefined)
        db.exec(`PRAGMA max_page_count = ${Math.trunc(options.maxPageCount)}`);
      const journal = new JournalDb({
        path: options.path,
        mode: 'WRITABLE',
        schemaVersion: known,
        db,
        lock,
        faultInjector: options.faultInjector,
      });
      const version = journal.migrate(migrations);
      const opened = new JournalDb({
        path: options.path,
        mode: 'WRITABLE',
        schemaVersion: version,
        db,
        lock,
        faultInjector: options.faultInjector,
      });
      opened.loadFaultMarker();
      return opened;
    } catch (error) {
      try {
        db?.close();
      } catch {
        // ignore
      }
      lock.release();
      throw mapSqliteError(error);
    }
  }

  /** Returns the applied schema version, verifying checksums of every known applied migration. */
  private static inspectVersion(
    db: DatabaseSync,
    migrations: readonly Migration[],
    allowEmpty: boolean,
  ): number {
    const hasTable = db
      .prepare("SELECT 1 AS x FROM sqlite_schema WHERE type = 'table' AND name = 'schema_migrations'")
      .get();
    if (!hasTable) {
      if (!allowEmpty)
        throw new RouteSpecError('RS_STORAGE_CORRUPT', 'Not an initialized RouteSpec journal.');
      return 0;
    }
    const rows = db
      .prepare('SELECT version, checksum FROM schema_migrations ORDER BY version')
      .all() as Array<{
      version: number;
      checksum: string;
    }>;
    let expected = 1;
    for (const row of rows) {
      if (row.version !== expected) {
        throw new RouteSpecError('RS_STORAGE_CORRUPT', 'Schema migration history has a gap.', {
          details: { version: row.version },
        });
      }
      const known = migrations[row.version - 1];
      if (known && migrationChecksum(known) !== row.checksum) {
        throw new RouteSpecError(
          'RS_MIGRATION_CHECKSUM_MISMATCH',
          'Applied migration checksum differs from this build.',
          {
            details: { version: row.version },
          },
        );
      }
      expected++;
    }
    return rows.length;
  }

  private migrate(migrations: readonly Migration[]): number {
    this.db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at_ms INTEGER NOT NULL
    ) STRICT`);
    this.db.exec(`PRAGMA application_id = ${APPLICATION_ID}`);
    let current = JournalDb.inspectVersion(this.db, migrations, true);
    for (const migration of migrations.slice(current)) {
      try {
        this.db.exec('BEGIN IMMEDIATE');
        this.db.exec(migration.sql);
        this.db
          .prepare(
            'INSERT INTO schema_migrations(version, name, checksum, applied_at_ms) VALUES (?, ?, ?, ?)',
          )
          .run(migration.version, migration.name, migrationChecksum(migration), Date.now());
        this.db.exec(`PRAGMA user_version = ${migration.version}`);
        this.db.exec('COMMIT');
        current = migration.version;
      } catch (error) {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          // already rolled back
        }
        const mapped = mapSqliteError(error);
        throw new RouteSpecError('RS_MIGRATION_FAILED', 'Schema migration failed and was rolled back.', {
          details: { version: migration.version, cause: mapped.code },
        });
      }
    }
    const fk = this.db.prepare('PRAGMA foreign_key_check').all();
    if (fk.length > 0)
      throw new RouteSpecError('RS_STORAGE_CORRUPT', 'Foreign-key check failed after migration.');
    return current;
  }

  get isWritable(): boolean {
    return this.mode === 'WRITABLE';
  }

  get faulted(): ErrorCode | null {
    return this.storageFault;
  }

  /** Run `fn` inside one `BEGIN IMMEDIATE` transaction on the single writer connection. */
  transact<T>(label: string, fn: (db: DatabaseSync) => T): T {
    this.assertOpen();
    if (this.mode !== 'WRITABLE') {
      throw new RouteSpecError('RS_READ_ONLY_RECOVERY', 'Journal is open read-only; writes are refused.', {
        details: { mode: this.mode },
      });
    }
    if (this.storageFault !== null) {
      throw new RouteSpecError(
        'RS_STORAGE_UNAVAILABLE',
        'Journal is in a storage-fault state; nothing is acknowledged.',
        {
          details: { fault: this.storageFault },
        },
      );
    }
    return this.runTransaction(label, fn);
  }

  /** Transaction used only by storage-fault recovery itself. */
  transactDuringFault<T>(label: string, fn: (db: DatabaseSync) => T): T {
    this.assertOpen();
    return this.runTransaction(label, fn);
  }

  private runTransaction<T>(label: string, fn: (db: DatabaseSync) => T): T {
    if (this.inTransaction)
      throw new RouteSpecError('RS_INTERNAL', 'Nested journal transactions are not permitted.');
    this.inTransaction = true;
    let began = false;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      began = true;
      const result = fn(this.db);
      this.faultInjector?.('beforeCommit', label);
      this.db.exec('COMMIT');
      began = false;
      this.faultInjector?.('afterCommit', label);
      return result;
    } catch (error) {
      if (began) {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          // SQLite may already have rolled back (e.g. SQLITE_FULL)
        }
      }
      const mapped = mapSqliteError(error);
      if (
        mapped.code === 'RS_STORAGE_FULL' ||
        mapped.code === 'RS_STORAGE_UNAVAILABLE' ||
        mapped.code === 'RS_STORAGE_CORRUPT'
      ) {
        this.setStorageFault(mapped.code);
      }
      throw mapped;
    } finally {
      this.inTransaction = false;
    }
  }

  /** Serialize async callers through the single writer queue. */
  enqueue<T>(label: string, fn: (db: DatabaseSync) => T): Promise<T> {
    const next = this.queue.then(() => this.transact(label, fn));
    this.queue = next.catch(() => undefined);
    return next;
  }

  read<T>(fn: (db: DatabaseSync) => T): T {
    this.assertOpen();
    return fn(this.db);
  }

  /** Path of the durable storage-fault marker; survives restart so a fault is never forgotten. */
  get faultMarkerPath(): string {
    return `${this.path}.storage-fault`;
  }

  setStorageFault(code: ErrorCode): void {
    this.storageFault = code;
    try {
      writeFileSync(this.faultMarkerPath, JSON.stringify({ code, atMs: Date.now() }));
    } catch {
      // Best effort: the disk may be full. The in-memory fault state still fails closed.
    }
  }

  clearStorageFault(): void {
    this.storageFault = null;
    try {
      if (existsSync(this.faultMarkerPath)) unlinkSync(this.faultMarkerPath);
    } catch {
      // marker removal failure leaves the journal fail-closed on next open, which is safe
    }
  }

  private loadFaultMarker(): void {
    if (!existsSync(this.faultMarkerPath)) return;
    let code: ErrorCode = 'RS_STORAGE_UNAVAILABLE';
    try {
      const parsed = JSON.parse(readFileSync(this.faultMarkerPath, 'utf8')) as { code?: ErrorCode };
      if (typeof parsed.code === 'string') code = parsed.code;
    } catch {
      // unreadable marker still means fail-closed
    }
    this.storageFault = code;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close();
    } finally {
      this.lock?.release();
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new RouteSpecError('RS_STORAGE_UNAVAILABLE', 'Journal is closed.');
  }
}

export { LATEST_SCHEMA_VERSION };
