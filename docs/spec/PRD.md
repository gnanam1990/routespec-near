---
project: RouteSpec
version: 2.0.0
artifact_status: SPECIFICATION_ONLY
product_runtime_status: NOT_RUN
requirements_authority: true
updated_at: 2026-11-11
---

# Product Requirements Document

## 1. Decision

**CONDITIONAL BUILD.** RouteSpec should be built only if the official 1Click client remains redirectable to a local base URL and the implementation can enforce safe-mode rejection before any committed upstream mutation. The objective is a production-shaped reliability platform for NEAR Intents integrators, not a generic blockchain dashboard or a real-money chaos tool.

## 2. Problem

A cross-chain intent spans a client, quote service, deposit chain, solver/settlement system, destination chain, and refund path. The client can receive a timeout after an accepted mutation, poll an incomplete view, retry while the first operation is unresolved, treat a provider label as independently proven delivery, or lose the exact relation between the original request and later evidence. Happy-path examples do not establish that the integration remains safe under these states.

Issue reports and official contract documentation show production-shaped failure classes, but they do not establish paid demand for RouteSpec. The business-demand status is **unproven**. The engineering problem evidence is positive; product-market fit is not.

## 3. User, buyer, and job

### Primary user

An engineer or SRE maintaining a wallet, checkout, exchange, x402 gateway, or agent-payment application that calls NEAR Intents 1Click.

### Economic buyer

The engineering, platform, security, or reliability leader responsible for preventing payment incidents and proving a release is safe.

### Core job

“Before I release an integration change, exercise my actual client against protocol-faithful failures, show exactly which economic invariant failed, and retain the failure as a regression so it cannot silently return.”

### Strongest conventional alternative

A team can use unit tests, a hand-built stub server, application logs, source/destination explorers, and incident runbooks. This is adequate for a small integration with few routes. RouteSpec is justified only when a versioned shared lifecycle model, repeatable adversarial cases, evidence preservation, and build-to-build regression history reduce duplicated internal work.

## 4. Product principles

1. Deterministic state machines own lifecycle transitions, while the deterministic evaluator owns the separate verdict.
2. The tested subject is the integrator's real client behavior, not an LLM response.
3. The networkless scenario runtime cannot reach an upstream provider, while the separately launched live-dry adapter rejects mutations before credentials, DNS, or sockets.
4. Evidence has provenance, visibility, freshness, and confidence; it is not flattened into a green badge.
5. A failure becomes useful only after installed-artifact capture, quarantine, sanitization, deterministic replay, explicit review, immutable promotion, and corrected-client rerun.
6. Release decisions bind exact project/build/artifact/attestation, gate/case/session, adapter/effect-manifest/epoch, scenario corpus, evaluator, configuration, and result identity.
7. The product is a local release check for credentials and traces; hosted collaboration is future scope, not part of the required product path.

## 5. Scope

### Included

- A networkless 1Click-compatible simulation/replay proxy and a separately launched, egress-capable live-dry adapter.
- An authenticated local control API with subject build/attestation, immutable GateRun, isolated CaseRun, and release matrices.
- A declarative, bounded scenario format and deterministic scheduler.
- A durable phased logical-job/run-operation journal, fenced recovery, and normalized lifecycle/effect-coverage evidence model.
- A deterministic invariant kernel.
- Installed-artifact trace capture, no-network quarantine, sanitized reviewed promotion to a new scenario/corpus, and corrected-client rerun.
- A release gate and CLI/GitHub-compatible machine outputs.
- A modern local web console for sessions, operations, regressions, and release evidence.
- Import/export of redacted evidence bundles.
- Optional non-authoritative explanations generated from the deterministic result only.
- An authenticated protected-effect observation SDK that records attempted, released, and blocked downstream effects without performing them.

### Explicitly excluded

- Forwarding committed quotes, deposits, transfers, withdrawals, signed intents, or deposit-submit mutations to mainnet.
- Custody, key management, transaction signing, solver operation, lending, insurance, refund advances, or recovery execution.
- Bridge backing, route solvency, solver concentration, safe-capacity scoring, or route-selection advice.
- End-user stuck-swap support or blame attribution.
- Claiming global exactly-once semantics.
- Executing arbitrary user project code from the RouteSpec service.
- Treating an optional report hash on NEAR as proof that the report is correct.

## 6. Required journeys

