---
project: RouteSpec
version: 2.0.0
artifact_status: SPECIFICATION_ONLY
product_runtime_status: NOT_RUN
contract_authority: true
updated_at: 2026-11-11
---

# RouteSpec core contract

This file is the implementation-facing contract for requirement meaning. Definitions below are copied exactly from the authoritative first paragraph in PRD.md and mirrored in requirements.json. A module may strengthen implementation detail but must not weaken, reinterpret, or silently waive a definition.

## Global execution contract

- The pack and every module begin SPECIFICATION_ONLY and NOT_RUN.
- SIMULATE and REPLAY run in a networkless scenario runtime that may model mutation-shaped requests locally; LIVE_DRY_PROBE runs in a separately launched adapter and denies mutations before provider credentials, DNS, or sockets.
- Deterministic code owns evaluation and release decisions; optional model text is non-authoritative.
- Execution state, verdict, evidence class, evidence scope/reason, artifact readiness, and enforcement mode remain separate. Missing, private, contradictory, stale, unsupported, or unverified required evidence cannot become PASS.
- Clients use distinct local session authentication and provider Authorization is stripped. Provider credentials exist only in live-dry adapter memory after policy and never cross persistence, logs, UI, exports, CI artifacts, or child-process arguments.
- Every implementation module uses failure-first TDD, records exact commands/exit codes/test counts/redacted evidence, and stops on a broken dependency or safety boundary.
- Local commits may be focused and reviewable when the user invokes implementation. Push, PR creation, merge, deployment, credential registration, paid calls, wallet signing, publication, and contest submission require separate matching authorization.

## Functional requirements

### FR-01 — Project and revision identity

The system shall register a project, immutable integration revision, and immutable mandatory subject build revision. The build revision binds source revision, configuration digest, artifact digest, dependency-lock digest, toolchain identity, effect-instrumentation-manifest digest, and an initial `USER_ASSERTED_LOCAL` registration claim; it is never upgraded or rewritten. A separate immutable attestation record may have class `TRUSTED_LAUNCHER` or `CI_ATTESTED` only when a single-use challenge is completed by an enabled attester principal whose local launcher key or CI OIDC issuer, audience, repository, workflow, ref, and subject policy was explicitly enrolled through the control plane. The verifier shall check signature, claims, freshness, revocation epoch, artifact/manifest digests, and challenge scope. Every gate run selects one exact attestation record or the user-asserted claim, and each case binds a separate launch attestation to the selected build. Every session, run operation, exchange, evidence item, effect observation, evaluation, export, and gate decision shall reference that exact build and attestation lineage. Local self-assertion, stale or revoked principals, swapped artifacts, challenge/token reuse, and concurrent subject clients fail closed and cannot be labelled verified.

Owners: M00, M01, M08.

### FR-02 — Local control plane

The system shall expose a loopback-bound authenticated local control API and CLI for project, scenario, session, regression, release-gate, export, and settings operations. Remote binding is unsupported unless a later reviewed security decision adds it.

Owners: M00, M02, M08.

### FR-03 — 1Click-compatible proxy

The system shall implement the declared 1Click paths used by an exact pinned official SDK and a versioned actual-client adapter/middleware contract. The adapter shall supply stable session, gate-run, case-run, logical-job, and transport identities; preserve the proxy-assigned run-operation identity across quote finalization, commit, internal retry, and status calls; enforce expiry and teardown; and strip every RouteSpec-local header before any upstream boundary. The SDK base URL shall target the local proxy, and unsupported or uncorrelated paths, schema versions, concurrent subject clients, and adapter/profile mismatches shall return typed fail-closed responses rather than pass through implicitly.

Owners: M00, M02, M07.

### FR-04 — Execution modes

