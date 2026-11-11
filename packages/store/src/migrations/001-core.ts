/**
 * Migration 001 — core RouteSpec schema (DATA-MODEL.md section 2).
 *
 * Conventions: STRICT tables; opaque TEXT ids; integer wall-clock milliseconds (`*_at_ms`) are
 * kept separate from virtual milliseconds (`virtual_ms`); amounts are base-unit decimal TEXT;
 * secrets are never a column. Insert-only tables get BEFORE UPDATE/DELETE triggers that abort
 * with `RS_IMMUTABLE_RECORD`. Lifecycle columns are guarded by the shared transition table
 * generated from @routespec/contracts, so terminal states and illegal transitions are rejected
 * by the database itself, not only by application code.
 */
import { allowedTransitions, OPERATION_PHASES, type LifecycleSubject } from '@routespec/contracts';

const IMMUTABLE_TABLES = [
  'protocol_profiles',
  'integration_revisions',
  'build_revisions',
  'attester_revocations',
  'subject_attestations',
  'effect_manifests',
  'effect_manifest_hooks',
  'effect_coverage_policies',
  'effect_callsite_inventories',
  'effect_boundary_observations',
  'protected_effect_observations',
  'scenario_revisions',
  'corpus_revisions',
  'corpus_cases',
  'gate_definitions',
  'logical_jobs',
  'run_operation_lineage',
  'quote_finalizations',
  'commit_bindings',
  'operation_conflicts',
  'lifecycle_events',
  'token_revocations',
  'evidence_items',
  'evidence_allocations',
  'evidence_allocation_parts',
  'evidence_consumptions',
  'invariant_results',
  'gate_evaluations',
  'import_mappings',
  'audit_events',
  'lifecycle_transitions',
] as const;

function immutableTriggers(table: string): string {
  return `
CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table}
BEGIN SELECT RAISE(ABORT, 'RS_IMMUTABLE_RECORD'); END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table}
BEGIN SELECT RAISE(ABORT, 'RS_IMMUTABLE_RECORD'); END;`;
}

function transitionRows(): string {
  const subjects: LifecycleSubject[] = ['GATE_RUN', 'CASE_RUN', 'SESSION'];
  const rows = subjects.flatMap((s) =>
    allowedTransitions(s).map(([from, to]) => `('${s}','${from}','${to}')`),
  );
  return `INSERT INTO lifecycle_transitions(subject, from_state, to_state) VALUES\n  ${rows.join(',\n  ')};`;
}

function lifecycleGuard(table: string, subject: LifecycleSubject): string {
  return `
CREATE TRIGGER ${table}_lifecycle_guard BEFORE UPDATE OF execution_lifecycle ON ${table}
WHEN NEW.execution_lifecycle IS NOT OLD.execution_lifecycle
BEGIN
  SELECT CASE
    WHEN OLD.execution_lifecycle IN ('COMPLETED','ABORTED','ERROR')
      THEN RAISE(ABORT, 'RS_TERMINAL_IMMUTABLE')
    WHEN NOT EXISTS (SELECT 1 FROM lifecycle_transitions
                     WHERE subject = '${subject}' AND from_state = OLD.execution_lifecycle
                       AND to_state = NEW.execution_lifecycle)
      THEN RAISE(ABORT, 'RS_LIFECYCLE_TRANSITION_INVALID')
  END;
END;
CREATE TRIGGER ${table}_verdict_once BEFORE UPDATE OF verdict ON ${table}
WHEN OLD.verdict IS NOT NULL AND NEW.verdict IS NOT OLD.verdict
BEGIN SELECT RAISE(ABORT, 'RS_IMMUTABLE_RECORD'); END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table}
BEGIN SELECT RAISE(ABORT, 'RS_IMMUTABLE_RECORD'); END;`;
}

const LIFECYCLE = `CHECK (execution_lifecycle IN ('PENDING','DRAFT','VALIDATING','READY','RUNNING','RECOVERY_REQUIRED','EVALUATING','COMPLETED','ABORTED','ERROR'))`;
const VERDICT = `CHECK (verdict IS NULL OR verdict IN ('NOT_RUN','PASS','FAIL','REVIEW','UNSUPPORTED'))`;
const PHASE = `CHECK (phase IN (${OPERATION_PHASES.map((p) => `'${p}'`).join(',')}))`;

