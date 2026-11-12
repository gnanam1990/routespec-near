# SEC RS-01 — Unauthenticated interceptor sink: status evidence

- Source: external security audit, finding RS-01 (medium). Verified independently on the real code
  with a failing test before any change.
- State: **FIXED** on `feat/routespec-m23-interceptor-sink-auth` (base `c588307`; `main` merged in
  before the final runs).
- ADR: `docs/adr/0024-interceptor-sink-token.md`.

## Finding (verified)

`packages/proxy/src/interceptor/canary-interceptor.ts` listens on `127.0.0.1:0` and handled
`POST /sink/<class>` with no caller check. It checked only the route, the `effectId` shape and the
body size. Each request was framed as ATTEMPTED, then BLOCKED or RELEASED, and sent to the parent
with the private channel key. `InterceptorHost` passed the frames to
`store.recordBoundaryObservation`, which authenticates only the channel key, so they were journaled
as boundary observations for the case's interceptor instance. INV-04 then dropped its
`REQUIRED_SINK_UNOBSERVED:<sink>` gap. In contained mode, `ContainmentHost.#onFrame` made the
one-shot release decision on the first ATTEMPTED frame.

Red reproduction: a separate `node` process with `env: {}` (no RouteSpec credentials) posted
`{"effectId":"forged-by-other-process"}` to the sink. It got `409 EFFECT_NOT_RELEASED`, and the
journal and `onFrame` recorded ATTEMPTED and BLOCKED for it.

## Change

1. `InterceptorHost.launch` creates a random per-instance sink token, or takes one from the
   caller as `sinkToken`, and sends it in the `bind` message over the inherited IPC pipe. It is
   never placed in argv or the environment and is not journaled.
2. The interceptor refuses any sink request that lacks the exact token in
   `x-routespec-sink-token`. The comparison is constant-time. The refusal is
   `401 {denied: true, reason: "SINK_UNAUTHENTICATED"}` and happens before the body is read or a
   frame is sent. A bind without a well-formed token is refused.
3. The containment host issues the token per case and gives it only to the contained subject, in
   `effectSink.token` of the run request. It passes the same token to the interceptor when the
   subject first connects to the sink tunnel. The test subject (`deliverEffect`) and the test
   helpers send the header.
4. The pinned `CANARY_INTERCEPTOR_ARTIFACT_DIGEST` is updated for the reviewed artifact change:
   `sha256:2105d1ab3a14f6a40fa4957753578bd23b60d9dd18510739fc4bd0d95ae12710`.

## Tests (red, green)

- `packages/proxy/test/interceptor-channel.test.ts`: "an unrelated local process without the
  per-instance sink token cannot frame or journal anything (RS-01)". A separate process with an
  empty environment posts with no token and with a wrong token. Both requests get 401
  `SINK_UNAUTHENTICATED`. No frame, ack or boundary observation follows. The bound subject is
  then still observed (409, ATTEMPTED and BLOCKED).
- `packages/kernel/test/t004-protected-effect.test.ts`: "a sink request from an unrelated local
  process is refused and is not boundary evidence (RS-01)". A baseline live case and a forged live
  case run without subject attempts. The forger gets 401, the journal holds no boundary
  observations, and INV-04 is REVIEW with `REQUIRED_SINK_UNOBSERVED:fulfilment-webhook` still
  present.

| Step                                                                                                 | Exit | Result                                                             |
| ---------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------ |
| `npx vitest run packages/proxy/test/interceptor-channel.test.ts -t RS-01`, before                    | 1    | 1 failed: forger got `409 EFFECT_NOT_RELEASED` twice, expected 401 |
| `npx vitest run packages/kernel/test/t004-protected-effect.test.ts -t RS-01`, before                 | 1    | 1 failed: forged attempt status 409, expected 401                  |
| `npx vitest run` on the proxy interceptor test, T-004 and T-059, after                               | 0    | 3 files, 23 passed                                                 |
| `ROUTESPEC_CONTAINER_CLI=<wsl docker> pnpm run test:containment` (Docker 29.1.3 in WSL Ubuntu 24.04) | 0    | 4 files, 19 passed, none skipped (contained case released once)    |

## Full regression (after `git merge main`)

Environment: `ROUTESPEC_TEST_PORT_BASE=9700`, `ROUTESPEC_DELIVERY_PORT=9705`, `FIXTURE_PORT=9708`
(ports 9700-9709), and
`ROUTESPEC_CONTAINER_CLI='["wsl.exe","-d","Ubuntu-24.04","-u","root","--exec","docker"]'` for the
containment and delivery suites.

| Command                     | Exit | Result                                                                                        |
| --------------------------- | ---- | --------------------------------------------------------------------------------------------- |
| `pnpm run check`            | 0    | typecheck, lint, format clean; 83 files, 711 passed, 2 skipped; secret scan clean (519 files) |
| `pnpm run test:containment` | 0    | 4 files, 19 passed, none skipped (Docker 29.1.3 in WSL Ubuntu 24.04)                          |
| `pnpm run test:delivery`    | 0    | 2 files, 21 passed (clean-clone uncontained journey and contained journey, none skipped)      |

Note: earlier `pnpm run check` runs, made while sibling suites were loading the host, had
timing failures in unrelated kill-timing and timeout-bound tests (T-025, T-044, T-046, T-057 (a 60 s timeout),
M16, T-036, M14 export boundary kill). Each passed when rerun alone and the whole suite passed on
the run above. One earlier `pnpm run test:delivery` (before `main` was merged) had a T-058 upload
failure inside the clean clone that did not reproduce; the run above passed.

## Residual

- A process that can read the bound subject's memory or its run request can present the token.
  Under containment that is the subject itself. Uncontained runs are `DECLARED_HOOKS_ONLY` and were
  never complete-coverage evidence.
- Any local process can still connect to the loopback port. It gets a 401 and changes no journal
  or release state.