The system shall run `SIMULATE` and `REPLAY` in a networkless scenario runtime that may accept mutation-shaped requests only as local test inputs and can never attach provider credentials or contact an upstream, while `LIVE_DRY_PROBE` runs in a separately launched egress-capable adapter. Mode is immutable once a session starts, and the live-dry adapter shall reject every committed or fund-moving request before provider credential attachment, DNS resolution, or socket creation.

Owners: M02, M07, M11.

### FR-05 — Scenario definitions

The system shall validate versioned declarative scenarios that define initial state, ordered triggers, bounded delays, provider responses, transport failures, ground-truth lifecycle events, expected outcomes, and forbidden client behaviors. Scenario files shall not contain executable code.

Owners: M03, M05.

### FR-06 — Deterministic fault scheduling

Given the same scenario revision, seed, evaluator revision, and client interaction sequence, the scheduler shall reproduce proxy-controlled schedules, barriers, response drops, connection outcomes, normalized events, and virtual timestamps. Client timer behavior is canonical only when the client uses an injected clock or transport; uncontrolled external wall-clock timers shall be labelled noncanonical REVIEW evidence rather than claimed deterministic.

Owners: M03.

### FR-07 — Durable operation journal

Every gate run, case run, logical job, run operation, attempt, proxy exchange, lifecycle event, evidence item, effect observation, evaluation, and gate decision shall be persisted transactionally with monotonic sequence numbers and mandatory subject-build identity. Each case run owns a unique expiring client token and isolated operation namespace; bounded parallelism is allowed only across distinct case runs. Crash, cancellation, or interruption shall enter `RECOVERY_REQUIRED`, revoke the stale token, increment the fencing epoch, and resume only through a read-only reconciliation-scoped token before evaluation. Incomplete required case runs aggregate to REVIEW, while zero started required cases remains NOT_RUN.

Owners: M01, M02, M06.

### FR-08 — Exact operation binding

The system shall distinguish a cross-run `logicalJobId` from a `runOperationId` scoped to project revision, subject build revision, gate run, case run, and logical job. Baseline, corrected, replay, and imported runs remain isolated operations connected only by typed lineage. Within one case run, exact retries join the same run operation; reuse across a different case/build/run or with changed material fails closed. The versioned profile shall model four phases: `QUOTE_REQUEST`, `QUOTE_FINALIZATION`, `COMMIT_MUTATION`, and `READ_ONLY_RECONCILIATION`. Quote-request fields are immutable and never include a deposit address; the first complete quote response atomically binds quote/correlation identity, returned constraints, assigned deposit address, and response extensions. The first commit mutation then atomically binds method/route, body/material digest, finalized quote, deposit address, and transaction or signed-material digest. Exact repeats are idempotent; partial, changed, concurrent, second-commit, unknown-material, or phase-invalid writes fail without rewriting history. Reconciliation may use the already bound deposit address only as derived identity and can never create another mutation.

Owners: M00, M01, M04.

### FR-09 — Deterministic invariant evaluation

The system shall evaluate `INV-01`–`INV-12` without an LLM. Each result shall bind subject build, gate run, case run, run operation, scenario, profile, evaluator, and fencing epoch and shall include a verdict from `PASS`, `FAIL`, `REVIEW`, `NOT_RUN`, or `UNSUPPORTED`; observed and missing facts; evidence IDs with separate class, scope, and reason; and an actionable deterministic explanation. A required effect-coverage policy shall bind the exact build/artifact/attestation, scenario, manifest, required sink classes, and one basis: `INDEPENDENT_BOUNDARY_INTERCEPT`, `TRUSTED_BUILD_INVENTORY_PLUS_INTERCEPT`, or `DECLARED_HOOKS_ONLY`. A complete-effect PASS requires an independently controlled runtime boundary interceptor outside the subject; a trust-root-attested build-time call-site inventory may strengthen coverage identity but never replaces runtime interception. Subject observer records are `SUBJECT_REPORTED` correlation only. `DECLARED_HOOKS_ONLY`, a missing/mismatched/forged/stale inventory or interceptor, an unsupported dynamic call site, or an unobserved required sink yields REVIEW unless independent ground truth already proves a violation and FAIL.

