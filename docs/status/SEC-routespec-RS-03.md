# SEC RS-03 — Pre-authentication read/mutation budget: status evidence

- Source: self-run audit, Cloudflare security-audit skill methodology, finding RS-03 (low, availability only; a variant of
  vuln-0003). Re-confirmed with a failing test on the real control server before any change.
- State: **FIXED** on `feat/routespec-m25-preauth-rate-budget` (base `c588307`, `main` merged in
  before the final run).
- ADR: `docs/adr/0022-auth-failure-budget-not-a-lockout.md`, amendment "budgets charged only after
  authentication" (replaces decision 3). No protocol or wire-format change.

## Finding (verified)

`ControlServer.#handle` (`packages/control-api/src/server.ts`) took the process-global `reads` or
`mutations` unit right after the browser boundary and before `authenticate()`. Any same-host
process with no credential and a valid Host header could send just over 500 POSTs (or 2000 GETs)
inside one 10 s window; every later genuine-token mutation (or read) was then refused with
`429 RS_RATE_LIMITED` until the window ended, and the flood could be repeated each window.
Failed authentication already had its own `authFailures` window, so charging those requests to
the shared budgets added nothing to flood control.

## Change

1. The read/mutation unit is taken only after a credential is accepted: the control bearer token,
   or on the subject route (`POST /effects/observe`) the case token checked by
   `caseAuthFromHeaders` (now evaluated at the same decision point as the bearer check).
2. A request that fails authentication (control or case; missing, wrong or malformed) counts only
   in the `authFailures` window; once that window is exhausted further failures get 429, as
   after vuln-0003. The genuine token is never charged for them.
3. Console static assets (no credential) are charged to a separate `static` counter with the
   read limit, so asset traffic cannot spend the API read budget. `OPTIONS` is refused (405)
   before any budget is charged; the browser boundary still runs first.
4. Default limits are unchanged; a genuine-token holder is still limited by the global budgets.

## Test (red, green)

`packages/control-api/test/sec-rs-03-preauth-rate-budget.test.ts` (real `ControlServer` on a
loopback socket, port 0, limits `{windowMs: 60000, mutations: 5, reads: 5, authFailures: 3}`):

- 10 credential-less POSTs: 3x 401 then 429; the genuine POST then gets 201 and a GET 200;
- 6 credential-less and 6 wrong-token GETs; the genuine GET then gets 200 and a POST 201;
- 10 POSTs to the case route without case headers: 3 refused (4xx, not 429) then 429; a genuine
  control mutation still gets 201;
- 8 static `/` requests: 5x 200 then 429; a genuine API read still gets 200;
- control: the genuine token itself is still limited (`reads: 3` -> 200,200,200,429;
  `mutations: 2` -> 201,201,429 with `RS_RATE_LIMITED`).

| Step                                                                                         | Exit | Result                                                                                                                              |
| -------------------------------------------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `npx vitest run packages/control-api/test/sec-rs-03-preauth-rate-budget.test.ts`, before fix | 1    | 4 failed, 1 passed (5): genuine POST and GET got 429 after the floods; case-route failures were not 429; static flood drained reads |
| same, after fix                                                                              | 0    | 5 passed (5)                                                                                                                        |

## Full regression

Environment: `ROUTESPEC_TEST_PORT_BASE=9720`, `ROUTESPEC_DELIVERY_PORT=9725`, `FIXTURE_PORT=9728`
(ports 9720-9729), `ROUTESPEC_CONTAINER_CLI` naming Docker in WSL 2 (Ubuntu 24.04, `-u root
--exec docker`); everything else binds OS-assigned loopback ports.

| Command                                              | Exit | Result                                                                       |
| ---------------------------------------------------- | ---- | ---------------------------------------------------------------------------- |
| `pnpm run check` (before merging `main`)             | 0    | typecheck, lint, format, 82 files / 708 passed, 2 skipped; secret-scan clean |
| `pnpm run test:containment` (before merging `main`)  | 0    | 4 files, 19 passed (engine configured)                                       |
| `pnpm run test:delivery` (before merging `main`)     | 0    | 2 files, 21 passed (includes the contained journey)                          |
| `pnpm run check` (after `git merge main`)            | 0    | typecheck, lint, format, 84 files / 714 passed, 2 skipped; secret-scan clean |
| `pnpm run test:containment` (after `git merge main`) | 0    | 4 files, 19 passed                                                           |
| `pnpm run test:delivery` (after `git merge main`)    | 0    | 2 files, 21 passed                                                           |

Final run, after merging `main` again (bringing in RS-02 `packages/containment` with ADR-0023,
RS-05 and RS-07 in `packages/store`, `packages/cli`, `packages/runner` and
`packages/control-api/src/main.ts`, and RS-01 in `packages/proxy` and
`packages/control-api/src/containment-host.ts` with ADR-0024): `pnpm run check` 0 (86 files: 85
passed, 1 skipped; 722 tests passed, 6 skipped; secret-scan clean), `pnpm run test:containment` 0
(4 files, 19 passed), `pnpm run test:delivery` 0 (2 files, 21 passed).

`main` brought in RS-04, RS-06, RS-02, RS-05, RS-07 and RS-01; none of them touches
`packages/control-api/src/server.ts`. Merge conflicts were limited to `BUILD-STATUS.md` (both
entries kept).

Note: three intermediate `pnpm run check` runs after the first merge, made while several sibling
branches were running their own suites on this host (CPU at 100%), failed only in timing-bound
tests (T-057 and T-025 in `packages/cli`, and the 2 s-window T-042 flood case). Each passed when
run alone (T-057 2/2, T-025 5/5 twice, T-042 12/12), and the full suite passed on the quiet-host
rerun above.

## Residual

- A holder of the genuine control token can still spend the global budgets (T-042 limit).
- An unauthenticated local process can fill the `authFailures` window (its own and other failing
  requests get 429) and the static-asset counter (the console shell can be slowed; the API
  cannot). Neither affects genuine-token API requests.
