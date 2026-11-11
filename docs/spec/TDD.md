---
project: RouteSpec
version: 2.0.0
artifact_status: SPECIFICATION_ONLY
product_runtime_status: NOT_RUN
updated_at: 2026-11-11
---

# Technical Design Document

## 1. Design objective

RouteSpec shall be an installable local-first and CI reliability release check for a NEAR Intents 1Click client. The design must prove the behavior of the integrator's actual pinned HTTP client under controlled lifecycle failures, persist and recover real observations, demonstrate a genuine client correction against the identical immutable regression, keep provider credentials inside a separately launched live-dry adapter, and ensure the networkless simulator/replay runtime cannot reach real funds. `REAL-PRODUCT-GATE.md` is part of the acceptance boundary; demo-only, seeded, mocked, hard-coded, manually repaired, or prerecorded central paths are prohibited.

The system is not a transaction intermediary. Its authoritative outputs are test observations and release decisions within a declared model.

## 2. Proposed stack

| Layer | Proposed technology | Reason | Status |
|---|---|---|---|
| Runtime | Node.js 22, TypeScript strict mode | Matches official TypeScript client ecosystem and cross-platform local tooling | Decision to confirm |
| Workspace | `pnpm` workspaces | Deterministic monorepo dependency graph | Decision to confirm |
| Local proxy/control API | Fastify with explicit schemas | Bounded request handling and route-level validation | Decision to confirm |
| Persistence | SQLite WAL, migration tool, synchronous transactions behind repository interfaces | Portable durable local evidence store | Decision to confirm |
| Console | React + Vite, semantic HTML, generated API types | Local static console with persisted API authority and measurable accessibility/performance | Decision to confirm |
| CLI | Node binary with machine-readable output | CI and local workflow | Decision to confirm |
| Tests | Vitest, fast-check, Playwright | Unit/property/browser coverage | Decision to confirm |
| Packaging | Checksummed release archives and optional container | Reproducible local installation without an unapproved signing claim | Future implementation |

No technology choice is implemented or verified by this document.

## 3. Component model

1. **Local control service** — mandatory loopback API, ephemeral local authentication, settings, project/revision/build matrix, sessions, regressions, gates, and exports.
2. **Networkless scenario proxy** — implements the supported simulation/replay protocol surface, records redacted exchanges, and has no upstream client or provider credential capability.
3. **Scenario compiler** — validates declarative source, resolves defaults, computes an immutable scenario revision, and produces a bounded execution plan.
4. **Scenario scheduler** — emits deterministic proxy responses, connection barriers, and ground-truth events using virtual time and a seeded deterministic PRNG; client timers are canonical only through an injected clock/transport.
5. **Operation journal** — transactionally stores operations, attempts, exchanges, events, evidence, and evaluations.
6. **Normalizer** — preserves raw provider observations and derives normalized lifecycle facts without overwriting them.
7. **Invariant kernel** — pure deterministic evaluation of `INV-01`–`INV-12`.
8. **Regression manager** — quarantines imports, assists explicit mapping, creates immutable reviewed scenarios, and versions corpora.
9. **Release-gate engine** — aggregates required results and binds the decision to complete revision identity.
10. **Artifact exporter** — emits redacted evidence bundles, JSON, JUnit, and optional SARIF.
11. **Console** — reads control API records and does not independently recompute verdicts.
12. **CLI/CI adapter** — starts or connects to the local service, runs pinned gates, streams progress, emits artifacts, and returns stable exit codes.
13. **Live-dry adapter** — a separately launched egress-capable process that attaches a memory-only provider JWT only after policy approval.
14. **Protected-effect subject observer** — an authenticated local SDK/API that records subject-declared attempted, blocked, or released effects for correlation only and never executes them.
15. **Independent effect boundary interceptor** — a separately launched, trust-root-attested sandbox/interceptor outside the subject process that observes or denies the declared sink classes and writes authoritative scenario-boundary observations over a private channel the subject cannot access.

## 4. Trust boundaries

### TB-01 — Integrator process to local proxy

The tested application is not trusted to identify its build, operation, retry, effect coverage, or status interpretation correctly. A versioned adapter supplies stable non-secret session/case/logical-job identity, a unique transport request ID, and one secret case token; the proxy assigns the run-operation identity. The token is bound to exact subject build/artifact, gate run, case run, client instance, adapter revision, allowed phases, and fencing epoch. Swapped artifacts, token reuse, concurrent subject clients, and mismatched identity fail closed. Provider `Authorization` and every RouteSpec-local header are stripped/redacted before any upstream boundary.