Owners: M04.

### FR-10 — Evidence classification

Evidence shall record a class (`PROVEN`, `REPORTED`, `INFERRED`, `UNKNOWN`, `UNSUPPORTED`, or `STALE`), an independent scope (`SIMULATED_GROUND_TRUTH`, `PUBLIC_CHAIN_OBSERVATION`, `PROVIDER_REPORTED`, `SUBJECT_REPORTED`, or `PRIVATE_NOT_VISIBLE`), and optional reason codes such as `NOT_VISIBLE`; a reason is never a verdict. Provider facts, subject self-reports, effect-coverage records, and live-probe compatibility results shall remain separate records. Only a predicate's declared acceptable class and scope may satisfy it; self-report cannot prove complete instrumentation, and private, missing, stale, unsupported, identity-mismatched, or partial evidence yields REVIEW unless a proven violation already yields FAIL.

Owners: M04, M05, M07.

### FR-11 — Capture-to-regression workflow

The installed product shall capture a real client trace into quarantine, stream-hash and secret-scan it before persistence, sanitize active/sensitive content, validate schema/resource bounds and determinism, show raw-to-normalized mapping plus unresolved facts, require explicit local review, and promote only an accepted immutable regression revision. Secret-bearing, nondeterministic, identity-mismatched, unresolved, or unreviewed traces remain rejected or quarantined and can never enter a required corpus. Promotion creates a new corpus identity; the corrected client must rerun that exact promoted regression through the normal proxy/journal/evaluator path.

Owners: M05.

### FR-12 — Regression corpus management

The system shall version corpora, pin scenario revisions, detect changed or removed cases, and retain prior corpus identities. A release gate must never silently follow a mutable “latest” corpus.

Owners: M05, M06.

### FR-13 — Release gates

The system shall create an immutable gate run bound to exact project, subject build/artifact, corpus, scenario cases, profile, evaluator, configuration, required effect-coverage policy/manifest, and selected call-site inventory/interceptor profile when applicable. Each required case has one isolated case run; FAIL dominates, zero started cases yields NOT_RUN, and any incomplete, cancelled, recovery-pending, private, stale, unsupported, unattested, identity/effect mismatch, `DECLARED_HOOKS_ONLY` complete-effect predicate, or missing/incomplete independent interceptor yields REVIEW. Only complete required PASS case runs yield gate PASS, independently from `artifactReady`. This version supports `LOCAL_ADVISORY`, `CI_CHECK`, and `REQUIRED_CHECK_UNVERIFIED` only. It does not implement a repository-settings verification adapter and shall never claim verified required-check state, branch protection, or release blocking from user-supplied state.

Owners: M06, M08, M10, M12.

### FR-14 — Machine-readable outputs

The CLI shall emit stable JSON and JUnit. SARIF may be emitted for source-locatable integration findings. Exit codes shall distinguish PASS, FAIL, REVIEW/incomplete, configuration error, and internal error.

Owners: M06, M10, M12.

### FR-15 — Product console

The console shall expose a local project/revision/subject-build/gate-run matrix, isolated case workspace, logical-job/run-operation phase explorer, effect coverage, installed-capture regression workflow, and safety/compatibility settings using the same persisted records as the CLI. It shall keep execution lifecycle, verdict, evidence class/scope/reason, subject attestation, effect-coverage basis/findings, artifact readiness, enforcement mode, and official-endpoint compatibility as separately named axes at every viewport; shall not compute a browser-only verdict; and shall provide API-authorized recovery for loading, empty, partial, stale, disconnected, token/client/identity/interceptor conflict, reconciliation-only, unsupported, privacy-blocked, and resource-limited states.

Owners: M09, M12.

### FR-16 — Live dry compatibility probe

