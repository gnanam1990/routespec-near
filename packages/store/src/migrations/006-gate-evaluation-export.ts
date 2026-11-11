/**
 * Migration 006 — release-gate evaluations, case interruptions, and export bundles (M06).
 *
 * Purely additive (T-028): new tables, triggers, and indexes only. Existing tables keep their
 * shape; `artifact_manifests` gains database-level guards.
 *
 * - `gate_evaluation_cases`: the exact ordered case links of one immutable gate evaluation
 *   (written in the same transaction as the `gate_evaluations` row, DATA-MODEL section 6);
 * - `gate_evaluation_digests`: the identity digest and the separate enforcement digest of an
 *   evaluation. Enforcement never enters the decision digest;
 * - `case_interruptions`: a runner restart or expired lease observed for a case before its
 *   evaluation finished. An interrupted case can never contribute PASS to a gate;
 * - `export_plans`: an immutable export plan (privacy-scan findings with category/path/count
 *   only, bundle entry digests, the expected bundle digest). A blocked plan stores no content;
 * - `export_writes`: every write attempt and its outcome. `artifact_manifests.artifact_ready`
 *   follows the latest write and is independent of the gate decision.
 */
const immutable = (table: string) => `
CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table}
BEGIN SELECT RAISE(ABORT, 'RS_IMMUTABLE_RECORD'); END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table}
BEGIN SELECT RAISE(ABORT, 'RS_IMMUTABLE_RECORD'); END;`;

const VERDICT = `CHECK (contribution IN ('NOT_RUN','PASS','FAIL','REVIEW','UNSUPPORTED'))`;

const IMMUTABLE_006 = [
  'gate_evaluation_cases',
  'gate_evaluation_digests',
  'case_interruptions',
  'export_plans',
  'export_writes',
];

export const MIGRATION_006_SQL = `
CREATE TABLE gate_evaluation_cases (
  gate_evaluation_id TEXT NOT NULL REFERENCES gate_evaluations(gate_evaluation_id),
  case_ordinal INTEGER NOT NULL CHECK (case_ordinal >= 0),
  case_run_id TEXT REFERENCES case_runs(case_run_id),
  required INTEGER NOT NULL CHECK (required IN (0,1)),
  lifecycle TEXT,
  case_verdict TEXT,
  result_digest TEXT,
  fencing_epoch INTEGER,
  contribution TEXT NOT NULL ${VERDICT},
  findings_json TEXT NOT NULL,
  PRIMARY KEY (gate_evaluation_id, case_ordinal)
) STRICT;

CREATE TABLE gate_evaluation_digests (
  gate_evaluation_id TEXT PRIMARY KEY REFERENCES gate_evaluations(gate_evaluation_id),
  identity_digest TEXT NOT NULL,
  enforcement_digest TEXT NOT NULL,
  aggregator_revision TEXT NOT NULL,
  runtime_json TEXT NOT NULL
) STRICT;

CREATE TABLE case_interruptions (
  interruption_id TEXT PRIMARY KEY,
  case_run_id TEXT NOT NULL REFERENCES case_runs(case_run_id),
  fencing_epoch INTEGER NOT NULL CHECK (fencing_epoch >= 0),
  kind TEXT NOT NULL CHECK (kind IN ('LEASE_EXPIRED','RUNNER_RESTART','RECOVERY_PENDING')),
  created_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE export_plans (
  export_id TEXT PRIMARY KEY REFERENCES artifact_manifests(export_id),
  gate_evaluation_id TEXT NOT NULL REFERENCES gate_evaluations(gate_evaluation_id),
  plan_digest TEXT NOT NULL UNIQUE,
  bundle_digest TEXT,
  bundle_bytes INTEGER,
  options_json TEXT NOT NULL,
  findings_json TEXT NOT NULL,
  entries_json TEXT NOT NULL,
  attachments_json TEXT,
  blocked INTEGER NOT NULL CHECK (blocked IN (0,1)),
  created_at_ms INTEGER NOT NULL,
  CHECK ((blocked = 1) = (bundle_digest IS NULL)),
  CHECK (blocked = 0 OR attachments_json IS NULL)
) STRICT;

CREATE TABLE export_writes (
  write_id TEXT PRIMARY KEY,
  export_id TEXT NOT NULL REFERENCES export_plans(export_id),
  outcome TEXT NOT NULL CHECK (outcome IN ('WRITTEN','FAILED')),
  output_digest TEXT,
  failure_code TEXT,
  overwrite INTEGER NOT NULL CHECK (overwrite IN (0,1)),
  manifest_revision INTEGER NOT NULL CHECK (manifest_revision >= 2),
  created_at_ms INTEGER NOT NULL,
  CHECK ((outcome = 'WRITTEN') = (output_digest IS NOT NULL)),
  CHECK ((outcome = 'FAILED') = (failure_code IS NOT NULL))
) STRICT;

CREATE TRIGGER artifact_manifests_identity_frozen BEFORE UPDATE ON artifact_manifests
WHEN NEW.export_id IS NOT OLD.export_id OR NEW.gate_evaluation_id IS NOT OLD.gate_evaluation_id
  OR NEW.session_id IS NOT OLD.session_id OR NEW.inclusion_policy_json IS NOT OLD.inclusion_policy_json
  OR NEW.privacy_scan_result IS NOT OLD.privacy_scan_result
  OR NEW.included_digests_json IS NOT OLD.included_digests_json OR NEW.exclusions_json IS NOT OLD.exclusions_json
  OR NEW.created_at_ms IS NOT OLD.created_at_ms OR NEW.revision IS NOT OLD.revision + 1
  OR (OLD.privacy_scan_result = 'BLOCKED' AND NEW.artifact_ready = 1)
BEGIN SELECT RAISE(ABORT, 'RS_IMMUTABLE_RECORD'); END;
CREATE TRIGGER artifact_manifests_no_delete BEFORE DELETE ON artifact_manifests
BEGIN SELECT RAISE(ABORT, 'RS_IMMUTABLE_RECORD'); END;

CREATE INDEX gate_evaluations_by_run ON gate_evaluations(gate_run_id, created_at_ms);
CREATE INDEX case_interruptions_by_case ON case_interruptions(case_run_id);
CREATE INDEX artifact_manifests_by_evaluation ON artifact_manifests(gate_evaluation_id);
CREATE INDEX export_writes_by_export ON export_writes(export_id, created_at_ms);
${IMMUTABLE_006.map(immutable).join('\n')}
`;
