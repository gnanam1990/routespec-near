---
project: RouteSpec
version: 2.0.0
artifact_status: SPECIFICATION_ONLY
security_review_status: NOT_RUN
updated_at: 2026-11-11
---

# Security and real-money safety

## 1. Security objective

RouteSpec must let an engineering team test payment lifecycle behavior without turning the test tool into a new custody, signing, credential-centralization, or real-money fault-injection risk.

This document is a threat model and design requirement. It is not a completed security review.

## 2. Assets

- 1Click JWT and other provider credentials held temporarily in memory.
- Integrator source, mandatory subject build/artifact/attestation, adapter, effect-policy/manifest, optional call-site inventory, and independent interceptor identity.
- Enrolled attester public keys/OIDC claim policies and monotonic revocation epochs; private launcher keys remain outside RouteSpec in the OS credential store.
- Local operation, address, transaction, and failure traces.
- Regression corpus and proprietary incident knowledge.
- Release decisions and evidence bundles.
- Local workstation and CI runner resources.
- User trust in PASS/FAIL/REVIEW semantics.

RouteSpec does not own customer funds, wallets, private keys, or signed transactions.

## 3. Threat actors and untrusted inputs

- Malicious or buggy integrator client.
- Malicious scenario/trace file.
- Compromised dependency or package.
- Local low-privilege process probing loopback or data files.
- Remote attacker attempting DNS rebinding, SSRF, CSRF, or browser-origin abuse.
- Insider exporting sensitive trace data.
- Misconfigured CI publishing credentials or traces.
- Provider response or issue text containing malicious strings/instructions.
- Buggy evaluator producing false PASS.
- Malicious subject forging hook reports or attempting to bypass, impersonate, or write through the independent effect interceptor.

Untrusted inputs include every HTTP request, header, provider response, scenario, YAML alias, JSON, imported trace, filename, URL, issue excerpt, repository content, model output, and browser parameter.

## 4. Hard real-money policy

### Supported modes

- `SIMULATE`: mutation-shaped requests may drive only a separately isolated networkless scenario runtime with no upstream client or provider credential capability.
- `REPLAY`: the same networkless runtime replays reviewed records locally.
- `LIVE_DRY_PROBE`: a separately launched egress-capable adapter permits only a narrowly allowlisted upstream read/dry request.

### Prohibited upstream actions

- committed quote (`dry: false`);
- deposit submission;
- token transfer or withdrawal;
- signed intent submission;
- wallet or chain signature;
- mainnet/testnet contract mutation;
- arbitrary status/address probing outside a reviewed profile;
- automatic retry of an uncertain mutation.

In the live-dry adapter, the request classifier and mode policy must run before provider credential attachment, DNS, connection creation, or body streaming upstream. A denial records credential, DNS, and upstream attempts as false. No UI flag or scenario field can override the policy. Simulation/replay has no upstream implementation to bypass.

### No “tiny amount” exception

Small value is still real value. The product must not move funds for demonstration optics. A future committed-traffic mode requires a new specification, security review, user authorization model, provider terms review, and explicit separation from the safe product.

## 5. Credential design

- The tested client uses a one-time case token plus stable non-secret session/case/logical-job/adapter/epoch headers. The token is bound to exact build/artifact, gate/case/session, client instance, adapter, allowed phases, and epoch; it is never a provider credential.
- Inbound provider `Authorization` is stripped/redacted before serialization and is not accepted as local authentication.
- Provider JWT input exists only in the separately launched live-dry adapter, through a protected environment variable or local no-echo prompt after policy preflight.
- Never accept credentials in CLI arguments, URLs, query parameters, project files, browser local/session storage, scenario files, or trace imports.
- Keep values in a narrow in-memory secret container; avoid copying to generic config objects.
- Attach authorization only after mutation classification and upstream allowlist approval.
- Redact before formatting/logging; do not serialize exception/request objects wholesale.
- Zero references and stop using the value at disconnect/expiry/process stop; do not claim guaranteed physical memory erasure in a managed runtime.
- The console receives only token state: `NOT_REQUIRED`, `OPTIONAL_ABSENT`, `PRESENT_IN_MEMORY`, or `EXPIRED`.
- Crash reporting is local and excludes memory dumps by default.

## 6. Local service security

