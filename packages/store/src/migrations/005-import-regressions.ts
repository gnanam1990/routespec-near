/**
 * Migration 005 — trace quarantine and capture-to-regression lineage (M05).
 *
 * Purely additive (T-028): new tables, triggers, and indexes only. The existing `imports`
 * table keeps its shape; it gains database-level guards:
 * - its state follows the closed import state machine
 *   `CAPTURED_UNTRUSTED -> QUARANTINED -> SANITIZED -> MAPPED -> REPLAY_VERIFIED -> REVIEWED ->
 *   PROMOTED`, where any non-terminal state may move to `REJECTED` or `PURGED`, `REJECTED` may
 *   only move to `PURGED`, and `PROMOTED`/`PURGED` are terminal;
 * - identity columns (origin, project, source session, raw digest/byte count) never change, the
 *   optimistic revision advances by exactly one per update, sanitized content is written at most
 *   once (and only cleared by a purge), and rows are never deleted.
 *
 * New insert-only tables:
 * - `import_capture_bindings`: the exact build/gate/case/session/scenario/effect identity an
 *   installed-artifact capture was derived from, plus the capture digest that promotion
 *   re-derives from the journal (a replaced capture cannot promote);
 * - `import_scans`: scanner revision and safe finding metadata (category, path, count — never a
 *   value);
 * - `import_replay_reports`: repeated no-network trial digests, stability and fidelity;
 * - `import_reviews`: immutable explicit local review records and their digests;
 * - `import_promotions`: one promotion per import, linking review, new scenario revision, and
 *   the new corpus revision;
 * - `corpus_lineage`: typed parent link of a corpus revision (explicit revision or promotion).
 */
const immutable = (table: string) => `
CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table}
BEGIN SELECT RAISE(ABORT, 'RS_IMMUTABLE_RECORD'); END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table}
BEGIN SELECT RAISE(ABORT, 'RS_IMMUTABLE_RECORD'); END;`;

export const IMPORT_STATE_EDGES: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ['CAPTURED_UNTRUSTED', 'QUARANTINED'],
  ['QUARANTINED', 'SANITIZED'],
  ['SANITIZED', 'MAPPED'],
  // A new mapping revision replaces the current draft before replay verification.
  ['MAPPED', 'MAPPED'],
  ['MAPPED', 'REPLAY_VERIFIED'],
  // A changed mapping after verification needs a fresh replay verification.
  ['REPLAY_VERIFIED', 'MAPPED'],
  ['REPLAY_VERIFIED', 'REVIEWED'],
  ['REVIEWED', 'PROMOTED'],
  ...['CAPTURED_UNTRUSTED', 'QUARANTINED', 'SANITIZED', 'MAPPED', 'REPLAY_VERIFIED', 'REVIEWED'].flatMap(
    (s) =>
      [
        [s, 'REJECTED'],
        [s, 'PURGED'],
      ] as const,
  ),
  ['REJECTED', 'PURGED'],
]);

const IMMUTABLE_005 = [
  'import_state_transitions',
  'import_capture_bindings',
  'import_scans',
  'import_replay_reports',
  'import_reviews',
  'import_promotions',
  'corpus_lineage',
];

