# RouteSpec build-status record

Record kind: implementation evidence log (from `docs/spec/templates/BUILD-STATUS.md`),
consolidated by M12 on 2026-11-12 from `docs/status/*.md`.

| Axis                                           | State                                                                                        |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Specification pack                             | `SPECIFICATION_ONLY` (sealed in `docs/spec/`, never edited)                                  |
| Implementation                                 | M00–M12 implemented and merged to local `main`; M12 is PARTIAL (below)                       |
| Product tests                                  | Local, win32/x64 only. Linux and macOS: NOT_RUN                                              |
| `WORKING_LOCAL` (RP-01..06, RP-08)             | **NOT REACHED — not claimed.** BLOCKED on trust-rooted identity and complete effect coverage |
| `OFFICIAL_ENDPOINT_COMPATIBLE` (RP-07)         | **BLOCKED** (needs a user-held provider JWT and an explicit user action)                     |
| Enforcement                                    | capped at `REQUIRED_CHECK_UNVERIFIED`; RouteSpec never claims it blocks a merge or release   |
| Independent security review                    | NOT_RUN (needs a reviewer outside this team)                                                 |
| Remote CI, deployment, publication, submission | NOT_RUN / NOT_AUTHORIZED                                                                     |

## Repository observation

- Local path: `C:\Users\Gnanam\Documents\Codex\Projects\routespec`, branch `main`. Module branches
  are merged with `--no-ff`; the final `main` HEAD is reported in the M12 handoff (a file cannot
  contain its own commit SHA).
- Remote `origin` is configured (`gnanam1990/routespec-near`) but nothing was pushed or fetched by
  any module: repository existence, visibility, and access are **UNVERIFIED**.
- Toolchain observed 2026-11-12: Windows 11 Home 10.0.26300 x64, Node v22.23.1, npm 10.9.8,
  pnpm 10.34.9, git 2.56.0.windows.4, SQLite 3.51.3 (`node:sqlite`), Playwright 1.65.0 (Chromium
  build 1254). Lockfile `pnpm-lock.yaml` (frozen; offline install works from a clean clone).

## Module ledger

States: NOT_STARTED, IN_PROGRESS, IMPLEMENTED_UNVERIFIED, VERIFIED_BOUNDED, BLOCKED. Here,
**VERIFIED_BOUNDED** means every owned test ran and passed on this machine at the module boundary;
it is not a product, runtime, or cross-platform claim. **PARTIAL** marks a module whose owned
tests pass for the part this host can run, with a named part BLOCKED or NOT_RUN.

| Module | Name                                      | Merge      | State            | Owned tests (win32/x64)                                          | Remaining gap                                                                                            | Evidence                     |
| ------ | ----------------------------------------- | ---------- | ---------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------- |
| M00    | Foundation and protocol contracts         | `7a4e095`  | VERIFIED_BOUNDED | T-027                                                            | T-027 on Linux/macOS NOT_RUN                                                                             | `docs/status/M00-M01-M03.md` |
| M01    | Domain states and durable persistence     | `f0a3184`  | VERIFIED_BOUNDED | T-001, T-002, T-006, T-007, T-022, T-023, T-024, T-026, T-028    | power-loss durability NOT_RUN                                                                            | `docs/status/M00-M01-M03.md` |
| M02    | Local proxy, recording, redaction         | `b467dc8`  | VERIFIED_BOUNDED | T-010, T-016, T-017                                              | interceptor containment is declared hooks only                                                           | `docs/status/M02.md`         |
| M03    | Scenario DSL and deterministic faults     | `d586964`  | VERIFIED_BOUNDED | T-009, T-013, T-014, T-015                                       | T-009 on Linux/macOS NOT_RUN                                                                             | `docs/status/M00-M01-M03.md` |
| M04    | Invariant kernel and evidence             | `c7c21c2`  | VERIFIED_BOUNDED | T-003, T-004 (PARTIAL), T-005, T-008, T-018, T-019, T-043, T-059 | live complete-effect PASS BLOCKED (no sandbox/interceptor)                                               | `docs/status/M04.md`         |
| M05    | Trace sanitizer and capture-to-regression | `a1449aa`  | VERIFIED_BOUNDED | T-029, T-030, T-031, T-032, T-033, T-039                         | —                                                                                                        | `docs/status/M05.md`         |
| M06    | Runner, CLI, release gates                | `3cb692b`  | VERIFIED_BOUNDED | T-012 (PARTIAL), T-025, T-034, T-035, T-041, T-046, T-053, T-057 | T-012 attestation sub-cases partly covered later by M08; NFR-04 timing in M09                            | `docs/status/M06.md`         |
| M07    | Official live dry adapter                 | `6556cb0`  | PARTIAL          | T-020 (local boundary only), T-021, T-038                        | **RP-07 real dry call BLOCKED** (user JWT + explicit action)                                             | `docs/status/M07.md`         |
| M08    | Local control API and build matrix        | `575a0fb`  | VERIFIED_BOUNDED | T-037, T-044, T-045                                              | hosted CI OIDC token unused; interceptor-launch attestation not linked to a sandbox; probe route refuses | `docs/status/M08.md`         |
| M09    | Modern accessible web console             | `0d36bd7`  | VERIFIED_BOUNDED | T-047, T-048, T-049, T-050, T-051 (automated parts)              | screen readers, manual high contrast, Firefox/WebKit, touch NOT_RUN                                      | `docs/status/M09.md`         |
| M10    | GitHub Action and CI                      | `38a7d87`  | PARTIAL          | T-056, T-058 (simulated runner environment)                      | remote GitHub Actions runs NOT_RUN; CI attestation BLOCKED                                               | `docs/status/M10.md`         |
| M11    | Security, observability, hardening        | `d6888a8`  | PARTIAL          | T-011, T-036 (container host NOT_RUN), T-040 (1 skipped), T-042  | independent security review NOT_RUN; 13 registry advisories triaged                                      | `docs/status/M11.md`         |
| M12    | End-to-end delivery verification          | this stage | PARTIAL          | T-052 (Chromium/win32), T-054 (win32), T-055 (PARTIAL)           | `WORKING_LOCAL` BLOCKED (see matrix); other platforms and browsers NOT_RUN                               | `docs/status/M12.md`         |

