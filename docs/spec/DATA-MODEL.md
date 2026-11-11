---
project: RouteSpec
version: 2.0.0
artifact_status: SPECIFICATION_ONLY
product_runtime_status: NOT_RUN
schema_status: PROPOSED
updated_at: 2026-11-11
---

# Data model

## 1. Storage principles

- SQLite is the proposed local store; the logical model is authoritative, not a specific ORM.
- IDs are opaque UUIDs. User labels are not identity.
- Immutable revisions are insert-only.
- Subject build/artifact, gate-run, case-run, session, run-operation, effect-policy/manifest, selected inventory/interceptor, and fencing-epoch identity is mandatory on runtime evidence and results where applicable; a display label or caller assertion never substitutes for those foreign keys.
- Raw provider observations, normalized facts, evidence classifications, and evaluator results are separate entities.
- Evidence class, evidence scope, evidence reason, provider fact, and live-probe result are separate axes/entities.
- Amounts use base-unit decimal strings plus asset identity.
- Virtual time and wall time are separate.
- Secrets are not a database field type and must never be persisted.
- Large reviewed payloads are content-addressed after redaction. Raw unreviewed import bytes are never copied into RouteSpec persistence; only a sanitized quarantine representation, source digest, bounded metadata, and secret-finding categories/paths may persist.
- Deletes are explicit local user actions with a dry-run dependency plan.

## 2. Core entities

### `projects`

| Field | Constraint |
|---|---|
| `project_id` | primary key |
| `name` | required, local display value |
| `description` | bounded optional text |
| `retention_policy_json` | validated structured policy |
| `created_at` | UTC wall time |
| `deleted_at` | nullable tombstone until purge completes |

### `integration_revisions`

| Field | Constraint |
|---|---|
| `revision_id` | primary key |
| `project_id` | foreign key |
| `revision_label` | required display label |
| `commit_sha` | nullable; validated opaque string |
| `configuration_digest` | required |
| `protocol_profile_id` | required foreign key |
| `metadata_json` | bounded scalar-only map |
| `identity_digest` | unique within project |
| `created_at` | immutable |

There is no update operation for economic identity fields.

### `build_revisions`

Stores `build_revision_id`, project/integration revision, exact repository locator, commit SHA, dirty-tree digest, built-artifact digest, toolchain/lock digests, required effect-manifest digest, optional CI workflow/run identity, declared launch-recipe digest, immutable build identity digest, and the permanent registration claim `USER_ASSERTED_LOCAL`. The row is insert-only and never acquires an attestation state. Trusted identity exists only in separate immutable `subject_attestations` records selected by a GateRun; registration neither runs nor verifies a build and cannot support a verified-build claim.

### `launcher_challenges` and `subject_attestations`

`attester_principals` stores kind (`LOCAL_LAUNCHER_KEY` or `CI_OIDC`), reviewed launcher artifact/public-key identity or pinned OIDC issuer/signing-key policy, audience, repository/workflow/ref/subject claim policy, token/key freshness limits, owner-only enrollment record, policy digest, enabled state, monotonic revocation epoch, and validity window. `attester_revocations` is append-only. Only authenticated control-plane administration with explicit local confirmation may enroll/disable/revoke; a case token has no access.

`launcher_challenges` has scope `BUILD_REGISTRATION`, `CASE_LAUNCH`, `EFFECT_INVENTORY`, or `EFFECT_INTERCEPTOR_LAUNCH`, an enabled principal ID/policy/revocation epoch, nonce digest, issue/expiry, and single-use state. Build registration binds project/build/artifact/lock/toolchain/effect-manifest/adapter identity. Case launch additionally binds selected build attestation, gate/case/session/client/fencing identity. Inventory scope binds the pinned analyzer and inventory digest to those exact build inputs. Interceptor scope binds reviewed interceptor artifact/profile, sandbox/process-tree/sink coverage, gate/case/session/fencing identity, and private-channel peer. `subject_attestations` stores consumed challenge, principal/policy/revocation epoch, verified signature or CI claims digest, scope-specific independently observed digests, verification/freshness/expiry, launch/teardown evidence, result, and immutable attestation digest. No completion mutates build/GateRun. Stale keys/claims, disabled/revoked principal, mismatch, expiry, replay, or concurrent completion is rejected; revocation during an in-progress required run yields REVIEW.

### `protocol_profiles`

