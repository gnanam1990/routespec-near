---
project: RouteSpec
version: 2.0.0
artifact_status: SPECIFICATION_ONLY
test_execution_status: NOT_RUN
test_id_range: T-001..T-059
updated_at: 2026-11-11
---

# Test plan

Every case below is `NOT_RUN`. This document defines future evidence; it does not report a passing product.

## 1. Test evidence contract

Each execution record must include test ID, exact repository HEAD, dirty state, mandatory `buildRevisionId`/artifact/effect-policy/manifest digest and selected subject/inventory/interceptor attestations, gate run, case run, session, adapter/profile, fencing epoch, toolchain, dependency lock digest, command, start/end time, exit code, observed assertion counts, redacted artifact paths/digests, environment classification, and deviations. A build or schema check does not substitute for runtime behavior. Mocks may test adapters but cannot prove the critical end-to-end claim; the deterministic simulator and independently attested no-effect boundary interceptor are product domain logic, not fake success services.

## 2. Requirement traceability

| Requirement | Primary tests |
|---|---|
| FR-01–FR-04 | T-013–T-021, T-044–T-046 |
| FR-05–FR-06 | T-009, T-013–T-017 |
| FR-07–FR-08 | T-001–T-003, T-022–T-028, T-059 |
| FR-09–FR-10 | T-001–T-012, T-018, T-019 |
| FR-11–FR-12 | T-029–T-033 |
| FR-13–FR-14 | T-034–T-035, T-044–T-046, T-056–T-058 |
| FR-15 | T-047–T-052 |
| FR-16 | T-020–T-021 |
| FR-17–FR-18 | T-036–T-043, T-053 |
| NFR-01 | T-009, T-015, T-027, T-031 |
| NFR-02–NFR-03 | T-036–T-041, T-054 |
| NFR-04 | T-051 |
| NFR-05 | T-022–T-028, T-057 |
| NFR-06 | T-014, T-042 |
| NFR-07 | T-047–T-050 |
| NFR-08–NFR-09 | T-018, T-044–T-046 |
| NFR-10–NFR-11 | T-052, T-054 |
| NFR-12 | T-011, T-019, T-047, T-055–T-057 |
| INV-01–INV-12 | T-001–T-012 respectively, plus end-to-end T-055 |

## 3. Invariant and property tests

### T-001 — Logical jobs never merge run-scoped operations
Status: NOT_RUN

Covers: `FR-08`, `INV-01`. Reuse one `logicalJobId` across baseline, corrected, replay, promoted-regression, different build, gate run, and case run. Each scope creates a distinct `runOperationId` connected only by typed lineage, with no shared attempts/evidence/results. Inside one exact case, SDK internal retries preserve the run operation and add attempts. Reuse with a copied token, other client, changed build/case/epoch, changed request material, or unknown field fails closed with original records unchanged. Transport request IDs never substitute for either logical or run identity, and every RouteSpec header is stripped at a live upstream boundary.

### T-002 — Finalized operation binding is immutable
Status: NOT_RUN

Covers: `FR-08`, `INV-02`. Exercise the four phases. Quote request binds all request-known material and rejects an assigned deposit address. One complete quote finalization atomically assigns quote/correlation identity, returned constraints, response-assigned deposit address, and extensions. One commit atomically binds method/route, canonical body/material digest, finalized quote, deposit address, and transaction/signed-material digest. Independently omit/change every field, race finalization/commit callers, repeat exact material, and try partial/second/stale-epoch writes. Exact repeats are idempotent; partial, changed, concurrent, phase-invalid, or second commits write nothing and preserve the first binding.

### T-003 — Unknown outcome blocks a second mutation
Status: NOT_RUN

Covers: `FR-07`, `INV-03`. After accepted commit and deterministic response loss, revoke the execution token, increment fencing epoch, and issue one reconciliation-only token. Read-only status checks on the bound run operation are permitted. Original/stale token, quote finalization, changed commit, or second mutation under either token is denied before state change. Crash/restart and concurrent recovery cannot issue competing mutation authority.