All 59 canonical tests T-001..T-059 have an owning module above; none is claimed beyond its
recorded scope. M09a (console shell, `eb10eb5`) is the first stage of M09.

## Real-product gate matrix (`docs/spec/REAL-PRODUCT-GATE.md`)

Every row was run from a clean clone of the committed HEAD by `pnpm run test:delivery` (M12)
unless another source is named. "Met" lists what ran for real; "Not met" is why the gate does
not pass.

| Gate                                  | Result      | Met (real, this host)                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Not met                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RP-01 Clean install and identity      | **BLOCKED** | clean clone; frozen lockfile installed offline (closed proxy, `--offline`); CLI/service/console built; fresh data directory; commit, dirty-tree digest, lock digest, artifact tree digests, policy/manifest digests, toolchain, commands and exit codes recorded; no author-machine path in built artifacts or the bundle (after the M12 console fix); uninstall keeps data, offline reinstall restarts on it                                                                     | no enrolled launcher/CI trust root binds build registration, case launch, or interceptor launch in the installed path: the standalone service accepts only `USER_ASSERTED_LOCAL` builds over HTTP (local launcher attestation exists in-process only, M08); no interceptor; CI OIDC unusable (M10); Linux/macOS NOT_RUN |
| RP-02 Actual client failure           | **BLOCKED** | pinned official SDK 0.1.26 in a separately launched process with the versioned adapter, protocol profile, effect manifest with a REQUIRED no-effect canary sink, isolated case with its own token/client; quote, finalization, commit through the real proxy; accepted-then-lost response; the client's unsafe resubmission (refused by the fence) and a deterministic REVIEW (INV-03 missing `ACCEPTED_TERMINAL_STATUS`)                                                         | no declared sandbox boundary for the process tree, no independently authenticated boundary observations: coverage is `DECLARED_HOOKS_ONLY`, which the gate says cannot satisfy it                                                                                                                                       |
| RP-03 Genuine client correction       | **BLOCKED** | a different client artifact (own digest, build registration, manifest, policy) that never resubmits an unknown commit; distinct case, run operation, client instance, and subject process per case; the original build still fails on the identical scenario revisions; the corrected build passes INV-01, 02, 03, 05, 06, 07, 08 on both cases; both evidence sets are in the journal and the bundle                                                                             | the corrected build does not pass every required predicate: INV-04 complete-effect stays REVIEW (no attested identity, no interceptor instance, no complete boundary coverage); lineage `CORRECTED_RUN_NOT_PASSING`                                                                                                     |
| RP-04 Durable recovery                | **PARTIAL** | journey: recovery revokes the stale token (`RS_TOKEN_REVOKED`), increments the epoch (1 -> 2), issues one reconciliation-only token, denies a second commit and a new quote (`RS_TOKEN_PHASE_DENIED`), allows read-only status; service killed and restarted on the same data with acknowledged records preserved. From the clean install: T-022/T-023 (kill before/after commit), T-025 (kill inside case and gate-aggregation transactions; interrupted case never PASS), T-003 | termination at the export boundary is not a separate kill test (export writes are tmp + exclusive link or confirmed rename; T-057 covers failed writes)                                                                                                                                                                 |
| RP-05 Real product surfaces           | **PARTIAL** | CLI (`gate show`), API, and console read the same persisted decision and enforcement for all three gate runs; eight-axis parity, keyboard journey, disconnect/stale, pagination at the declared load (M09 T-047..T-051); responsive journeys (T-052); no browser-computed verdict; machine-readable JSON/JUnit/SARIF; T-056/T-058 CI action with a simulated runner from the clean install                                                                                        | no clean-checkout run on a real CI service (no push authorized); subject/interceptor attestation axis can only show user-asserted / not applicable                                                                                                                                                                      |
| RP-06 Security and isolation          | **BLOCKED** | loopback binding and non-loopback refusal (T-036), local auth and Host/Origin/CORS/Fetch-Metadata (T-037), case-token/build/client/epoch binding (T-001, T-022, T-059), no provider credential path and no egress in the scenario runtime (T-010), untrusted input as text (T-039), resource limits (T-042), canary absence in database/WAL/log/export/DOM (T-011 and the M12 journey, 12 canaries), safe deletion (M11)                                                          | complete OS/container process-tree and sink coverage, interceptor private channel in the installed path, and attester enrollment/freshness/revocation in the installed path are not available on this host; container-host access NOT_RUN; independent security review NOT_RUN                                          |
| RP-07 Official live-dry compatibility | **BLOCKED** | denial before credential/DNS/socket, route allowlist, redirect and SSRF rejection, credential policy (T-020 local boundary, T-021, T-038)                                                                                                                                                                                                                                                                                                                                         | the real `dry: true` call to the official endpoint needs a user-held JWT and an explicit user action (`docs/USER-NEXT-STEPS.md`). Not part of `WORKING_LOCAL`                                                                                                                                                           |
| RP-08 Reproducible release evidence   | **BLOCKED** | capture from authoritative persisted exchanges; quarantine; sanitization; secret scan; material and coverage identity resolved; deterministic replay (3 identical trial digests, one in a separate process); 8-decision review; promotion to a new scenario and a new corpus; corrected rerun with fresh clients; checksummed bundle exported, extracted in a clean location with no journal, verified, decision reproduced; enforcement `LOCAL_ADVISORY`                         | the capture is declared-hooks-only with no boundary observations (the gate requires rejecting such captures for release evidence; RouteSpec promotes it only with its limitations labelled), and the corrected rerun does not pass (INV-04)                                                                             |

