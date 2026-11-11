/**
 * Ordered, checksummed, transactional schema migrations (DATA-MODEL.md section 8).
 *
 * - Each migration runs inside its own `BEGIN IMMEDIATE` transaction; a failure rolls back the
 *   whole migration and leaves the prior version intact.
 * - The SHA-256 checksum of each applied migration's SQL is stored; a mismatch on open fails
 *   closed (RS_MIGRATION_CHECKSUM_MISMATCH) rather than guessing.
 * - A database at a newer version than this build knows opens only in read-only recovery mode.
 */
import { createHash } from 'node:crypto';
import { MIGRATION_001_SQL } from './001-core.ts';
import { MIGRATION_002_SQL } from './002-results-maintenance.ts';
import { MIGRATION_003_SQL } from './003-proxy-interceptor.ts';
import { MIGRATION_004_SQL } from './004-effect-evaluation.ts';

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = Object.freeze([
  { version: 1, name: 'core', sql: MIGRATION_001_SQL },
  { version: 2, name: 'results-maintenance', sql: MIGRATION_002_SQL },
  { version: 3, name: 'proxy-interceptor', sql: MIGRATION_003_SQL },
  { version: 4, name: 'effect-evaluation', sql: MIGRATION_004_SQL },
]);

export const LATEST_SCHEMA_VERSION = MIGRATIONS.length;

/** PRAGMA application_id for RouteSpec databases: ASCII "RSPC". */
export const APPLICATION_ID = 0x52535043;

export function migrationChecksum(migration: Migration): string {
  return `sha256:${createHash('sha256').update(migration.sql, 'utf8').digest('hex')}`;
}
