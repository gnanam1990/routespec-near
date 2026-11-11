# ADR-0001 — Implementation stack and workspace layout

- Date: 2026-11-11. Decision owner: implementing agent (M00 stage), pending user review.
- Status: ACCEPTED
- Related: FR-01, FR-02, FR-03, FR-08, NFR-08, NFR-10, NFR-11, NFR-12; modules M00–M12; tests T-027 (M00).

## Context and evidence

`docs/spec/START-HERE.md` and `TDD.md` section 2 propose Node.js 22 + TypeScript strict, pnpm workspaces, SQLite WAL, React, Vitest/fast-check/Playwright, "to confirm against the actual repository and installed toolchain".

Observed toolchain on 2026-11-11 (evidence class: local command output): Windows 11, Node v22.23.1, npm 10.9.8, pnpm 10.34.9, git, Playwright Chromium installed. No Docker, no WSL, no C toolchain requirement desired. The repository was a fresh local repo containing only the sealed pack (`docs/spec/`).

## Options

1. **Proposed stack as-is with pnpm workspaces** — matches the pack, deterministic lockfile, pure-JS dependencies.
2. npm workspaces — workable, but the pack proposes pnpm and pnpm is installed.
3. `better-sqlite3` for persistence — mature, but a native module (prebuilds or a C toolchain), contrary to the stage constraint.

## Decision

- **Runtime:** Node.js `>=22.18.0` (verified on 22.23.1), ESM only. Sources are TypeScript executed directly via Node's built-in type stripping (unflagged since 22.18). Consequences: `erasableSyntaxOnly` (no `enum`, no parameter properties, no namespaces), relative imports carry `.ts` extensions (`allowImportingTsExtensions` + `rewriteRelativeImportExtensions` for emit). This removes a build step from child-process crash tests and keeps one source of truth.
- **Language:** TypeScript 5.9.3, `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, project references (`tsc -b`). TypeScript 7 (native port, `latest` on npm today) was not chosen: typescript-eslint 8 supports `<6.0`, and 5.9 is the reviewed baseline.
- **Workspace:** pnpm 10 workspaces, `save-exact`, committed `pnpm-lock.yaml` (frozen-lockfile policy for CI). Layout:
  - `packages/contracts` (M00) — closed versioned schemas, enums, canonical encoding/digests, protocol profile, errors. Depends only on `zod` and `node:crypto`.
  - `packages/store` (M01) — SQLite journal, migrations, repositories, fencing/leases.
  - `packages/kernel` (M04), `packages/proxy` (M02), `packages/runner` (M06), `packages/cli` (M06), `packages/control-api` (M08), `packages/live-dry-adapter` (M07), `apps/console` (M09) — reserved boundaries, NOT_STARTED. The official 1Click SDK is a dependency of `live-dry-adapter` only, so the networkless runtime packages never depend on an upstream client.
- **Schemas:** zod 3.25.76 (v3 API), every object `.strict()`.
- **Persistence:** built-in `node:sqlite` (`DatabaseSync`, SQLite 3.51.3 bundled with Node 22.23.1). It is flagged experimental by Node and prints an `ExperimentalWarning`; recorded as a known risk (API could change in a later Node major). See ADR-0004.
- **Tests:** Vitest 3.2.4 (forks pool), fast-check 4.3.0. Playwright arrives with M09.
- **Lint/format:** ESLint 9.39.1 + typescript-eslint 8.46.2 (flat config), Prettier 3.6.2.

## Dependency licenses (direct, exact)

| Package                                   | Version  | License    | Scope                   |
| ----------------------------------------- | -------- | ---------- | ----------------------- |
| zod                                       | 3.25.76  | MIT        | runtime (contracts)     |
| @defuse-protocol/one-click-sdk-typescript | 0.1.26   | ISC        | runtime (live-dry only) |
| typescript                                | 5.9.3    | Apache-2.0 | dev                     |
| vitest                                    | 3.2.4    | MIT        | dev                     |
| fast-check                                | 4.3.0    | MIT        | dev                     |
| eslint / @eslint/js                       | 9.39.1   | MIT        | dev                     |
| typescript-eslint                         | 8.46.2   | MIT        | dev                     |
| prettier                                  | 3.6.2    | MIT        | dev                     |
| @types/node                               | 22.18.12 | MIT        | dev                     |

Transitive SDK dependencies (axios, form-data, tweetnacl, @scure/base, @noble/hashes, json-stable-stringify) are confined to `live-dry-adapter`. A full SBOM/licence scan is owned by M11.

## Invalidation

Revisit if Node removes or breaks `node:sqlite`, if type stripping semantics change, or if a later module needs a native dependency.
