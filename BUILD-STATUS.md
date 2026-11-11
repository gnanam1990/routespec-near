# RouteSpec build-status record

Record kind: implementation evidence log (from `docs/spec/templates/BUILD-STATUS.md`).
Initial pack state: **SPECIFICATION_ONLY**
Implementation: **IN_PROGRESS** (M00 and M01 implemented at their library boundaries; M02–M12 not started)
Product runtime gates (`REAL-PRODUCT-GATE.md` WORKING\_\*): **NOT_RUN** — no WORKING\_\* level is claimed. There is no proxy, runner, CLI, control API, console, or live adapter yet.
Deployment: **NOT_RUN**

## Repository observation

- Local path: `C:\Users\Gnanam\Documents\Codex\Projects\routespec` (local git repo, branch `main`)
- Base SHA at M00 start: `27a39e101e1bce03d6a3425b71597101c53b148a` (`chore: normalize line endings`)
- M00 merged to `main` at `42d7e1c` (merge of `feat/routespec-m00-foundation-contracts`); M01 branched from it (`feat/routespec-m01-domain-persistence`) and merged with `--no-ff`. Final `main` HEAD is reported in the stage handoff (a file cannot contain its own commit SHA).
- Remote: none configured. Proposed remote `gnanam1990/routespec-near`: **UNVERIFIED / NOT_AUTHORIZED**
- Toolchain observed 2026-11-11: Windows 11 Home 10.0.26300 x64, Node v22.23.1, npm 10.9.8, pnpm 10.34.9, bundled SQLite 3.51.3 (`node:sqlite`). Lockfile: `pnpm-lock.yaml` (frozen).

## Module ledger

Allowed states: NOT_STARTED, IN_PROGRESS, IMPLEMENTED_UNVERIFIED, VERIFIED_BOUNDED, BLOCKED.

| Module       | State            | Owned tests (status on win32/x64)                                     | Remaining gap                                                                                                                                                                                                               |
| ------------ | ---------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M00          | VERIFIED_BOUNDED | T-027 PASSING (win32 only)                                            | T-027 cross-OS run on Linux/macOS NOT_RUN (M10 CI matrix or user run).                                                                                                                                                      |
| M01          | VERIFIED_BOUNDED | T-001, T-002, T-006, T-007, T-022, T-023, T-024, T-026, T-028 PASSING | Repository methods for later-module tables (attestations, effect inventories/interceptors/observations, imports, gate evaluations, artifact manifests, audit) are schema + constraints only. Power-loss durability NOT_RUN. |
| M03          | VERIFIED_BOUNDED | T-009, T-013, T-014, T-015 PASSING (win32 only)                       | T-009 cross-OS run on Linux/macOS NOT_RUN. T-042 (service-level abuse) is not owned here.                                                                                                                                   |
| M02, M04–M12 | NOT_STARTED      | —                                                                     | —                                                                                                                                                                                                                           |

"VERIFIED_BOUNDED" here means: every owned test ran and passed on this machine at its module boundary. It is not a product, runtime, or cross-platform claim.

### M00 — Foundation and protocol contracts (`packages/contracts`, `packages/live-dry-adapter` pin only)

Real behavior:

