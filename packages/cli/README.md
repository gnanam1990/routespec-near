# @routespec/cli

Owner module: M06. Status: **VERIFIED_BOUNDED** on win32/x64 (see `docs/status/M06.md`).

The `routespec` command (`bin/routespec.mjs`, Node 22.18+ with built-in type stripping).
stdout carries exactly one JSON document per invocation; diagnostics and JSON log lines go to
stderr. Exit codes: 0 PASS, 2 FAIL, 3 REVIEW/NOT_RUN/incomplete, 4 user/configuration/schema
error, 5 internal error or corrupted state, 6 safety policy denial.

Commands: `project create`, `revision register`, `build register`, `effect manifest`,
`effect policy`, `scenario validate|add`, `corpus create`, `gate create|run|evaluate|show`,
`case recover`, `export plan|write|verify`, `probe dry` (always refused here: the live-dry probe is
a separately authorized adapter), `certificate keygen|publish|verify|revoke-check` (M47), `certificate badge` (M49),
and `mcp` (M52: starts the MCP server of `packages/mcp` on stdio; it is the one command that does
not print a single JSON document). The data
directory comes from `--data` or `ROUTESPEC_DATA_DIR`.

`gate run` hands each case to the reviewed launcher (`runWithLauncher`) over an inherited IPC
pipe; the caller connects its separately started client to the printed proxy origin. Without a
launcher, only `--plan-only` is accepted (zero cases start: NOT_RUN).

## Release certificates (M47)

`certificate publish` verifies an evidence bundle, builds its certificate (bundle digest, gate
verdict, corpus digest, client artifact digest, commit, timestamp), signs it with an attester
key, and writes the signed envelope (`--out`) or submits it to the `routespec-registry` contract
on NEAR (`--submit`). `certificate verify` reads the registry and exits 0 only when the release
aggregates to PASS: under the default policy `require-onchain-attester` that needs a certificate
for exactly this bundle from an enrolled, unrevoked attester. `certificate revoke-check` reports
attester revocations. `certificate keygen` creates an attester key file.

These are the only commands that contact a network, and only the NEAR JSON-RPC endpoint named by
`--network testnet|mainnet` or `--rpc <https url>`. Gate runs and evaluations stay networkless.
Secrets come from a key file (`--attester-key`, `--near-key`) or from `ROUTESPEC_ATTESTER_KEY`,
`ROUTESPEC_NEAR_SIGNER_ACCOUNT` and `ROUTESPEC_NEAR_SIGNER_KEY`; they are never printed. Steps
and options: `docs/runbooks/release-certificates.md`; decisions:
`docs/adr/0029-onchain-release-certificates.md`.

`certificate badge` (M49) writes the shields.io endpoint JSON of the "RouteSpec Certified" badge
for a bundle digest, a bundle file, or a project's newest certificate (`--project-key`). The
status is the digest-only decision of `certificate verify --digest`; `--known-code-hash` refuses
unknown registry code and `--write-on-error` writes an "unverified" badge when the registry
cannot be read. Steps: `docs/runbooks/certified-badge.md`; decisions:
`docs/adr/0031-certified-badge-and-verify-page.md`.
