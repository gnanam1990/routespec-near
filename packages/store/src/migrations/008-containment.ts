/**
 * Migration 008 — subject containment and per-case effect-coverage policies (M14).
 *
 * Purely additive (T-028): only new tables, triggers, and indexes.
 *
 * - `gate_run_case_policies`: the effect-coverage policy selected for one case of a gate run
 *   when the corpus has more than one scenario (a policy binds exactly one scenario revision).
 *   Written in the gate-run creation transaction; a case without a row uses the gate run's
 *   policy. The session of the case binds the selected policy digest.
 * - `subject_containments`: the engine-verified containment record of one contained subject
 *   launch: engine and image identity, container id, containment class and findings, the
 *   observed sandbox scope and its digest, the shim's self-observation, the case-launch and
 *   interceptor-launch attestations, and the teardown evidence (container removed, survivors).
 *   Written once at teardown; immutable.
 */
const immutable = (table: string) => `
CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table}
BEGIN SELECT RAISE(ABORT, 'RS_IMMUTABLE_RECORD'); END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table}
BEGIN SELECT RAISE(ABORT, 'RS_IMMUTABLE_RECORD'); END;`;

export const MIGRATION_008_SQL = `
CREATE TABLE gate_run_case_policies (
  case_run_id TEXT PRIMARY KEY REFERENCES case_runs(case_run_id),
  gate_run_id TEXT NOT NULL REFERENCES gate_runs(gate_run_id),
  scenario_revision_id TEXT NOT NULL,
  effect_coverage_policy_digest TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE subject_containments (
  containment_id TEXT PRIMARY KEY,
  case_run_id TEXT NOT NULL REFERENCES case_runs(case_run_id),
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  interceptor_instance_id TEXT REFERENCES effect_interceptor_instances(interceptor_instance_id),
  engine TEXT NOT NULL,
  engine_version TEXT NOT NULL,
  image_id TEXT NOT NULL,
  container_id TEXT NOT NULL,
  containment TEXT NOT NULL CHECK (containment IN ('PROCESS_TREE_ENFORCED','DECLARED_HOOKS_ONLY')),
  findings_json TEXT NOT NULL,
  sandbox_scope_digest TEXT,
  scope_json TEXT NOT NULL,
  self_observation_json TEXT NOT NULL,
  case_launch_attestation_id TEXT REFERENCES subject_attestations(attestation_id),
  interceptor_attestation_id TEXT REFERENCES subject_attestations(attestation_id),
  container_removed INTEGER NOT NULL CHECK (container_removed IN (0,1)),
  teardown_json TEXT NOT NULL,
  started_at_ms INTEGER NOT NULL,
  torn_down_at_ms INTEGER NOT NULL,
  record_digest TEXT NOT NULL
) STRICT;

CREATE INDEX gate_run_case_policies_by_gate ON gate_run_case_policies(gate_run_id);
CREATE INDEX subject_containments_by_case ON subject_containments(case_run_id);
${['gate_run_case_policies', 'subject_containments'].map(immutable).join('\n')}
`;