### Journey A — Gate an integration revision

The engineer registers an immutable subject build/artifact, separate trust-rooted attestations, an effect policy/manifest, optional trusted call-site inventory, and an independent interceptor profile. They create one immutable GateRun from a pinned corpus and run isolated CaseRuns with distinct client/token/interceptor/reset lifecycles. The decision binds every exact identity; subject hooks or inventory without complete runtime boundary interception remain REVIEW.

### Journey B — Diagnose an uncertain retry

The engineer opens a run operation whose commit was accepted but whose response was deterministically lost. The timeline separates logical job, quote request/finalization, one-time commit binding, and reconciliation. Recovery revokes stale authority, increments epoch, and allows only read-only status; a second mutation is denied. The check remains FAIL/REVIEW until reconciled and v2 never claims repository blocking.

### Journey C — Promote an incident trace

The engineer captures the installed failing client's authoritative exchanges plus separate subject reports and independent boundary observations, quarantines and sanitizes them, resolves identities/phases/effect-coverage limits, proves deterministic replay, and explicitly reviews them. Promotion creates a new immutable scenario and new corpus identity; only the corrected installed client running that promoted corpus with a fresh interceptor completes the journey.

### Journey D — Prove an ambiguous case stays ambiguous

The suite presents a private or contradictory leg. The evaluator returns a `REVIEW` verdict with `PRIVATE_NOT_VISIBLE` scope or `NOT_VISIBLE` evidence reason; the UI explains what cannot be observed. The release check does not convert the absence of proof into PASS.

### Journey E — Verify provider compatibility without money

Separately from the local gate, the engineer runs a real `dry: true` quote/schema probe through the official client. The request cannot provide an assigned deposit address; response-assigned shape may be recorded when the pinned profile returns it. RouteSpec records only redacted compatibility, forwards no committed mutation, and cannot upgrade `WORKING_LOCAL`.

## 7. Functional requirements

### FR-01 — Project and revision identity

The system shall register a project, immutable integration revision, and immutable mandatory subject build revision. The build revision binds source revision, configuration digest, artifact digest, dependency-lock digest, toolchain identity, effect-instrumentation-manifest digest, and an initial `USER_ASSERTED_LOCAL` registration claim; it is never upgraded or rewritten. A separate immutable attestation record may have class `TRUSTED_LAUNCHER` or `CI_ATTESTED` only when a single-use challenge is completed by an enabled attester principal whose local launcher key or CI OIDC issuer, audience, repository, workflow, ref, and subject policy was explicitly enrolled through the control plane. The verifier shall check signature, claims, freshness, revocation epoch, artifact/manifest digests, and challenge scope. Every gate run selects one exact attestation record or the user-asserted claim, and each case binds a separate launch attestation to the selected build. Every session, run operation, exchange, evidence item, effect observation, evaluation, export, and gate decision shall reference that exact build and attestation lineage. Local self-assertion, stale or revoked principals, swapped artifacts, challenge/token reuse, and concurrent subject clients fail closed and cannot be labelled verified.

### FR-02 — Local control plane

The system shall expose a loopback-bound authenticated local control API and CLI for project, scenario, session, regression, release-gate, export, and settings operations. Remote binding is unsupported unless a later reviewed security decision adds it.

### FR-03 — 1Click-compatible proxy

The system shall implement the declared 1Click paths used by an exact pinned official SDK and a versioned actual-client adapter/middleware contract. The adapter shall supply stable session, gate-run, case-run, logical-job, and transport identities; preserve the proxy-assigned run-operation identity across quote finalization, commit, internal retry, and status calls; enforce expiry and teardown; and strip every RouteSpec-local header before any upstream boundary. The SDK base URL shall target the local proxy, and unsupported or uncorrelated paths, schema versions, concurrent subject clients, and adapter/profile mismatches shall return typed fail-closed responses rather than pass through implicitly.

### FR-04 — Execution modes

The system shall run `SIMULATE` and `REPLAY` in a networkless scenario runtime that may accept mutation-shaped requests only as local test inputs and can never attach provider credentials or contact an upstream, while `LIVE_DRY_PROBE` runs in a separately launched egress-capable adapter. Mode is immutable once a session starts, and the live-dry adapter shall reject every committed or fund-moving request before provider credential attachment, DNS resolution, or socket creation.

### FR-05 — Scenario definitions