### TB-02 — Local proxy to upstream 1Click

Only the separately launched `LIVE_DRY_PROBE` adapter may cross this boundary. Its allowlist and mutation classifier run before provider credential attachment, DNS resolution, or socket creation. Credentials remain memory-only and redirects are rejected unless their host is explicitly pinned and reviewed.

### TB-03 — Imported scenario/trace to compiler

Files, issue text, URLs, HTML, and JSON are untrusted. The compiler accepts data only, enforces a versioned JSON schema and resource caps, and never evaluates code or fetches referenced URLs.

### TB-04 — Deterministic kernel to explanation

The kernel is authoritative. Any optional model receives a redacted completed result and may summarize it. It cannot change status, evidence, remediation, or release decision.

### TB-05 — Local evidence to export/CI

Export is a disclosure boundary. A mandatory privacy scan and explicit confirmation precede export. Raw imports, secrets, full authorization values, and local-only annotations are excluded.

### TB-06 — Artifact identity to optional NEAR anchor

A hash anchor can prove that a specific digest existed. It cannot prove correct execution, truthful input, or runner integrity. Anchoring is optional and outside the core release gate.

### TB-07 — Subject build to launcher/CI attestation

A local user may declare an artifact digest, but that build remains `USER_ASSERTED_LOCAL`. Attestation authority comes only from an enabled `AttesterPrincipal` enrolled through authenticated control-plane administration with an explicit local confirmation and immutable policy digest:

- `LOCAL_LAUNCHER_KEY` pins the reviewed launcher artifact digest and public key; the private key remains in the OS credential store. The launcher opens/hashes the selected artifact through a read-only handle, launches that same handle, exchanges the nonce over an inherited pipe, and supplies OS peer UID/PID/executable identity where the platform supports it. If the platform cannot bind the peer/process/artifact, trusted-local attestation is unavailable and the run remains user-asserted.
- `CI_OIDC` pins issuer and signing-key policy plus audience, repository ID, workflow ref, ref/subject constraints, and maximum token age. Verification checks signature, `iss`, `aud`, `sub`, `iat`, `nbf`, `exp`, repository/workflow/ref/commit/run/attempt claims, nonce, and artifact/lock/toolchain/manifest digests. A cached signing-key set may be used only inside its declared freshness window.

Before GateRun creation, the attester may complete a single-use `BUILD_REGISTRATION` challenge; the GateRun then selects that immutable attestation ID or explicit user assertion. Each CaseRun completes a separate `CASE_LAUNCH` challenge bound to gate/case/session/client/epoch and the selected build attestation. Attestations record principal ID, policy digest, verification time, expiry, and principal revocation epoch. Disabling/revoking a principal invalidates it for new or in-progress evaluation (REVIEW) without rewriting historical evidence. A subject case token cannot enroll a principal or complete an attester challenge by itself. Reuse, copy, stale claims, signature/policy mismatch, or concurrent completion fails closed. Attestation proves bounded artifact/launch identity, not source correctness or repository protection.

### TB-08 — Subject process to effect boundary interceptor

Subject hooks and `/effects/observe` are untrusted self-report. A complete-effect claim requires an interceptor controlled outside the subject process and authenticated as its own enrolled launcher/CI artifact. The selected interceptor profile declares its OS/container process-tree boundary, supported sink classes, canary endpoint or denial mechanism, and non-bypass assumptions. Its private IPC is not exposed on the control or proxy listener; neither the subject case token nor an imported trace may write boundary observations. A pinned build-time compiler/plugin or binary scanner may produce an attested call-site inventory, but that inventory is supplemental and cannot replace runtime interception. Unsupported dynamic loading, reflection, native/FFI calls, an incomplete process-tree boundary, or a sink outside the profile forces `DECLARED_HOOKS_ONLY` and REVIEW. Test interceptors deny or redirect to a local canary; they never perform the real downstream effect.

## 5. Session execution flow