- Bind to `127.0.0.1`/`::1` only; verify actual socket addresses.
- Reject Host headers outside the generated local origin set.
- Use high-entropy ephemeral control and case tokens stored as digests. Bind case tokens to exact subject/client/run identity and reject copy/reuse/concurrent clients.
- Separate control token, execution token, and recovery-only reconciliation token. Recovery revokes stale authority before incrementing the epoch.
- Set strict CORS to the local console origin; state-changing API requests require bearer auth and origin checks.
- Console uses CSP denying remote scripts, frames, and arbitrary connections.
- Secure cookies are unnecessary if bearer tokens remain in memory; do not fall back to ambient unauthenticated cookies.
- Rate-limit endpoints; bound gate-case parallelism; and isolate every case token/client/reset lifecycle.
- Do not expose a browser-accessible endpoint that returns provider credentials or raw sensitive payloads.
- The independent interceptor uses a distinct inherited authenticated pipe or equivalent owner-only process-local channel. It never accepts the control bearer token or subject case token, and no public HTTP route can write `effect_boundary_observations`.

## 7. Upstream network and SSRF defense

### Attester trust root and revocation

- Attester enrollment/revocation is a control-plane administrative mutation with explicit local confirmation. A subject client/case token, scenario, imported trace, browser content, or CI output cannot enroll itself.
- A local trusted launcher principal pins the reviewed launcher artifact digest and public key. Its private key stays in an OS credential store. Challenge completion additionally requires an inherited pipe and platform peer UID/PID/executable binding; if those guarantees are unavailable, the result remains `USER_ASSERTED_LOCAL`.
- A CI principal pins OIDC issuer/signing-key policy, audience, repository ID, workflow ref, ref/subject policy, and maximum token/JWK age. Verify signature and all identity/time/run/commit/nonce claims; do not accept a caller-created JSON assertion.
- Attestations record principal/policy/revocation epoch, issuance/verification/expiry, independently observed digests, and safe claim digest. They are append-only and never mutate a build or GateRun.
- Disabling/revoking a principal increments its epoch. New challenges fail; in-progress required cases become REVIEW; historical evidence remains immutable but cannot satisfy a new gate under a newer trust-policy snapshot.
- Challenge nonce and case token are separate capabilities. Possession of one never grants the other; reuse, cross-client copy, stale claims, signature mismatch, or concurrent completion fails closed.

### Effect-coverage trust boundary

- The subject observer is untrusted `SUBJECT_REPORTED` correlation only. A subject hook, manifest, uploaded call-site list, or absence of a report never proves that every effect path was instrumented.
- A trusted call-site inventory must be produced by a pinned compiler/plugin or binary scanner run by an enrolled launcher/CI principal over the exact source/build/artifact, then bound by an `EFFECT_INVENTORY` challenge. Record unsupported reflection, dynamic loading, native/FFI, generated code, and analyzer gaps. Any unresolved gap forces `DECLARED_HOOKS_ONLY` and REVIEW.
- Complete-effect PASS requires a separately attested interceptor outside the subject process. Its `EFFECT_INTERCEPTOR_LAUNCH` challenge binds reviewed interceptor artifact/profile, OS/container sandbox, process tree, supported sink classes, gate/case/session/epoch, and private-channel peer. A call-site inventory may strengthen identity but cannot replace this runtime boundary.
- The interceptor observes or denies only declared test sinks and redirects, if needed, to a local no-effect canary. It must never forward to the real email, webhook, filesystem, process, queue, task, API, or other downstream target.
- Process-tree escape, channel loss, missing teardown, unsupported sink, missing/forged/stale interceptor identity, or any bypassable boundary yields REVIEW. An independently observed forbidden release may still establish FAIL.
- Boundary observations and subject reports are immutable separate record types. The evaluator rejects subject-written source kinds, copied interceptor credentials, cross-case reuse, stale epochs, and changed inventory/profile digests.

- Compile the origin and route allowlist from an integrity-pinned local protocol profile. A signature claim requires a future signing ADR.
- Require HTTPS and validate certificates normally.
- Deny redirects by default.
- Resolve and reject loopback, private, link-local, multicast, metadata, and reserved addresses.
- Defend against DNS rebinding by binding the resolved address policy to the connection.
- Ignore user-controlled proxy environment variables unless explicitly reviewed.
- Do not allow scenario files to select hosts, schemes, ports, or headers.
- Limit response size, duration, redirects, and decompression ratio.

## 8. Scenario and import safety