Stores profile ID/revision, exact official SDK commit/version, versioned actual-client adapter revision, route schemas, material-field registry with each field classified as quote-request-known, quote-response-assigned, commit material, or reconciliation-only, the seven known raw statuses and raw-to-normalized status map, stable-header/correlation/retry/expiry/teardown contract, dry-probe allowlist, and integrity digest. Unknown status/material fields fail closed. The actual JWT is never present.

### `effect_manifests`, `effect_manifest_hooks`, and `effect_coverage_policies`

Stores immutable manifest ID/digest bound to the subject build/artifact and adapter revision. Each hook row declares hook ID/revision, effect type, source locator digest where attestable, instrumentation mechanism, required scenario/capability selectors, and coverage expectation. A scenario resolves its required sink/hook set before execution. `effect_coverage_policies` bind one exact build/artifact/attestation, scenario, manifest, required sink classes, interceptor profile, optional trusted call-site inventory, and one closed basis: `INDEPENDENT_BOUNDARY_INTERCEPT`, `TRUSTED_BUILD_INVENTORY_PLUS_INTERCEPT`, or `DECLARED_HOOKS_ONLY`. Subject-only declarations remain `SELF_REPORTED`; they never become coverage proof.

### `effect_callsite_inventories`, `effect_interceptor_instances`, and `effect_boundary_observations`

`effect_callsite_inventories` are immutable outputs of a pinned compiler/plugin or binary scanner executed by the enrolled launcher or CI principal over the exact source/build/artifact inputs. They bind analyzer identity/digest, build/artifact/manifest, enumerated call sites and sink classes, unsupported dynamic/reflection/native findings, issuance/freshness, attestation, and inventory digest. A caller-uploaded list is `DECLARED_HOOKS_ONLY`; unresolved or unsupported analysis cannot support completeness.

`effect_interceptor_instances` identify an independently launched boundary interceptor outside the subject, its reviewed artifact/profile digest, OS/container sandbox and process-tree scope, supported sink classes, build/case/session/epoch binding, startup/teardown evidence, and trust-root attestation. `effect_boundary_observations` record intercepted `ATTEMPTED`, `BLOCKED`, or `RELEASED` actions with exact interceptor, build/artifact/attestation, policy/manifest/inventory, gate/case/session/run-operation/scenario, sink/effect, epoch, sequence, and time. Only this independently authenticated channel may write those rows; a case token or subject process cannot. Missing full boundary scope, missing teardown, or a sink outside the interceptor profile downgrades the case to REVIEW. No test interceptor may execute a real downstream effect.

### `scenario_revisions`

Stores scenario stable ID, immutable revision ID, schema version, canonical compiled JSON, seed, resource budget, provenance class, source locator after redaction, review status, compiler revision, and revision digest.

Allowed provenance classes:

- `SYNTHETIC`
- `OFFICIAL_SPEC_DERIVED`
- `ISSUE_DERIVED_NOT_REPRODUCED`
- `INDEPENDENTLY_REPRODUCED`
- `CUSTOMER_PROVIDED_REDACTED`
- `DISPUTED_AMBIGUITY_CASE`

### `corpus_revisions`

Stores immutable corpus identity, label, created time, and digest. `corpus_cases` pins ordered scenario revision IDs, required invariant IDs, severity, and gate policy. Removing or changing a case creates a new corpus revision.

### `gate_runs`

Stores immutable gate-run ID, gate-definition revision, project/integration revision, mandatory build revision/artifact and the exact pre-existing build-registration attestation digest/state (or explicit `USER_ASSERTED_LOCAL`), corpus revision, exact ordered case set, protocol/profile/adapter/evaluator/proxy/schema/configuration identities, effect-manifest and effect-coverage-policy digests, selected call-site-inventory/interceptor-profile digests when applicable, bounded parallelism, `execution_lifecycle`, started/closed times, separate aggregate verdict, and aggregate digest. Per-case subject/interceptor launch attestations link separately and cannot mutate this selection. A changed selection requires a new gate run.

### `case_runs`

Stores case-run ID, gate-run ID, case ordinal, scenario revision, required invariants/effect sinks/hooks, lineage role (`BASELINE`, `CORRECTED`, `REPLAY`, or `PROMOTED_REGRESSION`), client-instance digest, adapter revision, case-launch-attestation ID/state, interceptor-launch-attestation ID/state when selected, coverage-basis/result, reset-contract digest/result, `execution_lifecycle`, separate verdict, current fencing epoch, active-token digest nullable, lease fields, session ID, terminal result digest, and subject/interceptor teardown evidence. A unique `(gate_run_id, case_ordinal)` prevents replacement. Every required case gets one isolated run; bounded workers may execute cases concurrently but never share a token, client instance, session, launch attestation, interceptor instance, or unproven mutable state.

