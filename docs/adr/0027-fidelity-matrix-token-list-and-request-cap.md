# ADR-0027 — Fidelity matrix: token-list read, 40-request session cap, and a drift baseline

- Date: 2026-11-13. Decision owner: RouteSpec engineering (M51 stage), pending user review.
- Status: ACCEPTED
- Related: FR-04, FR-16, NFR-08, NFR-12, INV-08, INV-10; RP-07; module M51. Amends ADR-0011
  (decisions 3 and 8) for one explicitly requested mode. Builds on ADR-0002 (SDK pin) and M42
  (request-echo equivalence).

## Context

M42 recorded `OFFICIAL_ENDPOINT_COMPATIBLE` for one asset pair on one day. M51 widens that
evidence to a matrix: one `dry: true` quote per route over 20 or more routes taken from the
official token list, a response shape digest per route, a markdown matrix, and a scheduled CI job
that reports drift. Two things in ADR-0011 stand in the way: the adapter forwards nothing but
`POST /v0/quote` (so it cannot read the token list), and it forwards one request per session by
default with no stated upper bound when a caller asks for more.

**This goes beyond the specification pack.** `docs/spec/SECURITY.md` allows the live-dry adapter
"only a narrowly allowlisted upstream read/dry request" and RP-07 describes a single dry probe.
The pack does not describe a token-list read or a multi-route run. This ADR records the extension
and keeps every RP-07 rule in force for it; `docs/spec/` is unchanged.

## Decisions

1. **Same process, same egress.** The matrix runs through the existing separately launched
   adapter. No second network-capable component is added; outbound network modules stay confined
   to `egress.ts` (the boundary audit covers the new `matrix-*.ts` files).
2. **Token-list read is opt-in per session.** A start message may carry `maxTokenListFetches`
   (default 0). Only then does the adapter consult `classifyTokenListRequest`, which allows exactly
   a bare `GET /v0/tokens`: no query string (so `ondoTokens` cannot be sent), no body, no content
   encoding. With the default budget the route is denied as before (`ROUTE_NOT_ALLOWLISTED`,
   T-021 unchanged). The allowance is issued from its own module-private `WeakSet`.
3. **No credential on the token-list read.** `sendTokenListRequest` takes no vault, and the vault
   releases the credential only for a dry-quote allowance, so the public read cannot carry the
   provider JWT. It uses the same resolve-once, address-policy, pinned TLS, no-redirect,
   no-decompression, bounded exchange as a dry quote; its response bound is 2 MiB instead of
   256 KiB. Nothing about it is written to the compatibility ledger, and it never produces a
   compatibility label.
4. **Hard cap of 40 upstream requests per session.** `LIVE_DRY_HARD_REQUEST_CAP = 40`. An adapter
   whose `maxProbes + maxTokenListFetches` exceeds 40 refuses to start
   (`RS_MODE_POLICY_DENIED` / `REQUEST_CAP_EXCEEDED`); the server checks the combined count again
   before each egress. The matrix command starts a session with one token-list read and at most 39
   dry quotes, counts requests itself before each call, and never retries.
5. **Deterministic routes, intents-side endpoints.** Routes are a pure function of the sanitized
   token list: the NEAR pair wNEAR/USDC both ways, then USDC on NEAR against each other chain's
   preferred token (USDC, USDT, lowest asset id), alternating direction, chains ordered by listed
   token count then name. Each request is EXACT_INPUT for about 20 USD of the origin asset, with
   `refundType` and `recipientType` `INTENTS` and the all-zero implicit account, so no
   chain-specific address is needed and no real account is named. The price from the token list
   is used in memory to size the amount and is not kept.
6. **Probe until the target is met.** A run aims for 24 routes with a judgeable (2xx) answer. A
   route the endpoint cannot quote (for example no liquidity) stays in the matrix as `UNKNOWN`
   and the next candidate is probed, up to the 39-quote ceiling. A provider refusal message is
   reduced to one of three fixed labels (`NO_LIQUIDITY`, `AMOUNT_TOO_LOW`, `OTHER`); the text is
   not kept.
7. **What is kept.** Per route: public asset ids and symbols from the token list, HTTP status,
   the adapter's compatibility label and reason, the type-only response shape digest, and the
   round-trip time. Never: amounts, prices, addresses, signatures, correlation ids, response
   bodies, the credential. No quote is ever written to a file, so none can be committed.
8. **Drift baseline.** `packages/live-dry-adapter/fidelity-baseline.json` lists the reviewed
   response shape digests for the pinned profile. Verdicts: `DRIFT` (a 2xx answer that is not the
   profile shape; exit 1), `INCONCLUSIVE` (fewer than 20 compatible routes, no token list, or an
   injected transport; exit 3), `NEW_SHAPE` (profile-compatible but a digest outside the baseline;
   exit 0, to be reviewed), `NO_DRIFT` (exit 0). Only the system transport can yield a compatible
   row, so a test run cannot produce a passing matrix.
9. **Scheduled job.** `.github/workflows/fidelity-matrix.yml` runs daily and on manual dispatch
   only, with `contents: read` and nothing else, the JWT as a repository secret passed to one step
   as an environment variable, actions pinned by commit. It publishes the redacted matrix to the
   job summary and uploads it with a shields endpoint file (`fidelity-badge.json`). A failing run
   opens no issue, comment or pull request. The drift badge is the workflow's own status badge;
   the endpoint file is there for a later Pages stage to serve.

## Consequences

- The matrix is still RP-07 evidence only: its own axis, never an input to a GateRun, and it
  does not change `WORKING_LOCAL`.
- The intents-side refund and recipient types mean the matrix does not exercise
  `ORIGIN_CHAIN`/`DESTINATION_CHAIN` address validation per chain; M42's probe covers that pair
  for NEAR only.
- A daily run costs about 27 requests against the provider key. The cap bounds a single run, not
  a day; the schedule is the only automatic trigger.
- A new optional response field shows up as `NEW_SHAPE` (yellow, exit 0) and needs a baseline
  review; a field outside the profile shows up as `DRIFT` (red, exit 1) and needs a profile
  review and a re-pin (ADR-0011 decision 12).