- Parse YAML with unsafe types disabled and aliases bounded.
- Strict schema with unknown-field rejection in executable structures.
- Closed step enum; no `eval`, dynamic import, template execution, shell command, script, regex with catastrophic patterns, or arbitrary callback.
- Do not fetch URLs embedded in a file.
- Normalize filenames and prevent path traversal/symlink escape.
- Stream bounded input; enforce bytes, depth, events, strings, durations, and concurrency.
- Quarantine before rendering. Render imported text as text, never HTML.
- Scan for known configured secret values and high-confidence credential patterns.
- A secret finding blocks promotion/export; show category/path, not value.

## 9. Data protection

- Data directory uses owner-only permissions where supported.
- SQLite backups and exports inherit restrictive permissions.
- SQLite mutations pass through one writer queue/connection with busy timeout, explicit transaction mode, and declared synchronous policy. Session/execution-owned writes check the current monotonically increasing lease fencing epoch; administrative, project, import, and export writes use idempotency plus expected optimistic revision instead of a session lease.
- Checkpoint and verified backup failures or disk-full conditions stop acknowledgement and enter RECOVERY_REQUIRED/REVIEW; durability is never silently weakened.
- Addresses and transaction identifiers are not always secrets but may link identities; mask in default UI/export and warn before inclusion.
- Installed traces enter no-network quarantine under exact source identity. Raw unreviewed traces are never copied into ordinary RouteSpec persistence or synchronized. Sanitized quarantine content has the shortest retention; secrets, nondeterminism, unresolved material, or missing review block promotion.
- Export requires preview, privacy scan, explicit local path, and explicit overwrite confirmation.
- No telemetry or hosted sync by default.
- Deletion provides a dry-run plan and auditable local confirmation; document that SQLite/filesystem deletion may not guarantee physical media erasure without platform controls.

## 10. Evaluator integrity

- Domain kernel is pure and has no network, clock, random, database, or model dependency.
- Canonical inputs and evaluator revision are hashed.
- Property tests cover invariants and status lattice.
- Mutation testing is recommended for safety-critical rules.
- PASS requires complete required predicates for every exact required case. A complete-effect predicate additionally requires a fresh independently attested interceptor covering the full declared process-tree/sink boundary and complete runtime observations; trusted inventory is supplemental. `DECLARED_HOOKS_ONLY`, missing/forged/stale inventory or interceptor, unsupported dynamic call sites, incomplete teardown, or unobserved required sinks are REVIEW. Zero started required cases is NOT_RUN; partial, cancelled, recovery-pending, unattested, private, stale, unsupported, missing, identity-mismatched, or unknown values are REVIEW unless a proven FAIL dominates.
- Raw provider status and normalized fact are independently inspectable.
- Optional explanations cannot write result fields.
- Prior results are immutable when evaluator logic changes.

## 11. Release and supply chain

- Lock dependency versions and commit lockfile.
- Generate SBOM and license inventory for releases.
- Run vulnerability and secret scans; findings are reviewed, not auto-dismissed.
- Build from clean checkout in isolated CI.
- Checksums identify artifacts but do not prove semantic safety. No signed-manifest claim is permitted until a signing/key-lifecycle ADR is accepted.
- RouteSpec v2 emits advisory, CI-check, or required-check-unverified state only. It has no repository-settings verification adapter, rejects caller-supplied protection state as proof, and never claims release blocking. This pack authorizes no external configuration.
- No install script may modify firewall, SSH, wallet, browser, or system credentials.

## 12. Authorization matrix

| Action | Local engineer | CI | Console | Scenario file | Model |
|---|---:|---:|---:|---:|---:|
| Start simulation/replay | yes | yes | yes via authenticated control API | no | no |
| Enroll/revoke attester principal | explicit local admin confirmation | no | explicit authenticated admin UI only | no | no |
| Complete trusted build/case challenge | no | enrolled launcher or policy-matching CI identity only | no | no | no |
| Produce trusted effect inventory/interceptor observations | no | enrolled analyzer/interceptor principal only | displays status only | no | no |
| Start live dry probe | explicit local action | only with reviewed configuration | yes with warning | no | no |
| Supply provider JWT | protected local mechanism | protected secret store | no | no | no |
| Change safe-mode policy | no runtime bypass | no | no | no | no |
| Promote regression | explicit reviewed action | no default | yes authenticated | no | no |
| Decide verdict | no manual override | kernel only | displays result | no | no |
| Configure branch protection/required check | no authority from this pack | no | no | no | no |
| Export evidence | explicit action | reviewed workflow | plan/confirm | no | no |
| Move/sign funds | no | no | no | no | no |

