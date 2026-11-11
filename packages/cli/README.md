# @routespec/cli

Owner module: M06. Status: **VERIFIED_BOUNDED** on win32/x64 (see `docs/status/M06.md`).

The `routespec` command (`bin/routespec.mjs`, Node 22.18+ with built-in type stripping).
stdout carries exactly one JSON document per invocation; diagnostics and JSON log lines go to
stderr. Exit codes: 0 PASS, 2 FAIL, 3 REVIEW/NOT_RUN/incomplete, 4 user/configuration/schema
error, 5 internal error or corrupted state, 6 safety policy denial.

Commands: `project create`, `revision register`, `build register`, `effect manifest`,
`effect policy`, `scenario validate|add`, `corpus create`, `gate create|run|evaluate|show`,
`case recover`, `export plan|write|verify`, `probe dry` (always refused here: the live-dry probe is
a separately authorized adapter). The data directory comes from `--data` or `ROUTESPEC_DATA_DIR`.

`gate run` hands each case to the reviewed launcher (`runWithLauncher`) over an inherited IPC
pipe; the caller connects its separately started client to the printed proxy origin. Without a
launcher, only `--plan-only` is accepted (zero cases start: NOT_RUN).