### T-004 — Protected side effect requires configured terminal evidence
Status: NOT_RUN

Covers: `FR-09`, `INV-04`. Register an exact build/artifact/attestation/scenario effect manifest and policy. Launch a separately attested interceptor outside the subject over private peer-bound IPC, confine the real subject process tree, and route a configured canary sink through it. Before accepted completion, the interceptor must observe and deny the attempted effect while the subject report remains separate; after declared completion, exercise the allowed canary path without invoking a real target. Repeat with `TRUSTED_BUILD_INVENTORY_PLUS_INTERCEPT`, inventory mismatch/unsupported dynamic call, missing/forged/stale interceptor, process-tree escape, missing teardown, unobserved required sink, copied subject token, and `DECLARED_HOOKS_ONLY`. Only complete independent boundary coverage can satisfy a complete-effect PASS; declared hooks or inventory alone yield REVIEW, while an independently observed forbidden release yields FAIL.

### T-005 — Observable value conserves in base units
Status: NOT_RUN

Covers: `INV-05`. Property-generate origin-asset debit/refund/fee/locked partitions and destination-asset quote obligations with arbitrary-precision integers. Valid per-asset cases pass; unlike-asset addition, one-unit drift, wrong destination asset, quote shortfall, or positive unexplained loss fails; missing or private legs review.

### T-006 — Terminal outcomes cannot silently regress
Status: NOT_RUN

Covers: `INV-06`. Generate raw status sequences including late non-terminal and contradictory terminal states. Regressions never overwrite the terminal fact; contradictions produce REVIEW.

### T-007 — Single-use evidence cannot close two operations
Status: NOT_RUN

Covers: `INV-07`. Apply one deposit/refund proof to two operation digests. The second consumption is rejected unless an explicit aggregate allocation exactly partitions value.

### T-008 — Weak or missing evidence never upgrades to proven
Status: NOT_RUN

Covers: `FR-10`, `INV-08`. Exhaust evidence classes and scopes/reasons against predicates requiring PROVEN in an accepted scope. Only acceptable combinations pass; PRIVATE_NOT_VISIBLE/NOT_VISIBLE, UNKNOWN, REPORTED, INFERRED, STALE, and UNSUPPORTED yield REVIEW or block.

### T-009 — Canonical replay digest is deterministic
Status: NOT_RUN

Covers: `FR-06`, `NFR-01`, `INV-09`. Run the same exact build/artifact/gate/case/scenario/adapter/effect-policy/manifest/inventory/interceptor/epoch and canonical interaction repeatedly and across supported OSes; canonical results match while excluded run-envelope host/time fields may differ. Changing any mandatory identity changes the digest or rejects reuse.

### T-010 — Networkless scenario modes contain mutation-shaped requests locally
Status: NOT_RUN

Covers: `FR-04`, `INV-10`. In SIMULATE and REPLAY, submit every mutation-shaped method/path/body required by scenarios and prove the requests can affect only local scenario state: the process contains no upstream client, accepts no provider credential, and instruments zero DNS/socket attempts. This does not claim the separately launched sample-client process tree has no egress unless an OS/container sandbox and process-tree instrumentation are also present.

### T-011 — Canary credentials never cross persistence boundaries
Status: NOT_RUN

Covers: `FR-17`, `NFR-03`, `INV-11`. Inject unique canary secrets through approved memory input and error paths, then scan database, WAL, logs, exports, UI DOM/storage, crash artifacts, and child-process arguments; no canary may appear.

### T-012 — Gate identity changes invalidate prior decision
Status: NOT_RUN

