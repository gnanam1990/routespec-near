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
import { MIGRATION_005_SQL } from './005-import-regressions.ts';
import { MIGRATION_006_SQL } from './006-gate-evaluation-export.ts';
import { MIGRATION_007_SQL } from './007-control-plane.ts';
import { MIGRATION_008_SQL } from './008-containment.ts';
import { MIGRATION_009_SQL } from './009-review-evidence.ts';

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
  { version: 5, name: 'import-regressions', sql: MIGRATION_005_SQL },
  { version: 6, name: 'gate-evaluation-export', sql: MIGRATION_006_SQL },
  { version: 7, name: 'control-plane', sql: MIGRATION_007_SQL },
  { version: 8, name: 'containment', sql: MIGRATION_008_SQL },
  { version: 9, name: 'review-evidence', sql: MIGRATION_009_SQL },
]);

export const LATEST_SCHEMA_VERSION = MIGRATIONS.length;

/** PRAGMA application_id for RouteSpec databases: ASCII "RSPC". */
export const APPLICATION_ID = 0x52535043;

export function migrationChecksum(migration: Migration): string {
  return `sha256:${createHash('sha256').update(migration.sql, 'utf8').digest('hex')}`;
}