export const MIGRATION_001_SQL = `
CREATE TABLE lifecycle_transitions (
  subject TEXT NOT NULL CHECK (subject IN ('GATE_RUN','CASE_RUN','SESSION')),
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  PRIMARY KEY (subject, from_state, to_state)
) STRICT, WITHOUT ROWID;
${transitionRows()}

CREATE TABLE idempotency_keys (
  scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (scope, idempotency_key)
) STRICT;

CREATE TABLE projects (
  project_id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  description TEXT CHECK (description IS NULL OR length(description) <= 2000),
  retention_policy_json TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  created_at_ms INTEGER NOT NULL,
  deleted_at_ms INTEGER
) STRICT;
CREATE TRIGGER projects_revision_monotonic BEFORE UPDATE ON projects
WHEN NEW.revision <> OLD.revision + 1 OR NEW.project_id IS NOT OLD.project_id OR NEW.created_at_ms IS NOT OLD.created_at_ms
BEGIN SELECT RAISE(ABORT, 'RS_REVISION_CONFLICT'); END;

CREATE TABLE protocol_profiles (
  profile_id TEXT PRIMARY KEY,
  sdk_package TEXT NOT NULL,
  sdk_version TEXT NOT NULL,
  sdk_git_head TEXT NOT NULL,
  route_schema_digest TEXT NOT NULL,
  material_registry_digest TEXT NOT NULL,
  status_schema_digest TEXT NOT NULL,
  integrity_digest TEXT NOT NULL UNIQUE,
  profile_json TEXT NOT NULL
) STRICT;

CREATE TABLE integration_revisions (
  integration_revision_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  revision_label TEXT NOT NULL,
  commit_sha TEXT,
  configuration_digest TEXT NOT NULL,
  protocol_profile_id TEXT NOT NULL REFERENCES protocol_profiles(profile_id),
  metadata_json TEXT NOT NULL,
  identity_digest TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  UNIQUE (project_id, identity_digest),
  UNIQUE (integration_revision_id, project_id)
) STRICT;

CREATE TABLE build_revisions (
  build_revision_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  integration_revision_id TEXT NOT NULL,
  repository_locator TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  dirty_tree_digest TEXT,
  artifact_digest TEXT NOT NULL,
  toolchain_digest TEXT NOT NULL,
  lock_digest TEXT NOT NULL,
  effect_manifest_digest TEXT NOT NULL,
  ci_workflow_run_id TEXT,
  launch_recipe_digest TEXT NOT NULL,
  registration_claim TEXT NOT NULL CHECK (registration_claim = 'USER_ASSERTED_LOCAL'),
  identity_digest TEXT NOT NULL UNIQUE,
  created_at_ms INTEGER NOT NULL,
  FOREIGN KEY (integration_revision_id, project_id)
    REFERENCES integration_revisions(integration_revision_id, project_id),
  UNIQUE (build_revision_id, artifact_digest),
  UNIQUE (build_revision_id, integration_revision_id)
) STRICT;

CREATE TABLE attester_principals (
  principal_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('LOCAL_LAUNCHER_KEY','CI_OIDC')),
  key_or_issuer_policy_digest TEXT NOT NULL,
  audience TEXT,
  claim_policy_digest TEXT NOT NULL,
  max_freshness_ms INTEGER NOT NULL CHECK (max_freshness_ms > 0),
  policy_digest TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
  revocation_epoch INTEGER NOT NULL CHECK (revocation_epoch >= 0),
  valid_from_ms INTEGER NOT NULL,
  valid_until_ms INTEGER NOT NULL,
  enrolled_at_ms INTEGER NOT NULL
) STRICT;
CREATE TRIGGER attester_principals_guard BEFORE UPDATE ON attester_principals
WHEN NEW.revocation_epoch < OLD.revocation_epoch
  OR NEW.policy_digest IS NOT OLD.policy_digest
  OR NEW.kind IS NOT OLD.kind
  OR (OLD.enabled = 0 AND NEW.enabled = 1)
BEGIN SELECT RAISE(ABORT, 'RS_IMMUTABLE_RECORD'); END;

CREATE TABLE attester_revocations (
  revocation_id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL REFERENCES attester_principals(principal_id),
  revocation_epoch INTEGER NOT NULL,
  reason_code TEXT NOT NULL,
  revoked_at_ms INTEGER NOT NULL,
  UNIQUE (principal_id, revocation_epoch)
) STRICT;

CREATE TABLE launcher_challenges (
  challenge_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('BUILD_REGISTRATION','CASE_LAUNCH','EFFECT_INVENTORY','EFFECT_INTERCEPTOR_LAUNCH')),
  principal_id TEXT NOT NULL REFERENCES attester_principals(principal_id),
  principal_policy_digest TEXT NOT NULL,
  principal_revocation_epoch INTEGER NOT NULL,
  nonce_digest TEXT NOT NULL UNIQUE,
  binding_digest TEXT NOT NULL,
  issued_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  consumed_at_ms INTEGER
) STRICT;
CREATE TRIGGER launcher_challenges_single_use BEFORE UPDATE ON launcher_challenges
WHEN OLD.consumed_at_ms IS NOT NULL
  OR NEW.challenge_id IS NOT OLD.challenge_id OR NEW.binding_digest IS NOT OLD.binding_digest
  OR NEW.nonce_digest IS NOT OLD.nonce_digest OR NEW.scope IS NOT OLD.scope
BEGIN SELECT RAISE(ABORT, 'RS_IMMUTABLE_RECORD'); END;

CREATE TABLE subject_attestations (
  attestation_id TEXT PRIMARY KEY,
  attestation_class TEXT NOT NULL CHECK (attestation_class IN ('TRUSTED_LAUNCHER','CI_ATTESTED')),
  scope TEXT NOT NULL,
  challenge_id TEXT NOT NULL UNIQUE REFERENCES launcher_challenges(challenge_id),
  principal_id TEXT NOT NULL REFERENCES attester_principals(principal_id),
  principal_policy_digest TEXT NOT NULL,
  principal_revocation_epoch INTEGER NOT NULL,
  build_revision_id TEXT REFERENCES build_revisions(build_revision_id),
  verified_claims_digest TEXT NOT NULL,
  observed_digests_json TEXT NOT NULL,
  verified_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  attestation_digest TEXT NOT NULL UNIQUE
) STRICT;

CREATE TABLE effect_manifests (
  manifest_id TEXT PRIMARY KEY,
  build_revision_id TEXT NOT NULL,
  artifact_digest TEXT NOT NULL,
  adapter_revision TEXT NOT NULL,
  manifest_digest TEXT NOT NULL UNIQUE,
  created_at_ms INTEGER NOT NULL,
  FOREIGN KEY (build_revision_id, artifact_digest) REFERENCES build_revisions(build_revision_id, artifact_digest)
) STRICT;

CREATE TABLE effect_manifest_hooks (
  manifest_id TEXT NOT NULL REFERENCES effect_manifests(manifest_id),
  hook_id TEXT NOT NULL,
  hook_revision TEXT NOT NULL,
  effect_type TEXT NOT NULL,
  sink_class TEXT NOT NULL,
  source_locator_digest TEXT,
  mechanism TEXT NOT NULL,
  scenario_selectors_json TEXT NOT NULL,
  coverage_expectation TEXT NOT NULL CHECK (coverage_expectation IN ('REQUIRED','OPTIONAL')),
  PRIMARY KEY (manifest_id, hook_id)
) STRICT;

CREATE TABLE effect_callsite_inventories (
  inventory_id TEXT PRIMARY KEY,
  build_revision_id TEXT NOT NULL REFERENCES build_revisions(build_revision_id),
  manifest_digest TEXT NOT NULL REFERENCES effect_manifests(manifest_digest),
  analyzer_digest TEXT NOT NULL,
  attestation_id TEXT REFERENCES subject_attestations(attestation_id),
  inventory_json TEXT NOT NULL,
  unsupported_findings INTEGER NOT NULL CHECK (unsupported_findings >= 0),
  inventory_digest TEXT NOT NULL UNIQUE,
  issued_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE effect_coverage_policies (
  policy_id TEXT PRIMARY KEY,
  build_revision_id TEXT NOT NULL,
  artifact_digest TEXT NOT NULL,
  selected_attestation_id TEXT REFERENCES subject_attestations(attestation_id),
  scenario_revision_id TEXT NOT NULL REFERENCES scenario_revisions(scenario_revision_id),
  manifest_digest TEXT NOT NULL REFERENCES effect_manifests(manifest_digest),
  required_sink_classes_json TEXT NOT NULL,
  interceptor_profile_digest TEXT,
  callsite_inventory_digest TEXT REFERENCES effect_callsite_inventories(inventory_digest),
  basis TEXT NOT NULL CHECK (basis IN ('INDEPENDENT_BOUNDARY_INTERCEPT','TRUSTED_BUILD_INVENTORY_PLUS_INTERCEPT','DECLARED_HOOKS_ONLY')),
  policy_digest TEXT NOT NULL UNIQUE,
  created_at_ms INTEGER NOT NULL,
  CHECK (basis = 'DECLARED_HOOKS_ONLY' OR interceptor_profile_digest IS NOT NULL),
  CHECK (basis <> 'TRUSTED_BUILD_INVENTORY_PLUS_INTERCEPT' OR callsite_inventory_digest IS NOT NULL),
  FOREIGN KEY (build_revision_id, artifact_digest) REFERENCES build_revisions(build_revision_id, artifact_digest)
) STRICT;

CREATE TABLE scenario_revisions (
  scenario_revision_id TEXT PRIMARY KEY,
  scenario_stable_id TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  compiled_json TEXT NOT NULL,
  seed TEXT NOT NULL,
  resource_budget_json TEXT NOT NULL,
  provenance_class TEXT NOT NULL CHECK (provenance_class IN ('SYNTHETIC','OFFICIAL_SPEC_DERIVED','ISSUE_DERIVED_NOT_REPRODUCED','INDEPENDENTLY_REPRODUCED','CUSTOMER_PROVIDED_REDACTED','DISPUTED_AMBIGUITY_CASE')),
  source_locator TEXT,
  review_status TEXT NOT NULL CHECK (review_status IN ('UNREVIEWED','REVIEWED')),
  compiler_revision TEXT NOT NULL,
  revision_digest TEXT NOT NULL UNIQUE,
  created_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE corpus_revisions (
  corpus_revision_id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  corpus_digest TEXT NOT NULL UNIQUE,
  created_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE corpus_cases (
  corpus_revision_id TEXT NOT NULL REFERENCES corpus_revisions(corpus_revision_id),
  case_ordinal INTEGER NOT NULL CHECK (case_ordinal >= 0),
  scenario_revision_id TEXT NOT NULL REFERENCES scenario_revisions(scenario_revision_id),
  required_invariants_json TEXT NOT NULL,
  severity TEXT NOT NULL,
  gate_policy TEXT NOT NULL,
  PRIMARY KEY (corpus_revision_id, case_ordinal)
) STRICT;

CREATE TABLE gate_definitions (
  gate_definition_revision_id TEXT PRIMARY KEY,
  gate_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  name TEXT NOT NULL,
  corpus_revision_id TEXT NOT NULL REFERENCES corpus_revisions(corpus_revision_id),
  required_invariant_policy_json TEXT NOT NULL,
  stale_result_policy_json TEXT NOT NULL,
  artifact_policy_json TEXT NOT NULL,
  enforcement_mode TEXT NOT NULL CHECK (enforcement_mode IN ('LOCAL_ADVISORY','CI_CHECK','REQUIRED_CHECK_UNVERIFIED')),
  created_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE gate_runs (
  gate_run_id TEXT PRIMARY KEY,
  gate_definition_revision_id TEXT REFERENCES gate_definitions(gate_definition_revision_id),
  project_id TEXT NOT NULL,
  integration_revision_id TEXT NOT NULL,
  build_revision_id TEXT NOT NULL,
  artifact_digest TEXT NOT NULL,
  build_attestation_class TEXT NOT NULL CHECK (build_attestation_class IN ('USER_ASSERTED_LOCAL','TRUSTED_LAUNCHER','CI_ATTESTED')),
  build_attestation_id TEXT REFERENCES subject_attestations(attestation_id),
  corpus_revision_id TEXT NOT NULL REFERENCES corpus_revisions(corpus_revision_id),
  protocol_profile_id TEXT NOT NULL REFERENCES protocol_profiles(profile_id),
  adapter_revision TEXT NOT NULL,
  evaluator_revision TEXT NOT NULL,
  proxy_revision TEXT NOT NULL,
  configuration_digest TEXT NOT NULL,
  effect_manifest_digest TEXT NOT NULL REFERENCES effect_manifests(manifest_digest),
  effect_coverage_policy_digest TEXT NOT NULL REFERENCES effect_coverage_policies(policy_digest),
  callsite_inventory_digest TEXT,
  interceptor_profile_digest TEXT,
  max_parallel_cases INTEGER NOT NULL CHECK (max_parallel_cases BETWEEN 1 AND 64),
  execution_lifecycle TEXT NOT NULL ${LIFECYCLE},
  verdict TEXT ${VERDICT},
  identity_digest TEXT NOT NULL UNIQUE,
  created_at_ms INTEGER NOT NULL,
  started_at_ms INTEGER,
  closed_at_ms INTEGER,
  CHECK ((build_attestation_class = 'USER_ASSERTED_LOCAL') = (build_attestation_id IS NULL)),
  FOREIGN KEY (build_revision_id, artifact_digest) REFERENCES build_revisions(build_revision_id, artifact_digest),
  FOREIGN KEY (build_revision_id, integration_revision_id) REFERENCES build_revisions(build_revision_id, integration_revision_id),
  FOREIGN KEY (integration_revision_id, project_id) REFERENCES integration_revisions(integration_revision_id, project_id),
  UNIQUE (gate_run_id, build_revision_id, artifact_digest, integration_revision_id)
) STRICT;
CREATE TRIGGER gate_runs_identity_frozen BEFORE UPDATE ON gate_runs
WHEN NEW.identity_digest IS NOT OLD.identity_digest OR NEW.build_revision_id IS NOT OLD.build_revision_id
  OR NEW.artifact_digest IS NOT OLD.artifact_digest OR NEW.build_attestation_id IS NOT OLD.build_attestation_id
  OR NEW.build_attestation_class IS NOT OLD.build_attestation_class OR NEW.corpus_revision_id IS NOT OLD.corpus_revision_id
  OR NEW.configuration_digest IS NOT OLD.configuration_digest OR NEW.max_parallel_cases IS NOT OLD.max_parallel_cases
  OR NEW.effect_coverage_policy_digest IS NOT OLD.effect_coverage_policy_digest
BEGIN SELECT RAISE(ABORT, 'RS_IMMUTABLE_RECORD'); END;
${lifecycleGuard('gate_runs', 'GATE_RUN')}

CREATE TABLE case_runs (
  case_run_id TEXT PRIMARY KEY,
  gate_run_id TEXT NOT NULL REFERENCES gate_runs(gate_run_id),
  case_ordinal INTEGER NOT NULL CHECK (case_ordinal >= 0),
  scenario_revision_id TEXT NOT NULL REFERENCES scenario_revisions(scenario_revision_id),
  lineage_role TEXT NOT NULL CHECK (lineage_role IN ('BASELINE','CORRECTED','REPLAY','PROMOTED_REGRESSION')),
  required_invariants_json TEXT NOT NULL,
  adapter_revision TEXT NOT NULL,
  execution_lifecycle TEXT NOT NULL ${LIFECYCLE},
  verdict TEXT ${VERDICT},
  fencing_epoch INTEGER NOT NULL DEFAULT 0 CHECK (fencing_epoch >= 0),
  client_instance_digest TEXT,
  session_id TEXT,
  active_token_digest TEXT,
  lease_owner_digest TEXT,
  lease_expires_at_ms INTEGER,
  terminal_result_digest TEXT,
  teardown_recorded_at_ms INTEGER,
  UNIQUE (gate_run_id, case_ordinal),
  UNIQUE (case_run_id, gate_run_id)
) STRICT;
CREATE TRIGGER case_runs_epoch_monotonic BEFORE UPDATE OF fencing_epoch ON case_runs
WHEN NEW.fencing_epoch < OLD.fencing_epoch
BEGIN SELECT RAISE(ABORT, 'RS_STALE_FENCING_EPOCH'); END;
CREATE TRIGGER case_runs_identity_frozen BEFORE UPDATE ON case_runs
WHEN NEW.gate_run_id IS NOT OLD.gate_run_id OR NEW.case_ordinal IS NOT OLD.case_ordinal
  OR NEW.scenario_revision_id IS NOT OLD.scenario_revision_id OR NEW.lineage_role IS NOT OLD.lineage_role
  OR (OLD.session_id IS NOT NULL AND NEW.session_id IS NOT OLD.session_id)
  OR (OLD.client_instance_digest IS NOT NULL AND NEW.client_instance_digest IS NOT OLD.client_instance_digest)
BEGIN SELECT RAISE(ABORT, 'RS_IMMUTABLE_RECORD'); END;
${lifecycleGuard('case_runs', 'CASE_RUN')}

CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  integration_revision_id TEXT NOT NULL,
  build_revision_id TEXT NOT NULL,
  artifact_digest TEXT NOT NULL,
  subject_attestation_class TEXT NOT NULL,
  gate_run_id TEXT NOT NULL,
  case_run_id TEXT NOT NULL UNIQUE,
  scenario_revision_id TEXT NOT NULL REFERENCES scenario_revisions(scenario_revision_id),
  corpus_revision_id TEXT NOT NULL REFERENCES corpus_revisions(corpus_revision_id),
  case_launch_attestation_id TEXT REFERENCES subject_attestations(attestation_id),
  adapter_revision TEXT NOT NULL,
  effect_manifest_digest TEXT NOT NULL,
  effect_coverage_policy_digest TEXT NOT NULL,
  callsite_inventory_digest TEXT,
  interceptor_instance_id TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('SIMULATE','REPLAY','LIVE_DRY_PROBE')),
  evaluator_revision TEXT NOT NULL,
  configuration_digest TEXT NOT NULL,
  execution_lifecycle TEXT NOT NULL ${LIFECYCLE},
  verdict TEXT ${VERDICT},
  seed TEXT NOT NULL,
  next_sequence INTEGER NOT NULL CHECK (next_sequence >= 0),
  lease_owner_digest TEXT,
  lease_expires_at_ms INTEGER,
  lease_fencing_epoch INTEGER NOT NULL CHECK (lease_fencing_epoch >= 0),
  started_at_ms INTEGER,
  closed_at_ms INTEGER,
  result_digest TEXT,
  FOREIGN KEY (case_run_id, gate_run_id) REFERENCES case_runs(case_run_id, gate_run_id),
  FOREIGN KEY (gate_run_id, build_revision_id, artifact_digest, integration_revision_id)
    REFERENCES gate_runs(gate_run_id, build_revision_id, artifact_digest, integration_revision_id),
  UNIQUE (session_id, case_run_id, gate_run_id, build_revision_id, artifact_digest)
) STRICT;
CREATE TRIGGER sessions_sequence_monotonic BEFORE UPDATE OF next_sequence ON sessions
WHEN NEW.next_sequence < OLD.next_sequence
BEGIN SELECT RAISE(ABORT, 'RS_IMMUTABLE_RECORD'); END;
CREATE TRIGGER sessions_epoch_monotonic BEFORE UPDATE OF lease_fencing_epoch ON sessions
WHEN NEW.lease_fencing_epoch < OLD.lease_fencing_epoch
BEGIN SELECT RAISE(ABORT, 'RS_STALE_FENCING_EPOCH'); END;
CREATE TRIGGER sessions_identity_frozen BEFORE UPDATE ON sessions
WHEN NEW.mode IS NOT OLD.mode OR NEW.build_revision_id IS NOT OLD.build_revision_id
  OR NEW.case_run_id IS NOT OLD.case_run_id OR NEW.seed IS NOT OLD.seed
BEGIN SELECT RAISE(ABORT, 'RS_IMMUTABLE_RECORD'); END;
${lifecycleGuard('sessions', 'SESSION')}

CREATE TABLE case_tokens (
  token_digest TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('EXECUTION','RECONCILIATION_ONLY')),
  build_revision_id TEXT NOT NULL,
  artifact_digest TEXT NOT NULL,
  gate_run_id TEXT NOT NULL,
  case_run_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  client_instance_digest TEXT NOT NULL,
  adapter_revision TEXT NOT NULL,
  allowed_phases_json TEXT NOT NULL,
  fencing_epoch INTEGER NOT NULL,
  issued_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  last_used_at_ms INTEGER,
  CHECK (purpose = 'EXECUTION' OR allowed_phases_json = '["READ_ONLY_RECONCILIATION"]'),
  FOREIGN KEY (session_id, case_run_id, gate_run_id, build_revision_id, artifact_digest)
    REFERENCES sessions(session_id, case_run_id, gate_run_id, build_revision_id, artifact_digest),
  UNIQUE (case_run_id, fencing_epoch, purpose)
) STRICT;
CREATE TRIGGER case_tokens_frozen BEFORE UPDATE ON case_tokens
WHEN NEW.token_digest IS NOT OLD.token_digest OR NEW.purpose IS NOT OLD.purpose
  OR NEW.fencing_epoch IS NOT OLD.fencing_epoch OR NEW.allowed_phases_json IS NOT OLD.allowed_phases_json
  OR NEW.case_run_id IS NOT OLD.case_run_id OR NEW.client_instance_digest IS NOT OLD.client_instance_digest
  OR NEW.expires_at_ms IS NOT OLD.expires_at_ms
BEGIN SELECT RAISE(ABORT, 'RS_IMMUTABLE_RECORD'); END;
CREATE TRIGGER case_tokens_no_delete BEFORE DELETE ON case_tokens
BEGIN SELECT RAISE(ABORT, 'RS_IMMUTABLE_RECORD'); END;

CREATE TABLE token_revocations (
  token_digest TEXT PRIMARY KEY REFERENCES case_tokens(token_digest),
  reason_code TEXT NOT NULL,
  revoked_at_ms INTEGER NOT NULL,
  revoked_at_epoch INTEGER NOT NULL
) STRICT;

CREATE TABLE logical_jobs (
  logical_job_id TEXT PRIMARY KEY,
  integration_revision_id TEXT NOT NULL REFERENCES integration_revisions(integration_revision_id),
  logical_job_key_digest TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  UNIQUE (integration_revision_id, logical_job_key_digest)
) STRICT;

CREATE TABLE run_operations (
  run_operation_id TEXT PRIMARY KEY,
  integration_revision_id TEXT NOT NULL,
  build_revision_id TEXT NOT NULL,
  artifact_digest TEXT NOT NULL,
  gate_run_id TEXT NOT NULL,
  case_run_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  logical_job_id TEXT NOT NULL REFERENCES logical_jobs(logical_job_id),
  protocol_profile_id TEXT NOT NULL REFERENCES protocol_profiles(profile_id),
  adapter_revision TEXT NOT NULL,
  effect_coverage_policy_digest TEXT NOT NULL,
  effect_manifest_digest TEXT NOT NULL,
  callsite_inventory_digest TEXT,
  interceptor_instance_id TEXT,
  fencing_epoch INTEGER NOT NULL,
  current_phase TEXT NOT NULL CHECK (current_phase IN (${OPERATION_PHASES.map((p) => `'${p}'`).join(',')})),
  quote_request_digest TEXT NOT NULL,
  quote_request_json TEXT NOT NULL,
  quote_finalization_digest TEXT,
  commit_binding_digest TEXT,
  accepted_terminal_status TEXT,
  normalized_outcome TEXT,
  outcome_flags_json TEXT NOT NULL,
  created_sequence INTEGER NOT NULL,
  finalized_sequence INTEGER,
  committed_sequence INTEGER,
  created_at_ms INTEGER NOT NULL,
  CHECK (instr(quote_request_json, '"depositAddress"') = 0),
  FOREIGN KEY (session_id, case_run_id, gate_run_id, build_revision_id, artifact_digest)
    REFERENCES sessions(session_id, case_run_id, gate_run_id, build_revision_id, artifact_digest),
  UNIQUE (integration_revision_id, build_revision_id, gate_run_id, case_run_id, logical_job_id),
  UNIQUE (run_operation_id, session_id)
) STRICT;
CREATE TRIGGER run_operations_binding_once BEFORE UPDATE ON run_operations
WHEN NEW.quote_request_digest IS NOT OLD.quote_request_digest
  OR NEW.quote_request_json IS NOT OLD.quote_request_json
  OR NEW.logical_job_id IS NOT OLD.logical_job_id OR NEW.case_run_id IS NOT OLD.case_run_id
  OR NEW.build_revision_id IS NOT OLD.build_revision_id OR NEW.session_id IS NOT OLD.session_id
  OR (OLD.quote_finalization_digest IS NOT NULL AND NEW.quote_finalization_digest IS NOT OLD.quote_finalization_digest)
  OR (OLD.commit_binding_digest IS NOT NULL AND NEW.commit_binding_digest IS NOT OLD.commit_binding_digest)
  OR (NEW.commit_binding_digest IS NOT NULL AND NEW.quote_finalization_digest IS NULL)
  OR (OLD.accepted_terminal_status IS NOT NULL AND NEW.accepted_terminal_status IS NOT OLD.accepted_terminal_status)
  OR (OLD.normalized_outcome IN ('SUCCESS_REPORTED','REFUND_REPORTED','FAILED_REPORTED')
      AND NEW.normalized_outcome IS NOT OLD.normalized_outcome AND NEW.normalized_outcome <> 'CONTRADICTORY')
  OR (OLD.normalized_outcome = 'CONTRADICTORY' AND NEW.normalized_outcome IS NOT 'CONTRADICTORY')
BEGIN SELECT RAISE(ABORT, 'RS_IMMUTABLE_RECORD'); END;
CREATE TRIGGER run_operations_no_delete BEFORE DELETE ON run_operations
BEGIN SELECT RAISE(ABORT, 'RS_IMMUTABLE_RECORD'); END;

CREATE TABLE run_operation_lineage (
  from_run_operation_id TEXT NOT NULL REFERENCES run_operations(run_operation_id),
  to_run_operation_id TEXT NOT NULL REFERENCES run_operations(run_operation_id),
  relation TEXT NOT NULL CHECK (relation IN ('BASELINE_OF','CORRECTION_OF','REPLAY_OF','PROMOTED_FROM')),
  lineage_digest TEXT NOT NULL UNIQUE,
  created_at_ms INTEGER NOT NULL,
  CHECK (from_run_operation_id <> to_run_operation_id),
  PRIMARY KEY (from_run_operation_id, to_run_operation_id, relation)
) STRICT;

CREATE TABLE quote_finalizations (
  run_operation_id TEXT PRIMARY KEY REFERENCES run_operations(run_operation_id),
  quote_request_digest TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  quote_timestamp TEXT NOT NULL,
  signature_digest TEXT NOT NULL,
  response_digest TEXT NOT NULL,
  deposit_address TEXT,
  deposit_memo TEXT,
  constraints_json TEXT NOT NULL,
  extensions_json TEXT NOT NULL,
  finalization_digest TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  fencing_epoch INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  UNIQUE (run_operation_id, finalization_digest)
) STRICT;

CREATE TABLE commit_bindings (
  run_operation_id TEXT PRIMARY KEY,
  method TEXT NOT NULL CHECK (method = 'POST'),
  route TEXT NOT NULL CHECK (route = '/v0/deposit/submit'),
  body_digest TEXT NOT NULL,
  quote_finalization_digest TEXT NOT NULL,
  deposit_address_digest TEXT NOT NULL,
  transaction_digest TEXT NOT NULL,
  binding_digest TEXT NOT NULL,
  first_attempt_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  fencing_epoch INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  FOREIGN KEY (run_operation_id, quote_finalization_digest)
    REFERENCES quote_finalizations(run_operation_id, finalization_digest)
) STRICT;

CREATE TABLE operation_conflicts (
  conflict_id TEXT PRIMARY KEY,
  run_operation_id TEXT REFERENCES run_operations(run_operation_id),
  session_id TEXT NOT NULL,
  phase TEXT NOT NULL ${PHASE},
  error_code TEXT NOT NULL,
  attempted_digest TEXT,
  fencing_epoch INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE attempts (
  attempt_id TEXT PRIMARY KEY,
  run_operation_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  fencing_epoch INTEGER NOT NULL,
  attempt_ordinal INTEGER NOT NULL CHECK (attempt_ordinal >= 1),
  transport_request_id TEXT NOT NULL,
  phase TEXT NOT NULL ${PHASE},
  outcome TEXT NOT NULL CHECK (outcome IN ('NOT_SENT','REJECTED_LOCALLY','SENT_RESPONSE_RECEIVED','SENT_OUTCOME_UNKNOWN','RECONCILED')),
  timer_canonical INTEGER NOT NULL CHECK (timer_canonical IN (0,1)),
  virtual_start_ms INTEGER,
  virtual_end_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  FOREIGN KEY (run_operation_id, session_id) REFERENCES run_operations(run_operation_id, session_id),
  UNIQUE (run_operation_id, attempt_ordinal),
  UNIQUE (session_id, transport_request_id)
) STRICT;
CREATE TRIGGER attempts_outcome_forward BEFORE UPDATE ON attempts
WHEN NEW.attempt_id IS NOT OLD.attempt_id OR NEW.run_operation_id IS NOT OLD.run_operation_id
  OR NEW.transport_request_id IS NOT OLD.transport_request_id OR NEW.phase IS NOT OLD.phase
  OR NEW.attempt_ordinal IS NOT OLD.attempt_ordinal OR NEW.fencing_epoch IS NOT OLD.fencing_epoch
  OR NOT (
    NEW.outcome = OLD.outcome
    OR (OLD.outcome = 'NOT_SENT' AND NEW.outcome IN ('REJECTED_LOCALLY','SENT_RESPONSE_RECEIVED','SENT_OUTCOME_UNKNOWN'))
    OR (OLD.outcome = 'SENT_OUTCOME_UNKNOWN' AND NEW.outcome IN ('SENT_RESPONSE_RECEIVED','RECONCILED'))
  )
BEGIN SELECT RAISE(ABORT, 'RS_IMMUTABLE_RECORD'); END;
CREATE TRIGGER attempts_no_delete BEFORE DELETE ON attempts
BEGIN SELECT RAISE(ABORT, 'RS_IMMUTABLE_RECORD'); END;

CREATE TABLE proxy_exchanges (
  exchange_id TEXT PRIMARY KEY,
  build_revision_id TEXT NOT NULL,
  gate_run_id TEXT NOT NULL,
  case_run_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  run_operation_id TEXT REFERENCES run_operations(run_operation_id),
  attempt_id TEXT REFERENCES attempts(attempt_id),
  fencing_epoch INTEGER NOT NULL,
  transport_request_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  phase TEXT NOT NULL ${PHASE},
  method TEXT NOT NULL CHECK (method IN ('GET','POST')),
  route_template TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  request_payload_json TEXT,
  response_status INTEGER,
  response_digest TEXT,
  error_code TEXT,
  credential_attached INTEGER NOT NULL DEFAULT 0 CHECK (credential_attached = 0),
  dns_attempted INTEGER NOT NULL DEFAULT 0 CHECK (dns_attempted = 0),
  upstream_attempted INTEGER NOT NULL DEFAULT 0 CHECK (upstream_attempted = 0),
  virtual_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  UNIQUE (session_id, transport_request_id),
  UNIQUE (session_id, sequence)
) STRICT;
CREATE TRIGGER proxy_exchanges_response_once BEFORE UPDATE ON proxy_exchanges
WHEN OLD.response_status IS NOT NULL
  OR NEW.exchange_id IS NOT OLD.exchange_id OR NEW.session_id IS NOT OLD.session_id
  OR NEW.sequence IS NOT OLD.sequence OR NEW.request_digest IS NOT OLD.request_digest
  OR NEW.transport_request_id IS NOT OLD.transport_request_id OR NEW.phase IS NOT OLD.phase
  OR NEW.run_operation_id IS NOT OLD.run_operation_id OR NEW.attempt_id IS NOT OLD.attempt_id
  OR NEW.fencing_epoch IS NOT OLD.fencing_epoch OR NEW.request_payload_json IS NOT OLD.request_payload_json
BEGIN SELECT RAISE(ABORT, 'RS_IMMUTABLE_RECORD'); END;
CREATE TRIGGER proxy_exchanges_no_delete BEFORE DELETE ON proxy_exchanges
BEGIN SELECT RAISE(ABORT, 'RS_IMMUTABLE_RECORD'); END;

CREATE TABLE lifecycle_events (
  event_id TEXT PRIMARY KEY,
  build_revision_id TEXT NOT NULL,
  gate_run_id TEXT NOT NULL,
  case_run_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  run_operation_id TEXT REFERENCES run_operations(run_operation_id),
  exchange_id TEXT REFERENCES proxy_exchanges(exchange_id),
  fencing_epoch INTEGER NOT NULL,
  sequence INTEGER NOT NULL,
  event_kind TEXT NOT NULL,
  raw_status TEXT,
  normalized_fact TEXT,
  source_kind TEXT NOT NULL,
  payload_digest TEXT,
  scenario_step_id TEXT,
  virtual_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  UNIQUE (session_id, sequence)
) STRICT;

CREATE TABLE effect_interceptor_instances (
  interceptor_instance_id TEXT PRIMARY KEY,
  interceptor_profile_digest TEXT NOT NULL,
  artifact_digest TEXT NOT NULL,
  sandbox_scope_digest TEXT NOT NULL,
  supported_sinks_json TEXT NOT NULL,
  build_revision_id TEXT NOT NULL REFERENCES build_revisions(build_revision_id),
  case_run_id TEXT NOT NULL REFERENCES case_runs(case_run_id),
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  fencing_epoch INTEGER NOT NULL,
  attestation_id TEXT REFERENCES subject_attestations(attestation_id),
  started_at_ms INTEGER NOT NULL,
  teardown_at_ms INTEGER
) STRICT;
CREATE TRIGGER effect_interceptor_instances_guard BEFORE UPDATE ON effect_interceptor_instances
WHEN OLD.teardown_at_ms IS NOT NULL OR NEW.interceptor_instance_id IS NOT OLD.interceptor_instance_id
  OR NEW.attestation_id IS NOT OLD.attestation_id OR NEW.case_run_id IS NOT OLD.case_run_id
BEGIN SELECT RAISE(ABORT, 'RS_IMMUTABLE_RECORD'); END;

CREATE TABLE effect_boundary_observations (
  observation_id TEXT PRIMARY KEY,
  interceptor_instance_id TEXT NOT NULL REFERENCES effect_interceptor_instances(interceptor_instance_id),
  build_revision_id TEXT NOT NULL,
  artifact_digest TEXT NOT NULL,
  policy_digest TEXT NOT NULL,
  manifest_digest TEXT NOT NULL,
  gate_run_id TEXT NOT NULL,
  case_run_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  run_operation_id TEXT REFERENCES run_operations(run_operation_id),
  scenario_revision_id TEXT NOT NULL,
  sink_class TEXT NOT NULL,
  effect_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('ATTEMPTED','BLOCKED','RELEASED')),
  fencing_epoch INTEGER NOT NULL,
  sequence INTEGER NOT NULL,
  virtual_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  UNIQUE (interceptor_instance_id, sequence)
) STRICT;

CREATE TABLE protected_effect_observations (
  observation_id TEXT PRIMARY KEY,
  build_revision_id TEXT NOT NULL,
  gate_run_id TEXT NOT NULL,
  case_run_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  run_operation_id TEXT REFERENCES run_operations(run_operation_id),
  policy_digest TEXT NOT NULL,
  manifest_digest TEXT NOT NULL,
  hook_id TEXT NOT NULL,
  hook_revision TEXT NOT NULL,
  effect_id TEXT NOT NULL,
  effect_type TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('ATTEMPTED','BLOCKED','RELEASED')),
  idempotency_key_digest TEXT NOT NULL,
  fencing_epoch INTEGER NOT NULL,
  sequence INTEGER NOT NULL,
  coverage_classification TEXT NOT NULL CHECK (coverage_classification = 'SUBJECT_REPORTED'),
  result_digest TEXT NOT NULL,
  virtual_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  UNIQUE (session_id, run_operation_id, hook_id, effect_id, action, idempotency_key_digest)
) STRICT;

CREATE TABLE evidence_items (
  evidence_id TEXT PRIMARY KEY,
  integration_revision_id TEXT NOT NULL,
  build_revision_id TEXT NOT NULL,
  artifact_digest TEXT NOT NULL,
  build_attestation_class TEXT NOT NULL,
  case_launch_attestation_id TEXT,
  gate_run_id TEXT NOT NULL,
  case_run_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  scenario_revision_id TEXT NOT NULL,
  effect_coverage_policy_digest TEXT NOT NULL,
  effect_manifest_digest TEXT NOT NULL,
  callsite_inventory_digest TEXT,
  interceptor_instance_id TEXT,
  fencing_epoch INTEGER NOT NULL,
  run_operation_id TEXT REFERENCES run_operations(run_operation_id),
  evidence_class TEXT NOT NULL CHECK (evidence_class IN ('PROVEN','REPORTED','INFERRED','UNKNOWN','UNSUPPORTED','STALE')),
  evidence_scope TEXT NOT NULL CHECK (evidence_scope IN ('SIMULATED_GROUND_TRUTH','PUBLIC_CHAIN_OBSERVATION','PROVIDER_REPORTED','SUBJECT_REPORTED','PRIVATE_NOT_VISIBLE')),
  reasons_json TEXT NOT NULL,
  subject TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  asset_id TEXT,
  amount TEXT CHECK (amount IS NULL OR (amount NOT GLOB '*[^0-9]*' AND length(amount) BETWEEN 1 AND 78 AND (amount = '0' OR substr(amount,1,1) <> '0'))),
  single_use INTEGER NOT NULL CHECK (single_use IN (0,1)),
  payload_digest TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  FOREIGN KEY (session_id, case_run_id, gate_run_id, build_revision_id, artifact_digest)
    REFERENCES sessions(session_id, case_run_id, gate_run_id, build_revision_id, artifact_digest),
  UNIQUE (session_id, sequence)
) STRICT;

CREATE TABLE evidence_allocations (
  allocation_id TEXT PRIMARY KEY,
  evidence_id TEXT NOT NULL UNIQUE REFERENCES evidence_items(evidence_id),
  asset_id TEXT NOT NULL,
  total_amount TEXT NOT NULL,
  partition_digest TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE evidence_allocation_parts (
  allocation_id TEXT NOT NULL REFERENCES evidence_allocations(allocation_id),
  run_operation_id TEXT NOT NULL REFERENCES run_operations(run_operation_id),
  amount TEXT NOT NULL,
  PRIMARY KEY (allocation_id, run_operation_id)
) STRICT;

CREATE TABLE evidence_consumptions (
  consumption_id TEXT PRIMARY KEY,
  evidence_id TEXT NOT NULL REFERENCES evidence_items(evidence_id),
  run_operation_id TEXT NOT NULL REFERENCES run_operations(run_operation_id),
  predicate TEXT NOT NULL,
  allocation_id TEXT REFERENCES evidence_allocations(allocation_id),
  created_at_ms INTEGER NOT NULL,
  UNIQUE (evidence_id, run_operation_id, predicate)
) STRICT;
CREATE TRIGGER evidence_consumptions_single_use BEFORE INSERT ON evidence_consumptions
BEGIN
  SELECT CASE
    WHEN (SELECT single_use FROM evidence_items WHERE evidence_id = NEW.evidence_id) = 1
     AND NEW.allocation_id IS NULL
     AND EXISTS (SELECT 1 FROM evidence_allocations WHERE evidence_id = NEW.evidence_id)
      THEN RAISE(ABORT, 'RS_EVIDENCE_ALREADY_CONSUMED')
    WHEN (SELECT single_use FROM evidence_items WHERE evidence_id = NEW.evidence_id) = 1
     AND NEW.allocation_id IS NULL
     AND EXISTS (SELECT 1 FROM evidence_consumptions
                 WHERE evidence_id = NEW.evidence_id AND run_operation_id <> NEW.run_operation_id)
      THEN RAISE(ABORT, 'RS_EVIDENCE_ALREADY_CONSUMED')
    WHEN NEW.allocation_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM evidence_allocation_parts p JOIN evidence_allocations a USING (allocation_id)
                     WHERE p.allocation_id = NEW.allocation_id AND a.evidence_id = NEW.evidence_id
                       AND p.run_operation_id = NEW.run_operation_id)
      THEN RAISE(ABORT, 'RS_ALLOCATION_INVALID')
  END;
END;

CREATE TABLE invariant_results (
  result_id TEXT PRIMARY KEY,
  integration_revision_id TEXT NOT NULL,
  build_revision_id TEXT NOT NULL,
  artifact_digest TEXT NOT NULL,
  gate_run_id TEXT NOT NULL,
  case_run_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  scenario_revision_id TEXT NOT NULL,
  effect_coverage_policy_digest TEXT NOT NULL,
  effect_manifest_digest TEXT NOT NULL,
  run_operation_id TEXT REFERENCES run_operations(run_operation_id),
  invariant_id TEXT NOT NULL CHECK (invariant_id GLOB 'INV-[0-1][0-9]'),
  verdict TEXT NOT NULL CHECK (verdict IN ('NOT_RUN','PASS','FAIL','REVIEW','UNSUPPORTED')),
  evaluator_revision TEXT NOT NULL,
  evidence_ids_json TEXT NOT NULL,
  missing_predicates_json TEXT NOT NULL,
  reasons_json TEXT NOT NULL,
  fencing_epoch INTEGER NOT NULL,
  result_digest TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  FOREIGN KEY (session_id, case_run_id, gate_run_id, build_revision_id, artifact_digest)
    REFERENCES sessions(session_id, case_run_id, gate_run_id, build_revision_id, artifact_digest),
  UNIQUE (case_run_id, invariant_id, evaluator_revision, run_operation_id)
) STRICT;

CREATE TABLE gate_evaluations (
  gate_evaluation_id TEXT PRIMARY KEY,
  gate_run_id TEXT NOT NULL REFERENCES gate_runs(gate_run_id),
  gate_definition_revision_id TEXT REFERENCES gate_definitions(gate_definition_revision_id),
  identity_json TEXT NOT NULL,
  case_result_digests_json TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('NOT_RUN','PASS','FAIL','REVIEW','UNSUPPORTED')),
  findings_json TEXT NOT NULL,
  decision_digest TEXT NOT NULL UNIQUE,
  enforcement_mode TEXT NOT NULL CHECK (enforcement_mode IN ('LOCAL_ADVISORY','CI_CHECK','REQUIRED_CHECK_UNVERIFIED')),
  created_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE artifact_manifests (
  export_id TEXT PRIMARY KEY,
  gate_evaluation_id TEXT REFERENCES gate_evaluations(gate_evaluation_id),
  session_id TEXT REFERENCES sessions(session_id),
  inclusion_policy_json TEXT NOT NULL,
  privacy_scan_result TEXT NOT NULL,
  included_digests_json TEXT NOT NULL,
  exclusions_json TEXT NOT NULL,
  artifact_ready INTEGER NOT NULL CHECK (artifact_ready IN (0,1)),
  output_digest TEXT,
  retained_path TEXT,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  created_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE imports (
  import_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  origin TEXT NOT NULL CHECK (origin IN ('INSTALLED_ARTIFACT_CAPTURE','USER_FILE')),
  source_session_id TEXT REFERENCES sessions(session_id),
  source_filename TEXT,
  raw_byte_count INTEGER NOT NULL CHECK (raw_byte_count >= 0),
  raw_source_digest TEXT NOT NULL,
  sanitized_json TEXT,
  schema_state TEXT NOT NULL,
  secret_findings_json TEXT NOT NULL,
  determinism_findings_json TEXT NOT NULL,
  provenance_class TEXT,
  state TEXT NOT NULL CHECK (state IN ('CAPTURED_UNTRUSTED','QUARANTINED','SANITIZED','MAPPED','REPLAY_VERIFIED','REVIEWED','PROMOTED','REJECTED','PURGED')),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  created_at_ms INTEGER NOT NULL,
  CHECK (origin <> 'INSTALLED_ARTIFACT_CAPTURE' OR source_session_id IS NOT NULL)
) STRICT;

CREATE TABLE import_mappings (
  mapping_revision_id TEXT PRIMARY KEY,
  import_id TEXT NOT NULL REFERENCES imports(import_id),
  mapping_json TEXT NOT NULL,
  mapping_digest TEXT NOT NULL UNIQUE,
  created_at_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE audit_events (
  audit_id TEXT PRIMARY KEY,
  action_code TEXT NOT NULL,
  subject_kind TEXT NOT NULL,
  subject_id TEXT,
  details_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL
) STRICT;

CREATE INDEX run_operations_by_case ON run_operations(case_run_id);
CREATE INDEX attempts_by_operation ON attempts(run_operation_id);
CREATE INDEX lifecycle_events_by_operation ON lifecycle_events(run_operation_id, sequence);
CREATE INDEX proxy_exchanges_by_operation ON proxy_exchanges(run_operation_id, sequence);
CREATE INDEX case_runs_by_gate_lifecycle ON case_runs(gate_run_id, execution_lifecycle);
${IMMUTABLE_TABLES.map(immutableTriggers).join('\n')}
`;