1. Resolve project revision, mandatory subject build/artifact and immutable build-registration attestation (or explicit `USER_ASSERTED_LOCAL`), corpus, evaluator/profile revisions, configuration, effect policy/manifest, selected call-site inventory/interceptor profile when applicable, and bounded parallelism.
2. Create immutable `GateRun` with lifecycle `DRAFT`, enumerate exact required scenario revisions, and create one isolated `CaseRun` with lifecycle `PENDING` per required case.
3. Transition the gate/cases through `VALIDATING` to `READY` only after subject identity, adapter/profile, effect-coverage policy, attested inventory when selected, independently controlled interceptor profile when complete coverage is required, scenarios, resources, and case graph resolve. A declared-hooks-only policy remains runnable but can produce only REVIEW for complete-effect predicates.
4. For each scheduled case, acquire a case lease/fencing epoch and issue a unique expiring token bound to subject build/artifact, gate run, case run, adapter revision, and epoch. One subject client may own it.
5. The external launcher/CI adapter completes the case-launch challenge against the GateRun's already bound build attestation. If the GateRun selected `USER_ASSERTED_LOCAL` or the case handshake is absent/mismatched, retain the honest user-asserted label and make any required trusted-launch predicate REVIEW; never mutate the GateRun identity in place.
6. Start the networkless proxy and actual pinned subject client through the versioned adapter. RouteSpec does not interpret a shell string or execute unreviewed repository commands.
7. Validate session/case token, subject identity, phase, logical job, method/path/body and transport ID; strip/redact local/provider headers; journal before acknowledgement; and produce the planned response/failure.
8. Normalize exchanges and scheduler events; keep subject reports separate from independently intercepted boundary observations; validate manifest, inventory, interceptor, process-tree, and sink coverage; and persist evidence under exact case/run/build identity.
9. On input completion, transition the case lifecycle to `EVALUATING`; run the pure kernel over a stable fenced snapshot and persist one immutable verdict.
10. On crash/cancel/timeout, revoke the token, increment the epoch, enter `RECOVERY_REQUIRED`, and issue only a read-only reconciliation token. Reconcile the existing run operation; never create a second commit.
11. Close each case lifecycle as `COMPLETED`, `ABORTED`, or `ERROR` and persist its separate verdict. Aborted/error/recovery-incomplete required cases contribute REVIEW unless a proven FAIL dominates.
12. Aggregate the gate only after every required case is terminal or explicitly incomplete. Zero started required cases is NOT_RUN; FAIL dominates; otherwise incomplete/identity/effect/attestation gaps produce REVIEW; only all-complete PASS cases yield PASS.

No lifecycle transition implies a verdict, and no interrupted or partially evaluated record may receive PASS.

## 6. Scenario DSL

The canonical authoring form is YAML or JSON parsed into the same versioned JSON data model. The compiled form is canonical JSON.

Required fields:

- `schemaVersion`
- `scenarioId`
- `revisionLabel`
- `title`
- `protocolProfile`
- `seed`
- `initialState`
- `operationTemplate`
- `steps`
- `groundTruthEvents`
- `expectedOutcomes`
- `forbiddenBehaviors`
- `requiredEvidence`
- `resourceBudget`
- `sourceProvenance`

Allowed step types are a closed enum such as `respond`, `delay_virtual`, `transport_error`, `provider_status`, `ground_truth`, `assert_request`, and `end`. A step may match an enumerated method/path and selected schema fields. It cannot contain a regex with unbounded execution, arbitrary code, file paths, shell commands, or remote URLs to fetch.

The compiler shall:

1. parse with alias/anchor expansion disabled or bounded;
2. validate the declared major version;
3. enforce counts, depth, lengths, and duration caps;
4. resolve explicit defaults;
5. reject unknown fields in security-sensitive structures;
6. canonicalize numbers as strings where protocol precision requires it;
7. compute `scenario_revision_digest`;
8. produce a static route/step plan.

## 7. Job, run-operation, and phase identity

`logicalJobId` is a subject-provided stable business correlation value. It may intentionally recur across baseline, corrected, replay, or imported runs. It never owns mutable state. RouteSpec creates a separate `runOperationId` under the unique scope `(projectRevisionId, buildRevisionId, gateRunId, caseRunId, logicalJobId)` and records typed lineage such as `BASELINE_OF`, `CORRECTION_OF`, `REPLAY_OF`, or `PROMOTED_FROM`. Cross-scope keys never merge attempts, evidence, or results.

The pinned protocol profile defines four phases:

1. **`QUOTE_REQUEST`** — atomically creates the run operation with immutable quote-request fields: safe mode; swap/amount types; origin/destination assets; amount; slippage/minimum output; deposit type but no deposit address; recipient/refund type and addresses; confidentiality; fees; memo; deposit mode; custom messages; virtual recipient; deadline; protocol version; and request-known extensions.
2. **`QUOTE_FINALIZATION`** — the first complete accepted quote response atomically assigns quote/correlation ID and digest, returned constraints, assigned deposit address, and response extensions. Deposit address is response-assigned here, never request-known. Partial assignment writes nothing; exact repetition is read-idempotent; changed/concurrent finalization fails.
3. **`COMMIT_MUTATION`** — the first commit atomically binds method/route, canonical body/material digest, finalized quote digest, assigned deposit address, and transaction-hash or signed-material digest. A simultaneous or changed second commit fails before state mutation. An exact transport retry joins the same attempt lineage and cannot create another commit.
4. **`READ_ONLY_RECONCILIATION`** — status/read calls reference the already bound deposit address or quote identity as derived immutable identity. They can append observations but cannot alter quote/commit binding or authorize another mutation.