Claim: **no `WORKING_*` level is claimed.** `WORKING_LOCAL` requires RP-01..RP-06 and RP-08 with
trust-rooted subject/interceptor identity and complete independent boundary coverage; four of
those gates are BLOCKED on this host for that reason. What does work end to end is the local,
user-asserted, declared-hooks-only diagnostic path, which the specification allows as a useful
diagnostic and which cannot carry the claim.

## Release-check record (M12 journey, last green run)

| Gate run                         | Decision | Subject build attestation | Effect coverage       | `artifactReady`        | Enforcement      | Official compatibility |
| -------------------------------- | -------- | ------------------------- | --------------------- | ---------------------- | ---------------- | ---------------------- |
| Baseline build, release corpus   | REVIEW   | `USER_ASSERTED_LOCAL`     | `DECLARED_HOOKS_ONLY` | not exported           | `LOCAL_ADVISORY` | NOT_RUN                |
| Baseline build, promoted corpus  | REVIEW   | `USER_ASSERTED_LOCAL`     | `DECLARED_HOOKS_ONLY` | not exported           | `LOCAL_ADVISORY` | NOT_RUN                |
| Corrected build, promoted corpus | REVIEW   | `USER_ASSERTED_LOCAL`     | `DECLARED_HOOKS_ONLY` | true (bundle verified) | `LOCAL_ADVISORY` | NOT_RUN                |

The corrected decision is REVIEW only because of INV-04; the baseline decisions are REVIEW because
of INV-03 and INV-06 as well. The decision was identical before and after export.

## Test totals (win32/x64, final HEAD of the M12 branch)

| Suite                                                       | Command                  | Result                                        |
| ----------------------------------------------------------- | ------------------------ | --------------------------------------------- |
| Typecheck, lint, format, unit/integration, secret scan      | `pnpm run check`         | see `docs/status/M12.md` "Final verification" |
| Console against the real control service (Playwright + axe) | `pnpm run test:e2e:real` | 59 passed (T-047..T-052 and shell checks)     |
| Clean-clone delivery (T-054, T-055)                         | `pnpm run test:delivery` | 14 passed                                     |
| Console fixture suite (simulated, development only)         | `pnpm run test:e2e`      | 25 passed (M09; not rerun in M12)             |

## External action ledger

All NOT_AUTHORIZED and NOT_RUN: push, fetch, remote creation, PR creation, remote merge, GitHub
Actions runs, deployment, public visibility, live dry-provider access (no 1Click API call, no
JWT), account creation, faucet use, wallet signing, fund movement, public post, demo recording,
and event submission. Funded integration is unsupported. Only local commits and local `--no-ff`
merges to `main` were made. The only outbound request made by any module was M11's read-only
`pnpm audit` query to the public npm registry.

## Blocked / NOT_RUN items needing the user

See `docs/USER-NEXT-STEPS.md` for exact steps: RP-07 live dry probe with your own JWT, the first
remote CI run, the demo recording (only after the corresponding gates pass), the independent
security review, Linux/macOS runs, and the deferred dependency upgrades.