At implementation intake, the system shall pin an exact official SDK revision and exact route/status schemas before enabling its separately launched live-dry adapter. An explicit user-initiated probe may record only redacted shape and compatibility metadata and label the separate result `DOCUMENTED_ONLY`, `OFFICIAL_ENDPOINT_COMPATIBLE`, `INCOMPATIBLE`, or `UNKNOWN`; unknown status/schema values fail closed, the result cannot alter a local gate verdict, and no probe may claim a real settlement was tested.

Owners: M07.

### FR-17 — Secret and privacy controls

The networkless proxy shall authenticate each case client with a distinct expiring session/case token bound to subject build, artifact, gate run, case run, adapter revision, and fencing epoch and shall strip/redact all RouteSpec-local and provider authorization headers before any upstream boundary. Token reuse by another case, build, artifact, epoch, or concurrent client fails closed. Recovery revokes the old token, increments the epoch, and issues only a read-only reconciliation-scoped token until evaluation closes uncertainty. Only the separately launched live-dry adapter may attach a provider JWT after policy from memory-only state `NOT_REQUIRED`, `OPTIONAL_ABSENT`, `PRESENT_IN_MEMORY`, or `EXPIRED`; provider credentials never enter persistence, UI, or exports.

Owners: M02, M05, M08, M09, M11.

### FR-18 — Evidence export

The system shall export a self-describing redacted, checksummed evidence bundle containing identity, manifest, scenario revisions, normalized events, invariant results, gate decision, artifact readiness, enforcement mode, and integrity digests. Export must exclude secrets and raw unreviewed traces; it shall not claim a signed manifest until a signing ADR and key-lifecycle design are accepted.

Owners: M06, M08, M11, M12.

## Non-functional requirements

### NFR-01 — Determinism

Canonical proxy scheduling, barriers, replay, and evaluation shall be byte-stable for the same declared inputs, excluding a separately stored run envelope containing wall-clock and host metadata. Full client-timer determinism requires an injected clock or transport; uncontrolled external wall timers are noncanonical REVIEW evidence.

Owners: M03, M04, M10.

### NFR-02 — Local-first isolation

Default operation shall require no hosted RouteSpec service and shall bind to loopback. Simulation and replay RouteSpec processes shall remain functional with their own egress disabled; a claim that the entire tested client process tree had no egress requires a documented OS/container sandbox and process-tree network instrumentation.

Owners: M02, M08, M11.

### NFR-03 — Secret non-persistence

Automated scans shall find no provider token, authorization header, private key, or configured secret value in persistent databases, logs, exports, browser storage, or test artifacts.

Owners: M02, M05, M11.

### NFR-04 — Performance

On the documented reference machine, a 100-case deterministic corpus with 10,000 normalized events shall complete evaluation within 60 seconds, and the console shall render a 10,000-event operation using pagination or virtualization, acknowledge input visually within 100 ms, and avoid blocking interaction for more than 200 ms per user action. Route transitions shall reserve layout to keep cumulative layout shift below 0.1. These are acceptance targets, not measured results.

Owners: M06, M09.

### NFR-05 — Crash safety

A single-writer SQLite queue/connection with configured `busy_timeout`, explicit transaction mode, declared synchronous durability, WAL checkpoint/backup procedure, and fail-closed disk-full handling shall prevent duplicate events, loss of acknowledged writes, or PASS from a partial session. Every session- or execution-owned mutating transaction shall verify the current monotonically increasing lease fencing epoch so a stale worker cannot write after recovery; administrative, project, import, and export mutations shall instead use the same writer queue plus idempotency keys and optimistic revision checks without requiring a session lease.

Owners: M01, M06.

### NFR-06 — Resource bounds

Import size, event count, nesting depth, string length, simulated time, response body, concurrency, and retention shall have explicit configurable caps with safe defaults.

Owners: M03, M05, M11.

### NFR-07 — Accessibility

