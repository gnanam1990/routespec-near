---
project: RouteSpec
version: 2.0.0
artifact_status: SPECIFICATION_ONLY
product_runtime_status: NOT_RUN
updated_at: 2026-11-11
---

# Real product gate

## Purpose

RouteSpec is specified as an installable local-first and CI product, not as a hackathon facade. The event recording may show only a verified normal product journey. A polished screen, generated trace, seeded outcome, passing document checker, or prerecorded sequence cannot establish that RouteSpec works.

The networkless scenario proxy is the product's real execution mechanism. It is not a mock of the promised behavior: the user's pinned official 1Click client sends real HTTP requests to a protocol-faithful local service, the service applies a deterministic fault schedule, the durable journal records observed behavior, and the invariant kernel evaluates those records. The separate live-dry adapter performs a real allowlisted `dry: true` compatibility request to the official endpoint; it never settles funds.

## Forbidden substitutes

None of the following may satisfy a product or test claim:

- hard-coded PASS/FAIL/REVIEW values, browser-only verdicts, seeded release matrices, or hand-edited database rows;
- screenshots, videos, static HTML, Storybook-only states, mocked API handlers, or fixture JSON standing in for the normal end-to-end path;
- a fake SDK, reimplemented toy client, direct evaluator invocation that bypasses the proxy, or a recorded trace replayed as if the actual client produced it;
- a response-drop test where upstream acceptance, durable journal transition, retry behavior, or protected-effect observation is manually injected after the run;
- a source-code edit that changes only the expected test, fixture, scenario, or evaluator instead of fixing the tested client behavior;
- a local build, typecheck, component test, hosted preview, document QA result, or CI badge standing in for clean-install product verification;
- a dry quote described as a deposit, swap, delivery, settlement, or funds-safety proof.

Fixtures remain allowed only for bounded unit/property tests and explicitly labelled imported regression cases. They do not satisfy the central product gate.

## Required runtime evidence

### Gate RP-01 — Clean install and identity

From a clean checkout on each claimed supported environment, install pinned dependencies, build the CLI/service/console/launcher and supported interceptor, create a fresh local data directory, and record exact repository commit, dirty-tree digest, dependency lock digest, built-artifact digest, effect-policy/manifest/inventory/interceptor digests, commands, exit codes, and toolchain. Use enrolled launcher/CI trust roots to bind the immutable build-registration, subject case launch, optional build-time inventory, and interceptor launch as separate immutable attestations. A build row remains permanently `USER_ASSERTED_LOCAL`; an unattested launch cannot claim verified identity or complete `WORKING_LOCAL`. Swapped artifacts, stale/revoked principals, token/challenge reuse, or concurrent clients must fail. The installed artifacts must start without an author-machine path or undeclared service.

### Gate RP-02 — Actual client failure

Pin an exact official client revision, versioned adapter, schema profile, required effect policy/manifest, supported sink classes, and reviewed independent interceptor profile. Configure that actual client to use the RouteSpec loopback URL and run its process tree inside the declared sandbox boundary with a no-effect canary sink. Run an isolated case with its own token/client/interceptor lifecycle through a deterministic accepted-then-response-lost schedule. Evidence must show stable logical-job and scoped run-operation identity, quote request/finalization, first commit material binding, proxy acceptance barrier, lost response, client's unsafe retry or unsafe effect, separate subject reports and independently authenticated boundary observations, and deterministic FAIL/REVIEW reason. `DECLARED_HOOKS_ONLY`, inventory without runtime interception, an unsupported dynamic call site, or incomplete process-tree/sink coverage is REVIEW and cannot satisfy this gate. No real provider, funds, or downstream effect target is contacted.

### Gate RP-03 — Genuine client correction

Change the tested client application or its legitimate retry/effect configuration, not RouteSpec's expected result. Bind and attest the new source/build/artifact/effect-policy/manifest/inventory identity, launch a new independently attested interceptor instance, create a distinct corrected case/run operation linked by typed lineage, rerun the identical immutable scenario revision, and show the original unsafe revision still fails while the corrected revision passes every required predicate with complete independent boundary coverage. The before/after diff and both evidence digests must be reviewable; no attempt/evidence/interceptor instance may be shared across builds or cases.