### `case_tokens` and `token_revocations`

Stores only token digests, bound build/artifact, gate/case/session/client/adapter identities, allowed phase set, fencing epoch, issuance/expiry/use/revocation data, and token purpose (`EXECUTION` or `RECONCILIATION_ONLY`). Revocation is append-only. A recovery token can call only status/reconciliation surfaces and can never quote-finalize or commit. Token reuse across a case, build, epoch, or concurrent client fails closed.

### `sessions`

| Field | Constraint |
|---|---|
| `session_id` | primary key |
| `project_revision_id` | required |
| `build_revision_id`, `subject_artifact_digest`, `subject_attestation_id` | required; exact subject identity |
| `gate_run_id`, `case_run_id`, `scenario_revision_id` | required and mutually consistent foreign keys |
| `case_launch_attestation_id` | nullable only for explicitly user-asserted execution; trusted-run predicates require it |
| `corpus_revision_id` | required through the gate run |
| `adapter_revision`, `effect_manifest_digest`, `effect_coverage_policy_digest` | required |
| `effect_callsite_inventory_digest`, `effect_interceptor_instance_id` | nullable only when the selected basis does not require them |
| `mode` | enum |
| `evaluator_revision` | required |
| `configuration_digest` | required |
| `execution_lifecycle` | shared lifecycle enum; session begins `READY` |
| `verdict` | separate nullable value until evaluation closes |
| `seed` | required deterministic value |
| `next_sequence` | monotonic integer |
| `lease_owner_digest` | nullable; never clear token |
| `lease_expires_at` | nullable |
| `lease_fencing_epoch` | monotonically increasing integer checked by every session/execution-owned mutating transaction |
| `started_at`, `closed_at` | nullable wall times |
| `result_digest` | nullable until terminal evaluation |

### `logical_jobs`

Stores a subject-supplied stable `logical_job_key_digest` under the project revision plus safe display metadata. It is correlation only and owns no mutable economic state or finalization. The same logical job may appear across baseline, corrected, replay, and promoted cases.

### `run_operations`

Stores `run_operation_id`, project/integration/build/artifact/gate-run/case-run/session IDs, logical job ID, adapter/profile/effect-policy/manifest and selected inventory/interceptor identities, fencing epoch, current phase, quote-request digest and canonical JSON, quote-finalization digest and response-assigned JSON nullable, commit-binding digest and canonical material nullable, reconciliation summary, creation/finalization/commit sequences, and normalized outcome. Quote-request fields include deposit type but prohibit an assigned deposit address. Quote finalization atomically writes quote/correlation identity, returned constraints, assigned deposit address, and classified response extensions. Commit binding atomically writes method/route, canonical body/material digest, finalized quote digest, assigned deposit address, and transaction/signed-material digest. Unknown fields, partial writes, changed repeats, concurrent second commits, and phase regressions are rejected.

Unique constraints:

- `(project_revision_id, build_revision_id, gate_run_id, case_run_id, logical_job_id)` maps to exactly one run operation;
- quote and commit digests within the run operation are immutable after first atomic binding;
- a logical job reused in another build/gate/case creates another run operation and never merges evidence.

### `run_operation_lineage`

Links two run operations with a closed relation enum (`BASELINE_OF`, `CORRECTION_OF`, `REPLAY_OF`, `PROMOTED_FROM`) and immutable lineage digest. Lineage provides comparison only; it never permits state/evidence reuse.

### `quote_finalizations` and `commit_bindings`

Each is a one-to-one immutable row for a run operation. `quote_finalizations` stores the response correlation/quote identity, response digest, returned constraints, response-assigned deposit address, extensions, and sequence. `commit_bindings` stores method/route, canonical body/material digest, quote-finalization digest, assigned-deposit-address digest, transaction/signed-material digest, first attempt, and sequence. Database checks prevent a commit without finalized quote identity and prevent a request-known deposit address. Conflict rows record safe error codes only and cannot mutate either binding.

### `attempts`

Stores run operation, build/gate/case/session and fencing epoch, attempt ordinal, transport request ID, operation phase, attempt kind, sent/observed state, start/end virtual time, wall time, timer canonicality, outcome certainty, and related exchange IDs. Transport request ID is neither a logical job nor run-operation identity. `(run_operation_id, attempt_ordinal)` and `(session_id, transport_request_id)` are unique.

