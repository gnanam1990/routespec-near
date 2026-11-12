# RouteSpec build-status record

Record kind: implementation evidence log (from `docs/spec/templates/BUILD-STATUS.md`),
consolidated by M14 on 2026-11-12 from `docs/status/*.md`.

| Axis                                           | State                                                                                                                                                                                     |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Specification pack                             | `SPECIFICATION_ONLY` (sealed in `docs/spec/`, never edited)                                                                                                                               |
| Implementation                                 | M00–M14 implemented and merged to local `main` (M13 dependency upgrades, M14 container containment)                                                                                       |
| Product tests                                  | Local, win32/x64 host; container tests on Docker Engine 29.1.3 in WSL 2 (Ubuntu 24.04). Linux and macOS hosts: NOT_RUN                                                                    |
| Subject containment                            | **`PROCESS_TREE_ENFORCED`** for contained cases (engine-verified Linux container, real escape attempts blocked; M14). Uncontained runs stay `DECLARED_HOOKS_ONLY`                         |
| `WORKING_LOCAL` (RP-01..06, RP-08)             | **NOT REACHED — not claimed.** Containment, trust-rooted launches, and INV-04 now pass on the contained path; still unmet: real CI run (RP-05), capture rejection (RP-08), profile review |
| `OFFICIAL_ENDPOINT_COMPATIBLE` (RP-07)         | **BLOCKED** (needs a user-held provider JWT and an explicit user action)                                                                                                                  |
| Enforcement                                    | capped at `REQUIRED_CHECK_UNVERIFIED`; RouteSpec never claims it blocks a merge or release                                                                                                |
| Independent security review                    | NOT_RUN (needs a reviewer outside this team)                                                                                                                                              |
| Remote CI, deployment, publication, submission | NOT_RUN / NOT_AUTHORIZED                                                                                                                                                                  |

## Repository observation

- Local path: `C:\Users\Gnanam\Documents\Codex\Projects\routespec`, branch `main`. Module branches
  are merged with `--no-ff`; the final `main` HEAD is reported in the M14 handoff (a file cannot
  contain its own commit SHA).
- Remote `origin` is configured (`gnanam1990/routespec-near`) but nothing was pushed or fetched by
  any module: repository existence, visibility, and access are **UNVERIFIED**.
- Toolchain observed 2026-11-12: Windows 11 Home 10.0.26300 x64, Node v22.23.1, npm 10.9.8,
  pnpm 10.34.9, git 2.56.0.windows.4, SQLite 3.51.3 (`node:sqlite`), Playwright 1.65.0 (Chromium
  build 1254). Container runtime: WSL 3.0.5 (kernel 6.18.58.1), Ubuntu 24.04.5 LTS, Docker Engine
  29.1.3 (cgroup v2), image `node:22-bookworm-slim` id `sha256:e9f565d3…21ee` (Node 22.23.5).
  Lockfile `pnpm-lock.yaml` (frozen; offline install works from a clean clone).
- Dependencies (M13): zod 4.6.7, react-router 7.18.5, vitest 4.1.12 (tinypool no longer in the
  tree). `pnpm audit`: 13 advisories before M13, 5 after (node-forge, dev only, held by the
  two-week cool-down until 2026-11-18; minimatch through typescript-eslint).

## Module ledger

States: NOT_STARTED, IN_PROGRESS, IMPLEMENTED_UNVERIFIED, VERIFIED_BOUNDED, BLOCKED. Here,
**VERIFIED_BOUNDED** means every owned test ran and passed on this machine at the module boundary;
it is not a product, runtime, or cross-platform claim. **PARTIAL** marks a module whose owned
tests pass for the part this host can run, with a named part BLOCKED or NOT_RUN.