The system shall validate versioned declarative scenarios that define initial state, ordered triggers, bounded delays, provider responses, transport failures, ground-truth lifecycle events, expected outcomes, and forbidden client behaviors. Scenario files shall not contain executable code.

### FR-06 — Deterministic fault scheduling

Given the same scenario revision, seed, evaluator revision, and client interaction sequence, the scheduler shall reproduce proxy-controlled schedules, barriers, response drops, connection outcomes, normalized events, and virtual timestamps. Client timer behavior is canonical only when the client uses an injected clock or transport; uncontrolled external wall-clock timers shall be labelled noncanonical REVIEW evidence rather than claimed deterministic.

### FR-07 — Durable operation journal

Every gate run, case run, logical job, run operation, attempt, proxy exchange, lifecycle event, evidence item, effect observation, evaluation, and gate decision shall be persisted transactionally with monotonic sequence numbers and mandatory subject-build identity. Each case run owns a unique expiring client token and isolated operation namespace; bounded parallelism is allowed only across distinct case runs. Crash, cancellation, or interruption shall enter `RECOVERY_REQUIRED`, revoke the stale token, increment the fencing epoch, and resume only through a read-only reconciliation-scoped token before evaluation. Incomplete required case runs aggregate to REVIEW, while zero started required cases remains NOT_RUN.

### FR-08 — Exact operation binding

The system shall distinguish a cross-run `logicalJobId` from a `runOperationId` scoped to project revision, subject build revision, gate run, case run, and logical job. Baseline, corrected, replay, and imported runs remain isolated operations connected only by typed lineage. Within one case run, exact retries join the same run operation; reuse across a different case/build/run or with changed material fails closed. The versioned profile shall model four phases: `QUOTE_REQUEST`, `QUOTE_FINALIZATION`, `COMMIT_MUTATION`, and `READ_ONLY_RECONCILIATION`. Quote-request fields are immutable and never include a deposit address; the first complete quote response atomically binds quote/correlation identity, returned constraints, assigned deposit address, and response extensions. The first commit mutation then atomically binds method/route, body/material digest, finalized quote, deposit address, and transaction or signed-material digest. Exact repeats are idempotent; partial, changed, concurrent, second-commit, unknown-material, or phase-invalid writes fail without rewriting history. Reconciliation may use the already bound deposit address only as derived identity and can never create another mutation.

### FR-09 — Deterministic invariant evaluation

The system shall evaluate `INV-01`–`INV-12` without an LLM. Each result shall bind subject build, gate run, case run, run operation, scenario, profile, evaluator, and fencing epoch and shall include a verdict from `PASS`, `FAIL`, `REVIEW`, `NOT_RUN`, or `UNSUPPORTED`; observed and missing facts; evidence IDs with separate class, scope, and reason; and an actionable deterministic explanation. A required effect-coverage policy shall bind the exact build/artifact/attestation, scenario, manifest, required sink classes, and one basis: `INDEPENDENT_BOUNDARY_INTERCEPT`, `TRUSTED_BUILD_INVENTORY_PLUS_INTERCEPT`, or `DECLARED_HOOKS_ONLY`. A complete-effect PASS requires an independently controlled runtime boundary interceptor outside the subject; a trust-root-attested build-time call-site inventory may strengthen coverage identity but never replaces runtime interception. Subject observer records are `SUBJECT_REPORTED` correlation only. `DECLARED_HOOKS_ONLY`, a missing/mismatched/forged/stale inventory or interceptor, an unsupported dynamic call site, or an unobserved required sink yields REVIEW unless independent ground truth already proves a violation and FAIL.

### FR-10 — Evidence classification

Evidence shall record a class (`PROVEN`, `REPORTED`, `INFERRED`, `UNKNOWN`, `UNSUPPORTED`, or `STALE`), an independent scope (`SIMULATED_GROUND_TRUTH`, `PUBLIC_CHAIN_OBSERVATION`, `PROVIDER_REPORTED`, `SUBJECT_REPORTED`, or `PRIVATE_NOT_VISIBLE`), and optional reason codes such as `NOT_VISIBLE`; a reason is never a verdict. Provider facts, subject self-reports, effect-coverage records, and live-probe compatibility results shall remain separate records. Only a predicate's declared acceptable class and scope may satisfy it; self-report cannot prove complete instrumentation, and private, missing, stale, unsupported, identity-mismatched, or partial evidence yields REVIEW unless a proven violation already yields FAIL.

