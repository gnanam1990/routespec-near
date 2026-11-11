/**
 * Migration 004 — protected-effect evaluation support (M04).
 *
 * Purely additive (T-028): only new tables, triggers, and indexes. No existing table is
 * altered, so every row written under an earlier schema keeps its exact shape and digest.
 *
 * - `boundary_observation_order`: the session journal sequence allocated to each independent
 *   boundary observation, so the kernel can order a boundary `RELEASED` frame against the
 *   accepted-completion release authorization in one total order (INV-04).
 * - `effect_release_authorizations`: the runner's fenced decision to release protected effects,
 *   citing the exact completion evidence it relied on, at a session sequence. The kernel decides
 *   independently whether the cited evidence was acceptable; the row itself proves nothing.
 * - `effect_coverage_findings`: coverage defects reported by an authenticated interceptor over
 *   its private channel (process-tree escape, unsupported dynamic call, sink bypass).
 */
const immutable = (table: string) => `
CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table}
BEGIN SELECT RAISE(ABORT, 'RS_IMMUTABLE_RECORD'); END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table}
BEGIN SELECT RAISE(ABORT, 'RS_IMMUTABLE_RECORD'); END;`;

export const MIGRATION_004_SQL = `
CREATE TABLE boundary_observation_order (
  observation_id TEXT PRIMARY KEY REFERENCES effect_boundary_observations(observation_id),
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  session_sequence INTEGER NOT NULL CHECK (session_sequence >= 0),
  UNIQUE (session_id, session_sequence)
) STRICT;

CREATE TABLE effect_release_authorizations (
  authorization_id TEXT PRIMARY KEY,
  case_run_id TEXT NOT NULL REFERENCES case_runs(case_run_id),
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  interceptor_instance_id TEXT REFERENCES effect_interceptor_instances(interceptor_instance_id),
  fencing_epoch INTEGER NOT NULL CHECK (fencing_epoch >= 0),
  session_sequence INTEGER NOT NULL CHECK (session_sequence >= 0),
  completion_evidence_ids_json TEXT NOT NULL,
  decision_digest TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  UNIQUE (session_id, session_sequence)
) STRICT;

CREATE TABLE effect_coverage_findings (
  finding_id TEXT PRIMARY KEY,
  interceptor_instance_id TEXT NOT NULL REFERENCES effect_interceptor_instances(interceptor_instance_id),
  case_run_id TEXT NOT NULL REFERENCES case_runs(case_run_id),
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  kind TEXT NOT NULL CHECK (kind IN ('PROCESS_TREE_ESCAPE','UNSUPPORTED_DYNAMIC_CALL','SINK_BYPASS')),
  sink_class TEXT,
  fencing_epoch INTEGER NOT NULL CHECK (fencing_epoch >= 0),
  session_sequence INTEGER NOT NULL CHECK (session_sequence >= 0),
  finding_digest TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  UNIQUE (interceptor_instance_id, finding_digest)
) STRICT;

CREATE INDEX effect_release_authorizations_by_case
  ON effect_release_authorizations(case_run_id, session_sequence);
CREATE INDEX effect_coverage_findings_by_case
  ON effect_coverage_findings(case_run_id, session_sequence);
${['boundary_observation_order', 'effect_release_authorizations', 'effect_coverage_findings'].map(immutable).join('\n')}
`;