Every digest uses versioned, typed, length-prefixed canonical fields and a pinned cryptographic algorithm. Unknown material fields or invalid phase transitions fail closed. The actual-client adapter supplies `X-RouteSpec-Session`, `X-RouteSpec-Case-Run`, `X-RouteSpec-Logical-Job`, and a transport request ID; RouteSpec assigns/returns the run-operation reference. All local headers are stripped before upstream. The adapter's exact header/correlation contract is validated against the pinned official SDK, includes internal retry visibility, expires with the case, and tears down tokens on terminal/recovery transition.

## 8. Attempt and uncertainty model

A **run operation** is the isolated economic action inside one case run. An **attempt** is a client-visible transport or commit attempt within it. Timeouts and exact retries create attempts, never new run operations; a different case/build/run always creates a new run operation even if it shares the logical job.

Attempt outcomes:

- `NOT_SENT`
- `REJECTED_LOCALLY`
- `SENT_RESPONSE_RECEIVED`
- `SENT_OUTCOME_UNKNOWN`
- `RECONCILED`

The canonical accepted-then-lost-response case journals local protocol acceptance, then deterministically drops the response or holds a connection barrier so the commit attempt is `SENT_OUTCOME_UNKNOWN`; it does not depend on an uncontrolled wall timeout. RouteSpec immediately revokes the original case token, increments the fencing epoch, and may issue only a read-only reconciliation token. A second mutation is denied and `INV-03` fails if attempted. Recovery closes only after authoritative scenario evidence reaches a terminal result and the fenced evaluator consumes a stable snapshot. If a real client relies on wall timers, canonical timer conformance additionally requires an injected clock/transport; otherwise that timer observation is noncanonical REVIEW evidence.

## 9. Lifecycle normalization

At implementation intake, the selected official SDK commit/version and exact route/status schemas must be pinned. The profile enumerates the seven official raw values `PENDING_DEPOSIT`, `KNOWN_DEPOSIT_TX`, `PROCESSING`, `SUCCESS`, `INCOMPLETE_DEPOSIT`, `REFUNDED`, and `FAILED`; any other value is preserved as unknown and yields REVIEW until a reviewed profile version maps it. The normalizer emits separate facts:

- `AWAITING_DEPOSIT`
- `DEPOSIT_OBSERVED`
- `PROCESSING`
- `SUCCESS_REPORTED`
- `SUCCESS_PROVEN`
- `INCOMPLETE_REPORTED`
- `REFUND_REPORTED`
- `REFUND_PROVEN`
- `FAILED_REPORTED`
- `CONTRADICTORY`
- `UNKNOWN`
- `NOT_VISIBLE`

The mapping from raw status to normalized fact is protocol-profile versioned. A provider `SUCCESS` is `SUCCESS_REPORTED` unless the scenario or adapter provides the declared independent completion evidence. A private leg may remain `NOT_VISIBLE` even when the provider reports success.

## 10. Evidence model

Each evidence item includes mandatory project revision, subject `buildRevisionId`, artifact digest, selected build-registration attestation/state, case-launch attestation/state, gate run, case run, session, run operation when applicable, fencing epoch, scenario revision, effect-policy/manifest/inventory/interceptor digests when applicable, source kind, source locator after redaction, subject, observed/collected time, evidence class/scope/reason, integrity digest, freshness policy, and payload digest. Evidence scopes include `SIMULATED_GROUND_TRUTH`, `PUBLIC_CHAIN_OBSERVATION`, `PROVIDER_REPORTED`, `SUBJECT_REPORTED`, and `PRIVATE_NOT_VISIBLE`; `NOT_VISIBLE` is a reason, never a verdict. Provider facts, subject self-reports, independently intercepted boundary observations, instrumentation coverage, and live-probe compatibility results are separate records. A subject-reported effect is correlation evidence only: it cannot prove complete instrumentation. Payload storage is optional and redacted.