## 13. Abuse cases

### AC-01 — Scenario requests a mainnet deposit submit

Compiler rejects the unsupported step/host; even if it reaches proxy request matching, mode policy denies before network.

### AC-02 — Authorization header appears in trace

Importer detects and blocks. The finding records path/category only. The user removes/rotates the credential outside RouteSpec; RouteSpec does not contact the provider.

### AC-03 — Client reuses logical job with changed or cross-case material

The same logical job in another build/gate/case creates a distinct run operation. Within a case, a changed recipient/material, copied token, client mismatch, or stale epoch fails before mutation. The journal records a safe violation and never rewrites the original binding.

### AC-03A — Provider response partially or repeatedly finalizes an operation

The quote request cannot include an assigned deposit address. The first complete quote response atomically assigns quote/correlation identity, returned constraints, response-assigned deposit address, and extensions. The first commit separately atomically binds method/route, body/material, finalized quote, deposit address, and transaction/signed material. Partial, changed, concurrent, second, or phase-invalid writes fail; exact repeats are idempotent.

### AC-04 — Provider says SUCCESS but destination proof is unavailable

Result is `SUCCESS_REPORTED` plus `PRIVATE_NOT_VISIBLE` scope/`NOT_VISIBLE` reason or `UNKNOWN` class for required proof. Verdict is REVIEW, not PASS.

### AC-05 — Malicious import contains HTML/script or instruction text

It is rendered as escaped text, cannot execute, cannot alter product instructions, and cannot make network requests.

### AC-06 — Local webpage attempts CSRF against service

Host/origin and bearer-token checks fail. State change requires a non-ambient token unavailable to the webpage.

### AC-07 — Process crashes after simulator accepts mutation but before response

The journal commit precedes simulated acceptance. Recovery revokes the stale token, increments the epoch, issues only read-only reconciliation authority, preserves unknown/accepted ground truth, and denies any second mutation or partial PASS.

### AC-08 — Forged or replayed protected-effect observation

The subject observer requires the current case token and exact build/artifact/gate/case/session/run-operation/manifest/hook/epoch/effect/idempotency binding. An exact retry returns the prior observation; a changed or stale binding fails closed. Subject reports never prove completeness. Only the separately attested interceptor may write boundary observations over peer-bound private IPC. Missing/forged/stale inventory or interceptor, incomplete process-tree/sink scope, unsupported dynamic calls, or unobserved required sinks yield REVIEW. Both observers have no capability to perform the real downstream effect.

### AC-09 — Tested client escapes the RouteSpec network boundary

RouteSpec proves no egress only for its networkless scenario processes. A claim covering the tested client's full process tree requires a documented OS/container sandbox plus process-tree DNS/socket instrumentation; otherwise the claim is explicitly out of scope.

## 14. Disclosure and claim limits

RouteSpec can establish that a declared client revision behaved according to a declared scenario/evidence model under a declared evaluator. It cannot establish that:

- NEAR Intents will behave identically in production;
- every supported chain or private leg was observed;
- an issue allegation is true;
- a report hash makes false input truthful;
- a passing integration has no bugs;
- an advisory or unverified CI check blocks a repository release;
- a provider will refund or recover funds;
- a customer or regulator accepts the evidence.

These limits must appear in UI exports and public documentation.

## 15. Security launch gates

- Independent review of mode policy, SSRF, credential flow, redaction, imports, evaluator, migrations, export, and local auth.
- Independent review of attester enrollment, launcher OS binding, CI OIDC claim verification, freshness, and revocation.
- Independent review of the build-time call-site analyzer, interceptor artifact/profile, private IPC authentication, sandbox/process-tree coverage, sink-denial behavior, and declared-hooks-only REVIEW fallback.
- Negative tests demonstrate no upstream socket for denied requests.
- Process separation proves simulation/replay has no upstream client or provider credential path; full sample-client no-egress claims additionally require sandbox/process-tree evidence.
- Canary-secret tests prove absence from every persistence/export/browser/log surface.
- Dependency/SBOM/license checks complete.
- Clean installation and uninstall leave no service exposed.
- No real-fund transaction used to pass security tests.
- Incident and disclosure contact/process documented for a future public release.

