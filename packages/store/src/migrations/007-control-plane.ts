/**
 * Migration 007 — local control plane (M08).
 *
 * Purely additive (T-028): new tables, triggers, and indexes only.
 *
 * - `control_idempotency`: one row per (route scope, Idempotency-Key). A row is written PENDING
 *   before the mutation and COMPLETE with the safe response after it. A PENDING row seen by a
 *   later request means the earlier outcome is unknown (crash between commit and record); the
 *   API refuses to guess and never re-executes it. Responses never contain one-time token values.
 * - `project_records`: project scoping for records whose core tables are content-addressed and
 *   global (scenario/corpus revisions, manifests, policies, inventories, interceptor profiles,
 *   attester principals, gate definitions). Every control query joins through it.
 * - `interceptor_profiles`: caller-declared interceptor profiles. Registration never makes a
 *   profile reviewed; the review state column admits only `DECLARED_UNREVIEWED`.
 * - `local_confirmations`: single-use, short-lived out-of-band confirmations for attester
 *   enrollment/revocation and project deletion. Only the code digest is stored.
 * - `attester_policies`: the public verification policy of an enrolled principal (public key or
 *   pinned OIDC signing keys and claim policy). No private key column exists.
 * - `challenge_bindings` / `challenge_outcomes`: the exact identity a launcher challenge binds
 *   and its single terminal outcome (ATTESTED or REJECTED with a reason code).
 * - `gate_run_settings`: the networkless mode a control-API gate run was created for.
 */
const immutable = (table: string) => `
CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table}
BEGIN SELECT RAISE(ABORT, 'RS_IMMUTABLE_RECORD'); END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table}
BEGIN SELECT RAISE(ABORT, 'RS_IMMUTABLE_RECORD'); END;`;

const IMMUTABLE_007 = [
  'project_records',
  'interceptor_profiles',
  'attester_policies',
  'challenge_bindings',
  'challenge_outcomes',
  'gate_run_settings',
];

export const MIGRATION_007_SQL = `
CREATE TABLE control_idempotency (
  scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('PENDING','COMPLETE')),
  status_code INTEGER,
  response_json TEXT,
  created_at_ms INTEGER NOT NULL,
  completed_at_ms INTEGER,
  PRIMARY KEY (scope, idempotency_key),
  CHECK ((state = 'COMPLETE') = (response_json IS NOT NULL AND status_code IS NOT NULL))
) STRICT, WITHOUT ROWID;
CREATE TRIGGER control_idempotency_complete_once BEFORE UPDATE ON control_idempotency
WHEN OLD.state = 'COMPLETE' OR NEW.request_digest IS NOT OLD.request_digest
  OR NEW.scope IS NOT OLD.scope OR NEW.idempotency_key IS NOT OLD.idempotency_key
BEGIN SELECT RAISE(ABORT, 'RS_IMMUTABLE_RECORD'); END;
CREATE TRIGGER control_idempotency_delete_pending_only BEFORE DELETE ON control_idempotency
WHEN OLD.state = 'COMPLETE'
BEGIN SELECT RAISE(ABORT, 'RS_IMMUTABLE_RECORD'); END;

CREATE TABLE project_records (
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  record_kind TEXT NOT NULL CHECK (record_kind IN ('SCENARIO_REVISION','CORPUS_REVISION','EFFECT_MANIFEST',
    'EFFECT_POLICY','CALLSITE_INVENTORY','INTERCEPTOR_PROFILE','ATTESTER_PRINCIPAL','GATE_DEFINITION')),
  record_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (record_kind, record_id, project_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE interceptor_profiles (
  profile_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  profile_digest TEXT NOT NULL,
  interceptor_artifact_digest TEXT NOT NULL,
  containment TEXT NOT NULL CHECK (containment IN ('PROCESS_TREE_ENFORCED','DECLARED_HOOKS_ONLY')),
  process_tree_scope TEXT NOT NULL,
  supported_sinks_json TEXT NOT NULL,
  denial_mechanism TEXT NOT NULL CHECK (denial_mechanism IN ('DENY','CANARY_REDIRECT')),
  review_state TEXT NOT NULL CHECK (review_state = 'DECLARED_UNREVIEWED'),
  created_at_ms INTEGER NOT NULL,
  UNIQUE (project_id, profile_digest)
) STRICT;

CREATE TABLE local_confirmations (
  confirmation_id TEXT PRIMARY KEY,
  action_code TEXT NOT NULL,
  plan_digest TEXT NOT NULL,
  code_digest TEXT NOT NULL,
  issued_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  consumed_at_ms INTEGER
) STRICT;
CREATE TRIGGER local_confirmations_single_use BEFORE UPDATE ON local_confirmations
WHEN OLD.consumed_at_ms IS NOT NULL
  OR NEW.confirmation_id IS NOT OLD.confirmation_id OR NEW.plan_digest IS NOT OLD.plan_digest
  OR NEW.code_digest IS NOT OLD.code_digest OR NEW.action_code IS NOT OLD.action_code
  OR NEW.expires_at_ms IS NOT OLD.expires_at_ms
BEGIN SELECT RAISE(ABORT, 'RS_IMMUTABLE_RECORD'); END;
CREATE TRIGGER local_confirmations_no_delete BEFORE DELETE ON local_confirmations
BEGIN SELECT RAISE(ABORT, 'RS_IMMUTABLE_RECORD'); END;

CREATE TABLE attester_policies (
  principal_id TEXT PRIMARY KEY REFERENCES attester_principals(principal_id),
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  label TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  policy_digest TEXT NOT NULL,
  confirmation_id TEXT NOT NULL UNIQUE REFERENCES local_confirmations(confirmation_id)
) STRICT;

CREATE TABLE challenge_bindings (
  challenge_id TEXT PRIMARY KEY REFERENCES launcher_challenges(challenge_id),
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  binding_json TEXT NOT NULL
) STRICT;

CREATE TABLE challenge_outcomes (
  challenge_id TEXT PRIMARY KEY REFERENCES launcher_challenges(challenge_id),
  outcome TEXT NOT NULL CHECK (outcome IN ('ATTESTED','REJECTED')),
  reason_code TEXT,
  attestation_id TEXT REFERENCES subject_attestations(attestation_id),
  completed_at_ms INTEGER NOT NULL,
  CHECK ((outcome = 'ATTESTED') = (attestation_id IS NOT NULL)),
  CHECK ((outcome = 'REJECTED') = (reason_code IS NOT NULL))
) STRICT;

CREATE TABLE gate_run_settings (
  gate_run_id TEXT PRIMARY KEY REFERENCES gate_runs(gate_run_id),
  mode TEXT NOT NULL CHECK (mode IN ('SIMULATE','REPLAY')),
  created_at_ms INTEGER NOT NULL
) STRICT;

CREATE TRIGGER sessions_case_launch_attestation_once BEFORE UPDATE OF case_launch_attestation_id ON sessions
WHEN OLD.case_launch_attestation_id IS NOT NULL
  AND NEW.case_launch_attestation_id IS NOT OLD.case_launch_attestation_id
BEGIN SELECT RAISE(ABORT, 'RS_IMMUTABLE_RECORD'); END;

CREATE INDEX project_records_by_project ON project_records(project_id, record_kind, created_at_ms);
CREATE INDEX lifecycle_events_by_session_kind ON lifecycle_events(session_id, event_kind, sequence);
CREATE INDEX launcher_challenges_by_principal ON launcher_challenges(principal_id, issued_at_ms);
${IMMUTABLE_007.map(immutable).join('\n')}
`;