Covers: `FR-13`, `INV-12`. Change project revision, subject build/artifact/selected attestation/case-launch attestation, principal policy or revocation epoch, gate/case, corpus/scenario, effect policy/manifest/inventory/interceptor, adapter, evaluator, proxy/profile/schema, configuration, or fencing epoch one at a time. Prior PASS/evidence is not reused. Test user self-completion, unenrolled key, bad signature, wrong OIDC issuer/audience/repository/workflow/ref/subject/commit/run/nonce, expired token/JWK, revoked principal, unavailable local peer binding, swapped artifact/interceptor, replay, and concurrent completion. Only a policy-matching enabled principal can create an attestation; otherwise the build remains user-asserted and complete-effect coverage remains REVIEW.

## 4. Scenario and proxy tests

### T-013 — Valid scenario compiles to a closed execution plan
Status: NOT_RUN

Covers: `FR-05`. Validate every allowed step and explicit default, then assert canonical compiled JSON and digest.

### T-014 — Malformed and over-budget scenarios fail closed
Status: NOT_RUN

Covers: `FR-05`, `NFR-06`. Exercise unknown fields, unsafe YAML types, excessive aliases/depth/events/duration/body size, invalid amounts, and executable constructs. None executes or persists as reviewed.

### T-015 — Virtual scheduler reproduces delays and failures exactly
Status: NOT_RUN

Covers: `FR-06`, `NFR-01`. Repeat seeded response-drop, connection-barrier, reorder, duplicate, late-success, and refund schedules; proxy event order and virtual times match exactly. Client timer behavior is canonical only with injected clock/transport; an uncontrolled external wall timer is recorded as noncanonical REVIEW evidence.

### T-016 — Versioned adapter drives the pinned official client
Status: NOT_RUN

Covers: `FR-03`. Pin an exact official SDK and adapter revision, set the documented base URL to RouteSpec, and run quote request/finalization, first commit, deterministic response loss, SDK-internal retry, status reconciliation, expiry, teardown, and next-case reset. Verify stable session/case/logical-job/run-operation correlation, unique transport IDs, token/client/build/epoch binding, and stripping of every RouteSpec header before any live boundary. A substitute client cannot satisfy the test.

### T-017 — Unknown proxy routes never pass through
Status: NOT_RUN

Covers: `FR-03`, `FR-04`. Call unknown path/method/content type and assert typed local denial plus zero upstream attempts.

### T-018 — Raw provider status and normalized fact remain distinct
Status: NOT_RUN

Covers: `FR-09`, `FR-10`, `NFR-08`. Under an implementation-intake profile pinned to an exact SDK/schema revision, feed `PENDING_DEPOSIT`, `KNOWN_DEPOSIT_TX`, `PROCESSING`, `SUCCESS`, `INCOMPLETE_DEPOSIT`, `REFUNDED`, `FAILED`, and unknown values. Raw text remains immutable; the seven mappings, unknown fail-closed behavior, normalized facts, provider facts, probe results, and mapping revision are independently inspectable.

### T-019 — Provider SUCCESS without required delivery proof remains REVIEW
Status: NOT_RUN

Covers: `FR-09`, `FR-10`, `NFR-12`. Return SUCCESS while withholding or privatizing destination evidence. UI/API/kernel must not report PASS.

### T-020 — Live dry quote forwards only an exact allowlisted request
Status: NOT_RUN

Covers: `FR-04`, `FR-16`. With explicit local setup, send a real `dry: true` request through the pinned client/origin and verify redacted response-shape capture plus a separate compatibility label. The request cannot supply an assigned deposit address; any profile-declared response address remains response-assigned shape data only. No mutation, settlement, or local-gate claim is made.

### T-021 — Dry-probe mutation denial precedes credential attachment
Status: NOT_RUN

Covers: `FR-04`, `FR-16`, `INV-10`. In the separately launched live-dry adapter, attempt false/missing/string `dry`, deposit submit, transfer, withdrawal, and all profile-declared mutating/material extensions. Assert policy denial occurs before provider credential attachment, DNS resolution, socket creation, and upstream client invocation.

## 5. Persistence, concurrency, and recovery tests

### T-022 — Acknowledged proxy exchange survives restart
Status: NOT_RUN

