# @routespec/runner

Owner module: M06. Status: **VERIFIED_BOUNDED** on win32/x64 (see `docs/status/M06.md`).

Gate runner and release gates over the real domain modules:

- `GateService` — immutable GateRun creation (bound to a gate definition, build/artifact,
  corpus, effect manifest/policy, adapter/evaluator/proxy revisions), validation, start, a
  bounded-parallelism case scheduler with a fresh session/client/token per case, cancel, restart
  recovery (one reconciliation-only token, interruption recorded), kernel evaluation, and gate
  evaluation persisted as one immutable record.
- `aggregateGate` — pure fail-closed precedence: FAIL dominates; zero started required cases is
  NOT_RUN; anything incomplete, interrupted, stale, tampered, identity-mismatched, or unattested
  under a strict policy is REVIEW; PASS only when every required case is a complete PASS.
- `CaseDriver` / `IpcCaseDriver` — the reviewed launcher channel. The runner never launches
  integrator commands; credentials cross only the inherited IPC pipe.
- Reports — JSON (`routespec.gate-report/1`), JUnit, SARIF 2.1.0 (source-locatable findings only).
- Bundles — deterministic ustar evidence bundles with a privacy scan, explicit confirmation,
  checksummed manifest, declared exclusions, and stand-alone verification. No signature is claimed.
- `Logger` / `Metrics` — structured, redacted local logs and counters; no telemetry.

Decisions: `docs/adr/0012-runner-cli-release-gates.md`.