### FR-11 — Capture-to-regression workflow

The installed product shall capture a real client trace into quarantine, stream-hash and secret-scan it before persistence, sanitize active/sensitive content, validate schema/resource bounds and determinism, show raw-to-normalized mapping plus unresolved facts, require explicit local review, and promote only an accepted immutable regression revision. Secret-bearing, nondeterministic, identity-mismatched, unresolved, or unreviewed traces remain rejected or quarantined and can never enter a required corpus. Promotion creates a new corpus identity; the corrected client must rerun that exact promoted regression through the normal proxy/journal/evaluator path.

### FR-12 — Regression corpus management

The system shall version corpora, pin scenario revisions, detect changed or removed cases, and retain prior corpus identities. A release gate must never silently follow a mutable “latest” corpus.

### FR-13 — Release gates

The system shall create an immutable gate run bound to exact project, subject build/artifact, corpus, scenario cases, profile, evaluator, configuration, required effect-coverage policy/manifest, and selected call-site inventory/interceptor profile when applicable. Each required case has one isolated case run; FAIL dominates, zero started cases yields NOT_RUN, and any incomplete, cancelled, recovery-pending, private, stale, unsupported, unattested, identity/effect mismatch, `DECLARED_HOOKS_ONLY` complete-effect predicate, or missing/incomplete independent interceptor yields REVIEW. Only complete required PASS case runs yield gate PASS, independently from `artifactReady`. This version supports `LOCAL_ADVISORY`, `CI_CHECK`, and `REQUIRED_CHECK_UNVERIFIED` only. It does not implement a repository-settings verification adapter and shall never claim verified required-check state, branch protection, or release blocking from user-supplied state.

### FR-14 — Machine-readable outputs

The CLI shall emit stable JSON and JUnit. SARIF may be emitted for source-locatable integration findings. Exit codes shall distinguish PASS, FAIL, REVIEW/incomplete, configuration error, and internal error.

### FR-15 — Product console

The console shall expose a local project/revision/subject-build/gate-run matrix, isolated case workspace, logical-job/run-operation phase explorer, effect coverage, installed-capture regression workflow, and safety/compatibility settings using the same persisted records as the CLI. It shall keep execution lifecycle, verdict, evidence class/scope/reason, subject attestation, effect-coverage basis/findings, artifact readiness, enforcement mode, and official-endpoint compatibility as separately named axes at every viewport; shall not compute a browser-only verdict; and shall provide API-authorized recovery for loading, empty, partial, stale, disconnected, token/client/identity/interceptor conflict, reconciliation-only, unsupported, privacy-blocked, and resource-limited states.

### FR-16 — Live dry compatibility probe

At implementation intake, the system shall pin an exact official SDK revision and exact route/status schemas before enabling its separately launched live-dry adapter. An explicit user-initiated probe may record only redacted shape and compatibility metadata and label the separate result `DOCUMENTED_ONLY`, `OFFICIAL_ENDPOINT_COMPATIBLE`, `INCOMPATIBLE`, or `UNKNOWN`; unknown status/schema values fail closed, the result cannot alter a local gate verdict, and no probe may claim a real settlement was tested.

### FR-17 — Secret and privacy controls

The networkless proxy shall authenticate each case client with a distinct expiring session/case token bound to subject build, artifact, gate run, case run, adapter revision, and fencing epoch and shall strip/redact all RouteSpec-local and provider authorization headers before any upstream boundary. Token reuse by another case, build, artifact, epoch, or concurrent client fails closed. Recovery revokes the old token, increments the epoch, and issues only a read-only reconciliation-scoped token until evaluation closes uncertainty. Only the separately launched live-dry adapter may attach a provider JWT after policy from memory-only state `NOT_REQUIRED`, `OPTIONAL_ABSENT`, `PRESENT_IN_MEMORY`, or `EXPIRED`; provider credentials never enter persistence, UI, or exports.

### FR-18 — Evidence export

The system shall export a self-describing redacted, checksummed evidence bundle containing identity, manifest, scenario revisions, normalized events, invariant results, gate decision, artifact readiness, enforcement mode, and integrity digests. Export must exclude secrets and raw unreviewed traces; it shall not claim a signed manifest until a signing ADR and key-lifecycle design are accepted.

