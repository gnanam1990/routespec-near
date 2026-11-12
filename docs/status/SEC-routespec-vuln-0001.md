# SEC vuln-0001 — Withheld CI credentials readable through /proc environ: status evidence

- Source: external automated scan, finding vuln-0001 (MEDIUM, CWE-526). Verified independently on
  the real modules and on the shipped gate step before any change.
- State: **FIXED** on `feat/routespec-m20-proc-environ-withholding` (base `f20917f`, merged with
  `main` at `cc0fdd5` before the final runs).
- Decision record: ADR-0022 (amends ADR-0015 decision 5).

## Finding (verified)

`withholdSecrets` deleted provider and CI credentials from `process.env`. On Linux that leaves
the original environment block, served by `/proc/<pid>/environ`, untouched. The gate step started
Node with the full step environment, then imported the configured client module into the same
process; subjects the module starts run as the same user.

Reproduction (Linux, Ubuntu 24.04 in WSL 2, Node v22.23.1 from the official archive verified
against `SHASUMS256.txt`), importing the real `packages/ci/src/secrets.ts` from `main`:

| Observation                                                                                 | Result                                                            |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| names withheld by `withholdSecrets`                                                         | `ACTIONS_RUNTIME_TOKEN`, `GITHUB_TOKEN`, `ROUTESPEC_PROVIDER_JWT` |
| `process.env.ROUTESPEC_PROVIDER_JWT` after withholding                                      | `undefined`                                                       |
| names in `/proc/self/environ` (client-module view)                                          | all three                                                         |
| names in `/proc/<ppid>/environ` from a child started with `childEnvironment` (subject view) | all three                                                         |

## Fix

- `.github/actions/routespec-gate/action.yml`: the gate step gets the withheld names from
  `packages/ci/bin/withheld-names.mjs`, runs `export -n` on each, and `exec`s the entry point, so
  the action process starts without them and no parent keeps the original block. Values are
  written NUL-terminated to fd 3 and `ROUTESPEC_CI_WITHHELD_FD=3` names it.
- `packages/ci/src/main.ts`: reads and closes that pipe before running the action.
- `packages/ci/src/secrets.ts`: `withheldNames`, `parseLauncherWithheld` (fails closed with
  `RS_INTERNAL`), and `withholdSecrets(env, launcherWithheld)` recording both sources alike.
- `packages/ci/src/action.ts`: passes the handed-over credentials to `withholdSecrets`.
- `packages/ci/test/support/sample-client.ts`: opt-in `ROUTESPEC_CI_TEST_PROC_ENVIRON` report of
  which watched names (names only) appear in `/proc/self/environ` and the parent's block.

## Test (red, green)

`packages/ci/test/sec-0001-proc-environ.test.ts`: the Linux case writes the gate step's `run:`
text from `action.yml` to a script, runs it with `bash --noprofile --norc -eo pipefail` (as a
runner does) with four canary credentials planted, and requires an empty `/proc` report, the
withheld names and `PROVIDER_SECRET_WITHHELD` in the result, a secret-bearing log still refused
as `SECRET_BEARING` (values reached the leak scan), and no canary in any output. Four
cross-platform unit cases cover `withheldNames`, the handoff parser (including fail-closed
input), and the merge in `withholdSecrets`.

| Step                                                                                       | Host    | Exit | Result                                                                                  |
| ------------------------------------------------------------------------------------------ | ------- | ---- | --------------------------------------------------------------------------------------- |
| `npx vitest run packages/ci/test/sec-0001-proc-environ.test.ts`, before (test commit only) | Linux   | 1    | 1 failed: `client-module-initial-environ` held all four planted names; gate itself PASS |
| same command, after the fix                                                                | Linux   | 0    | 5 passed                                                                                |
| `npx vitest run packages/ci` (T-056, T-058, M13, supply chain, this test)                  | Linux   | 0    | 5 files, 41 passed                                                                      |
| `npx vitest run packages/ci/test/sec-0001-proc-environ.test.ts`                            | Windows | 0    | 4 passed, 1 skipped (Linux-only case)                                                   |

## Full suite (after `git merge main`)

| Command                                        | Host    | Exit | Result                                                                                        |
| ---------------------------------------------- | ------- | ---- | --------------------------------------------------------------------------------------------- |
| `ROUTESPEC_TEST_PORT_BASE=9500 pnpm run check` | Windows | 0    | typecheck, lint, format clean; 80 files, 701 passed, 2 skipped; secret scan clean (510 files) |

Delivery, containment and browser e2e suites were not rerun: no route, console, container or
delivery code changed, and none of them invoke the gate action or `routespec-ci`.

## Not done (recorded in ADR-0022)

- Code loaded into the action process (the client module) can still read the values from the
  process's own memory, where they stay for the leak scan; this cannot be closed in-process.
- A direct `routespec-ci run` without the composite action's step script keeps the old exposure.
- The Linux case runs on Linux hosts only; this repository's remote CI result is reported by the
  owner separately.
