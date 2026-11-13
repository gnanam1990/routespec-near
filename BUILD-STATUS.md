# RouteSpec build-status record

Record kind: implementation evidence log (from `docs/spec/templates/BUILD-STATUS.md`),
consolidated by M18 on 2026-11-12 from `docs/status/*.md` and a full regression run on the
consolidation branch (`main` at `bd66faf` plus a test-port configuration and the T-051 console focus fix; `docs/status/M18.md`).
Updated by M41 on 2026-11-13: the real CI run (RP-05) observed, a judge-visible FAIL case in the
delivery journey, concrete audit names, ADR numbering, and the console Gate summary default.

| Axis                                           | State                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Specification pack                             | `SPECIFICATION_ONLY` (sealed in `docs/spec/`, never edited)                                                                                                                                                                                                                                                                                                                      |
| Implementation                                 | M00–M17 implemented and merged to local `main` (M15 CI runner fix, M16 release-evidence refusal and profile review, M17 container-host access); M18 consolidation                                                                                                                                                                                                                |
| Product tests                                  | Local, win32/x64 host; container tests on Docker Engine 29.1.3 in WSL 2 (Ubuntu 24.04). `pnpm run check` also ran green on GitHub-hosted ubuntu-24.04, windows-2022, and macos-15 (`ci` run 43272644091 on `ab9b89f`); the contained journey and `test:delivery` on Linux/macOS hosts: NOT_RUN                                                                                   |
| Subject containment                            | **`PROCESS_TREE_ENFORCED`** for contained cases (engine-verified Linux container, seccomp filter required in the self-observation, real escape and container-host attempts blocked; M14, M17). Uncontained runs stay `DECLARED_HOOKS_ONLY`                                                                                                                                       |
| Release evidence (RP-08)                       | Ineligible captures are **refused** as release evidence (`RS_CAPTURE_NOT_RELEASE_EVIDENCE`) at promotion, corpus creation, gate aggregation, and export; `DIAGNOSTIC_ONLY` is an explicit, advisory-only choice (M16)                                                                                                                                                            |
| Interceptor profile review                     | Signed-review workflow real and enforced by INV-04 (M16). On this host only a **locally generated test reviewer key** reviewed the profile; the **independent review is NOT_RUN**                                                                                                                                                                                                |
| `WORKING_LOCAL` (RP-01..06, RP-08)             | **NOT REACHED — not claimed.** RP-05 is now met (real CI run observed, below). Still unmet: an independent review of the interceptor profile (RP-02/RP-06), a contained gate run on that review, and a `test:delivery` rerun on that commit                                                                                                                                      |
| `OFFICIAL_ENDPOINT_COMPATIBLE` (RP-07)         | **BLOCKED** (needs a user-held provider JWT and an explicit user action)                                                                                                                                                                                                                                                                                                         |
| Enforcement                                    | capped at `REQUIRED_CHECK_UNVERIFIED`; RouteSpec never claims it blocks a merge or release                                                                                                                                                                                                                                                                                       |
| Independent security review                    | NOT_RUN (needs a reviewer outside this team)                                                                                                                                                                                                                                                                                                                                     |
| Remote CI, deployment, publication, submission | Remote CI: **observed green** — `ci` [run 43272644091](https://github.com/gnanam1990/routespec-near/actions/runs/43272644091) and `routespec-gate` [run 43272644038](https://github.com/gnanam1990/routespec-near/actions/runs/43272644038) on `ab9b89f`; both again on `bfd3065` (runs 43357797047, 43357797080). Deployment, publication, submission: NOT_RUN / NOT_AUTHORIZED |

## Repository observation

- Local repository `routespec`, branch `main`. Module branches are merged with `--no-ff`; the
  final `main` HEAD is reported in the M18 handoff (a file cannot contain its own commit SHA).
- Remote `origin` is configured (`gnanam1990/routespec-near`). No module pushed; the repository
  owner pushes. M41 read the resulting GitHub Actions runs (read-only `gh run view` and
  `gh run list`): see "Remote CI (RP-05)" below.
- Branches: one `feat/routespec-mNN-*` branch per module, merged with `--no-ff` and kept. M00–M18
  are the build modules, M19 the reviewer kits, M40 onward the hackathon write-up and screening
  fixes. `feat/routespec-m20-*` to `feat/routespec-m29-*` are **security-fix branches**, one per
  audit finding: m20 vuln-0001, m21 vuln-0002, m22 vuln-0003, m23 RS-01, m24 RS-02, m25 RS-03,
  m26 RS-04, m27 RS-05, m28 RS-06, m29 RS-07.
- Toolchain observed 2026-11-12: Windows 11 Home 10.0.26300 x64, Node v22.23.1, pnpm 10.34.9,
  git 2.56.0.windows.4, SQLite 3.51.3 (`node:sqlite`), Playwright 1.65.0 (Chromium). Container
  runtime: WSL 3.0.5 (kernel 6.18.58.1, networking mode `nat`), Ubuntu 24.04, Docker Engine
  29.1.3 (cgroup v2, seccomp `builtin`), image `node:22-bookworm-slim` id
  `sha256:e9f565d3…21ee`. Lockfile `pnpm-lock.yaml` (frozen; offline install works from a clean
  clone).
- Dependencies: zod 4.6.7, react-router 7.18.5, vitest 4.1.12 (M13); minimatch 11.0.3 through a
  scoped pnpm override (M17). `pnpm audit` on 2026-11-12 (M18, read-only): **4 advisories**
  (1 low, 3 moderate), all node-forge 1.4.2 (dev only, live-dry adapter test certificates),
  patched in 1.4.3, held by the two-week cool-down until 2026-11-18. The minimatch advisory is
  resolved.

## Module ledger

States: NOT_STARTED, IN_PROGRESS, IMPLEMENTED_UNVERIFIED, VERIFIED_BOUNDED, BLOCKED. Here,
**VERIFIED_BOUNDED** means every owned test ran and passed on this machine at the module boundary;
it is not a product, runtime, or cross-platform claim. **PARTIAL** marks a module whose owned
tests pass for the part this host can run, with a named part BLOCKED or NOT_RUN.

| Module | Name                                                       | Merge      | State            | Owned tests (this host)                                                                                                                                  | Remaining gap                                                                                 | Evidence                     |
| ------ | ---------------------------------------------------------- | ---------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------- |
| M00    | Foundation and protocol contracts                          | `7a4e095`  | VERIFIED_BOUNDED | T-027                                                                                                                                                    | — (T-027 parity also ran on Linux/macOS in `ci` run 43272644091)                              | `docs/status/M00-M01-M03.md` |
| M01    | Domain states and durable persistence                      | `f0a3184`  | VERIFIED_BOUNDED | T-001, T-002, T-006, T-007, T-022, T-023, T-024, T-026, T-028                                                                                            | power-loss durability NOT_RUN                                                                 | `docs/status/M00-M01-M03.md` |
| M02    | Local proxy, recording, redaction                          | `b467dc8`  | VERIFIED_BOUNDED | T-010, T-016, T-017                                                                                                                                      | —                                                                                             | `docs/status/M02.md`         |
| M03    | Scenario DSL and deterministic faults                      | `d586964`  | VERIFIED_BOUNDED | T-009, T-013, T-014, T-015                                                                                                                               | — (T-009 parity also ran on Linux/macOS in `ci` run 43272644091)                              | `docs/status/M00-M01-M03.md` |
| M04    | Invariant kernel and evidence                              | `c7c21c2`  | VERIFIED_BOUNDED | T-003, T-004, T-005, T-008, T-018, T-019, T-043, T-059                                                                                                   | — (INV-04 needs an effective profile review since M16, `routespec-kernel@1.1.0`)              | `docs/status/M04.md`         |
| M05    | Trace sanitizer and capture-to-regression                  | `a1449aa`  | VERIFIED_BOUNDED | T-029, T-030, T-031, T-032, T-033, T-039                                                                                                                 | — (ineligible captures are refused since M16)                                                 | `docs/status/M05.md`         |
| M06    | Runner, CLI, release gates                                 | `3cb692b`  | VERIFIED_BOUNDED | T-012, T-025, T-034, T-035, T-041, T-046, T-053, T-057                                                                                                   | T-012 attestation sub-cases completed by M08 and M14; T-025 and T-057 show rare timing flakes | `docs/status/M06.md`         |
| M07    | Official live dry adapter                                  | `6556cb0`  | PARTIAL          | T-020 (local boundary only), T-021, T-038                                                                                                                | **RP-07 real dry call BLOCKED** (user JWT + explicit action)                                  | `docs/status/M07.md`         |
| M08    | Local control API and build matrix                         | `575a0fb`  | VERIFIED_BOUNDED | T-037, T-044, T-045                                                                                                                                      | hosted CI OIDC token unused; probe route refuses                                              | `docs/status/M08.md`         |
| M09    | Modern accessible web console                              | `0d36bd7`  | VERIFIED_BOUNDED | T-047, T-048, T-049, T-050, T-051 (automated parts)                                                                                                      | screen readers, manual high contrast, Firefox/WebKit, touch NOT_RUN                           | `docs/status/M09.md`         |
| M10    | GitHub Action and CI                                       | `38a7d87`  | PARTIAL          | T-056, T-058 (simulated runner environment); hosted `routespec-gate` runs 43272644038 and 43357797080 green                                              | CI attestation BLOCKED (OIDC unused); enforcement still capped at `REQUIRED_CHECK_UNVERIFIED` | `docs/status/M10.md`         |
| M11    | Security, observability, hardening                         | `d6888a8`  | PARTIAL          | T-011, T-036, T-040 (1 skipped), T-042                                                                                                                   | independent security review NOT_RUN (T-036 container-host part closed by M17)                 | `docs/status/M11.md`         |
| M12    | End-to-end delivery verification                           | `b766006`  | PARTIAL          | T-052 (Chromium/win32), T-054 (win32), T-055 (uncontained path)                                                                                          | other platforms and browsers NOT_RUN                                                          | `docs/status/M12.md`         |
| M13    | Dependency major upgrades                                  | `e195e5a`  | VERIFIED_BOUNDED | parity tests for T-014, T-044                                                                                                                            | node-forge 1.4.3 held until 2026-11-18                                                        | `docs/status/M13.md`         |
| M14    | Container containment of the subject                       | `9f43586`  | VERIFIED_BOUNDED | T-004 (live), T-010, T-012, T-055 (contained), T-059; RP-04 kill                                                                                         | plain-Linux Docker and other engines NOT_RUN                                                  | `docs/status/M14.md`         |
| M15    | CI runner fix (Playwright Chromium, macOS)                 | `dff3aa7`  | VERIFIED_BOUNDED | `ci` on ubuntu-24.04, windows-2022, macos-15 green ([run 43272644091](https://github.com/gnanam1990/routespec-near/actions/runs/43272644091), `ab9b89f`) | —                                                                                             | commit `f82247f`             |
| M16    | Release-evidence refusal, profile review                   | `bd66faf`  | PARTIAL          | T-004, T-031, T-053, T-055; M16 store/security-suite/console suites                                                                                      | independent human review of the canary interceptor profile NOT_RUN (user action)              | `docs/status/M16.md`         |
| M17    | Container-host access (T-036), minimatch                   | `d0738e0`  | VERIFIED_BOUNDED | T-036 (container-host part, real engine), tunnel teardown, seccomp                                                                                       | WSL `mirrored` mode, plain Linux Docker, rootless engines NOT_RUN                             | `docs/status/M17.md`         |
| M18    | Consolidation and full regression                          | `262b663`  | VERIFIED_BOUNDED | full regression (table below); T-051 slow-page focus (new); configurable test port window                                                                | — (T-051 focus defect found and fixed)                                                        | `docs/status/M18.md`         |
| M41    | Screening fixes (judge-visible FAIL, CI evidence, console) | this stage | VERIFIED_BOUNDED | T-055 hedged-submission case (uncontained and contained journeys); console Gate summary default (unit + fixture e2e)                                     | —                                                                                             | this file, `README.md`       |

All 59 canonical tests T-001..T-059 have an owning module above; none is claimed beyond its
recorded scope. M09a (console shell, `eb10eb5`) is the first stage of M09.

## Real-product gate matrix (`docs/spec/REAL-PRODUCT-GATE.md`)

Every row was re-run by M18 from a clean clone of the committed consolidation HEAD with
`pnpm run test:delivery` (uncontained journey and contained journey, engine configured) unless
another source is named. "Met" lists what ran for real; "Not met" is why the gate does not pass.

| Gate                                  | Result                                            | Met (real, this host)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Not met                                                                                                                                                       |
| ------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RP-01 Clean install and identity      | **MET (this environment)**                        | clean clone, frozen lockfile installed offline, CLI/service/console/launcher/interceptor built, fresh data directory, digests and commands recorded, no author path; an enrolled operator launcher key (local confirmation) attests BUILD_REGISTRATION, CASE_LAUNCH, and EFFECT_INTERCEPTOR_LAUNCH as separate immutable records; swapped artifact, revoked principal, challenge reuse, concurrent clients fail (M08, M14); a launcher key cannot be a reviewer key and the reverse (M16)                                                                                                                                                                                                                                                                                                                                                                                         | only Windows + Docker Engine in WSL 2 ran here; the trust root is an operator key on the same machine (`LOCAL_LAUNCHER_KEY`), CI OIDC unused                  |
| RP-02 Actual client failure           | **PARTIAL (independent profile review NOT_RUN)**  | pinned SDK 0.1.26 build confined (`PROCESS_TREE_ENFORCED`), REQUIRED no-effect canary sink behind an attested independent interceptor, isolated case, accepted-then-lost response, unsafe resubmission refused, deterministic REVIEW (INV-03), boundary observations over the private channel; the interceptor profile is `REVIEWED` through a signed review by an enrolled reviewer key distinct from every launcher key, and INV-04 requires that review (M16)                                                                                                                                                                                                                                                                                                                                                                                                                  | the review that makes the profile `REVIEWED` is signed by a locally generated test key held by the same operator; an independent reviewer's review is NOT_RUN |
| RP-03 Genuine client correction       | **MET (with the test-reviewed profile)**          | different artifact with its own attested registration, manifest, policies (one per scenario), fresh attested interceptor and client per case; the original build still fails on the identical revisions; the corrected build passes every required predicate (INV-01..04) with complete independent coverage on both cases; gate PASS                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | complete coverage rests on the same test-key profile review as RP-02                                                                                          |
| RP-04 Durable recovery                | **MET**                                           | stale token revoked, epoch 1 -> 2, one reconciliation-only token, second mutation and quote denied, read-only status allowed, restart on the same data; T-022/T-023, T-025 (evaluation and aggregation), and the M14 export-boundary kill (decision unchanged, readiness false, retry needs overwrite confirmation)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | —                                                                                                                                                             |
| RP-05 Real product surfaces           | **MET**                                           | CLI, API, console read the same persisted records (decision, enforcement, coverage `COMPLETE` only from INV-04 PASS, release-evidence refusals, profile review state); keyboard, disconnect, pagination (M09); responsive (T-052); console against the real service (`test:e2e:real`); CI action from the clean install with a simulated runner environment; **a green clean-checkout run on a real CI service**: GitHub Actions `ci` [run 43272644091](https://github.com/gnanam1990/routespec-near/actions/runs/43272644091) on `ab9b89f` (ubuntu-24.04, windows-2022, macos-15: frozen install, pinned Playwright Chromium, `pnpm run check`, T-027/T-009 parity, SBOM), and `routespec-gate` [run 43272644038](https://github.com/gnanam1990/routespec-near/actions/runs/43272644038) on the same commit (decision PASS on the sample subject); both green again on `bfd3065` | commits after `bfd3065` are covered only once pushed and green                                                                                                |
| RP-06 Security and isolation          | **MET (this environment); reviews NOT_RUN**       | loopback/auth/Origin/CORS (T-036, T-037), token/build/client/epoch binding, attester enrollment/freshness/revocation (M08, M14), interceptor private channel, complete container process-tree and sink coverage with real escape attempts blocked; **T-036 container-host access ran on the real engine (M17)**: no bridge, host-network, or confined container reached any RouteSpec listener; seccomp filter required in the self-observation; tunnel connections end with the subject; resource limits, canaries absent, safe deletion                                                                                                                                                                                                                                                                                                                                         | independent interceptor profile review NOT_RUN; independent security review NOT_RUN; WSL `mirrored` mode, plain Linux Docker, rootless engines NOT_RUN        |
| RP-07 Official live-dry compatibility | **BLOCKED**                                       | denial before credential/DNS/socket, route allowlist, redirect and SSRF rejection, credential policy (T-020 local boundary, T-021, T-038)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | the real `dry: true` call needs a user-held JWT and an explicit user action. Not part of `WORKING_LOCAL`                                                      |
| RP-08 Reproducible release evidence   | **MET (this environment, test-reviewed profile)** | contained capture with independent observations and confinement classified as release evidence; quarantine, sanitization, secret scan, identity resolved, deterministic replay (3 trials, one separate process), review, promotion as `RELEASE_EVIDENCE` to a new scenario and corpus, corrected rerun with fresh interceptors PASS, `routespec.bundle/2` exported with `evidenceUse` and signed reviews, verified in a clean location, decision PASS reproduced; uncontained capture **refused** (422 `RS_CAPTURE_NOT_RELEASE_EVIDENCE`, six reasons), promoted only as `DIAGNOSTIC_ONLY` ADVISORY, release-evidence export refused                                                                                                                                                                                                                                              | release-evidence status of the contained capture depends on the test-key profile review (RP-02)                                                               |

Claim: **no `WORKING_*` level is claimed.** M16 closed the two engineering gaps M14 left (RP-08
refusal, a profile review workflow used by INV-04) and M17 closed the container-host part of
T-036. M41 observed the real CI run, so RP-05 is met. Re-evaluated strictly, `WORKING_LOCAL`
needs every one of RP-01..06 and RP-08 met on runtime evidence; RP-02 and RP-06 are not, so it is
not reached. It now needs exactly:

1. ~~RP-05: a green clean-checkout run of `ci` on a real CI service~~ — **met**: `ci` run
   43272644091 on `ab9b89f` (and 43357797047 on `bfd3065`).
2. **RP-02/RP-06:** a review of the canary interceptor profile by a reviewer independent of the
   operator, with their own Ed25519 key, recorded in a data directory
   (`docs/runbooks/interceptor-profile-review.md`), followed by a contained gate run in that same
   data directory so INV-04 and the capture classification rest on that review rather than on
   the journey's test key.
3. Then a rerun of `pnpm run test:delivery` with the engine configured on the same commit, and
   the claim reconsidered from that runtime evidence.

## Release-check record (M18 journeys)

From the M18 clean-clone delivery run and a direct run of both journeys on the consolidation
branch (`journey.ts --no-ui`, control ports 9444 and 9445; evidence summary in
`docs/status/M18.md`).

| Gate run                         | Journey     | Decision | Subject build attestation | Effect coverage                                                 | Release evidence                                            | `artifactReady`                                    | Enforcement      |
| -------------------------------- | ----------- | -------- | ------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------- | ---------------- |
| Baseline build, release corpus   | contained   | REVIEW   | `TRUSTED_LAUNCHER`        | `INDEPENDENT_BOUNDARY_INTERCEPT`, INV-04 PASS (test-key review) | capture classified release evidence, no refusal reason      | not exported                                       | `LOCAL_ADVISORY` |
| Baseline build, promoted corpus  | contained   | REVIEW   | `TRUSTED_LAUNCHER`        | `INDEPENDENT_BOUNDARY_INTERCEPT`, INV-04 PASS                   | promoted as `RELEASE_EVIDENCE` (REQUIRED)                   | not exported                                       | `LOCAL_ADVISORY` |
| Corrected build, promoted corpus | contained   | **PASS** | `TRUSTED_LAUNCHER`        | `INDEPENDENT_BOUNDARY_INTERCEPT`, every invariant PASS          | regression `CORRECTED_RUN_PASSED`                           | true (release-evidence bundle verified)            | `LOCAL_ADVISORY` |
| Baseline build, release corpus   | uncontained | REVIEW   | `USER_ASSERTED_LOCAL`     | `DECLARED_HOOKS_ONLY`, INV-04 REVIEW                            | refused: 422 `RS_CAPTURE_NOT_RELEASE_EVIDENCE`, six reasons | not exported                                       | `LOCAL_ADVISORY` |
| Baseline build, promoted corpus  | uncontained | REVIEW   | `USER_ASSERTED_LOCAL`     | `DECLARED_HOOKS_ONLY`, INV-04 REVIEW                            | promoted only as `DIAGNOSTIC_ONLY` (ADVISORY)               | not exported                                       | `LOCAL_ADVISORY` |
| Corrected build, promoted corpus | uncontained | REVIEW   | `USER_ASSERTED_LOCAL`     | `DECLARED_HOOKS_ONLY`, INV-04 REVIEW                            | regression `CORRECTED_RUN_NOT_PASSING`                      | release export refused; diagnostic bundle verified | `LOCAL_ADVISORY` |

The six uncontained refusal reasons: `DECLARED_HOOKS_ONLY`, `INTERCEPTOR_COVERAGE_INCOMPLETE`,
`INTERCEPTOR_PROFILE_UNPINNED`, `NO_INDEPENDENT_BOUNDARY_OBSERVATION`,
`PROCESS_TREE_NOT_CONFINED`, `UNATTESTED_IDENTITY`. The release-evidence export of the
uncontained gate was refused with `CAPTURE_NOT_RELEASE_EVIDENCE:DIAGNOSTIC_ONLY`. The baseline
decisions are REVIEW because of INV-03 and INV-06 (no accepted terminal status). The contained
profile review was signed by the journey's local test reviewer (`independentHumanReview:
NOT_RUN`); enrolling the launcher key as a reviewer was refused (409
`RS_REVIEWER_NOT_INDEPENDENT`) and replaying the used challenge was refused (422
`RS_PROFILE_REVIEW_INVALID`). Both decisions were identical before and after export and after a
crash and restart.

## Remote CI (RP-05), observed by M41 on 2026-11-13

Read-only `gh run view` / `gh run list` against `gnanam1990/routespec-near`:

| Workflow         | Run                                                                                  | Commit (`main`) | Event | Jobs                                                         | Conclusion |
| ---------------- | ------------------------------------------------------------------------------------ | --------------- | ----- | ------------------------------------------------------------ | ---------- |
| `ci`             | [43272644091](https://github.com/gnanam1990/routespec-near/actions/runs/43272644091) | `ab9b89f`       | push  | check (ubuntu-24.04), check (windows-2022), check (macos-15) | success    |
| `routespec-gate` | [43272644038](https://github.com/gnanam1990/routespec-near/actions/runs/43272644038) | `ab9b89f`       | push  | gate (ubuntu-24.04)                                          | success    |
| `ci`             | [43357797047](https://github.com/gnanam1990/routespec-near/actions/runs/43357797047) | `bfd3065`       | push  | check (ubuntu-24.04), check (windows-2022), check (macos-15) | success    |
| `routespec-gate` | [43357797080](https://github.com/gnanam1990/routespec-near/actions/runs/43357797080) | `bfd3065`       | push  | gate (ubuntu-24.04)                                          | success    |

`ab9b89f` is the RS-03 security merge; `bfd3065` is the M40 README merge. The `routespec-gate`
step exits 0 only for a PASS decision. The earlier pull-request runs on `9a7cc32` failed and are
superseded by the push runs above. M41's own commits were not pushed by this build.

## Judge-visible FAIL case (M41)

The delivery journey now runs a third client build, `hedging-client`
(`packages/regressions/test/support/subject/hedging-client.ts`), against the `slow-commit-answer`
scenario (`packages/delivery/src/scenarios.ts`): the commit is accepted and its answer held until
a status read. The client hedges after 750 ms (fresh quote under a new order key, second deposit
submission, first request cancelled). The kernel returns INV-03 FAIL
(`INV03_SECOND_MUTATION_UNDER_UNCERTAINTY`) and the gate decision is FAIL in the API, the
console, and the CLI (`gate show` exit code 2). Observed on this host in the uncontained journey
(three runs) and the contained journey (Docker Engine in WSL 2; INV-04 PASS there, INV-03 still
FAIL). No verdict is set by the journey or the scenario. Asserted by T-055 in
`packages/delivery/e2e/m12-delivery.e2e.test.ts`.

## Test totals (this host, M18 consolidation branch, final run on the merge candidate)

| Suite                                                       | Command                       | Result                                                                                                |
| ----------------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------- |
| Typecheck, lint, format, unit/integration, secret scan      | `pnpm run check`              | 78 files / 619 tests (618 passed, 1 skipped: T-040 file symlink), secret scan clean (500 files)       |
| Container runtime tests (escape attempts, T-036, cases)     | `pnpm run test:containment`   | 4 files / 19 passed, none skipped (M14 11, M16 2, M17 6) — NOT_RUN with reason when no engine         |
| Clean-clone delivery (T-054, T-055, contained journey)      | `pnpm run test:delivery`      | 2 files / 21 passed (M12 uncontained 14, M14 contained 7; clean clone containment suite fully passed) |
| Console against the real control service (Playwright + axe) | `pnpm run test:e2e:real`      | 63 passed (includes the new T-051 slow-page focus test)                                               |
| Console fixture suite (simulated, development only)         | `pnpm run test:e2e`           | 25 passed                                                                                             |
| Offline lockfile, license, install-script audit             | `pnpm run audit:supply-chain` | verdict CLEAN                                                                                         |

## Security fix: vuln-0001 (Strix 1.7.0 automated pentest scan, self-run)

- Withheld CI credentials were still readable through `/proc/<pid>/environ` on Linux by the
  client module and the subject. Fixed: the gate step removes them before the entry point starts
  and hands the values over a pipe for the leak scan (ADR-0025,
  `docs/status/SEC-routespec-vuln-0001.md`). Remaining limit: hostile code inside the action
  process (the client module) is not contained.
- Verified on Linux (Ubuntu 24.04 in WSL 2) with Node v22.23.1 downloaded from nodejs.org and
  checked against its published SHA-256 list, plus a frozen-lockfile `pnpm install` from the npm
  registry in a temporary clone. No system setting was changed.

## Security fix: RS-04 (self-run audit, Cloudflare security-audit skill methodology)

- The import quarantine finding set dropped every new finding once 512 were held, so a user
  trace that filled it with advisory active-content findings lost its blocking findings and
  could be mapped. Fixed: past the per-path bound, findings merge into one `$` record per
  category instead of being dropped, so blocking and rejecting findings always survive and the
  list stays within the journal limit (`docs/status/SEC-routespec-RS-04.md`). No ADR: no
  protocol or format change.

## Security fix: RS-06 (self-run audit, Cloudflare security-audit skill methodology)

- The shared scenario proxy kept held connection-barrier responses keyed by step id only, so two
  parallel cases running the same scenario released or overwrote each other's held response.
  Fixed: held barriers are keyed by the authenticated case run and step id, and an abandoned
  entry is dropped (`docs/status/SEC-routespec-RS-06.md`).

## Security fix: RS-07 (self-run audit, Cloudflare security-audit skill methodology)

- A gate evaluation after the selected build attester was revoked or disabled still returned
  PASS, because the attestation was checked only at gate-run creation. Fixed: every evaluation
  re-reads the attestation and its principal in the gate snapshot and re-checks it inside the
  write. A trusted class that is missing, disabled, revoked, policy-changed or mismatched is a
  blocking gate finding (REVIEW). Aggregator `routespec-gate@1.2.0`
  (`docs/status/SEC-routespec-RS-07.md`). Expiry is still enforced at gate-run creation and per
  case at input close, not at gate level.

## Security fix: RS-05 (self-run audit, Cloudflare security-audit skill methodology)

- The CLI created the journal data directory without a mode (0755 under umask 0022) and SQLite
  created `journal.db` as 0644, so other local accounts could read the journal; the service's
  `mode: 0o700` applied only to a directory it created itself. Fixed: the store's
  `ensurePrivateDataDir` creates or tightens the directory to 0700 for both the CLI and the
  service, and `JournalDb.open` creates the journal as 0600 and tightens it and its `-wal`,
  `-shm`, `-journal` and writer-lock files to 0600 on every writable open
  (`docs/status/SEC-routespec-RS-05.md`). POSIX only; Windows relies on the profile ACLs.

## Security fix: RS-01 (self-run audit, Cloudflare security-audit skill methodology)

- The canary interceptor's loopback sink accepted effect attempts from any local process, so an
  unrelated process could journal boundary observations for a running case, clear INV-04's
  `REQUIRED_SINK_UNOBSERVED` gap, and (contained mode) use up the one-shot release decision.
  Fixed: a random per-instance sink token is bound over the interceptor's private pipe and handed
  only to the subject; requests without it get 401 `SINK_UNAUTHENTICATED` before anything is
  framed. The reviewed interceptor artifact digest pin is updated (ADR-0024,
  `docs/status/SEC-routespec-RS-01.md`).

## Security fix: RS-03 (self-run audit, Cloudflare security-audit skill methodology)

- Credential-less local requests spent the global read/mutation budget before authentication and
  could lock the genuine control token out with `429` each window. Fixed: the budgets are charged
  only after the control or case token is accepted, failures count only in the failure window,
  and console assets have their own counter (ADR-0022 amendment, `docs/status/SEC-routespec-RS-03.md`).
  Remaining limit: a genuine-token holder can still spend the global budgets.

## External action ledger

All NOT_AUTHORIZED and NOT_RUN by this build: push, fetch, remote creation, PR creation, remote
merge, deployment, public visibility, live dry-provider access (no 1Click API call, no JWT),
account creation, faucet use, wallet signing, fund movement, public post, demo recording, and
event submission. The GitHub Actions runs are the repository owner's pushes; M41 only read their
results (read-only GitHub API queries through `gh`). Funded integration is unsupported. Only local commits and local `--no-ff`
merges to `main` were made. Outbound requests: read-only `pnpm audit` queries (M11, M13, M17,
M18) and registry checks (M13, M17) against the public npm registry, M17's package install of the
minimatch override, and M14's one `docker pull node:22-bookworm-slim` from Docker Hub. No Windows
feature or system setting was changed.

## Blocked / NOT_RUN items needing the user

See `docs/USER-NEXT-STEPS.md` for exact steps: the independent interceptor profile review
(RP-02/RP-06) and the contained gate run and `test:delivery` rerun on it, the independent security review, RP-07 live dry probe
with your own JWT, the demo recording (only of gates that pass), Linux/macOS clean-install runs,
and the node-forge upgrade on or after 2026-11-18.