### `proxy_exchanges`

Stores exact build/gate/case/session/run-operation/fencing identity, transport request ID, session sequence, phase, method, route template, redacted header/body digests, bounded redacted payload references, response/error code, credential/DNS/upstream-attempted booleans, virtual/wall timing, and attempt relation. RouteSpec-local headers plus raw provider authorization are prohibited in stored payloads and stripped before any live upstream boundary.

### `lifecycle_events`

Append-only ordered events with build/gate/case/session/run-operation/fencing identity, sequence, event kind, raw status where applicable, normalized fact kind, virtual/wall time, source kind, payload digest, and scenario step ID.

Raw provider observation and normalized fact are either separate rows or separately typed fields with an immutable derivation link. They are never overwritten.

### `evidence_items`

Stores evidence ID, mandatory project/integration/build/artifact/build-attestation/case-launch-attestation/gate/case/session/scenario/effect-policy/manifest/fencing identities, optional inventory/interceptor identity where applicable, run operation nullable where case-wide, class, scope, optional reason code such as `NOT_VISIBLE`, subject, source kind, redacted locator, observed/collected time, freshness policy, payload digest/reference, integrity state, and exclusion reason. An index supports `(run_operation_id, subject, class, scope)`. Provider facts, subject self-reports, independent boundary observations, coverage findings, and probe results are separately typed and cannot overwrite each other.

### `protected_effect_observations`

Stores observation ID, project/integration/build/artifact/gate/case/session/run-operation, effect-policy/manifest/hook ID and revision, effect ID/type, action (`ATTEMPTED`, `BLOCKED`, `RELEASED`), idempotency-key digest, fencing epoch, virtual time nullable, wall time, sequence, coverage classification, and result digest. The unique key covers the full identity plus idempotency digest; exact retries return the original observation and changed/stale bindings fail closed. This table is explicitly `SUBJECT_REPORTED` correlation, never proof of complete instrumentation and never authority to drive a downstream effect. Independent interceptor data is stored only in `effect_boundary_observations`.

### `evidence_consumptions`

Maps evidence ID to operation/invariant predicate. A uniqueness constraint prevents a single-use proof from satisfying multiple operations. Explicit aggregate allocation requires allocation ID and amount partition.

### `invariant_results`

Stores mandatory project/integration/build/artifact/build-attestation/case-launch-attestation/gate/case/session/scenario/effect-policy/manifest/fencing identities, optional selected inventory/interceptor identities, run operation nullable, invariant ID, verdict (`PASS`, `FAIL`, `REVIEW`, `NOT_RUN`, `UNSUPPORTED`), evaluator revision, ordered fact/evidence IDs, missing predicate/effect coverage and evidence reason codes, explanation/remediation codes, and result digest. Results are immutable for an evaluator snapshot and reject any foreign-key identity mismatch. A complete-effect PASS has a foreign-key-valid independent interceptor instance/attestation and complete boundary observations; inventory or subject reports alone cannot satisfy it.

### `imports`

Stores capture/import ID, origin (`INSTALLED_ARTIFACT_CAPTURE` or `USER_FILE`), mandatory source build/gate/case/session/run identity for installed captures, source filename after sanitization when applicable, raw-source byte count and digest, sanitized normalized content, schema state, secret-finding categories/counts, nondeterminism/unresolved-material findings, provenance selection, quarantine/mapping/review/promotion state, and purge state. It stores neither raw source bytes nor detected secret values. A blocked secret-bearing import retains only digest and safe finding metadata, not sanitized content that could contain an unrecognized copy.

### `import_mappings`

Immutable review revisions mapping imported fields/events to normalized facts, run-operation phases, and required effect coverage. Promotion references one exact mapping revision, secret-scan revision, determinism report, reviewer-local confirmation record/digest, produced scenario revision, and new corpus revision. Existing scenario/corpus identities are never overwritten.

### `gate_definitions`

Stores gate ID, project ID, name, pinned corpus revision, required invariant policy, stale-result policy, requested artifact policy, desired enforcement mode, and immutable revision. It does not configure repository settings.

### `gate_evaluations`

