/**
 * Migration 002 — canonical case results with separately stored run envelopes, durable
 * maintenance (checkpoint/backup/storage-fault) records, and the evidence query index from
 * DATA-MODEL.md section 2 (`(run_operation_id, subject, class, scope)`).
 *
 * Purely additive: it never rewrites a row written under schema version 1 (T-028).
 */
export const MIGRATION_002_SQL = `
CREATE TABLE case_results (
  case_run_id TEXT PRIMARY KEY REFERENCES case_runs(case_run_id),
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  result_digest TEXT NOT NULL UNIQUE,
  canonical_json TEXT NOT NULL,
  envelope_digest TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('NOT_RUN','PASS','FAIL','REVIEW','UNSUPPORTED')),
  evaluator_revision TEXT NOT NULL,
  fencing_epoch INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL
) STRICT;
CREATE TRIGGER case_results_no_update BEFORE UPDATE ON case_results
BEGIN SELECT RAISE(ABORT, 'RS_IMMUTABLE_RECORD'); END;
CREATE TRIGGER case_results_no_delete BEFORE DELETE ON case_results
BEGIN SELECT RAISE(ABORT, 'RS_IMMUTABLE_RECORD'); END;

CREATE TABLE maintenance_events (
  maintenance_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('CHECKPOINT','BACKUP','STORAGE_FAULT','STORAGE_RESUME')),
  outcome TEXT NOT NULL CHECK (outcome IN ('COMPLETE','INCOMPLETE','FAILED','VERIFIED')),
  details_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
) STRICT;
CREATE TRIGGER maintenance_events_no_update BEFORE UPDATE ON maintenance_events
BEGIN SELECT RAISE(ABORT, 'RS_IMMUTABLE_RECORD'); END;
CREATE TRIGGER maintenance_events_no_delete BEFORE DELETE ON maintenance_events
BEGIN SELECT RAISE(ABORT, 'RS_IMMUTABLE_RECORD'); END;

CREATE INDEX evidence_items_by_predicate
  ON evidence_items(run_operation_id, subject, evidence_class, evidence_scope);
`;