| Module | Name                                      | Merge      | State            | Owned tests (this host)                                              | Remaining gap                                                                                     | Evidence                     |
| ------ | ----------------------------------------- | ---------- | ---------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------- |
| M00    | Foundation and protocol contracts         | `7a4e095`  | VERIFIED_BOUNDED | T-027                                                                | T-027 on Linux/macOS NOT_RUN                                                                      | `docs/status/M00-M01-M03.md` |
| M01    | Domain states and durable persistence     | `f0a3184`  | VERIFIED_BOUNDED | T-001, T-002, T-006, T-007, T-022, T-023, T-024, T-026, T-028        | power-loss durability NOT_RUN                                                                     | `docs/status/M00-M01-M03.md` |
| M02    | Local proxy, recording, redaction         | `b467dc8`  | VERIFIED_BOUNDED | T-010, T-016, T-017                                                  | process-tree no-egress claim now holds for contained cases (M14)                                  | `docs/status/M02.md`         |
| M03    | Scenario DSL and deterministic faults     | `d586964`  | VERIFIED_BOUNDED | T-009, T-013, T-014, T-015                                           | T-009 on Linux/macOS NOT_RUN                                                                      | `docs/status/M00-M01-M03.md` |
| M04    | Invariant kernel and evidence             | `c7c21c2`  | VERIFIED_BOUNDED | T-003, T-004, T-005, T-008, T-018, T-019, T-043, T-059               | T-004 live complete-effect PASS now runs on the contained path (M14)                              | `docs/status/M04.md`         |
| M05    | Trace sanitizer and capture-to-regression | `a1449aa`  | VERIFIED_BOUNDED | T-029, T-030, T-031, T-032, T-033, T-039                             | declared-hooks-only captures are promoted with labels, not rejected (RP-08)                       | `docs/status/M05.md`         |
| M06    | Runner, CLI, release gates                | `3cb692b`  | VERIFIED_BOUNDED | T-012 (PARTIAL), T-025, T-034, T-035, T-041, T-046, T-053, T-057     | T-012 attestation sub-cases: M08 (HTTP/IPC) and M14 (contained launches)                          | `docs/status/M06.md`         |
| M07    | Official live dry adapter                 | `6556cb0`  | PARTIAL          | T-020 (local boundary only), T-021, T-038                            | **RP-07 real dry call BLOCKED** (user JWT + explicit action)                                      | `docs/status/M07.md`         |
| M08    | Local control API and build matrix        | `575a0fb`  | VERIFIED_BOUNDED | T-037, T-044, T-045                                                  | hosted CI OIDC token unused; probe route refuses; interceptor profiles stay `DECLARED_UNREVIEWED` | `docs/status/M08.md`         |
| M09    | Modern accessible web console             | `0d36bd7`  | VERIFIED_BOUNDED | T-047, T-048, T-049, T-050, T-051 (automated parts)                  | screen readers, manual high contrast, Firefox/WebKit, touch NOT_RUN                               | `docs/status/M09.md`         |
| M10    | GitHub Action and CI                      | `38a7d87`  | PARTIAL          | T-056, T-058 (simulated runner environment)                          | remote GitHub Actions runs NOT_RUN; CI attestation BLOCKED                                        | `docs/status/M10.md`         |
| M11    | Security, observability, hardening        | `d6888a8`  | PARTIAL          | T-011, T-036 (container-host part NOT_RUN), T-040 (1 skipped), T-042 | independent security review NOT_RUN; registry advisories triaged (5 left after M13)               | `docs/status/M11.md`         |
| M12    | End-to-end delivery verification          | `b766006`  | PARTIAL          | T-052 (Chromium/win32), T-054 (win32), T-055 (uncontained path)      | other platforms and browsers NOT_RUN; the export-boundary kill test was added by M14              | `docs/status/M12.md`         |
| M13    | Dependency major upgrades                 | `e195e5a`  | VERIFIED_BOUNDED | parity tests for T-014, T-044                                        | node-forge 1.4.3 held until 2026-11-18; minimatch not assigned                                    | `docs/status/M13.md`         |
| M14    | Container containment of the subject      | this stage | VERIFIED_BOUNDED | T-004 (live), T-010, T-012, T-055 (contained), T-059; RP-04 kill     | the three `WORKING_LOCAL` gaps below; plain-Linux Docker and other engines NOT_RUN                | `docs/status/M14.md`         |