Stores gate-run ID, gate definition revision, integration/build/artifact/attestation, corpus/evaluator/profile/adapter/proxy/schema/config/effect-policy/manifest/inventory/interceptor identities, ordered exact case-run/result IDs, fencing epochs, decision, incomplete/missing/coverage findings, independent `artifact_ready` boolean, and enforcement mode. Allowed enforcement is `LOCAL_ADVISORY`, `CI_CHECK`, or `REQUIRED_CHECK_UNVERIFIED`; no repository-settings verification evidence or blocking claim exists in v2. Decision persistence never depends on artifact generation.

### `artifact_manifests`

Stores export ID, gate/session reference, inclusion policy, privacy-scan result, included object digests, exclusion declarations, output digest after write, checksum manifest, and local path only when the user opts to retain it. No upload URL or signature is implied.

### `audit_events`

Stores local administrative actions such as setting change, import promotion, export write, deletion plan/confirmation, and credential connect/disconnect. Details are coded and redacted. Test traffic remains in the session journal, not this audit table.

## 3. Canonical identities

### Integration revision digest

Pure function of project ID, revision label, optional commit SHA, configuration digest, protocol profile revision, and bounded metadata.

### Scenario revision digest

Pure function of schema version, compiled canonical scenario, seed, resource budget, provenance metadata, and compiler major revision.

### Result digest

Pure function defined by `INV-09`, including project/integration/build/artifact/attestation, gate run, case run, session, scenario/corpus, logical/run-operation lineage, effect policy/manifest/inventory/interceptor, profile/adapter/evaluator/configuration, fencing epoch, and canonical ordered facts/evidence. Wall-clock start/end, host name, local file path, and display labels are excluded and stored in a run envelope.

### Gate evaluation digest

Includes all identities in `INV-12`, ordered case result digests, decision, and missing/review findings. `artifactReady` and enforcement records have separate digests and cannot alter the decision digest.

## 4. State constraints

### Shared execution lifecycle

All GateRun, CaseRun, and session rows use exactly one lifecycle enum: `PENDING | DRAFT | VALIDATING | READY | RUNNING | RECOVERY_REQUIRED | EVALUATING | COMPLETED | ABORTED | ERROR`. Verdict is stored separately and is never a lifecycle value.

### Gate-run transitions

Allowed:

- `DRAFT -> VALIDATING | ABORTED | ERROR`
- `VALIDATING -> READY | ABORTED | ERROR`
- `READY -> RUNNING | ABORTED | ERROR`
- `RUNNING -> EVALUATING | RECOVERY_REQUIRED | ABORTED | ERROR`
- `RECOVERY_REQUIRED -> RUNNING | EVALUATING | ABORTED | ERROR`
- `EVALUATING -> COMPLETED | ERROR | RECOVERY_REQUIRED`

A gate run cannot receive verdict PASS until every required case has lifecycle COMPLETED and verdict PASS. FAIL dominates; otherwise any incomplete/aborted/error/recovery-pending case aggregates REVIEW. Zero started cases evaluates to lifecycle COMPLETED with verdict NOT_RUN.

### Case-run/session transitions

Allowed:

- CaseRun: `PENDING -> VALIDATING -> READY`; session begins `READY`.
- `READY -> RUNNING | ABORTED | ERROR`
- `RUNNING -> EVALUATING | ABORTED | ERROR | RECOVERY_REQUIRED`
- `RECOVERY_REQUIRED -> RUNNING | EVALUATING | ABORTED | ERROR`
- `EVALUATING -> COMPLETED | ERROR | RECOVERY_REQUIRED`

Terminal lifecycle states are immutable. Recovery first revokes the stale execution token and increments the fencing epoch; `RECOVERY_REQUIRED -> RUNNING` permits only reconciliation-scoped reads under a newly issued token, not another quote finalization or commit. ABORTED/ERROR required cases have separate REVIEW verdict unless a proven FAIL dominates the gate.

### Import transitions

`CAPTURED_UNTRUSTED -> QUARANTINED -> SANITIZED -> MAPPED -> REPLAY_VERIFIED -> REVIEWED -> PROMOTED`

Any stage may move to `REJECTED` or `PURGED`. Secret-bearing, nondeterministic, unresolved, unreviewed, or identity-mismatched captures cannot promote. Only `REVIEWED` can promote, and promotion atomically creates a new immutable scenario revision plus new corpus revision. Promotion does not delete the sanitized quarantine record; the external raw source remains outside RouteSpec throughout.

## 5. Transaction boundaries