- Closed enums for every separate axis (lifecycle, verdict, evidence class/scope/reason, attestation class, coverage basis, enforcement mode capped at `REQUIRED_CHECK_UNVERIFIED`, provider-token state, mode, official compatibility, phases, token purposes, attempt outcomes, seven raw statuses, normalized facts, lineage, provenance, import states, material-field classes).
- Strict, versioned zod record schemas; `parseContract` fails closed on unknown kind/major/newer minor/missing version/unknown field. Build records are permanently `USER_ASSERTED_LOCAL`.
- `rs-canon/1` typed length-prefixed canonical encoding and domain-separated SHA-256 digests behind a `Digester` interface (ADR-0003); canonical case result vs separately digested run envelope.
- Shared ExecutionLifecycle transition tables with terminal immutability.
- Protocol profile `oneclick-v0@1.0.0` derived from the pinned SDK: material-field registry, four-phase validators, raw→normalized status map, unknown status/field fail-closed, terminal fold (ADR-0005), route/material/status schema digests and integrity digest, typed denial for unsupported routes; correlation-header contract and `stripForUpstream`.
- Official SDK pin `@defuse-protocol/one-click-sdk-typescript@0.1.26` (ISC, registry gitHead `414467b879863661e736eab338b316f567db68fe`) in `packages/live-dry-adapter` only. **Base URL configurable: yes** (`OpenAPI.BASE`), verified against an in-test 127.0.0.1 server (ADR-0002). No 1Click API call was made.

T-027 red/green: red with a temporary naive model (`sha256(JSON.stringify(canonical+envelope))`, no normalization/strict schema) via `ROUTESPEC_RED_NAIVE=1 npx vitest run packages/contracts/test/t027-canonical-result.test.ts` → exit 1, 7 failed / 2 passed; the naive model was removed before commit. Green → exit 0, 9 passed. Golden digest `sha256:128c4e601a599ab074864c19faf11ea6a06f3501c7213d24784b3177fe7f6d36` (`packages/contracts/test/vectors/t027-golden.json`).

### M01 — Domain states and durable persistence (`packages/store`)

Real behavior (ADR-0004):

- `node:sqlite` single-writer journal: writer lock file with dead-holder takeover, `BEGIN IMMEDIATE`, WAL, `synchronous=FULL`, `foreign_keys=ON`, `busy_timeout` (default 5000 ms), `application_id`; checksummed transactional migrations 001 (core) and 002 (case results with separate envelopes, maintenance events, evidence predicate index); read-only recovery for newer schemas; refusal of foreign/garbage files.
- STRICT schema for every DATA-MODEL entity with database-level immutability, lifecycle, set-once binding, monotonic epoch/sequence, single-use evidence, and composite identity foreign keys.
- Repositories: idempotent/optimistic-revision project writes; immutable profile/integration/build/manifest/scenario/corpus/coverage-policy registration; gate run + ordered case runs in one transaction; case start with bounded parallelism, fresh session/client/EXECUTION token (digest-only storage); token/identity/client/epoch/phase/lease authorization inside each write transaction; four-phase proxy journal (quote request → atomic complete finalization → one-time commit binding → read-only status with terminal fold) with exchange + attempt + event + sequence in one transaction; transport-request idempotency; conflict rows with safe codes only; lineage; evidence with separate class/scope/reasons, single-use consumption and exact aggregate allocation; fenced evaluation persistence (invariant results + canonical result + envelope + terminal transition in one transaction); lease expiry → RECOVERY_REQUIRED, compare-and-set recovery issuing exactly one RECONCILIATION_ONLY token; checkpoint, verified `VACUUM INTO` backup, storage-fault state with a restart-surviving marker and fenced resume; repository-boundary secret guards.
- Simulated vs real: all journal behavior is real SQLite on real files; T-022/T-023 kill a real child Node.js process. Verdict values passed to `persistCaseEvaluation` in tests are inputs (the evaluator is M04). The T-028 v1 historical invariant-result/gate-evaluation rows are an explicitly labelled migration fixture written with raw SQL; everything else in that journal was produced through the repository API.

Red evidence for M01 (honest account): the M01 repository code was written before most of its tests in this stage, so classic red-before-green exists only where a test exposed a real defect:

- T-001 first run → exit 1, **1 failed / 3 passed**: a global `UNIQUE(finalization_digest)` rejected an identical quote response in a different case scope (scopes were not independent). Fixed by scoping finalization uniqueness to the run operation and removing global uniqueness of commit binding digests; rerun 4 passed.
- T-007 first run → 1 failed / 4 passed (assertion expected a different fail-closed code for a second allocation after consumption); the test was corrected to assert the actual fail-closed code and a separate case for a second allocation before consumption was added. The product behavior did not change.