Covers: `FR-07`, `NFR-05`. Kill after acknowledged commit-journal transaction, restart, revoke the stale token, increment epoch, and verify exactly one commit/exchange/event with unchanged sequence/digest. The recovery token permits only reconciliation and no second mutation.

### T-023 — Crash before journal commit does not acknowledge acceptance
Status: NOT_RUN

Covers: `FR-07`, `NFR-05`. Inject termination before commit and prove the client never receives an acceptance that is absent from the journal.

### T-024 — Expired execution lease cannot create two runners
Status: NOT_RUN

Covers: `FR-07`, `NFR-05`. Race recovery workers, case schedulers under bounded parallelism, busy-timeout paths, checkpoints, copied case tokens, concurrent clients, and a stale worker after recovery. Assert only the one bound client/token/current epoch may mutate before loss, recovery can issue only one reconciliation token, and duplicate sequence allocation is impossible. Every case has a fresh token/client/reset lifecycle. Also prove project/admin/import/export writes serialize by idempotency/revision without a case lease, and disk-full/backup failures cannot acknowledge or PASS work.

### T-025 — Interrupted evaluation cannot become PASS
Status: NOT_RUN

Covers: `FR-13`, `NFR-05`. Terminate during case invariant persistence and gate aggregation; cancel/crash cases between corpus entries; resume reconciliation; and verify transactional rollback or incomplete REVIEW/ERROR, never partial PASS. FAIL still dominates, and only all exact required case runs complete PASS may aggregate PASS.

### T-026 — Duplicate proxy request ID is idempotent
Status: NOT_RUN

Covers: `FR-07`, `FR-08`. Send the same transport request ID concurrently and after restart. One exchange is authoritative; a different request ID under the same case/logical job/run operation and exact material adds an attempt. The same logical job in another build/gate/case creates a distinct run operation. Changed material, stale epoch, token copy, or second commit fails closed.

### T-027 — Cross-platform canonical result ignores run envelope
Status: NOT_RUN

Covers: `NFR-01`, `NFR-10`. Compare canonical results across macOS, Linux, and Windows while wall time/path/host metadata differ only in excluded envelope fields.

### T-028 — Database migration preserves immutable historical results
Status: NOT_RUN

Covers: `NFR-05`, `NFR-08`. Migrate a fixture through every schema version; prior digests and status semantics remain readable and unchanged.

## 6. Capture, regression, gate, and artifact tests

### T-029 — Installed capture remains quarantined until safe review
Status: NOT_RUN

Covers: `FR-11`. Capture the failure from the installed subject through the normal adapter/proxy/journal path and bind exact build/gate/case/session/run/manifest identity. It cannot enter a corpus before no-network quarantine, schema validation, secret scan, material resolution, sanitization, deterministic replay, and immutable review. Secret-bearing, nondeterministic, unresolved, unreviewed, caller-replaced, or identity-mismatched traces are rejected.

### T-030 — Disputed incident promotes only as ambiguity case
Status: NOT_RUN

Covers: `FR-10`, `FR-11`. Model issue-384-shaped disputed evidence with contradictory visibility. Promotion cannot declare loss/success ground truth; the evaluator returns REVIEW with `PRIVATE_NOT_VISIBLE` scope or `NOT_VISIBLE` reason where required.

### T-031 — Promoted regression replays to the same digest
Status: NOT_RUN

Covers: `FR-11`, `NFR-01`. Run the sanitized reviewed capture repeatedly before promotion; mismatched digests block it. Promotion creates a new immutable scenario and new corpus identity. Then run the corrected installed client through that promoted case and require full adapter/proxy/journal/kernel/gate PASS; replay-only PASS is insufficient.

### T-032 — Corpus revision pins exact scenario revisions
Status: NOT_RUN

Covers: `FR-12`. Revise or promote a scenario after corpus creation. Existing corpus remains unchanged; promotion atomically creates or explicitly targets a new corpus revision and the corrected-client gate run binds that new identity.

### T-033 — Removing a required case changes corpus identity
Status: NOT_RUN

