/**
 * Upload staging (FR-14, FR-17, NFR-03; T-058).
 *
 * The workflow uploads exactly one directory: the staging directory this module fills. A file is
 * staged only when its kind was explicitly configured, the job's trust allows it, it is a regular
 * file inside an allowed root, it is not a database, journal, raw trace, or token file, and a
 * content scan finds no credential, configured secret value, local token, private key, or
 * author-machine path. Untrusted jobs (pull requests, forks, untrusted refs and events) may stage
 * only the generated JSON/JUnit/SARIF reports; evidence bundles and extra paths are refused.
 * Retention is bounded. Refusals record kind, a short name, and a reason code, never content.
 */
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { FindingSet, scanSecretsInString } from '@routespec/regressions';
import { MAX_RETENTION_DAYS, isWithin, type UploadKind } from './config.ts';

export const UPLOAD_MANIFEST_SCHEMA = 'routespec.ci-upload-manifest/1' as const;
export const MAX_UPLOAD_BYTES = 16 * 1024 * 1024;

export type StageKind = UploadKind | 'extra';

export interface UploadCandidate {
  readonly kind: StageKind;
  readonly path: string;
}

export type RefusalReason =
  | 'UNTRUSTED_CONTEXT'
  | 'PATH_OUTSIDE_ALLOWED_ROOTS'
  | 'PATH_IN_DATA_DIRECTORY'
  | 'SYMLINK'
  | 'NOT_A_REGULAR_FILE'
  | 'TOO_LARGE'
  | 'DATABASE_FILE'
  | 'RAW_TRACE'
  | 'SECRET_BEARING'
  | 'LOCAL_TOKEN'
  | 'AUTHOR_PATH'
  | 'NOT_PRODUCED';

export interface StagedFile {
  readonly kind: StageKind;
  readonly name: string;
  readonly digest: string;
  readonly bytes: number;
}

export interface Refusal {
  readonly kind: StageKind;
  readonly name: string;
  readonly reason: RefusalReason;
}

export interface UploadManifest {
  readonly schema: typeof UPLOAD_MANIFEST_SCHEMA;
  readonly trust: string;
  readonly retentionDays: number;
  readonly staged: readonly StagedFile[];
  readonly refused: readonly Refusal[];
  readonly excludedAlways: readonly string[];
}

const DATABASE_NAME = /(?:\.(?:db|sqlite|sqlite3|db3)|-(?:wal|shm|journal))$/i;
const TRACE_NAME = /(?:\.har$|trace|quarantine|capture)/i;
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');
const TRACE_CONTENT = /"(?:routespec\.trace\/1|routespec\.quarantine[^"]*)"/;
const LOCAL_TOKEN = /\b(?:rsct|rsctl|rsprobe)_[A-Za-z0-9_-]{16,}/;
const EXTRA_SECRET =
  /(?:\bBearer\s+[A-Za-z0-9._~+/=-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:github_pat_[A-Za-z0-9_]{30,}|gh[pousr]_[A-Za-z0-9]{30,}))/;

function shortName(path: string): string {
  return (
    basename(path)
      .replace(/[^A-Za-z0-9._-]/g, '_')
      .slice(0, 96) || 'file'
  );
}

export interface StageOptions {
  readonly trusted: boolean;
  readonly trust: string;
  readonly retentionDays: number;
  /** Roots a staged file may come from (workspace, reports directory). */
  readonly allowedRoots: readonly string[];
  /** The RouteSpec data directory (journal): never uploaded. */
  readonly dataDirectory: string;
  readonly stagingDirectory: string;
  /** In-memory secret values (withheld environment) for exact-match scanning. */
  readonly configuredSecrets: readonly string[];
  /** Absolute paths that must not appear in uploaded content (author-machine locators). */
  readonly pathMarkers: readonly string[];
}