Before a case starts, the registered effect manifest and coverage policy must declare every required sink class, effect hook, source/build binding, hook revision, effect type, and coverage point for the exact scenario. Coverage basis is one of `INDEPENDENT_BOUNDARY_INTERCEPT`, `TRUSTED_BUILD_INVENTORY_PLUS_INTERCEPT`, or `DECLARED_HOOKS_ONLY`. The launcher/CI adapter verifies the installed manifest and, when selected, call-site inventory digests against the subject artifact. The independent interceptor separately proves its reviewed artifact/profile, sandbox/process-tree scope, supported sinks, case/session/epoch binding, and teardown. A complete-effect PASS requires its runtime observations. The inventory can show which analyzed call sites should reach that boundary but cannot by itself establish runtime coverage. Missing, mismatched, forged, disabled, stale, unreachable, unsupported-dynamic, bypassable, or exercised-but-unobserved coverage yields REVIEW. A local `USER_ASSERTED_LOCAL` manifest or declared-hooks-only run remains explicitly self-reported and can never upgrade build identity or effect completeness.

Evidence classes follow `FR-10`. Evaluators request explicit predicates, for example:

```text
requires class in {PROVEN}
subject = destination_credit
operation_digest = X
amount = Y
recipient = Z
fresh_at = evaluation_time
```

No evaluator accepts “some evidence exists” as a substitute for the declared predicate.

## 11. Invariant kernel

The kernel is a pure function over:

```text
KernelInput {
  projectRevision
  subjectBuildRevision
  subjectArtifactDigest
  buildAttestation
  caseLaunchAttestation
  gateRun
  caseRun
  session
  corpusRevision
  scenarioRevision
  effectManifestDigest
  effectCoveragePolicyDigest
  effectCallsiteInventoryDigest?
  effectInterceptorProfileDigest?
  evaluatorRevision
  configurationDigest
  fencingEpoch
  orderedRunOperations
  orderedAttempts
  orderedEvents
  evidenceIndex
}
```

It returns one result per applicable invariant:

```text
InvariantResult {
  projectRevisionId
  buildRevisionId
  subjectArtifactDigest
  buildAttestationId
  caseLaunchAttestationId
  gateRunId
  caseRunId
  sessionId
  scenarioRevisionId
  effectCoveragePolicyDigest
  effectManifestDigest
  effectCallsiteInventoryDigest?
  effectInterceptorInstanceId?
  effectInterceptorAttestationId?
  fencingEpoch
  invariantId
  verdict: PASS | FAIL | REVIEW | NOT_RUN | UNSUPPORTED
  factIds[]
  evidenceIds[]
  missingPredicates[]
  explanationCode
  remediationCode?
}
```

Rules:

- `PASS` requires every mandatory predicate satisfied by an acceptable evidence class under the exact build/gate/case/session/policy/manifest/inventory/interceptor/epoch identity. Any complete-effect predicate additionally requires independently intercepted runtime boundary coverage; declared hooks and call-site inventory alone are insufficient.
- A violated predicate is `FAIL` when enough ground truth exists to establish the violation.
- Missing, conflicting, private, stale, unattested, identity-mismatched, or uninstrumented mandatory facts produce `REVIEW`.
- `NOT_RUN` means no completed required evaluation exists; it is not a substitute for incomplete REVIEW.
- `UNSUPPORTED` is allowed only when the gate marks that invariant non-required for the scenario. A required unsupported invariant blocks the gate.
- Explanations are template-rendered from codes and facts. Free-form model output is not part of the result digest.

## 12. Conservation evaluation

Amounts remain base-unit integer strings and are parsed with arbitrary precision. The evaluator partitions facts by canonical asset identity; it never adds origin and destination token amounts or converts them using a display price.

For the origin asset, the scenario defines the accepted debit, refund, origin-side fees, and any still-locked amount. Those terms must reconcile within that single asset. For the destination asset, observed credit is checked against the immutable quoted asset and exact or minimum amount constraint. Provider fees in a third asset form a separate ledger. A positive unexplained loss is a deterministic FAIL when all required facts are proven. Missing, private, contradictory, or stale legs produce REVIEW with `UNKNOWN` or `NOT_VISIBLE`; they cannot PASS.

## 13. Capture-to-regression pipeline