Covers: `FR-12`, `INV-12`. Create corpus variants with reordered/removed/changed policy and verify distinct identities and visible diff.

### T-034 — Release aggregation follows fail-closed precedence
Status: NOT_RUN

Covers: `FR-13`. Create explicit GateRun/CaseRun states and enumerate all combinations: zero started required cases is NOT_RUN; FAIL dominates; otherwise queued, running, cancelled, aborted, crashed, recovery-pending, private, REVIEW, unsupported-required, stale, missing, unattested, effect-coverage-incomplete, identity-mismatched, or reset/teardown-incomplete yields REVIEW. PASS requires every exact required case complete PASS. `NOT_VISIBLE` remains only an evidence reason.

### T-035 — JSON, JUnit, and SARIF agree with gate result
Status: NOT_RUN

Covers: `FR-14`, `FR-18`. Generate all formats from one evaluation and assert identity/status/count parity. SARIF contains only source-locatable findings and never invents locations.

## 7. Security and privacy tests

### T-036 — Local listeners reject non-loopback exposure
Status: NOT_RUN

Covers: `FR-02`, `NFR-02`. Verify bind addresses and attempt access from another interface/container host; default service is unavailable externally.

### T-037 — Host, Origin, CORS, and token checks block browser attacks
Status: NOT_RUN

Covers: `FR-02`, `FR-17`. Exercise malicious origins, DNS-rebinding-style hosts, missing/wrong tokens, preflight, and CSRF attempts; state never changes.

### T-038 — SSRF and redirect targets are denied
Status: NOT_RUN

Covers: `FR-16`, `NFR-02`. Test private/link-local/metadata/loopback/IP-literal/DNS-rebound targets, alternate schemes, redirects, and proxy environment variables; no forbidden connection occurs.

### T-039 — Imported active content renders only as text
Status: NOT_RUN

Covers: `FR-11`, `FR-17`. Include HTML, script, SVG event handlers, terminal escapes, Markdown links, and instruction text; none executes, navigates, or changes product policy.

### T-040 — Path traversal and symlink escape are blocked
Status: NOT_RUN

Covers: `FR-17`, `FR-18`. Exercise import/export names, archive entries, local output paths, symlinks, UNC paths, and platform separators; writes remain in explicitly chosen targets.

### T-041 — Export privacy scan blocks sensitive material
Status: NOT_RUN

Covers: `FR-17`, `FR-18`. Seed credential, cookie, private key, signed payload, and sensitive-address findings. Export remains blocked and reports categories/locations without values.

### T-042 — Parser and service resource limits hold under abuse
Status: NOT_RUN

Covers: `NFR-06`. Fuzz large bodies, deep nesting, decompression bombs, slow clients, high concurrency, huge virtual delay, and event floods; service bounds resources and remains recoverable.

### T-043 — Explanation output cannot modify authoritative result
Status: NOT_RUN

Covers: `FR-09`, `NFR-12`. Inject malicious or contradictory optional explanation output. Stored invariant/gate fields and digest remain unchanged; UI labels explanation non-authoritative.

## 8. API and CLI tests

### T-044 — Control mutations are idempotent and schema-strict
Status: NOT_RUN

Covers: `FR-01`, `FR-02`, `FR-14`. Exercise attester enrollment/revocation, immutable build/effect-policy/manifest/inventory/interceptor registration, build/case/inventory/interceptor challenges, GateRun/CaseRun creation, recovery, promotion, and export. Prove a case token cannot enroll an attester, write boundary observations, or self-complete trust; validate local launcher signature/peer binding and CI OIDC signature/claims/freshness/revocation. Retry idempotency, changed bodies, stale revisions, challenge/token cross-use, unknown fields, and bounds. Builds/GateRuns never mutate when a later attestation appears.

### T-045 — Cursor pagination is stable under concurrent append
Status: NOT_RUN