function classify(candidate: UploadCandidate, options: StageOptions): RefusalReason | Buffer {
  if (!options.trusted && (candidate.kind === 'evidence-bundle' || candidate.kind === 'extra')) {
    return 'UNTRUSTED_CONTEXT';
  }
  const full = resolve(candidate.path);
  if (!existsSync(full)) return 'NOT_PRODUCED';
  if (lstatSync(full).isSymbolicLink()) return 'SYMLINK';
  const real = realpathSync(full);
  const data = realpathSync(options.dataDirectory);
  if (isWithin(data, real)) return 'PATH_IN_DATA_DIRECTORY';
  if (!options.allowedRoots.some((root) => existsSync(root) && isWithin(realpathSync(root), real))) {
    return 'PATH_OUTSIDE_ALLOWED_ROOTS';
  }
  const stat = lstatSync(real);
  if (!stat.isFile()) return 'NOT_A_REGULAR_FILE';
  if (stat.size > MAX_UPLOAD_BYTES) return 'TOO_LARGE';
  if (DATABASE_NAME.test(real)) return 'DATABASE_FILE';
  const bytes = readFileSync(real);
  if (bytes.subarray(0, SQLITE_MAGIC.length).equals(SQLITE_MAGIC)) return 'DATABASE_FILE';
  if (candidate.kind === 'extra' && TRACE_NAME.test(basename(real))) return 'RAW_TRACE';
  // Bundles are ustar archives of text members; latin1 keeps every byte for scanning.
  const text = bytes.toString('latin1');
  if (TRACE_CONTENT.test(text)) return 'RAW_TRACE';
  if (LOCAL_TOKEN.test(text)) return 'LOCAL_TOKEN';
  const findings = new FindingSet();
  scanSecretsInString(text, '$', findings, options.configuredSecrets);
  if (findings.list().length > 0 || EXTRA_SECRET.test(text)) return 'SECRET_BEARING';
  const lower = text.toLowerCase();
  for (const marker of options.pathMarkers) {
    if (marker.length < 4) continue;
    const variants = [marker, marker.replace(/\\/g, '/'), marker.replace(/\\/g, '\\\\')];
    if (variants.some((m) => lower.includes(m.toLowerCase()))) return 'AUTHOR_PATH';
  }
  return bytes;
}

/** Stage the configured, permitted, scanned files and write `upload-manifest.json`. */
export function stageUploads(candidates: readonly UploadCandidate[], options: StageOptions): UploadManifest {
  const retentionDays = Math.max(1, Math.min(MAX_RETENTION_DAYS, Math.trunc(options.retentionDays)));
  mkdirSync(options.stagingDirectory, { recursive: true });
  const staged: StagedFile[] = [];
  const refused: Refusal[] = [];
  const used = new Set<string>(['upload-manifest.json']);
  for (const c of candidates) {
    const verdict = classify(c, options);
    let name = shortName(c.path);
    if (typeof verdict === 'string') {
      refused.push({ kind: c.kind, name, reason: verdict });
      continue;
    }
    for (let i = 2; used.has(name); i++) name = `${i}-${shortName(c.path)}`;
    used.add(name);
    const target = join(options.stagingDirectory, name);
    if (relative(options.stagingDirectory, target).includes('..')) {
      refused.push({ kind: c.kind, name, reason: 'PATH_OUTSIDE_ALLOWED_ROOTS' });
      continue;
    }
    copyFileSync(resolve(c.path), target);
    staged.push({
      kind: c.kind,
      name,
      digest: `sha256:${createHash('sha256').update(verdict).digest('hex')}`,
      bytes: verdict.length,
    });
  }
  const manifest: UploadManifest = {
    schema: UPLOAD_MANIFEST_SCHEMA,
    trust: options.trust,
    retentionDays,
    staged,
    refused,
    excludedAlways: [
      'journal database and WAL/SHM files',
      'raw or quarantined traces',
      'case, control, and probe tokens',
      'provider JWTs and CI runtime tokens',
      'run envelopes and author-machine paths',
    ],
  };
  writeFileSync(
    join(options.stagingDirectory, 'upload-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}
