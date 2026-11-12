# Review kit: independent security review

For: a security reviewer outside the RouteSpec team. It is self-contained: scope, a summary of the
threat model, where the code lives, the specific questions for each requirement in
`docs/spec/SECURITY.md`, how to run the suites, and a findings template.

Status today: the independent security review is `NOT_RUN` (`BUILD-STATUS.md`). Until it is done
and its findings are handled, production use is blocked. Reviewing does not need any provider
account, credential, wallet, or network access beyond installing dependencies.

## 1. What RouteSpec is, in one paragraph

A local-first release check for NEAR Intents 1Click clients. The user's real client runs against a
loopback, networkless scenario proxy that injects deterministic faults (for example "accepted, then
the response is lost"). A durable SQLite journal records what happened, a pure invariant kernel
evaluates it, and a gate aggregates cases into PASS / FAIL / REVIEW / NOT_RUN. Subjects can run
confined in a Linux container with an independent interceptor that observes protected effects. A
separately launched live-dry adapter may send one allowlisted `dry: true` request to the official
endpoint. RouteSpec never signs, deposits, or moves funds (`docs/spec/SECURITY.md` section 4).

## 2. Scope

In scope (the launch gates in `docs/spec/SECURITY.md` section 15):

1. mode policy, SSRF, credential flow, redaction, imports, evaluator, migrations, export, local auth;
2. attester enrollment, launcher OS binding, CI OIDC claim verification, freshness, revocation;
3. interceptor artifact and profile, private IPC authentication, sandbox and process-tree
   coverage, sink-denial behaviour, and the declared-hooks-only REVIEW fallback;
4. since M16: interceptor profile review signatures and the release-evidence classification
   (`docs/adr/0021-release-evidence-and-profile-review.md`);
5. since M17: container-host access and the seccomp requirement (`docs/adr/0020-container-host-access-and-minimatch-override.md`).

Not in scope: the official 1Click service itself, hosted deployment (there is none), funded
operation (unsupported), GitHub repository settings (RouteSpec never claims a check blocks a merge),
and the build-time call-site analyzer (not implemented; complete-effect coverage rests on the
runtime interceptor). Call out anything you think should be in scope.

## 3. Threat model summary

Read `docs/spec/SECURITY.md` in full; this is a map, not a substitute.

| Actor (SECURITY.md section 3)                         | Main boundary that must hold                                                     |
| ----------------------------------------------------- | -------------------------------------------------------------------------------- |
| Malicious or buggy client under test (the subject)    | case-token binding, container confinement, interceptor independence, INV-04      |
| Malicious scenario or trace file                      | closed scenario schema, bounded parsing, quarantine, text-only rendering         |
| Local low-privilege process or webpage on the machine | loopback bind, bearer token, Host/Origin/Fetch-Metadata checks, owner-only files |
| Remote attacker (DNS rebinding, SSRF, CSRF)           | Host allowlist, live-dry address policy and redirect denial                      |
| Compromised dependency                                | frozen lockfile, install-script audit, SBOM, advisories reviewed                 |
| Insider exporting sensitive traces                    | export preview, privacy scan, explicit path and confirmation                     |
| Buggy evaluator producing a false PASS                | pure kernel, fail-closed status lattice, PASS needs every required predicate     |
| Operator posing as reviewer                           | reviewer keys distinct from launcher keys, signed statements (M16)               |

Assets: provider JWT (memory only, live-dry adapter only), control/case/reconciliation tokens,
launcher and reviewer public keys and revocation epochs, traces and corpora, release decisions and
bundles, the workstation and CI runner.

## 4. Areas and files

| Area                                    | Code                                                                                                                                                | Decisions          |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| Local control API, auth, browser checks | `packages/control-api/src/security.ts`, `server.ts`, `http.ts`, `routes.ts`, `schemas.ts`                                                           | ADR-0013, ADR-0016 |
| Scenario proxy and redaction            | `packages/proxy/src/server.ts`, `http.ts`, `redact.ts`, `tripwire.ts`, `supervisor.ts`                                                              | ADR-0007           |
| Interceptor and private channel         | `packages/proxy/src/interceptor/canary-interceptor.ts`, `packages/proxy/src/interceptor-channel.ts`, `packages/control-api/src/containment-host.ts` | ADR-0007, ADR-0019 |
| Containment                             | `packages/containment/src/sandbox.ts`, `runtime.ts`, `verify.ts`, `shim.mjs`, `identity.ts`, `attesting-launcher.ts`                                | ADR-0019, ADR-0020 |
| Attestation and trust roots             | `packages/control-api/src/attestation.ts`, `packages/store/src/control.ts`, `packages/cli/src/launcher.ts`, `packages/ci/src/attestation.ts`        | ADR-0013           |
| Profile review                          | `packages/contracts/src/review.ts`, `packages/store/src/reviews.ts`, `packages/cli/src/review.ts`, migration `009-review-evidence.ts`               | ADR-0021           |
| Evaluator                               | `packages/kernel/src/` (`invariants/inv04.ts`, `evaluate.ts`, `verdict.ts`, `snapshot.ts`), `packages/runner/src/aggregate.ts`, `gate-snapshot.ts`  | ADR-0009, ADR-0012 |
| Live-dry adapter, SSRF, credential      | `packages/live-dry-adapter/src/policy.ts`, `address-policy.ts`, `egress.ts`, `credential.ts`, `launch.ts`, `process.ts`                             | ADR-0011           |
| Scenario parsing and limits             | `packages/scenario/src/parse.ts`, `schema.ts`, `compile.ts`, `budget.ts`                                                                            | ADR-0006           |
| Imports and quarantine                  | `packages/regressions/src/ingest.ts`, `quarantine.ts`, `scan.ts`, `limits.ts`, `trace.ts`, `release-evidence.ts`                                    | ADR-0010, ADR-0021 |
| Persistence and migrations              | `packages/store/src/database.ts`, `guards.ts`, `store.ts`, `migrations/`                                                                            | ADR-0004           |
| Export and bundles                      | `packages/runner/src/bundle.ts`, `tar.ts`, `packages/regressions/src/export-scan.ts`                                                                | ADR-0012, ADR-0021 |
| Hardening (paths, canaries, processes)  | `packages/hardening/src/paths.ts`, `canary.ts`, `processes.ts`, `supply-chain.ts`; `scripts/secret-scan.mjs`                                        | ADR-0016           |
| CI action                               | `packages/ci/src/`, `.github/workflows/`, `docs/ci/`                                                                                                | ADR-0015           |
| Console (CSP, token handling)           | `apps/console/src/api/`, `apps/console/src/app/`                                                                                                    | ADR-0008, ADR-0014 |

Decisions are in `docs/adr/`; per-module evidence and known limits are in `docs/status/`.

## 5. Questions per SECURITY.md requirement

Answer each with "holds", "does not hold (finding id)", or "not reviewed". The test named next to a
question is where the build claims evidence; please challenge the test as well as the code.

### 5.1 Hard real-money policy (section 4)

1. Can any request shape reach an upstream socket in `SIMULATE` or `REPLAY`? Is there any upstream
   client or provider credential reachable from the scenario runtime? (T-010, T-017)
2. In the live-dry adapter, do classification and mode policy run before credential attachment,
   DNS, socket creation, and body streaming, for every path including errors? (T-020, T-021)
3. Can a committed quote (`dry: false`), deposit, signature, or transfer be sent by any flag,
   scenario field, environment variable, or console action?
4. Is there any automatic retry of an uncertain mutation?

### 5.2 Credentials (section 5)

1. Is the case token bound to build, artifact, gate, case, session, client instance, adapter,
   phases, and epoch, and is reuse across clients refused? (T-059, T-024)
2. Is an inbound provider `Authorization` header stripped before serialization and never accepted
   as local auth? (T-016, `redact.ts`)
3. Is the provider JWT accepted only through the protected environment variable or no-echo prompt
   of the live-dry adapter, and never through argv, URLs, files, browser storage, or traces?
4. Do any logs, errors, or child-process arguments carry a secret? (T-011, M11 persistence guard)
5. Does the console only ever receive token state, never a value?

### 5.3 Local service (section 6)

1. Does the service bind only to loopback, verify the actual socket address, and refuse other
   interfaces and container hosts? (T-036 including the M17 container-host runtime test)
2. Are Host, Origin, and Fetch Metadata checks complete against DNS rebinding and CSRF; is
   `Access-Control-Allow-Origin` never sent to a foreign origin; are preflights refused? (T-037)
3. Is the control token accepted only in `Authorization: Bearer`, never in a query string or
   cookie, and is it stored only as a digest? Is the token fragment removed from the console URL?
4. Are control, execution, and reconciliation tokens separate, and does recovery revoke the stale
   token before incrementing the epoch? (T-022, T-023, T-024)
5. Are rate limits and case parallelism bounded? (T-042)
6. Can any public HTTP route write `effect_boundary_observations`? Can the interceptor channel be
   reached with the control or case token? (T-059)

### 5.4 Attester trust root, revocation, effect coverage (section 7)

1. Can enrollment or revocation happen without the local confirmation code delivered on the
   operator channel? Is the code single use, short lived, and bound to the plan digest? (T-044)
2. Does a launcher challenge require the inherited pipe and peer binding; does it fall back to
   `USER_ASSERTED_LOCAL` when those are missing? (T-012, M14)
3. CI OIDC: are issuer, signing key policy, audience, repository, workflow ref, subject, commit,
   run, nonce, and token/JWK age all verified? (Implemented but never exercised with a real hosted
   token; `docs/status/M08.md`.)
4. Does revocation increment the epoch, fail new challenges, and turn in-progress required cases
   into REVIEW without rewriting history? (T-012)
5. Can a subject forge, replay, or copy a boundary observation, or bypass the interceptor? Do
   channel loss, missing teardown, process-tree escape, or an unsupported sink yield REVIEW?
   (T-004, T-059, `pnpm run test:containment`)
6. Does a missing seccomp filter, a weaker engine setting, or an unverifiable container record
   downgrade to `DECLARED_HOOKS_ONLY`? (M17)
7. Profile review (M16): can a launcher key become a reviewer key or the reverse? Can the control
   token alone produce a review? Is the signed statement complete (profile fields, reviewer key
   digest, decision, checklist, nonce, expiry) and are challenges single use? Is a revoked review
   or reviewer ignored at evaluation and at capture classification? (`m16-profile-review.test.ts`,
   T-004)

### 5.5 Upstream network and SSRF (section 7)

1. Are loopback, private, link-local, multicast, metadata, and reserved addresses rejected after
   resolution, and is the resolved address bound to the connection (DNS rebinding)? (T-038)
2. Are redirects denied, proxy environment variables ignored, and HTTPS with normal certificate
   validation required?
3. Can a scenario choose a host, scheme, port, or header?
4. Are response size, duration, and decompression ratio bounded?

### 5.6 Scenario and import safety (section 8)

1. Is YAML parsed without unsafe types and with bounded aliases; are unknown fields rejected? (T-014)
2. Is there any `eval`, dynamic import, template execution, or catastrophic regex reachable from a
   scenario or trace?
3. Are filenames normalized and symlinks, UNC paths, and traversal refused? (T-040; one symlink
   sub-case is skipped on Windows without privilege)
4. Is imported text quarantined and rendered only as text in the console? (T-039)
5. Does a secret finding block promotion and export, reporting only category and path? (T-029, T-041)

### 5.7 Data protection (section 9)

1. Are the data directory, backups, logs, and exports owner-only where the platform supports it?
2. Is there a single writer with fencing; can a stale worker write? (T-024)
3. Do checkpoint, backup, or disk-full failures stop acknowledgement rather than weaken durability?
4. Does export require preview, privacy scan, explicit path, and overwrite confirmation? (T-041, T-053)
5. Is there any telemetry or network sync? Does safe deletion do what it says, with the documented
   physical-erasure limit? (M11 safe deletion)

### 5.8 Evaluator integrity (section 10)

1. Is the kernel pure (no network, clock, randomness, database, or model)?
2. Can any partial, cancelled, recovery-pending, unattested, stale, unsupported, or unknown input
   reach PASS? Can zero started cases be anything but NOT_RUN? (T-003, T-005, T-008, T-019, T-025)
3. Can explanation output change a stored result? (T-043)
4. Are prior results immutable when the evaluator revision changes (`GATE_EVALUATOR_STALE`)?
5. Release evidence (M16): can a declared-hooks-only, unconfined, unattested, or unreviewed capture
   become a required case or a release-evidence bundle by any path (promotion, corpus revision,
   gate aggregation, export)? (`m16-release-evidence.test.ts`, T-031)

### 5.9 Release and supply chain (section 11)

1. Is the lockfile frozen and does `pnpm run audit:supply-chain` reflect reality (licenses,
   install scripts)? Review the open node-forge advisories (dev only, see `BUILD-STATUS.md`) and the
   minimatch override (ADR-0020).
2. Do any install scripts touch firewall, SSH, wallet, browser, or system credentials?
3. Is any checksum presented as a signature? (Bundles carry checksums; a full rewrite of a bundle is
   not detected, ADR-0012.)
4. Does any surface claim that RouteSpec blocks a merge or release? (T-056)
5. CI: do fork and pull-request jobs get no secrets and no live-dry adapter? (T-058)

### 5.10 Authorization matrix and abuse cases (sections 12 and 13)

For each row of the matrix and each abuse case AC-01 to AC-09, confirm that the stated actor
cannot perform the action, or record a finding.

## 6. How to run the suites

Node 22.18 or newer and pnpm 10 (the version in `package.json`). From a clean checkout:

```sh
pnpm install --frozen-lockfile
pnpm run check                 # typecheck, lint, format, unit/integration tests, secret scan
pnpm run audit:supply-chain    # offline lockfile, license, and install-script audit
```

With a container engine (Docker Engine; on Windows inside WSL 2, see
`docs/runbooks/container-containment.md`):

```sh
export ROUTESPEC_CONTAINER_CLI='["docker"]'
pnpm run test:containment      # escape attempts, T-036 container-host access, contained cases
pnpm run test:delivery         # clean clone, offline install, both product journeys
```

Without an engine these report `NOT_RUN` with a reason, which is not a pass. With a browser
installed for Playwright (`pnpm --filter @routespec/console exec playwright install chromium`):

```sh
pnpm run test:e2e:real         # console against the real service, including axe checks
```

Focused runs: `pnpm exec vitest run packages/security-suite` (or any test file path). On a shared
machine, give runtime suites their own ports with `ROUTESPEC_TEST_PORT_BASE=<base>` and
`ROUTESPEC_DELIVERY_PORT=<port>`.

Mutation testing evidence is recorded in `docs/status/M11.md` and `docs/status/M16.md`; reruns of
your own mutations are welcome. Do not run anything against the official endpoint: RP-07 needs the
owner's credential and explicit action.

## 7. Findings template

One block per finding; keep values (tokens, keys) out of the report.

```text
ID:              SEC-<nn>
Title:
Severity:        critical | high | medium | low | informational
SECURITY.md:     section / requirement (or "new")
Affected:        file:line, route, command, or surface
Preconditions:   attacker position (subject, local process, webpage, scenario file, insider, ...)
Description:
Reproduction:    exact commands or requests (redacted)
Impact:          what an attacker gains; does it reach PASS, a secret, egress, or funds?
Suggested fix:
Test to add:     the test that should fail before the fix
Status:          open | fixed in <commit> | accepted risk (who, why)
```

Summary sheet for the owner:

```text
Reviewer role / organisation:
Commit reviewed:
Dates:
Areas reviewed (section 5 numbers):        Not reviewed:
Suites run and results:
Findings by severity:  critical _  high _  medium _  low _  info _
Overall opinion on the section 15 launch gates:
```

## 8. After the review (owner)

Record the summary and findings in a new `docs/status/` entry, link it from `BUILD-STATUS.md`
("Independent security review"), fix or explicitly accept each finding, and rerun the suites in
section 6 on the fixed commit.