All 59 canonical tests T-001..T-059 have an owning module above; none is claimed beyond its
recorded scope. M09a (console shell, `eb10eb5`) is the first stage of M09.

## Real-product gate matrix (`docs/spec/REAL-PRODUCT-GATE.md`)

Every row was run from a clean clone of the committed HEAD by `pnpm run test:delivery` (M12
uncontained journey and M14 contained journey) unless another source is named. "Met" lists what
ran for real; "Not met" is why the gate does not pass.

| Gate                                  | Result                     | Met (real, this host)                                                                                                                                                                                                                                                                                                                                                                                                                                     | Not met                                                                                                                                 |
| ------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| RP-01 Clean install and identity      | **MET (this environment)** | clean clone, frozen lockfile installed offline, CLI/service/console/launcher/interceptor built, fresh data directory, digests and commands recorded, no author path; an enrolled operator launcher key (local confirmation) attests BUILD_REGISTRATION, CASE_LAUNCH, and EFFECT_INTERCEPTOR_LAUNCH as separate immutable records through the standalone service; swapped artifact, revoked principal, challenge reuse, concurrent clients fail (M08, M14) | only Windows + Docker Engine in WSL 2 ran; the trust root is an operator key on the same machine (`LOCAL_LAUNCHER_KEY`), CI OIDC unused |
| RP-02 Actual client failure           | **MET (mechanics)**        | pinned SDK 0.1.26 build confined (`PROCESS_TREE_ENFORCED`), REQUIRED no-effect canary sink behind an attested independent interceptor, isolated case, accepted-then-lost response, unsafe resubmission refused, deterministic REVIEW (INV-03), boundary observations over the private channel                                                                                                                                                             | the interceptor profile record is `DECLARED_UNREVIEWED` (no profile review workflow)                                                    |
| RP-03 Genuine client correction       | **MET**                    | different artifact with its own attested registration, manifest, policies (one per scenario), fresh attested interceptor and client per case; the original build still fails on the identical revisions; the corrected build passes every required predicate (INV-01..04) with complete independent coverage on both cases; gate PASS                                                                                                                     | —                                                                                                                                       |
| RP-04 Durable recovery                | **MET**                    | stale token revoked, epoch 1 -> 2, one reconciliation-only token, second mutation and quote denied, read-only status allowed, restart on the same data; T-022/T-023, T-025 (evaluation and aggregation), and the M14 export-boundary kill (decision unchanged, readiness false, retry needs overwrite confirmation)                                                                                                                                       | —                                                                                                                                       |
| RP-05 Real product surfaces           | **PARTIAL**                | CLI, API, console read the same persisted records (decision, enforcement, coverage `COMPLETE` only from INV-04 PASS); keyboard, disconnect, pagination (M09); responsive (T-052); CI action from the clean install with a simulated runner environment                                                                                                                                                                                                    | no clean-checkout run on a real CI service (needs your push)                                                                            |
| RP-06 Security and isolation          | **MET (this environment)** | loopback/auth/Origin/CORS (T-036, T-037), token/build/client/epoch binding, attester enrollment/freshness/revocation (M08, M14), interceptor private channel, complete container process-tree and sink coverage with real escape attempts blocked (egress, DNS, gateway, IPv6, daemons, flood, writes), resource limits, canaries absent, safe deletion                                                                                                   | container-host access part of T-036 NOT_RUN; profile review and independent security review NOT_RUN                                     |
| RP-07 Official live-dry compatibility | **BLOCKED**                | denial before credential/DNS/socket, route allowlist, redirect and SSRF rejection, credential policy (T-020 local boundary, T-021, T-038)                                                                                                                                                                                                                                                                                                                 | the real `dry: true` call needs a user-held JWT and an explicit user action. Not part of `WORKING_LOCAL`                                |
| RP-08 Reproducible release evidence   | **PARTIAL**                | contained capture with independent observations and confinement, quarantine, sanitization, secret scan, identity resolved, deterministic replay (3 trials, one separate process), review, promotion to a new scenario and corpus, corrected rerun with fresh interceptors PASS, bundle exported, verified in a clean location, decision PASS reproduced; `CORRECTED_RUN_PASSED`                                                                           | the product does not refuse declared-hooks-only or unconfined captures at promotion (it labels them)                                    |