The console shall meet WCAG 2.2 AA for keyboard operation, 200 percent browser zoom, contrast, focus visibility and non-obscuration, semantic labels, error recovery, target sizing, reduced motion, and non-color status communication. Tables, timelines, and dense identity data shall retain equivalent text or table access without hover, drag, color, animation, or pointer precision.

Owners: M09, M12.

### NFR-08 — Versioned compatibility

Every proxy, scenario, event, evaluator, export, and API contract shall carry a schema version. Unknown major versions fail closed.

Owners: M00, M01, M03, M07.

### NFR-09 — Observability

Local structured logs and metrics shall identify session, operation, attempt, scenario, and evaluator revision without secrets or full payment identifiers.

Owners: M02, M06, M08, M11.

### NFR-10 — Portability

The CLI, proxy, runner, and console shall support documented macOS, Linux, and Windows environments, with no dependence on an author-machine absolute path.

Owners: M00, M10, M12.

### NFR-11 — Supply-chain discipline

Dependencies shall be locked, licensed, scanned, and minimized. Builds and exports shall include dependency and toolchain identity.

Owners: M00, M08, M10, M11, M12.

### NFR-12 — Truthful status

The UI, CLI, API, documentation, and exports shall use the same orthogonal execution-lifecycle, verdict, evidence-class, evidence-scope/reason, subject-attestation, effect-coverage-basis/finding, artifact-readiness, enforcement, and official-compatibility semantics. Simulated proof shall say “proven within scenario”; self-reported, inventory-only, declared-hooks-only, dry-probe, private, disputed, or source-derived evidence must never be described as complete instrumentation, a completed real settlement, or repository blocking.

Owners: M00, M04, M07, M09, M12.

## Invariants

### INV-01 — One scoped run operation per logical job

Within one project revision, subject build, gate run, and case run, one `logicalJobId` maps to exactly one `runOperationId`; exact retries add attempts to that operation. The same logical job in another case, build, baseline/correction run, replay, or import creates a distinct run operation with typed lineage and can never merge state or evidence.

Owners: M01.

### INV-02 — Operation binding is immutable

Every quote-request material field is immutable from run-operation creation. Deposit address is never quote-request-known: it is assigned only by one complete atomic quote finalization. The first commit mutation atomically binds its method/route, canonical body/material digest, finalized quote, assigned deposit address, and transaction or signed-material digest. Exact repeats are idempotent; partial, changed, concurrent, unknown, phase-invalid, or second-commit attempts fail closed without rewriting quote or commit history.

Owners: M01.

### INV-03 — Reconcile before retry under uncertainty

When a commit attempt's outcome is unknown, RouteSpec revokes the stale case token, increments the fencing epoch, and permits only a reconciliation-scoped token and read-only status calls bound to the existing run operation. No second commit mutation is permitted until authoritative scenario evidence reaches an accepted terminal result; cancellation, crash, timeout, or user assertion never authorizes another mutation.

Owners: M04.

### INV-04 — Protected side effects wait for accepted completion evidence

Goods, access, task completion, or downstream irreversible effects must not be released solely because a request was sent or a non-terminal status was observed. Every required sink and effect observation shall bind the exact build/artifact/attestation, effect policy/manifest, session, gate run, case run, run operation, scenario, effect ID/type, fencing epoch, idempotency key, and time. Complete-effect PASS requires independently controlled boundary observation or denial outside the subject; an attested build-time call-site inventory is supplemental and must be paired with runtime interception. Subject reports cannot prove coverage. `DECLARED_HOOKS_ONLY`, a missing/mismatched/forged/stale inventory or interceptor, an unsupported call site, or an unobserved required sink yields REVIEW, while independent scenario-boundary ground truth may prove a forbidden release and FAIL.

Owners: M04.

### INV-05 — Observable value conservation

