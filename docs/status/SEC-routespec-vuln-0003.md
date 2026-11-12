# SEC vuln-0003 — Auth-failure budget locked out the operator: status evidence

- Source: external automated scan, finding vuln-0003 (LOW, CWE-770, availability only). Verified
  independently on the real control server before any change.
- State: **FIXED** on `feat/routespec-m22-auth-failure-budget-dos` (base `f20917f`, `main`
  merged in before the final runs).
- ADR: `docs/adr/0022-auth-failure-budget-not-a-lockout.md` (amends one sentence of ADR-0013
  decision 3).

## Finding (verified)

`packages/control-api/src/server.ts` keeps one fixed-window counter set for every client. The
first check in `#handle` was
`take(reads|mutations) || exhausted('authFailures')`, before the browser boundary and before
authentication. After `authFailures` (default 50) failed authentications in the window, every
request was answered `429 RS_RATE_LIMITED`: the genuine control token and the console's static
assets included. Any local process can reach the loopback port, so it could keep the operator out
by repeating this each window. The read/mutation budget was also spent by requests the
Host/Origin/Fetch-Metadata boundary then refused.

Existing tests (T-037, T-042) asserted the lockout on purpose ("no oracle for guessing"). The
control token is `rsctl_` plus 32 random bytes, so throttling guesses adds nothing against a
256-bit secret, while the lockout is a real denial of service.

## Change

1. `checkBrowserBoundary` runs before the read/mutation budget is taken.
2. The auth-failure window is consulted only when authentication fails. While it is exhausted the
   failing request is answered 429 (and still counted) instead of 401. Requests with the genuine
   token, case-token routes and static assets are not affected by it.
3. Read/mutation budgets are unchanged (global; T-042 floods still get 429).

## Test (red, green)

`packages/control-api/test/sec-vuln-0003-auth-failure-budget.test.ts` (real `ControlServer` on a
loopback socket, port 0):

- exhausts the failure window (5) with random bad tokens: first 5 are 401, the rest 429, a request
  without credentials is 429; then the genuine token gets 200 on `/metrics` and `/projects`, and
  `/` and `/assets/app.js` get 200; the journal row counts are unchanged;
- with `reads: 5`, 20 foreign-Host and 20 cross-origin requests are refused with
  `RS_HOST_REJECTED` / `RS_ORIGIN_REJECTED` (not `RS_RATE_LIMITED`), and a genuine read still
  gets 200.

T-037 and T-042 now assert that further failing guesses get 429 and the genuine token gets 200
during the window.

| Step                                                                                         | Exit | Result                                                                                           |
| -------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------ |
| `npx vitest run packages/control-api/test/sec-vuln-0003-auth-failure-budget.test.ts`, before | 1    | 2 failed (2): genuine token got 429 after the window; cross-origin request got `RS_RATE_LIMITED` |
| same, after                                                                                  | 0    | 2 passed (2)                                                                                     |
| `npx vitest run packages/control-api packages/security-suite`, after                         | 0    | 16 files, 88 passed, 1 skipped                                                                   |

## Full regression (after `git merge main`)

Environment: `ROUTESPEC_TEST_PORT_BASE=9600`, `ROUTESPEC_DELIVERY_PORT=9605`, `FIXTURE_PORT=9608`
(ports 9600-9609); everything else binds OS-assigned loopback ports.

| Command                  | Exit | Result                                                                                                                                                         |
| ------------------------ | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm run check`         | 0    | typecheck, lint, format, 80 files / 699 passed, 1 skipped; secret-scan clean                                                                                   |
| `pnpm run test:e2e:real` | 0    | 63 passed (console against the real control service)                                                                                                           |
| `pnpm run test:delivery` | 0    | 2 files, 14 passed, 7 skipped (the M14 contained journey skips itself on this host without its opt-in container setup; this change does not touch containment) |

Note: one earlier `pnpm run check` before the merge (default port window, run while other
suites were active on the host) had a single T-057 timing failure in `packages/cli`, unrelated to
this change; T-057 passed alone (2 passed) and the whole suite passed on the rerun above.

## Residual

- The global read/mutation budget can still be spent by a local valid-Host flood; this is the
  generic T-042 limit and cannot be keyed per client because every client is `127.0.0.1`.