export const MIGRATION_005_SQL = `
CREATE TABLE import_state_transitions (
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  PRIMARY KEY (from_state, to_state)
) STRICT;
INSERT INTO import_state_transitions(from_state, to_state) VALUES
  ${IMPORT_STATE_EDGES.map(([a, b]) => `('${a}','${b}')`).join(',\n  ')};

CREATE TRIGGER imports_state_guard BEFORE UPDATE OF state ON imports
WHEN NEW.state IS NOT OLD.state
BEGIN
  SELECT CASE
    WHEN OLD.state IN ('PROMOTED','PURGED') THEN RAISE(ABORT, 'RS_TERMINAL_IMMUTABLE')
    WHEN NOT EXISTS (SELECT 1 FROM import_state_transitions
                     WHERE from_state = OLD.state AND to_state = NEW.state)
      THEN RAISE(ABORT, 'RS_IMPORT_STATE_INVALID')
  END;
END;
CREATE TRIGGER imports_identity_frozen BEFORE UPDATE ON imports
WHEN NEW.import_id IS NOT OLD.import_id OR NEW.project_id IS NOT OLD.project_id
  OR NEW.origin IS NOT OLD.origin OR NEW.source_session_id IS NOT OLD.source_session_id
  OR NEW.source_filename IS NOT OLD.source_filename OR NEW.raw_byte_count IS NOT OLD.raw_byte_count
  OR NEW.raw_source_digest IS NOT OLD.raw_source_digest OR NEW.created_at_ms IS NOT OLD.created_at_ms
  OR NEW.revision IS NOT OLD.revision + 1
BEGIN SELECT RAISE(ABORT, 'RS_IMMUTABLE_RECORD'); END;
CREATE TRIGGER imports_sanitized_once BEFORE UPDATE OF sanitized_json ON imports
WHEN OLD.sanitized_json IS NOT NULL AND NEW.sanitized_json IS NOT OLD.sanitized_json
  AND NOT (NEW.state = 'PURGED' AND NEW.sanitized_json IS NULL)
BEGIN SELECT RAISE(ABORT, 'RS_IMMUTABLE_RECORD'); END;
CREATE TRIGGER imports_no_delete BEFORE DELETE ON imports
BEGIN SELECT RAISE(ABORT, 'RS_IMMUTABLE_RECORD'); END;

CREATE TABLE import_capture_bindings (
  import_id TEXT PRIMARY KEY REFERENCES imports(import_id),
  case_run_id TEXT NOT NULL REFERENCES case_runs(case_run_id),
  gate_run_id TEXT NOT NULL REFERENCES gate_runs(gate_run_id),
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  build_revision_id TEXT NOT NULL REFERENCES build_revisions(build_revision_id),
  artifact_digest TEXT NOT NULL,
  scenario_revision_id TEXT NOT NULL REFERENCES scenario_revisions(scenario_revision_id),
  effect_manifest_digest TEXT NOT NULL,
  effect_coverage_policy_digest TEXT NOT NULL,
  callsite_inventory_digest TEXT,
  interceptor_profile_digest TEXT,
  adapter_revision TEXT NOT NULL,
  fencing_epoch INTEGER NOT NULL CHECK (fencing_epoch >= 0),
  identity_digest TEXT NOT NULL,
  capture_digest TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE import_scans (
  scan_id TEXT PRIMARY KEY,
  import_id TEXT NOT NULL REFERENCES imports(import_id),
  scanner_revision TEXT NOT NULL,
  findings_json TEXT NOT NULL,
  blocking_count INTEGER NOT NULL CHECK (blocking_count >= 0),
  scan_digest TEXT NOT NULL UNIQUE,
  created_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE import_replay_reports (
  report_id TEXT PRIMARY KEY,
  import_id TEXT NOT NULL REFERENCES imports(import_id),
  mapping_revision_id TEXT NOT NULL REFERENCES import_mappings(mapping_revision_id),
  scenario_revision_digest TEXT NOT NULL,
  evaluator_revision TEXT NOT NULL,
  trials INTEGER NOT NULL CHECK (trials >= 2),
  trial_digests_json TEXT NOT NULL,
  stable INTEGER NOT NULL CHECK (stable IN (0,1)),
  fidelity TEXT NOT NULL CHECK (fidelity IN ('MATCH','MISMATCH')),
  findings_json TEXT NOT NULL,
  report_digest TEXT NOT NULL UNIQUE,
  created_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE import_reviews (
  review_id TEXT PRIMARY KEY,
  import_id TEXT NOT NULL REFERENCES imports(import_id),
  import_revision INTEGER NOT NULL CHECK (import_revision >= 1),
  mapping_revision_id TEXT NOT NULL REFERENCES import_mappings(mapping_revision_id),
  replay_report_id TEXT NOT NULL REFERENCES import_replay_reports(report_id),
  scan_id TEXT NOT NULL REFERENCES import_scans(scan_id),
  reviewer_digest TEXT NOT NULL,
  decisions_json TEXT NOT NULL,
  review_digest TEXT NOT NULL UNIQUE,
  created_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE import_promotions (
  promotion_id TEXT PRIMARY KEY,
  import_id TEXT NOT NULL UNIQUE REFERENCES imports(import_id),
  review_id TEXT NOT NULL UNIQUE REFERENCES import_reviews(review_id),
  scenario_revision_id TEXT NOT NULL UNIQUE REFERENCES scenario_revisions(scenario_revision_id),
  corpus_revision_id TEXT NOT NULL UNIQUE REFERENCES corpus_revisions(corpus_revision_id),
  base_corpus_revision_id TEXT REFERENCES corpus_revisions(corpus_revision_id),
  promotion_digest TEXT NOT NULL UNIQUE,
  created_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE corpus_lineage (
  corpus_revision_id TEXT PRIMARY KEY REFERENCES corpus_revisions(corpus_revision_id),
  parent_corpus_revision_id TEXT REFERENCES corpus_revisions(corpus_revision_id),
  relation TEXT NOT NULL CHECK (relation IN ('REVISION_OF','PROMOTION_INTO')),
  import_id TEXT REFERENCES imports(import_id),
  lineage_digest TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  CHECK ((relation = 'PROMOTION_INTO') = (import_id IS NOT NULL)),
  CHECK (parent_corpus_revision_id IS NULL OR parent_corpus_revision_id <> corpus_revision_id)
) STRICT;

CREATE INDEX import_scans_by_import ON import_scans(import_id, created_at_ms);
CREATE INDEX import_mappings_by_import ON import_mappings(import_id, created_at_ms);
CREATE INDEX import_replay_reports_by_import ON import_replay_reports(import_id, created_at_ms);
CREATE INDEX import_reviews_by_import ON import_reviews(import_id, created_at_ms);
${IMMUTABLE_005.map(immutable).join('\n')}
`;