Claim: **no `WORKING_*` level is claimed.** M14 resolved the M12 blockers that were about this
host (containment, an independent interceptor, trust-rooted launches in the installed path,
complete-effect coverage, per-case policies, the export-boundary kill test). `WORKING_LOCAL` still
needs a clean-checkout run on a real CI service (RP-05, your action), refusal of
declared-hooks-only or unconfined captures as release evidence (RP-08, engineering), and a review
of the interceptor profile (RP-02/RP-06).

## Release-check record

| Gate run                         | Journey     | Decision | Subject build attestation | Effect coverage                               | `artifactReady`        | Enforcement      |
| -------------------------------- | ----------- | -------- | ------------------------- | --------------------------------------------- | ---------------------- | ---------------- |
| Baseline build, release corpus   | contained   | REVIEW   | `TRUSTED_LAUNCHER`        | `INDEPENDENT_BOUNDARY_INTERCEPT`, INV-04 PASS | not exported           | `LOCAL_ADVISORY` |
| Baseline build, promoted corpus  | contained   | REVIEW   | `TRUSTED_LAUNCHER`        | `INDEPENDENT_BOUNDARY_INTERCEPT`, INV-04 PASS | not exported           | `LOCAL_ADVISORY` |
| Corrected build, promoted corpus | contained   | **PASS** | `TRUSTED_LAUNCHER`        | `INDEPENDENT_BOUNDARY_INTERCEPT`, `COMPLETE`  | true (bundle verified) | `LOCAL_ADVISORY` |
| Corrected build, promoted corpus | uncontained | REVIEW   | `USER_ASSERTED_LOCAL`     | `DECLARED_HOOKS_ONLY`, INV-04 REVIEW          | true (bundle verified) | `LOCAL_ADVISORY` |

The baseline decisions are REVIEW because of INV-03 and INV-06 (no accepted terminal status). The
corrected decision was identical before and after export, and after a crash and restart.

## Test totals (this host, M14 branch with `main` merged)

| Suite                                                       | Command                     | Result                                                          |
| ----------------------------------------------------------- | --------------------------- | --------------------------------------------------------------- |
| Typecheck, lint, format, unit/integration, secret scan      | `pnpm run check`            | 74 files / 602 tests (601 passed, 1 skipped), secret scan clean |
| Container runtime tests (escape attempts, contained cases)  | `pnpm run test:containment` | 2 files / 11 passed (NOT_RUN with reason when no engine)        |
| Clean-clone delivery (T-054, T-055, M14 contained journey)  | `pnpm run test:delivery`    | 2 files / 20 passed (M12 14, M14 6)                             |
| Console against the real control service (Playwright + axe) | `pnpm run test:e2e:real`    | see `docs/status/M14.md` "Final verification"                   |
| Console fixture suite (simulated, development only)         | `pnpm run test:e2e`         | see `docs/status/M14.md` "Final verification"                   |

## External action ledger

All NOT_AUTHORIZED and NOT_RUN: push, fetch, remote creation, PR creation, remote merge, GitHub
Actions runs, deployment, public visibility, live dry-provider access (no 1Click API call, no
JWT), account creation, faucet use, wallet signing, fund movement, public post, demo recording,
and event submission. Funded integration is unsupported. Only local commits and local `--no-ff`
merges to `main` were made. Outbound requests: M11's read-only `pnpm audit` query and M13's
registry checks to the public npm registry, and M14's one `docker pull node:22-bookworm-slim`
from Docker Hub. No Windows feature or system setting was changed.

## Blocked / NOT_RUN items needing the user

See `docs/USER-NEXT-STEPS.md` for exact steps: the first remote CI run (the RP-05 gap), RP-07 live
dry probe with your own JWT, the independent security review (and with it an interceptor profile
review), the demo recording (only of gates that pass), Linux/macOS runs, and the node-forge
upgrade after 2026-11-18.