For every other owned test, the test was proven to exercise its guard by mutation (each mutation disables one guard in product code, the owning test file is run, then the file is restored; script kept outside the repo). Command per mutation: `npx vitest run <owning test file>`.

| Test  | Mutation (guard disabled)                                     | Result with mutation                                                                            |
| ----- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| T-001 | run-operation lookup ignores `case_run_id`                    | exit 1, 2 failed / 2 passed                                                                     |
| T-002 | changed re-finalization treated as idempotent                 | exit 1, 3 failed / 3 passed                                                                     |
| T-006 | late non-terminal status replaces accepted terminal (fold)    | exit 1, 3 failed / 1 passed                                                                     |
| T-007 | single-use consumption trigger clause disabled                | exit 1, 1 failed / 4 passed                                                                     |
| T-022 | recovery issues an EXECUTION-scoped token                     | exit 1, 1 failed / 2 passed                                                                     |
| T-022 | authorization ignores token revocation                        | exit 1, 1 failed / 2 passed (stale epoch still blocks; defense in depth)                        |
| T-022 | `markRecoveryRequired` skips revocation                       | exit 0, 3 passed — **survived**: `recoverCase` revokes again (redundant guard), not a weakening |
| T-023 | `beforeCommit` crash point moved after `COMMIT`               | exit 1, 2 failed / 1 passed                                                                     |
| T-024 | expired lease lets a second runner start without recovery     | exit 1, 1 failed / 8 passed                                                                     |
| T-026 | commit transport-request dedupe removed                       | exit 1, 3 failed / 2 passed                                                                     |
| T-028 | migration 002 drops a trigger and rewrites historical results | exit 1, 2 failed / 3 passed                                                                     |
| T-027 | canonical digest skips strict normalization                   | exit 1, 6 failed / 3 passed                                                                     |

### M03 — Scenario DSL, virtual clock, deterministic faults (`packages/scenario`)

Real behavior (ADR-0006): bounded data-only YAML/JSON parsing (core schema, tags/merge keys/duplicate keys/aliases rejected, linear JSON depth scan); strict closed schema v1.0 with 14 step types; executable-looking fields reported as unsafe; budgets with hard caps; explicit defaults; canonical compiled JSON; scenario revision digest equal to the journal's; static route plan; sfc32 seeded PRNG; integer virtual clock; two-phase plan/commit/deny runtime with response drop, connection barrier, transport error, delays, provider status queue, ground truth, assertions, duplicate, reorder, late success, incomplete deposit, refund, and end; noncanonical-timer labelling; canonical replay digest; six reviewed synthetic core scenarios. Nothing is simulated beyond the scenario itself, which is the product domain logic.

Red evidence (honest account): the M03 source was written before its tests in this stage. The only first-run failures were wrong expectations in the tests themselves (T-014 depth input exceeded the byte cap first; T-015 expected `wait@11600` instead of the correct `wait@10600`), so the tests were corrected and the product did not change. Instead, each owned test was shown to exercise its guard by mutation (`npx vitest run <owning test>` with one guard disabled; file restored afterwards):

| Test  | Mutation (guard disabled)                      | Result with mutation        |
| ----- | ---------------------------------------------- | --------------------------- |
| T-014 | explicit YAML tags accepted                    | exit 1, 1 failed / 9 passed |
| T-014 | executable-field scan disabled                 | exit 1, 1 failed / 9 passed |
| T-014 | declared budget may exceed the hard cap        | exit 1, 1 failed / 9 passed |
| T-013 | default poll interval changed                  | exit 1, 2 failed / 5 passed |
| T-013 | forbidden behaviors not sorted/deduplicated    | exit 1, 2 failed / 5 passed |
| T-015 | PRNG warm-up perturbed by `Math.random`        | exit 1, 2 failed / 3 passed |
| T-015 | respond delay not applied to the virtual clock | exit 1, 1 failed / 4 passed |
| T-015 | journal-denied request consumes a step         | exit 1, 1 failed / 4 passed |
| T-009 | fencing epoch excluded from the replay digest  | exit 1, 3 failed / 2 passed |
| T-009 | seed mismatch accepted                         | exit 1, 1 failed / 4 passed |