1. A trace is captured from the installed subject artifact through the normal actual-client adapter and networkless proxy, bound to build, gate run, case run, session, run operations, scenario, effect policy/manifest/inventory/interceptor, separate subject reports, and independent boundary observations. Imported files use the same path after bounded streaming; neither path treats a fixture as installed-client evidence.
2. The capture immediately enters `CAPTURED_UNTRUSTED`. RouteSpec hashes bounded raw bytes while streaming and places the trace in a no-network quarantine. The external source remains user-owned; raw bytes are never copied into ordinary RouteSpec persistence.
3. Structural validation, active-content escaping, secret scanning, and nondeterminism detection run before sanitized content persists. A configured or high-confidence secret, unresolved material field, nondeterministic ordering/time, malformed identity, or resource-limit breach rejects promotion. Only source digest plus safe finding category/path may remain for a secret-bearing rejection.
4. The mapper proposes normalized events and typed operation/attempt/phase lineage; proposals are non-authoritative. Every material field must resolve against the pinned protocol profile.
5. A reviewer approves redactions, build/session/operation binding, expected terminal state, forbidden behaviors, required evidence/effect coverage, and provenance. Review identity and review digest are immutable.
6. Repeated trial replays must produce the same canonical result digest under the pinned evaluator. Any unresolved or nondeterministic replay remains quarantined or rejected.
7. Promotion creates a new immutable scenario revision and new corpus revision/identity; it never mutates an existing corpus or silently replaces a case. The source capture, sanitized representation, mapping, review, scenario, and corpus remain linked by typed lineage.
8. The corrected installed client artifact must then run the promoted scenario from the new corpus through the full adapter/proxy/journal/kernel/gate path. A direct replay-only PASS does not satisfy the product E2E.

Source provenance records whether the trace is synthetic, source-derived, independently reproduced, customer-provided, or disputed. A disputed incident can test ambiguity behavior but cannot assert the disputed outcome as ground truth.

## 14. Release-gate algorithm

For gate `G`:

1. Resolve the immutable `GateRun` and every identity required by `INV-12`, including the mandatory subject build/artifact, attestation, exact ordered `CaseRun` set, effect manifest/coverage policy, trusted call-site inventory and independent interceptor when selected, adapter, corpus, evaluator, profile, configuration, and fencing epochs.
2. Enumerate pinned cases and required invariants; verify each case used a distinct token/client lifecycle and declared reset/isolation boundary under the configured bounded parallelism.
3. Require one complete terminal result per case under the exact identities. A cancelled, crashed, recovery-pending, unattested, declared-hooks-only complete-effect predicate, missing independent interceptor, coverage-incomplete, or identity-mismatched required case is incomplete even if it has some PASS invariants.
4. Return `NOT_RUN` only if zero required cases started and zero required results completed.
5. Return `FAIL` if any complete required case/invariant is FAIL.
6. Otherwise return `REVIEW` if any required case/result is partial, cancelled, aborted, recovery-pending, private, REVIEW, UNSUPPORTED, stale, missing, unattested, uninstrumented, or identity-mismatched.
7. Return `PASS` only when all required case runs are complete PASS under the same immutable gate-run snapshot.
8. Calculate `artifactReady` independently from the decision, based on requested output generation and privacy/checksum validation.
9. Record `enforcementMode` as `LOCAL_ADVISORY`, `CI_CHECK`, or `REQUIRED_CHECK_UNVERIFIED`. This version has no authoritative repository-settings verification adapter; it never emits a verified/blocking claim or trusts caller-supplied branch-protection state.

The gate is immutable. Re-run creates a new gate evaluation revision.

## 15. Persistence, concurrency, and restart

- SQLite runs in WAL mode with foreign keys enabled, a documented `busy_timeout`, declared synchronous setting/durability claim, and migrations inside explicit transactions.
- One writer connection and queue owns all mutations. Every session/execution-owned transaction uses an explicit transaction mode and checks the current monotonically increasing lease fencing epoch. Administrative, project, import, and export writes do not require a session lease; they use the writer queue, an idempotency key, and an expected optimistic revision.
- Each gate run owns immutable required case runs and a bounded parallelism limit. Each case run has at most one active subject-client lease identified by owner token digest, expiry, client-instance digest, and fencing epoch; another client or copied token is rejected.
- Starting a case issues a unique token and creates a fresh client lifecycle. Terminal close revokes the token and records teardown. A case cannot reuse another case's token, session, client instance, or mutable local state unless an explicit reset contract is part of the pinned adapter and its completion is journaled.
- Durable writes append events and update the derived session `ExecutionLifecycle` in the same transaction; verdict remains a separate immutable evaluation field.
- Sequence numbers are allocated per session inside that transaction.
- Request deduplication uses `(session_id, proxy_request_id)` uniqueness.
- On restart, expired RUNNING/EVALUATING leases become `RECOVERY_REQUIRED`; recovery revokes the stale token, increments the fencing epoch, and issues only an expiring reconciliation-scoped token. That token may read the existing quote/commit/status journal and append read observations, but it cannot quote-finalize or commit. Recovery either resumes deterministic evaluation from a stable fenced snapshot or closes lifecycle `COMPLETED`/`ERROR` with a separate REVIEW verdict when required evidence remains incomplete; it never repeats a client mutation.
- Export reads from a transactionally consistent snapshot.
- WAL checkpoint and verified backup procedures run at documented boundaries. Disk-full, checkpoint, or backup failure stops acknowledgements and transitions affected work to RECOVERY_REQUIRED/REVIEW; it never degrades durability silently.

