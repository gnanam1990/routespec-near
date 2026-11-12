# ADR-0022 — The authentication-failure budget is not a global lockout (SEC vuln-0003)

- Status: accepted
- Date: 2026-11-12
- Module: security follow-up on M08/M11 (control API rate limits; supersedes one sentence of
  ADR-0013 decision 3)

## Context

An external automated scan reported that the control API's failed-authentication window was a
process-wide lockout. ADR-0013 said "when it is exhausted every request gets 429". The rate
limiter is a single fixed window shared by every client, and the service is reachable by any local
process on the loopback port with no peer authentication. Fifty bad-token requests in ten seconds
therefore made every request answer `429 RS_RATE_LIMITED`, including requests that carried the
genuine control token and requests for the console's static assets. Repeating this each window
kept the operator locked out (CWE-770, availability only). The read and mutation budgets were also
spent before the Host/Origin/Fetch-Metadata boundary ran, so requests the boundary refuses still
used up the shared budget.

The lockout was meant to remove a guessing oracle. The control token is 32 random bytes
(`rsctl_` + 256 bits), so throttling guesses gives no practical gain over refusing them, and a
genuine token presented during the window is not a guess.

## Decision

1. The browser boundary (`checkBrowserBoundary`) runs before the read/mutation budget is taken.
   Refused foreign-Host, cross-origin and cross-site requests no longer spend the shared budget.
2. The authentication-failure window throttles only requests that fail authentication. While it is
   exhausted, a failing or missing credential is answered `429 RS_RATE_LIMITED` instead of
   401, and it still counts against the window. A request with the genuine control token is served
   normally, and console static assets (which need no control credential) are unaffected.
3. The read and mutation budgets are unchanged and remain global, per ADR-0013 and SECURITY.md
   ("Rate-limit endpoints").

## Consequences

- A local process can no longer deny the operator the control API or the console by sending bad
  tokens. It can still spend the global read/mutation budget with valid-Host requests; that is the
  generic request-flood limit (T-042) and is not keyed per client because every client is
  `127.0.0.1`.
- Wrong guesses after the window is exhausted get 429 rather than 401, as before.
- Tests: `packages/control-api/test/sec-vuln-0003-auth-failure-budget.test.ts` (new); T-037 and
  T-042 assertions that the genuine token is refused during the window now assert it is served.
- Evidence: `docs/status/SEC-routespec-vuln-0003.md`.

## Amendment — budgets charged only after authentication (SEC RS-03)

- Date: 2026-11-12
- Source: external security audit, finding RS-03 (low, availability only).

Decision 3 left the read/mutation budgets charged before authentication, so a credential-less
local flood with a valid Host header (just over 500 POSTs or 2000 GETs in one 10 s window) made
every genuine-token mutation or read answer `429 RS_RATE_LIMITED` until the window ended. The
"cannot be keyed per client" residual above overlooked that clients can be keyed by
authentication outcome. Decision 3 is replaced by:

3. The read and mutation budgets stay global (ADR-0013, SECURITY.md "Rate-limit endpoints") but
   are charged only after a credential is accepted: the control bearer token, or on the subject
   route (`POST /effects/observe`) the case token checked by `caseAuthFromHeaders`. A request that
   fails authentication (missing, wrong or malformed credential, control or case) counts only in
   the authentication-failure window. Console static assets carry no credential and are charged
   to their own counter (same limit as reads), so asset traffic cannot spend the API read budget.
   `OPTIONS` is refused before any budget is charged.

Consequences: an unauthenticated local process can no longer exhaust the operator's read or
mutation allocation; it can only fill the failure window (its own further failures get 429) or
the static-asset counter (the console shell, not the API). A holder of the genuine token is still
limited by the global budgets. Tests: `packages/control-api/test/sec-rs-03-preauth-rate-budget.test.ts`.
Evidence: `docs/status/SEC-routespec-RS-03.md`.