Golden vectors: `packages/scenario/test/vectors/t013-golden.json` (revision digest `sha256:9fe565e2…ab16c`) and `t009-golden.json` (replay digest `sha256:2b0a8888…472cd`). T-009 also recomputes the digest in two separately spawned Node.js processes.

## Command evidence

| Date (UTC) | HEAD               | Command                          | Exit | Observed                                                                                           |
| ---------- | ------------------ | -------------------------------- | ---- | -------------------------------------------------------------------------------------------------- |
| 2026-11-11 | 27a39e1 + M00 tree | `pnpm install`                   | 0    | 213 packages; esbuild postinstall skipped by pnpm policy (prebuilt binary used)                    |
| 2026-11-11 | 27a39e1 + M00 tree | `pnpm test`                      | 0    | 4 files, 47 tests passed                                                                           |
| 2026-11-11 | 42d7e1c + M01 tree | `pnpm install --frozen-lockfile` | 0    | lockfile up to date                                                                                |
| 2026-11-11 | 42d7e1c + M01 tree | `pnpm run typecheck` (`tsc -b`)  | 0    | clean                                                                                              |
| 2026-11-11 | 42d7e1c + M01 tree | `pnpm run lint`                  | 0    | clean                                                                                              |
| 2026-11-11 | 42d7e1c + M01 tree | `pnpm run format:check`          | 0    | clean (after fixing one file)                                                                      |
| 2026-11-11 | 42d7e1c + M01 tree | `pnpm test`                      | 0    | 13 files, **93 tests passed** (contracts 43, live-dry SDK pin 4, store 46)                         |
| 2026-11-11 | 42d7e1c + M01 tree | `pnpm run secret-scan`           | 0    | clean (123 files, 8 rules) after replacing one literal PEM header in a test                        |
| 2026-11-11 | 42d7e1c + M01 tree | `git diff --check`               | 0    | clean                                                                                              |
| 2026-11-11 | 7854464 + M03 tree | `npx vitest run`                 | 0    | 18 files, **122 tests passed** (scenario 29 new: T-009 5, T-013 7, T-014 10, T-015 5, isolation 2) |
| 2026-11-11 | 7854464 + M03 tree | `pnpm run secret-scan`           | 0    | clean (144 files, 8 rules)                                                                         |

Per-file test counts: contracts `canonical-encoding` 21, `contracts` 13, `t027-canonical-result` 9; live-dry-adapter `sdk-pin` 4; store `t001` 4, `t002` 6, `t006` 4, `t007` 5, `t022-t023-crash` 3, `t024` 9, `t026` 5, `t028` 5, `store-guards` 5.

## External action ledger

All NOT_AUTHORIZED and NOT_RUN: remote creation, push, PR creation, remote merge, deployment, public visibility, live dry-provider access (no 1Click API call, no JWT), account creation, faucet use, wallet signing, public post, event submission. Funded integration is unsupported. Only local commits and local `--no-ff` merges to `main` were made.

## Blocked / NOT_RUN items needing the user

- **T-027 cross-OS:** on a Linux and a macOS machine run `pnpm install --frozen-lockfile && pnpm exec vitest run packages/contracts/test/t027-canonical-result.test.ts`; it must pass with the same golden digest. (Alternatively, the M10 CI matrix once a remote exists — remote creation requires the user's authorization.)
- **Power-loss durability:** not testable here (needs hardware/VM fault injection). Process-crash durability is tested.
- **Official endpoint compatibility (M07, T-020/T-021):** requires the user to obtain 1Click access themselves; not attempted.
