# SEC RS-06 — Shared scenario proxy keyed connection barriers by step id only: status evidence

- Source: self-run audit, Cloudflare security-audit skill methodology, finding RS-06 (LOW; likelihood low, impact medium). Verified
  independently on the real proxy before any change.
- State: **FIXED** on `feat/routespec-m28-proxy-barrier-case-scope` (base `c588307`, `main`
  merged in before the final runs).
- ADR: none. No protocol, header, journal or public API changes; the fix is internal to
  `ScenarioProxy`.

## Finding (verified)

The runner opens one `ScenarioProxy` for every case of a gate and runs cases with bounded
parallelism (`max_parallel_cases` 1..64). `packages/proxy/src/server.ts` kept held
connection-barrier responses in one proxy-wide `Map<string, () => void>` keyed only by the
scenario step id, and step ids are unique only within one scenario. With two concurrent cases
running the same scenario:

- case B's `HOLD_BARRIER` overwrote case A's held response under the same step id;
- case A's own release (its runtime's `releasedBarriers`) delivered case B's held response;
- case A's held commit was never answered, so the supervisor saw `BARRIER_ABANDONED` for case A
  and fenced it into recovery (`requireRecovery ... OUTCOME_UNKNOWN`) although A's runtime had
  recorded `BARRIER_HELD` then `BARRIER_RELEASED`.

Fault injection, and so verdict inputs, crossed case boundaries.

## Change (`packages/proxy/src/server.ts`)

1. Held barriers are keyed by `caseRunId` + NUL + `stepId` (`barrierKey`). The case run id is the
   one authenticated for the request (case token bound to case, session and epoch), and is a
   UUID, so the separator cannot collide.
2. `releaseBarriers(caseRunId, decision)` releases only the releasing case's own entries; both
   call sites (accepted exchange and `RESET_BEFORE_ACCEPT`) pass the authenticated case run id.
3. When a held response's client goes away (case teardown, client disconnect), its entry is
   removed if it still holds that response, so the map stays bounded and a stale closure can
   never be delivered later. The `BARRIER_ABANDONED` report for that case is unchanged.

Spec-required behaviour is unchanged: barriers stay deterministic per case and a lost held
response is still reported to the supervisor as an uncertain outcome for its own case.

## Test (red, green)

`packages/proxy/test/sec-rs06-barrier-case-scope.test.ts` runs the real `ScenarioProxy` on a
loopback socket (OS-assigned port) with a stub store and two real `ScenarioRuntime` instances
compiled from one scenario with a shared `c-barrier` step (different seeds):

- A and B both hold `c-barrier`; A's STATUS delivers A's held commit (200) and B's stays held;
  B's STATUS then delivers B's; responses differ; no uncertain outcome is reported;
- B's client abandons its held commit: exactly one `BARRIER_ABANDONED` for B; A's release still
  delivers A's own held commit.

| Step                                                                                    | Exit | Result                                                                                                       |
| --------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------ |
| `npx vitest run packages/proxy/test/sec-rs06-barrier-case-scope.test.ts`, before change | 1    | 2 failed (2): A's held commit not delivered by A's own release; after B abandoned, A's commit never answered |
| same, after change                                                                      | 0    | 2 passed (2)                                                                                                 |

## Full regression (after `git merge main`)

Environment: `ROUTESPEC_TEST_PORT_BASE=9750`, `ROUTESPEC_DELIVERY_PORT=9755`/`9756`, container
engine `ROUTESPEC_CONTAINER_CLI='["wsl.exe","-d","Ubuntu-24.04","-u","root","--exec","docker"]'`.
Everything else binds OS-assigned loopback ports.

| Command                     | Exit | Result                                                                             |
| --------------------------- | ---- | ---------------------------------------------------------------------------------- |
| `pnpm run check`            | 0    | typecheck, lint, format, 82 files / 705 passed, 2 skipped; secret-scan clean (514) |
| `pnpm run test:containment` | 0    | 4 files / 19 passed                                                                |
| `pnpm run test:delivery`    | 0    | 2 files / 21 passed (M12 uncontained 14, M14 contained 7)                          |

After a second `git merge main` (brought in the RS-04 fix, `packages/regressions` only; one
`BUILD-STATUS.md` conflict resolved by keeping both sections), `pnpm run check` exited 0 again
(83 files / 709 passed, 2 skipped; secret-scan clean, 517 files) and `pnpm run test:containment`
exited 0 again (4 files / 19 passed). `test:delivery` was not rerun: the merged change does not
touch the proxy, containment or delivery code.

## Residual

- None for this finding. Cases still share one proxy process by design (one proxy per gate).