## 8. Non-functional requirements

### NFR-01 — Determinism

Canonical proxy scheduling, barriers, replay, and evaluation shall be byte-stable for the same declared inputs, excluding a separately stored run envelope containing wall-clock and host metadata. Full client-timer determinism requires an injected clock or transport; uncontrolled external wall timers are noncanonical REVIEW evidence.

### NFR-02 — Local-first isolation

Default operation shall require no hosted RouteSpec service and shall bind to loopback. Simulation and replay RouteSpec processes shall remain functional with their own egress disabled; a claim that the entire tested client process tree had no egress requires a documented OS/container sandbox and process-tree network instrumentation.

### NFR-03 — Secret non-persistence

Automated scans shall find no provider token, authorization header, private key, or configured secret value in persistent databases, logs, exports, browser storage, or test artifacts.

### NFR-04 — Performance

On the documented reference machine, a 100-case deterministic corpus with 10,000 normalized events shall complete evaluation within 60 seconds, and the console shall render a 10,000-event operation using pagination or virtualization, acknowledge input visually within 100 ms, and avoid blocking interaction for more than 200 ms per user action. Route transitions shall reserve layout to keep cumulative layout shift below 0.1. These are acceptance targets, not measured results.

### NFR-05 — Crash safety

A single-writer SQLite queue/connection with configured `busy_timeout`, explicit transaction mode, declared synchronous durability, WAL checkpoint/backup procedure, and fail-closed disk-full handling shall prevent duplicate events, loss of acknowledged writes, or PASS from a partial session. Every session- or execution-owned mutating transaction shall verify the current monotonically increasing lease fencing epoch so a stale worker cannot write after recovery; administrative, project, import, and export mutations shall instead use the same writer queue plus idempotency keys and optimistic revision checks without requiring a session lease.

### NFR-06 — Resource bounds

Import size, event count, nesting depth, string length, simulated time, response body, concurrency, and retention shall have explicit configurable caps with safe defaults.

### NFR-07 — Accessibility

The console shall meet WCAG 2.2 AA for keyboard operation, 200 percent browser zoom, contrast, focus visibility and non-obscuration, semantic labels, error recovery, target sizing, reduced motion, and non-color status communication. Tables, timelines, and dense identity data shall retain equivalent text or table access without hover, drag, color, animation, or pointer precision.

### NFR-08 — Versioned compatibility

Every proxy, scenario, event, evaluator, export, and API contract shall carry a schema version. Unknown major versions fail closed.

### NFR-09 — Observability

Local structured logs and metrics shall identify session, operation, attempt, scenario, and evaluator revision without secrets or full payment identifiers.

### NFR-10 — Portability

The CLI, proxy, runner, and console shall support documented macOS, Linux, and Windows environments, with no dependence on an author-machine absolute path.

### NFR-11 — Supply-chain discipline

Dependencies shall be locked, licensed, scanned, and minimized. Builds and exports shall include dependency and toolchain identity.

### NFR-12 — Truthful status

The UI, CLI, API, documentation, and exports shall use the same orthogonal execution-lifecycle, verdict, evidence-class, evidence-scope/reason, subject-attestation, effect-coverage-basis/finding, artifact-readiness, enforcement, and official-compatibility semantics. Simulated proof shall say “proven within scenario”; self-reported, inventory-only, declared-hooks-only, dry-probe, private, disputed, or source-derived evidence must never be described as complete instrumentation, a completed real settlement, or repository blocking.

## 9. Authoritative invariants

### INV-01 — One scoped run operation per logical job

Within one project revision, subject build, gate run, and case run, one `logicalJobId` maps to exactly one `runOperationId`; exact retries add attempts to that operation. The same logical job in another case, build, baseline/correction run, replay, or import creates a distinct run operation with typed lineage and can never merge state or evidence.

### INV-02 — Operation binding is immutable

Every quote-request material field is immutable from run-operation creation. Deposit address is never quote-request-known: it is assigned only by one complete atomic quote finalization. The first commit mutation atomically binds its method/route, canonical body/material digest, finalized quote, assigned deposit address, and transaction or signed-material digest. Exact repeats are idempotent; partial, changed, concurrent, unknown, phase-invalid, or second-commit attempts fail closed without rewriting quote or commit history.

### INV-03 — Reconcile before retry under uncertainty

