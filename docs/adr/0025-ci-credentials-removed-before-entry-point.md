# ADR-0025 — CI gate: withheld credentials are removed before the entry point starts

- Status: accepted
- Date: 2026-11-12
- Numbering: merged as a second ADR-0022 on 2026-11-12, a minute after
  `0022-auth-failure-budget-not-a-lockout.md`; renumbered to 0025 on 2026-11-13. The content is
  unchanged.
- Module: security follow-up (Strix 1.7.0 automated pentest scan, self-run, vuln-0001; amends ADR-0015 decision 5;
  FR-17, NFR-03, INV-11, T-058)

## Context

ADR-0015 decision 5 withholds provider secrets and CI runtime credentials "from everything the
action starts or loads" by deleting them from `process.env` at the top of `runAction`. On Linux
that only edits the C `environ` array: the kernel keeps serving the process's original
environment block through `/proc/<pid>/environ`. The configured client module runs inside the
action process and can read `/proc/self/environ`; a subject it starts runs as the same user and
can read `/proc/<ppid>/environ`. Both recovered every withheld value in a reproduction on the
real `secrets.ts`, and in a run of the shipped gate step (see
`docs/status/SEC-routespec-vuln-0001.md`).

## Decision

1. **The step shell removes the credentials, not Node.** The composite action's gate step asks
   `packages/ci/bin/withheld-names.mjs` for the names to withhold (names only; same rules as
   `isWithheldName`), drops their export flag with `export -n`, and starts the entry point with
   `exec`. The action process therefore never has them in its environment block, and no process
   keeps the step's original block while the gate runs (the shell is replaced, not a parent).
2. **Values reach the leak scan over a pipe only.** The shell writes `NAME=VALUE` entries, each
   NUL-terminated, to file descriptor 3 (process substitution) and sets
   `ROUTESPEC_CI_WITHHELD_FD=3`. The entry point reads the pipe to its end and closes it before
   it parses the configuration or loads the client module (`parseLauncherWithheld`). Unknown or
   non-withheld names, duplicates, and an unterminated handoff fail closed with `RS_INTERNAL`.
   `withholdSecrets` records these names and values exactly like ones it deletes itself, so the
   `withheldEnvironment` output, the `PROVIDER_SECRET_*` findings, and the upload leak scan are
   unchanged.
3. **In-process deletion stays** as a second layer for direct invocations of `routespec-ci`.

## Consequences and limits (recorded)

- **Hostile code inside the action process is not contained.** The client module is loaded into
  the action process, which keeps the withheld values in memory for the leak scan. Withholding
  removes the trivially readable copies (environment variables, environment blocks); it cannot
  protect against code that reads its own process memory. Integrators should not expose provider
  secrets to the gate step at all; a live-dry probe belongs in a separate job or step.
- **Direct invocation keeps the old exposure.** Running `routespec-ci run` without the composite
  action's step script leaves credentials in that process's environment block on Linux. The
  composite action is the supported entry point; a custom wrapper must do the same removal.
- **Short-lived writer.** The process-substitution writer is a fork of the step shell, so its
  environment block still holds the original values until it exits. It finishes writing before
  the entry point reads end-of-file on the pipe, which happens before any configuration or client
  code is read; it then remains only as an exited (zombie) child with no memory or environment.
- **Other runners.** macOS has no `/proc`; Windows runners use Git Bash, where the same script
  runs. The Linux-only regression test (`packages/ci/test/sec-0001-proc-environ.test.ts`) runs
  the gate step's `run:` text from `action.yml` exactly as a runner does; it is skipped on other
  hosts.
