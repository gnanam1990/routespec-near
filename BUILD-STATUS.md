# RouteSpec build-status record

Record kind: implementation evidence log (from `docs/spec/templates/BUILD-STATUS.md`).
Initial pack state: **SPECIFICATION_ONLY**
Implementation: **IN_PROGRESS** (M00 complete at its boundary; later modules not started)
Product runtime gates (`REAL-PRODUCT-GATE.md` WORKING\_\*): **NOT_RUN** — no WORKING\_\* level is claimed.
Deployment: **NOT_RUN**

## Repository observation

- Local path: `C:\Users\Gnanam\Documents\Codex\Projects\routespec` (local git repo, branch `main`)
- Base SHA at M00 start: `27a39e101e1bce03d6a3425b71597101c53b148a` (`chore: normalize line endings`)
- Remote: none configured. Proposed remote `gnanam1990/routespec-near`: **UNVERIFIED / NOT_AUTHORIZED**
- Toolchain observed 2026-11-11: Windows 11 Home 10.0.26300, Node v22.23.1, npm 10.9.8, pnpm 10.34.9, bundled SQLite 3.51.3 (`node:sqlite`)

## Module ledger

Allowed states: NOT_STARTED, IN_PROGRESS, IMPLEMENTED_UNVERIFIED, VERIFIED_BOUNDED, BLOCKED.

| Module  | State            | Owned tests                                                   | Evidence / remaining gap                                                                                       |
| ------- | ---------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| M00     | VERIFIED_BOUNDED | T-027                                                         | T-027 passing on win32/x64 only. Cross-OS (Linux/macOS) execution NOT_RUN (needs M10 CI matrix or a user run). |
| M01     | NOT_STARTED      | T-001, T-002, T-006, T-007, T-022, T-023, T-024, T-026, T-028 | —                                                                                                              |
| M02–M12 | NOT_STARTED      | —                                                             | —                                                                                                              |

### M00 — Foundation and protocol contracts

Implemented (real behavior, `packages/contracts`):

- Closed enums for every separate axis (lifecycle, verdict, evidence class/scope/reason, attestation class, coverage basis, enforcement mode capped at `REQUIRED_CHECK_UNVERIFIED`, provider token state, mode, official compatibility, phases, token purposes, attempt outcomes, raw statuses, normalized facts, lineage, provenance, import states, material-field classes).
- Strict, versioned zod schemas for build (permanently `USER_ASSERTED_LOCAL`), attester principal, launcher challenge, subject attestation, effect manifest/coverage policy/boundary observation, gate run, case run, session, case token, logical job, run operation, lineage, attempt, evidence item, invariant result, gate evaluation (separate `artifactReady`/`enforcementMode`), compatibility probe; `parseContract` fails closed on unknown kind/major/newer minor/missing version/unknown field.
- `rs-canon/1` typed length-prefixed canonical encoding + domain-separated SHA-256 digests behind a `Digester` interface (ADR-0003); canonical case result vs separately digested run envelope (T-027).
- Shared ExecutionLifecycle transition tables (GateRun/CaseRun/Session) with terminal immutability.
- Protocol profile `oneclick-v0@1.0.0` derived from the pinned SDK: material-field registry (request-known / response-assigned / display / commit / reconciliation / prohibited), four-phase validators (deposit address never request-known; complete-response finalization; commit bound to finalized quote; read-only status by bound address), seven raw statuses → normalized facts, unknown statuses preserved as UNKNOWN, terminal fold (ADR-0005), route/material/status schema digests and profile integrity digest, typed denial for unsupported routes.
- Correlation-header contract and `stripForUpstream` (removes every `x-routespec-*`, Authorization, Cookie).
- Official SDK pin `@defuse-protocol/one-click-sdk-typescript@0.1.26` (ISC, gitHead `414467b8…`), installed only in `packages/live-dry-adapter`. **Base URL configurable: yes** (`OpenAPI.BASE`), verified against a local loopback server (ADR-0002).
- Simulated vs real: all of the above is real code exercised by tests. Nothing contacts the 1Click API. The SDK runtime check uses an in-test 127.0.0.1 HTTP stub, labelled as such.

Red/green evidence for T-027:

- Red (2026-11-11, base `27a39e1` + uncommitted M00 work): `ROUTESPEC_RED_NAIVE=1 npx vitest run packages/contracts/test/t027-canonical-result.test.ts` with a temporary naive digest (`sha256(JSON.stringify(record))` over canonical+envelope, no normalization or strict schema) → exit 1, **7 failed / 2 passed** (envelope changed digest; golden mismatch; key/collection order changed digest; smuggled envelope fields, missing identity, and duplicate sequences accepted). The naive model was removed; it is not in any commit.
- Green: same command without the flag against the real implementation → exit 0, 9 passed.

## Command evidence

| Timestamp (UTC date) | HEAD                       | Command                 | Exit | Observed                                                                                                        |
| -------------------- | -------------------------- | ----------------------- | ---- | --------------------------------------------------------------------------------------------------------------- |
| 2026-11-11           | 27a39e1 + M00 working tree | `pnpm install`          | 0    | 213 packages added; esbuild postinstall ignored by pnpm policy (vitest works with the prebuilt platform binary) |
| 2026-11-11           | 27a39e1 + M00 working tree | `pnpm run typecheck`    | 0    | `tsc -b` clean                                                                                                  |
| 2026-11-11           | 27a39e1 + M00 working tree | `pnpm run lint`         | 0    | clean                                                                                                           |
| 2026-11-11           | 27a39e1 + M00 working tree | `pnpm run format:check` | 0    | clean                                                                                                           |
| 2026-11-11           | 27a39e1 + M00 working tree | `pnpm test`             | 0    | 4 files, 47 tests passed (contracts 43, live-dry-adapter SDK pin 4)                                             |
| 2026-11-11           | 27a39e1 + M00 working tree | `pnpm run secret-scan`  | 0    | clean (99 files, 8 rules)                                                                                       |
| 2026-11-11           | 27a39e1 + M00 working tree | `git diff --check`      | 0    | clean                                                                                                           |

## External action ledger

All NOT_AUTHORIZED and NOT_RUN: remote creation, push, PR creation, remote merge, deployment, public visibility, live dry-provider access (no 1Click API call, no JWT), account creation, public post, event submission. Funded integration is unsupported. Local commits and local `--no-ff` merges to `main` only.

## Blocked / NOT_RUN items needing the user

- T-027 cross-OS evidence: run `pnpm install --frozen-lockfile && pnpm exec vitest run packages/contracts/test/t027-canonical-result.test.ts` on Linux and macOS (or wait for the M10 CI matrix) and confirm the golden digest matches.
- Official endpoint compatibility (M07/T-020/T-021): requires the user to obtain 1Click access themselves; not attempted.