When a commit attempt's outcome is unknown, RouteSpec revokes the stale case token, increments the fencing epoch, and permits only a reconciliation-scoped token and read-only status calls bound to the existing run operation. No second commit mutation is permitted until authoritative scenario evidence reaches an accepted terminal result; cancellation, crash, timeout, or user assertion never authorizes another mutation.

### INV-04 — Protected side effects wait for accepted completion evidence

Goods, access, task completion, or downstream irreversible effects must not be released solely because a request was sent or a non-terminal status was observed. Every required sink and effect observation shall bind the exact build/artifact/attestation, effect policy/manifest, session, gate run, case run, run operation, scenario, effect ID/type, fencing epoch, idempotency key, and time. Complete-effect PASS requires independently controlled boundary observation or denial outside the subject; an attested build-time call-site inventory is supplemental and must be paired with runtime interception. Subject reports cannot prove coverage. `DECLARED_HOOKS_ONLY`, a missing/mismatched/forged/stale inventory or interceptor, an unsupported call site, or an unobserved required sink yields REVIEW, while independent scenario-boundary ground truth may prove a forbidden release and FAIL.

### INV-05 — Observable value conservation

Conservation shall be evaluated separately for each asset in base units: origin-asset debit, refund, and origin-side fees must reconcile within that asset, while destination credit must satisfy the immutable quoted destination asset and amount constraint. Unlike assets shall never be added or converted by display price; any positive unexplained loss is FAIL, and missing or private legs yield a REVIEW verdict with `UNKNOWN` evidence class or `NOT_VISIBLE` evidence reason, never PASS.

### INV-06 — Terminal outcomes do not regress

Once the normalized provider lifecycle reaches an accepted terminal state, a later lower-precedence or non-terminal observation cannot silently replace it. Contradictory terminal evidence requires REVIEW.

### INV-07 — Evidence is consumed once

A deposit transaction, settlement proof, refund proof, or simulated ground-truth event may satisfy at most one operation binding unless the protocol explicitly defines a multi-operation aggregate and the evaluator models its allocation.

### INV-08 — Missing or weak evidence cannot satisfy a stronger claim

`REPORTED`, `INFERRED`, `UNKNOWN`, `UNSUPPORTED`, or `STALE` classes and a `PRIVATE_NOT_VISIBLE` scope or `NOT_VISIBLE` reason cannot satisfy a predicate that requires `PROVEN` evidence in an accepted scope.

### INV-09 — Replay identity is deterministic

The canonical result digest is a pure function of project revision, subject build/artifact and attestation, gate run, case run, run-operation lineage, scenario revision, seed, ordered client exchanges, normalized evidence, effect-policy/manifest/inventory/interceptor identities, evaluator/profile revisions, fencing epoch, and configuration digest.

### INV-10 — Safe modes cannot mutate real value

`SIMULATE` and `REPLAY` may accept mutation-shaped requests only inside the networkless scenario runtime, where they can reach neither upstream services nor provider credentials. `LIVE_DRY_PROBE` must reject committed quote, deposit-submit, transfer, withdrawal, signing, and every other mutating or fund-moving request before provider credential attachment, DNS resolution, or socket creation.

### INV-11 — Secrets never cross the persistence boundary

Credentials and configured secret values may exist only in protected process memory for the minimum required duration. Their raw value must not cross into persistence, logging, UI state, exports, crash dumps, or child-process arguments.

### INV-12 — A gate binds complete revision identity

A gate decision is valid only for one project revision, mandatory subject build/artifact and attestation, gate run, exact isolated case runs, corpus/scenario revisions, effect-policy/manifest and selected inventory/interceptor identities, evaluator/profile/proxy/schema versions, configuration digest, fencing epochs, and complete required results. Any identity change invalidates prior evidence. This version may emit advisory, CI check, or required-check-unverified state only and cannot claim repository enforcement or release blocking.

## 10. Status models

### Execution lifecycle

One lifecycle-only enum is shared by GateRun, CaseRun, and session records: `PENDING | DRAFT | VALIDATING | READY | RUNNING | RECOVERY_REQUIRED | EVALUATING | COMPLETED | ABORTED | ERROR`. GateRuns begin `DRAFT`, CaseRuns begin `PENDING`, and sessions begin `READY`; inapplicable transitions are forbidden. `PASS`, `FAIL`, `REVIEW`, `NOT_RUN`, and `UNSUPPORTED` never appear in lifecycle state.