## 16. Network policy

The networkless scenario runtime does not contain an upstream client or provider credential path. The separately launched live-dry adapter receives a compiled allowlist, not an arbitrary URL:

- `SIMULATE` and `REPLAY`: mutation-shaped requests may drive only local scenario state; RouteSpec's scenario process has egress disabled. A stronger claim covering the tested client's entire process tree requires a documented OS/container sandbox and process-tree network instrumentation.
- `LIVE_DRY_PROBE`: only the pinned HTTPS origin and explicitly enumerated method/path/body predicates are permitted.
- Redirects, alternate schemes, IP literals, localhost targets, metadata addresses, and user-controlled host headers are denied.
- A request failing the allowlist is journaled as `REJECTED_LOCALLY` with no secret-bearing body persisted.

## 17. Secret handling

The tested client authenticates locally with distinct session and case-run headers plus an expiring token bound to exact build/artifact, adapter, client instance, gate run, case run, permitted phases, and fencing epoch. A recovery token is reconciliation-only. Provider `Authorization` and every RouteSpec-local header are stripped/redacted from every inbound exchange and before the separate live boundary. Only the separately launched live-dry adapter reads a provider JWT into a dedicated in-memory container after policy approval; token state is `NOT_REQUIRED`, `OPTIONAL_ABSENT`, `PRESENT_IN_MEMORY`, or `EXPIRED`. Logging hooks redact before formatting, error objects are normalized rather than serialized wholesale, child processes never receive the provider token, and the browser sees state only. The memory-only credential is released on stop, expiry, or disconnect without claiming guaranteed physical erasure.

## 18. Protected-effect coverage contract

The subject observer API/SDK requires the current session and case-run token and records `{buildRevisionId, artifactDigest, gateRunId, caseRunId, sessionId, runOperationId, effectPolicyDigest, effectManifestDigest, hookId, effectId, effectType, hookRevision, action: ATTEMPTED|BLOCKED|RELEASED, idempotencyKey, fencingEpoch, virtualTime?, wallTime}`. The unique binding covers every field through the fencing epoch; an exact retry returns the original report, while a changed binding, stale epoch, missing hook, or copied token fails closed. This path is always `SUBJECT_REPORTED` correlation and never proves completeness.

The independently launched interceptor uses a distinct enrolled principal and `EFFECT_INTERCEPTOR_LAUNCH` attestation. It writes `{interceptorInstanceId, interceptorProfileDigest, interceptorAttestationId, buildRevisionId, artifactDigest, gateRunId, caseRunId, sessionId, runOperationId, scenarioRevisionId, effectPolicyDigest, effectManifestDigest, effectCallsiteInventoryDigest?, sinkClass, effectId, effectType, action, fencingEpoch, sequence, virtualTime?, wallTime}` only over an inherited peer-authenticated private channel. It runs outside the subject, covers the declared sandbox/process tree and sink classes, and denies or redirects to a local no-effect canary. Subject/control/case tokens cannot write these rows. Exact duplicate events are idempotent; changed, stale, forged, cross-case, unsupported, or incomplete bindings fail closed. Channel loss, process-tree escape, missing teardown, an unobserved required sink, or inventory-only/declared-hook coverage yields REVIEW. `INV-04` may emit FAIL from an independently observed forbidden release, but no test path performs an email, webhook, task, fulfillment, asset, process, file, queue, or other real downstream effect.

## 19. Observability

Structured local logs include level, code, build short ID, gate-run ID, case-run ID, session ID, run-operation short ID, logical-job digest, scenario ID, fencing epoch, and sequence. Metrics include active gate/case runs, bounded-parallelism utilization, request counts by safe route/phase, evaluator duration, queue depth, import rejection reasons, effect-coverage gaps, and redaction hits. Identifiers are shortened or hashed for default display. Full evidence is available only through deliberate local drill-down.

No telemetry leaves the machine by default. Any future hosted telemetry must be opt-in, schema-documented, and independently disableable.

## 20. Console architecture and authority

The console is a typed view/controller over the local control API. It does not import the evaluator kernel into the browser, reconstruct verdicts, infer terminal state from missing updates, or persist provider credentials. Generated schemas or an equivalently verified shared contract bind every request and response to the API revision.

