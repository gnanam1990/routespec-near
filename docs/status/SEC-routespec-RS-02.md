# SEC routespec RS-02 — contained subject could write to the host control channel

- Source: self-run audit, Cloudflare security-audit skill methodology, finding RS-02 (severity low: likelihood medium, impact low)
- Branch: `feat/routespec-m24-containment-stdout-framing`
- Decision record: ADR-0023 (amends ADR-0019 decision 4)

## Finding

The in-container shim forked the subject with `stdio: ['ignore', 'inherit', 'inherit', 'ipc']`,
so the subject's stdout was the shim's stdout: the only shim -> host channel. The host read it
with `readline` and no line limit, inside the shared control-service process. A contained
subject could print its own shim frames (a forged `{t:'exit',code:0}` set the host's
`subjectExit` while the subject still ran), lose real frames by leaving an unterminated partial
line in front of them, and make the control service hold unbounded newline-free output.

## Fix

- `packages/containment/src/shim.mjs`: the subject is forked with `stdio: ['ignore', 2, 2, 'ipc']`
  (its stdout goes to stderr, as the existing comment intended). An IPC message whose frame would
  be over `MAX_LINE` (1 MiB, UTF-8 bytes) is not relayed; the shim kills the subject.
- `packages/containment/src/sandbox.ts`: `readline` is replaced by a bounded byte splitter. A
  frame or pending partial line over `MAX_FRAME_BYTES` (2 MiB) sets `channelFault` to
  `CONTROL_CHANNEL_FRAME_TOO_LARGE`, drops the buffer, downgrades the verdict to
  `DECLARED_HOOKS_ONLY` with that finding (kept by a later `verify()`), rejects a pending launch,
  and stops the container.
- Wire format is unchanged for a well-behaved subject (one JSON object per line).

## Red / green

New test: `packages/containment/test/rs02-channel-framing.test.ts`. It runs the real
`ContainedSubject` and the real `shim.mjs`; only the engine is replaced by a stand-in that runs
the shim with stdio passed through unchanged (as `docker run -i` does).

| Step                                                                               | Exit | Result                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx vitest run packages/containment/test/rs02-*.test.ts`, before (unfixed source) | 1    | 5 failed (5): teardown reported the forged `{code:0,signal:null}`; after a 4 MiB newline-free write the real `loaded` frame never arrived; a 2 MiB IPC message was relayed and the subject kept running; a 2 MiB + 1 KiB partial line left the container running; no `channelFault` field |
| `npx vitest run packages/containment/test/`, after                                 | 0    | 2 files, 30 passed (25 existing M14 unit tests + 5 RS-02)                                                                                                                                                                                                                                 |

## Full regression

Environment: `ROUTESPEC_TEST_PORT_BASE=9710`, `ROUTESPEC_DELIVERY_PORT=9715`, `FIXTURE_PORT=9718`,
`ROUTESPEC_CONTAINER_CLI=["wsl.exe","-d","Ubuntu-24.04","-u","root","--exec","docker"]` (Docker
Engine in WSL 2, Ubuntu 24.04).

All three ran after `git merge main` (main at the RS-06 merge), on the merged HEAD.

| Command                     | Exit | Result                                                                                        |
| --------------------------- | ---- | --------------------------------------------------------------------------------------------- |
| `pnpm run check`            | 0    | typecheck, lint, format clean; 84 files, 714 passed, 2 skipped; secret scan clean (520 files) |
| `pnpm run test:containment` | 0    | 4 files, 19 passed (M14 11, M16 2, M17 6), none skipped, real Docker engine                   |
| `pnpm run test:delivery`    | 0    | 2 files, 21 passed (M12 uncontained 14, M14 contained 7)                                      |

Also green before the merge on the fix commit: `pnpm run check` (82 files, 708 passed, 2 skipped),
`pnpm run test:containment` (19 passed), `pnpm run test:delivery` (21 passed).

Note: three intermediate `pnpm run check` runs while sibling suites saturated the host (CPU at
100%, over 100 node processes) had load-dependent timeouts in `packages/cli` (T-025, T-057) and
`packages/security-suite` (T-036, T-042); none touch containment. T-025 and T-057 passed alone
(7 passed), and the full run above passed with no failures.

## Residual

- The subject can still send any IPC message through `process.send` (as before); those are data
  and arrive only as `ipc` frames.
- The host's stderr tail stays at 8000 characters, so subject stdout is now retained only there.