`COMPLETED` means evaluation closed, not that it passed. `ABORTED` and `ERROR` are execution outcomes with a separate verdict: an incomplete required case contributes REVIEW unless another case establishes FAIL. Zero started required cases yields a completed GateRun evaluation with verdict NOT_RUN.

### Verdict

`NOT_RUN | PASS | FAIL | REVIEW | UNSUPPORTED`

### Evidence class

`PROVEN | REPORTED | INFERRED | UNKNOWN | UNSUPPORTED | STALE`

### Evidence scope and reason

`SIMULATED_GROUND_TRUTH | PUBLIC_CHAIN_OBSERVATION | PROVIDER_REPORTED | SUBJECT_REPORTED | PRIVATE_NOT_VISIBLE`; `NOT_VISIBLE` is an evidence reason, never a verdict. Independent boundary observations use `SIMULATED_GROUND_TRUTH` only when the trust-rooted interceptor and declared process-tree/sink scope are complete; subject hooks always use `SUBJECT_REPORTED`.

### Artifact and enforcement

`artifactReady` is an independent boolean. `enforcementMode` is `LOCAL_ADVISORY | CI_CHECK | REQUIRED_CHECK_UNVERIFIED`. Official-endpoint compatibility is separate and cannot upgrade the gate verdict or enforcement claim.

### Provider credential state

`NOT_REQUIRED | OPTIONAL_ABSENT | PRESENT_IN_MEMORY | EXPIRED`

### Provider lifecycle

The pinned official profile shall enumerate the seven raw values `PENDING_DEPOSIT`, `KNOWN_DEPOSIT_TX`, `PROCESSING`, `SUCCESS`, `INCOMPLETE_DEPOSIT`, `REFUNDED`, and `FAILED`; unknown values are preserved but fail closed to REVIEW until a new reviewed profile maps them. A separate normalized model represents waiting for deposit, observed deposit, processing, success reported/proven, incomplete deposit, refund reported/proven, failure, unknown, and contradictory evidence. Provider facts and probe results remain separate and raw and normalized states never overwrite each other.

## 11. Acceptance and launch gates

### Product acceptance

- All `FR-01`–`FR-18`, `NFR-01`–`NFR-12`, and `INV-01`–`INV-12` have linked tests and bounded evidence.
- RP-01 through RP-06 and RP-08 in `REAL-PRODUCT-GATE.md` have retained evidence for `WORKING_LOCAL`; RP-07 is a separate optional `OFFICIAL_ENDPOINT_COMPATIBLE` claim and cannot block local-product acceptance. A mock, fixture, seed, screen recording, preview, or manual state edit cannot satisfy either claim.
- The installable product starts from a clean checkout and the actual pinned official client targets the real local proxy.
- A real client integration fails the deterministic accepted-then-response-lost scenario before a genuine client code or supported-configuration correction and passes the identical immutable scenario after that correction.
- Complete-effect PASS is backed by a separately attested runtime interceptor covering the full declared process tree and sink classes against a no-effect canary. Subject hooks, inventory alone, or `DECLARED_HOOKS_ONLY` remain REVIEW.
- The issue-383-derived case runs through the full client/proxy/journal/evaluator path; PASS means safe refund/failure handling with no unsafe retry or fulfillment, never successful settlement.
- The issue-384-derived case remains disputed; private or ambiguous evidence stays REVIEW with a `NOT_VISIBLE` evidence reason rather than becoming a verdict.
- Restart, fencing, idempotent rerun, import, export, redaction, clean-install, CLI, API, UI, and CI paths pass from authoritative persisted state.
- Every UI state in `UI-SPEC.md` is verified in both themes at required viewports, 200 percent zoom, keyboard-only navigation, reduced motion, and declared performance bounds.

### Production readiness

Not established by this pack. Production use additionally requires a security review, data-protection review, dependency audit, performance measurements, provider compatibility validation, operational runbooks, and customer-specific risk acceptance. Inline committed-traffic proxying remains unsupported unless separately designed and reviewed.

### Demand validation

Before treating RouteSpec as a company rather than an open-source event product, obtain at least three current integrator interviews, one independently reproduced client failure, and one design partner willing to run the gate in CI. A prize, star, issue, or offer to try is not willingness to pay.