Covers: `FR-07`, `FR-14`. Page session events while new events arrive. No duplicate/skip occurs relative to sequence order; invalid cursors fail clearly.

### T-046 — CLI exit codes distinguish pass, fail, review, config, internal, and policy denial
Status: NOT_RUN

Covers: `FR-14`. Exercise every documented exit code and assert stdout machine output remains parseable while human diagnostics use stderr.

## 9. UI, accessibility, and performance tests

### T-047 — Gate and evidence statuses are consistent across UI and API
Status: NOT_RUN

Covers: `FR-15`, `NFR-12`. Render execution lifecycle, separate verdict, evidence, subject build/attestation, effect-coverage basis/findings, artifact, enforcement, and separate official compatibility axes without collapsing them. Render GateRun/CaseRun/client/interceptor/token/epoch, logical-job/run-operation phases, subject reports versus independent boundary observations, inventory/interceptor freshness/process-tree scope, and capture/promotion lineage from persisted API records. Exercise all loading/empty/partial/stale/disconnected/retrying/identity/token/concurrent-client/interceptor/recovery/unsupported/privacy/resource states. Recovery exposes only reconciliation. Scenario evidence says “proven within scenario”; subject reports are labelled and `DECLARED_HOOKS_ONLY` shows REVIEW; no browser-only verdict, repository-blocking claim, or NOT_VISIBLE verdict is computed.

### T-048 — Complete keyboard journey works with visible focus
Status: NOT_RUN

Covers: `FR-15`, `NFR-07`. At default size and 200 percent zoom, a keyboard-only user creates a GateRun, starts an isolated case, inspects a phase/effect failure, performs fenced reconciliation, captures/quarantines/reviews/promotes a trace to a new corpus, verifies the corrected-client rerun, and plans export with logical unobscured focus and no pointer-only action.

### T-049 — Error summary and inline errors are announced
Status: NOT_RUN

Covers: `FR-15`, `NFR-07`. Submit invalid session/import forms using screen-reader testing; focus moves to summary, links target fields, inline errors are associated, and correction preserves input.

### T-050 — Status and timeline remain accessible without color or motion
Status: NOT_RUN

Covers: `FR-15`, `NFR-07`. Use monochrome/high-contrast/reduced-motion settings. Text/icon/structure preserve meaning; timeline has keyboard and table equivalents; streaming can pause.

### T-051 — Dense-session UI meets interaction and rendering targets
Status: NOT_RUN

Covers: `NFR-04`. Load 10,000 events and a 100-case corpus; measure evaluation, first visual feedback within 100 ms, per-action blocking below 200 ms, route cumulative layout shift below 0.1, and render targets on documented reference hardware. Verify pagination or prove focus/screen-reader-safe virtualization with the equivalent table path.

### T-052 — Responsive journeys pass at required widths and platforms
Status: NOT_RUN

Covers: `NFR-07`, `NFR-10`. Run visual/interaction checks at 375, 768, 1024, and 1440 px on supported browsers in dark, light, reduced-motion, and high-contrast contexts; repeat core journeys at 200 percent zoom. Assert no body horizontal scroll, clipped/obscured focus, inaccessible drawer/back behavior, status meaning by color alone, or token/component visual drift.

## 10. Installed-artifact and end-to-end tests

### T-053 — Redacted bundle verifies after clean extraction
Status: NOT_RUN

Covers: `FR-18`. Export, extract to a disposable directory, verify manifest/digests/identity, rescan secrets, and inspect declared exclusions without author-machine paths.

### T-054 — Clean install works offline for simulation and replay
Status: NOT_RUN

Covers: `NFR-02`, `NFR-10`, `NFR-11`. Install the built CLI/service/console, reviewed launcher, and supported interceptor on clean supported OS environments, create fresh data, disable provider network, and run the actual pinned client through CLI/API/UI/CI. Verify local launcher/interceptor keys, OS peer/process-tree binding, and private IPC where supported and honestly fall back to USER_ASSERTED/DECLARED_HOOKS_ONLY REVIEW where not; verify CI OIDC policy in CI. Restart/uninstall without exposure or user-data loss. Record source, lock, artifacts, effect policy/manifest/inventory/interceptor, principal policy/revocation, toolchain, commands, and exit codes required by RP-01.