### Gate RP-04 — Durable recovery

Terminate the service at the documented pre-commit, post-commit, evaluation, and export boundaries. Restart from the same data directory. Recovery must revoke the stale token, increment the fencing epoch, issue only a reconciliation-scoped token, preserve acknowledged exchanges, deny a second mutation, and evaluate from the fenced journal. Partial evaluation must never become PASS; stale workers must fail; exact retries remain idempotent; changed/concurrent commits fail.

### Gate RP-05 — Real product surfaces

The CLI, local API, and console must read the same persisted records and agree on execution lifecycle, separate verdict, evidence scope/reason, subject/build/interceptor attestation, effect-coverage basis/findings, artifact readiness, and enforcement mode. Complete the normal user journey with keyboard-only navigation, disconnected/stale recovery, pagination or virtualization at the declared load, and no browser-computed success. A clean-checkout CI run must emit machine-readable evidence and the documented exit code.

### Gate RP-06 — Security and isolation

Prove loopback binding, local authentication, case-token/build/client/epoch binding, attester enrollment/freshness/revocation, effect policy/manifest/inventory identity, interceptor private-channel authentication, complete declared OS/container process-tree and sink coverage, Origin/Host/CORS controls, no provider credential path in the scenario runtime, no unexpected egress from that runtime, untrusted-input rendering as text, resource limits, secret-canary absence across database/WAL/log/export/browser artifacts, and safe local deletion. Subject reports remain self-report. `DECLARED_HOOKS_ONLY`, missing/forged/stale inventory or interceptor, unsupported dynamic/native call sites, process-tree escape, channel loss, missing teardown, or unobserved required sinks must yield REVIEW; independently observed forbidden release yields FAIL. No test executes a real downstream effect.

### Gate RP-07 — Official live-dry compatibility

After an explicit user action, run the separately launched adapter against the pinned real official endpoint with `dry: true`. Mutation denial, route allowlist, redirect rejection, and credential policy must execute before credential attachment, DNS, or sockets. Record only redacted compatibility shape and status. Failure or unknown schema leaves compatibility `INCOMPATIBLE` or `UNKNOWN`; it never weakens the networkless product tests.

### Gate RP-08 — Reproducible release evidence

Capture the real installed-client failure from authoritative persisted exchanges plus separately persisted subject reports and independent boundary observations, quarantine it, sanitize and secret-scan it, resolve every material field and effect-coverage identity, prove deterministic replay, review it, promote it to a new immutable scenario and new corpus identity, then rerun the corrected installed client through the full product path with a fresh interceptor instance. Reject secret-bearing, nondeterministic, unresolved, identity-mismatched, declared-hooks-only, interceptor-incomplete, or unreviewed captures. Export a redacted checksummed bundle, extract it in a clean location, verify its manifest, and reproduce the decision against the exact revisions. This version may report only advisory, CI-check, or required-check-unverified state and never says it blocks release.

## Claim policy

The current pack remains `SPECIFICATION_ONLY`; implementation, product tests, integration tests, deployment, and event submission are `NOT_RUN`.

- `WORKING_LOCAL` requires RP-01 through RP-06 and RP-08 with trust-rooted subject/interceptor identity, complete independent boundary coverage, and retained evidence; RP-07 is deliberately excluded. User-asserted or declared-hooks-only runs remain useful diagnostics but cannot carry this claim.
- `OFFICIAL_ENDPOINT_COMPATIBLE` separately requires RP-07 against the real official endpoint and never upgrades `WORKING_LOCAL`.
- `REQUIRED_CHECK_UNVERIFIED` means a check was emitted/configured as declared but RouteSpec v2 has no repository-settings verification adapter and makes no blocking claim.
- `Production proven`, `mainnet tested`, `settlement verified`, and `buyer demand validated` are outside these gates and must not be inferred.

The event video is recorded only after the corresponding normal product path passes these gates. Recording the verified path creates a submission artifact; it does not create or upgrade product evidence.