Conservation shall be evaluated separately for each asset in base units: origin-asset debit, refund, and origin-side fees must reconcile within that asset, while destination credit must satisfy the immutable quoted destination asset and amount constraint. Unlike assets shall never be added or converted by display price; any positive unexplained loss is FAIL, and missing or private legs yield a REVIEW verdict with `UNKNOWN` evidence class or `NOT_VISIBLE` evidence reason, never PASS.

Owners: M04.

### INV-06 — Terminal outcomes do not regress

Once the normalized provider lifecycle reaches an accepted terminal state, a later lower-precedence or non-terminal observation cannot silently replace it. Contradictory terminal evidence requires REVIEW.

Owners: M01, M04.

### INV-07 — Evidence is consumed once

A deposit transaction, settlement proof, refund proof, or simulated ground-truth event may satisfy at most one operation binding unless the protocol explicitly defines a multi-operation aggregate and the evaluator models its allocation.

Owners: M01, M04.

### INV-08 — Missing or weak evidence cannot satisfy a stronger claim

`REPORTED`, `INFERRED`, `UNKNOWN`, `UNSUPPORTED`, or `STALE` classes and a `PRIVATE_NOT_VISIBLE` scope or `NOT_VISIBLE` reason cannot satisfy a predicate that requires `PROVEN` evidence in an accepted scope.

Owners: M04, M05, M07.

### INV-09 — Replay identity is deterministic

The canonical result digest is a pure function of project revision, subject build/artifact and attestation, gate run, case run, run-operation lineage, scenario revision, seed, ordered client exchanges, normalized evidence, effect-policy/manifest/inventory/interceptor identities, evaluator/profile revisions, fencing epoch, and configuration digest.

Owners: M03, M06, M10.

### INV-10 — Safe modes cannot mutate real value

`SIMULATE` and `REPLAY` may accept mutation-shaped requests only inside the networkless scenario runtime, where they can reach neither upstream services nor provider credentials. `LIVE_DRY_PROBE` must reject committed quote, deposit-submit, transfer, withdrawal, signing, and every other mutating or fund-moving request before provider credential attachment, DNS resolution, or socket creation.

Owners: M02, M07, M11.

### INV-11 — Secrets never cross the persistence boundary

Credentials and configured secret values may exist only in protected process memory for the minimum required duration. Their raw value must not cross into persistence, logging, UI state, exports, crash dumps, or child-process arguments.

Owners: M02, M05, M11.

### INV-12 — A gate binds complete revision identity

A gate decision is valid only for one project revision, mandatory subject build/artifact and attestation, gate run, exact isolated case runs, corpus/scenario revisions, effect-policy/manifest and selected inventory/interceptor identities, evaluator/profile/proxy/schema versions, configuration digest, fencing epochs, and complete required results. Any identity change invalidates prior evidence. This version may emit advisory, CI check, or required-check-unverified state only and cannot claim repository enforcement or release blocking.

Owners: M06, M08, M10, M12.

## Status semantics

- PASS means all required evidence passed for the exact revision identity; artifact readiness remains separate. RouteSpec v2 never asserts verified required-check state, branch protection, repository enforcement, or release blocking.
- FAIL means a deterministically established required condition or invariant failed.
- REVIEW means required evidence is missing, contradictory, private, stale, or unsupported.
- NOT_RUN means zero required cases started; a started-but-incomplete required set is REVIEW unless FAIL dominates.
- UNSUPPORTED is never silently treated as PASS for a required case.
- NOT_VISIBLE is an evidence reason/scope, never a verdict. Scenario-grounded proof is labelled “proven within scenario.”
- `artifactReady` is independent from the verdict. This version exposes advisory, CI-check, or required-check-unverified state only and never claims blocking. Official-endpoint compatibility is a separate claim axis.

## Change control

Changing a definition requires an explicit product decision, corresponding PRD and registry update, affected test updates, semantic review, and a new pack version. A coding agent must not change this contract merely to make a failing implementation pass.