### State ownership

- **Authoritative server state:** projects, revisions, immutable subject builds and separate attestations, adapter/effect policies/manifests/inventories/interceptor instances, subject reports and independent boundary observations, gate runs, isolated case runs, sessions, logical jobs, run operations/phases, token/lease/recovery state, events, evidence, evaluations, regression revisions, corpora, exports, artifact readiness, enforcement mode, retention jobs, and compatibility results.
- **Ephemeral browser state:** current route, open panel, column presentation, unsaved form input, paused stream view, and nonauthoritative filters.
- **URL-addressable state:** selected project/revision/build/corpus, operation/evidence detail, search, sort, and safe filters so browser Back and deep links preserve user context.

The data client distinguishes first load, refreshing, stale, disconnected, retrying, conflict, forbidden, unsupported, resource-limited, and terminal failure. Cached content remains visible but visibly stale when disconnected. No cache transition changes a persisted verdict.

### Mutation contract

Every control mutation carries the API idempotency key and expected revision where required. The UI disables only the submitted action, preserves valid input, renders the authoritative returned record, and handles optimistic-concurrency failure by displaying the competing identity plus reload/compare options. It does not optimistically render PASS, enforcement, deletion completion, promotion, or export readiness. A retry is offered only when the API classifies it safe; unknown outcomes route to reconciliation.

### Streaming and dense data

Session progress uses one authenticated stream or documented polling fallback with monotonic cursor/sequence handling. Reconnect resumes after the last persisted cursor, de-duplicates received events, and exposes gaps rather than inventing continuity. Evidence tables use server cursor pagination. A virtualized timeline is permitted only if focus order, screen-reader position, selected-row identity, and table fallback are proven; otherwise use pagination.

### Design-system implementation

Semantic tokens, typography, spacing, radius, elevation, motion, status copy, and z-index layers are centralized and tested in dark/light/high-contrast/reduced-motion contexts. IBM Plex Sans and JetBrains Mono are proposed, subject to implementation-intake license and bundle review. No raw component-local status color or browser-only wording is allowed. The Swiss/minimal console structure, prohibited vibe-code patterns, responsive rules, and full component acceptance contract live in `UI-SPEC.md`.

### Browser security

The local control token is memory-scoped and never written to persistent browser storage. Sensitive values are never returned to the console. Imported content and provider text render as escaped text. The control service validates Host, Origin, CORS, authentication, schema, authorization, idempotency, and revision; browser concealment is not an access control.

## 21. Deployment topology

### Supported initial topology

Required local process groups:

- control service and project/revision/build matrix on loopback;
- networkless simulation/replay proxy with no upstream client;
- separately launched live-dry adapter only for explicit probes;
- worker thread or child process with no network for compilation/evaluation;
- SQLite data directory with owner-only permissions;
- static console served by control service;
- CLI connecting through an ephemeral local token.

The evaluator process should use OS-level resource constraints where available. A future container may enforce stronger isolation, but a container is not treated as a security boundary without a documented profile.

### Future hosted collaboration

Hosted collaboration is excluded from the required DAG. A future specification may accept reviewed redacted bundles only; it requires separate authorization, data-protection, and isolation design.

## 22. Proposed decision records

### ADR-001 — Local sidecar, not inline production gateway

Accepted for this specification. It prevents a testing product from becoming a credential and funds control point.

### ADR-002 — Deterministic kernel owns verdicts

Accepted. Models may explain but cannot decide.

### ADR-003 — Safe live capability is dry-only

Accepted. Real-fund chaos is unnecessary for the core claim and creates avoidable harm.

### ADR-004 — Raw and normalized lifecycle states coexist

Accepted. Overwriting provider observations would destroy provenance and hide mapping errors.

### ADR-005 — Immutable reviewed regressions

Accepted. Imports remain quarantined until explicit review; required corpora pin exact revisions.

### ADR-006 — Optional chain hash is provenance only

Accepted. It is not an oracle for correctness.

## 23. Unresolved implementation gates

- Pin and test the exact official SDK commit/version plus exact route and seven-status schemas; no moving `latest` or unverified current-version claim is allowed.
- Confirm license compatibility for proposed dependencies.
- Select the cryptographic digest and canonical JSON scheme.
- Define the first two public-chain evidence adapters, if any, without implying full route coverage.
- Benchmark SQLite and console targets on documented reference hardware.
- Any future signing proposal requires an ADR covering key ownership, rotation, revocation, and verification; until then bundles are checksummed only.