### T-055 — Full local product journey captures and fixes a real client regression
Status: NOT_RUN

Covers: critical-path requirements/invariants and RP-02 through RP-06 plus RP-08; RP-07 is explicitly not required. From a clean install, use enrolled trust-rooted launcher/CI and interceptor principals to attest the actual pinned client, adapter, effect policy/manifest, optional call-site inventory, interceptor profile, GateRun, and isolated CaseRun. Run the subject inside the declared sandbox/process-tree boundary against a no-effect canary sink; declared-hooks-only or unavailable interception must honestly remain REVIEW and cannot complete `WORKING_LOCAL`. Run quote/finalization/commit, deterministic accepted-response loss, unsafe retry/effect, fenced reconciliation, and second-mutation denial. Capture/quarantine/sanitize/resolve/replay/review/promote to a new scenario/corpus, then run a genuinely corrected distinct artifact through it. Original/corrected state never merges. Require independent boundary observations, CLI/API/UI/CI parity, checksummed export, and clean reproduction. Reject self-attestation, mocks, seeds, caller-replaced traces, manual repair, direct-evaluator, replay-only, fixture-only, hard-coded, or prerecorded substitutes. Live dry remains separate.

### T-056 — Enforcement is capped at required-check-unverified
Status: NOT_RUN

Covers: `FR-13`, `NFR-12`, `INV-12`. Verify `LOCAL_ADVISORY`, `CI_CHECK`, and `REQUIRED_CHECK_UNVERIFIED`. Submit caller-supplied branch-protection screenshots/JSON/flags, stale workflow metadata, changed repository/commit/artifact/workflow identity, and claims that a check blocks merging. API/CLI/UI/export reject or label them unverified and never emit a verified/blocking state. The test performs no external configuration.

### T-057 — Gate decision is independent of artifact readiness
Status: NOT_RUN

Covers: `FR-13`, `FR-18`, `NFR-05`. For PASS, FAIL, REVIEW, and NOT_RUN decisions, force export/privacy/write success and failure independently. The decision remains unchanged while `artifactReady` changes, and artifact generation never creates a circular gate dependency.

### T-058 — Fork CI isolates secrets and unsafe artifacts
Status: NOT_RUN

Covers: `FR-14`, `FR-17`, `NFR-03`, `NFR-11`. Execute trusted-branch, pull-request, and fork-style CI matrices. Untrusted/fork jobs receive no provider secrets, cannot start the live-dry adapter, cannot upload unreviewed traces or secret-bearing artifacts, and retain a truthful advisory/check result.

### T-059 — Protected-effect observation is operation-bound and idempotent
Status: NOT_RUN

Covers: `FR-07`, `FR-08`, `FR-09`, `INV-04`. Authenticate a subject report with the case token and bind build/artifact/gate/case/session/run-operation, effect policy/manifest/hook, effect ID/type/action, fencing epoch, idempotency, and time. Exact retries return the original report; changed identities/actions, stale epoch, token copy, concurrent client, undeclared/forged hook, or mismatched manifest fails closed. Separately authenticate the interceptor through its private peer-bound channel and prove subject/control/case tokens cannot write `effect_boundary_observations`. Exercise exact duplicate boundary events, forged/stale interceptor, inventory/profile mismatch, omitted required sink, process-tree escape, and channel loss. Any incomplete independent coverage is REVIEW, not safe PASS; an observed forbidden release is FAIL. No real downstream effect executes.

## 11. Non-test validation

The following are separate from automated product tests:

- dependency/license and security review;
- source-claim freshness review;
- event-rule refresh;
- user interviews and design-partner evidence;
- demo/video/repository/submission verification;
- legal/privacy review for future hosted trace collaboration.

None is marked complete by this pack.

