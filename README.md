# RouteSpec

Local-first, deterministic reliability release check for NEAR Intents 1Click clients. The
authoritative specification is the sealed pack in [`docs/spec/`](docs/spec/START-HERE.md); this
repository is its implementation, built module by module (M00–M12).

**Status:** early implementation. See [`BUILD-STATUS.md`](BUILD-STATUS.md) for exactly what is
implemented and verified. No product runtime (proxy, CLI, control API, console) exists yet, and no
`WORKING_*` gate from `docs/spec/REAL-PRODUCT-GATE.md` is claimed.

## Requirements

- Node.js `>= 22.18` (type stripping and `node:sqlite` are used directly; verified on 22.23.1)
- pnpm 10 (`corepack enable` or a global install)
- Windows, Linux, or macOS. No Docker, WSL, or C toolchain is required.

## Setup

```sh
pnpm install --frozen-lockfile
```

## Commands

| Command                 | What it does                                                        |
| ----------------------- | ------------------------------------------------------------------- |
| `pnpm run typecheck`    | `tsc -b` over all TypeScript project references (strict)            |
| `pnpm test`             | Vitest suite for every package (`packages/*/test/**/*.test.ts`)     |
| `pnpm run lint`         | ESLint (flat config, typescript-eslint)                             |
| `pnpm run format:check` | Prettier check (the sealed `docs/spec/` pack is excluded)           |
| `pnpm run secret-scan`  | Scans tracked/untracked files for secret patterns (values withheld) |
| `pnpm run check`        | All of the above in sequence                                        |

Run one package's tests with e.g. `pnpm exec vitest run packages/contracts`.

## Layout

```text
packages/contracts         M00  closed versioned schemas, enums, rs-canon/1 encoding + digests,
                                oneclick-v0 protocol profile, lifecycle tables, typed errors
packages/live-dry-adapter  M07  (NOT_STARTED) — pins the official 1Click SDK 0.1.26 only
packages/store             M01  SQLite journal (see BUILD-STATUS.md for current state)
packages/kernel            M04  (NOT_STARTED)
packages/proxy             M02  (NOT_STARTED)
packages/runner, cli       M06  (NOT_STARTED)
packages/control-api       M08  (NOT_STARTED)
apps/console               M09  (NOT_STARTED)
docs/adr                        architecture decision records
docs/spec                       sealed specification pack (never edited)
scripts/secret-scan.mjs         repository secret scan
```

## Safety boundary

RouteSpec has no funded mode. Nothing in this repository contacts the hosted 1Click API, holds a
provider credential, signs a transaction, or moves funds. The live-dry compatibility probe (M07)
requires explicit user-provided access and is not implemented.