- Every mutation enters one in-process writer queue/connection and opens the documented explicit transaction mode. Session/execution-owned mutations compare build/artifact/gate/case/client/token identity and the caller's lease fencing epoch with current rows before writing. Administrative, project, import, and export mutations instead require an idempotency key plus expected optimistic revision and do not require a session lease.
- Creating a gate run, its exact ordered case runs, resolved effect policy/manifest/inventory/interceptor requirements, and bounded-parallelism policy is one transaction.
- Issuing a case token requires the active case lease and stores only its digest. Recovery revokes the old token and increments the epoch before a reconciliation-only token can issue; no second commit path is opened.
- Appending a proxy exchange, related lifecycle event, and sequence advancement is one transaction.
- Creating a run operation from quote-request-known fields excludes an assigned deposit address and is atomic under its case/build/logical-job unique scope.
- Validating and atomically assigning the complete quote finalization—quote/correlation identity and digest, returned-amount constraints, response-assigned deposit address, and extensions—is one transaction. Partial assignment writes nothing; exact repetition is read-idempotent; changed/concurrent re-finalization is rejected.
- Validating and atomically assigning the first commit binding—method/route, canonical body/material digest, finalized quote, assigned deposit address, and transaction/signed-material digest—is a separate one-time transaction. Exact transport retry joins; changed, concurrent, stale-epoch, or second commit is rejected before mutation.
- Persisting all invariant results and changing a case to terminal is one transaction over a fenced stable snapshot. Aggregating the gate is a later transaction that verifies all exact case identities and incompleteness rules.
- Creating a corpus revision and its pinned ordered cases is one transaction.
- Creating a gate evaluation and its case links is one transaction.
- Persisting a gate decision is independent from writing an artifact manifest; artifact failure updates `artifactReady` without changing the decision.
- Deletion plan generation is read-only; confirmed purge is a separate transaction/batch with resumable audit state.

SQLite uses foreign keys, WAL, documented `busy_timeout`, and an explicit synchronous setting whose durability limitations are stated. Checkpoint and verified backup operations have bounded schedules. `SQLITE_FULL`, checkpoint failure, or backup failure prevents acknowledgement of affected writes, records a safe local diagnostic when possible, and enters RECOVERY_REQUIRED/REVIEW without silently lowering durability.

## 6. Retention and deletion

Proposed safe defaults:

- Rejected-import digests and finding metadata: purge within 24 hours unless the user explicitly retains the non-content audit record.
- Reviewed local traces/scenarios: retain until user deletion.
- Session event payloads: metadata retained; large redacted payloads use configurable 30-day default.
- Gate manifests/results: retain until project deletion.
- Credentials: never retained.

The UI must show estimated records/bytes before deletion. Project deletion does not delete source repositories, CI artifacts outside RouteSpec's data directory, or upstream provider records.

## 7. Redaction model

Redaction and secret blocking occur before any content persistence and use:

1. semantic field rules (`authorization`, token, signed payload, private key, cookie);
2. configured secret-value matching in memory;
3. high-confidence pattern detectors;
4. size and binary guards;
5. review warnings for addresses and transaction identifiers that are not secrets but may be sensitive.

Redaction records category, location path, action, and rule revision—not the removed value. The database shall reject known secret-field types at repository boundaries as defense in depth.

## 8. Migrations

- Schema migration files are ordered, checksummed, and transactional.
- Startup checks database application/schema major compatibility before opening a writable service.
- Unknown newer schema opens read-only recovery/export mode or stops; it never guesses.
- Destructive migrations require a verified local backup and an explicit versioned migration plan.
- Evaluator semantic changes never rewrite prior results; they create new results under a new evaluator revision.

## 9. Query patterns

- Release page: local project/revision/subject-build/attestation/gate-run/corpus matrix with decision, artifact readiness, enforcement mode, and a separate official-endpoint compatibility axis.
- Gate-run page: bounded worker progress, isolated case rows, per-case client/token/epoch/reset state, incomplete/recovery findings, and aggregate verdict.
- Session page: exact build/gate/case identity plus sequence-paginated events and invariant summary.
- Operation page: logical-job lineage -> run-operation phases -> quote finalization -> commit binding -> attempts -> exchanges -> raw statuses -> normalized facts -> protected-effect observations/coverage -> evidence class/scope/reason -> invariant results.
- Regression page: installed-artifact capture, quarantine/sanitization/mapping/review/promotion lineage, deterministic replay history, new scenario/corpus identities, and corrected-client rerun.
- Privacy page: retention estimates, quarantine state, export findings, and deletion plans.

Every query is scoped by local project and uses bounded pagination. Search never returns raw credentials or excluded payloads.

