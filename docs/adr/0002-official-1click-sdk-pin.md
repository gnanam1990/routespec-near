# ADR-0002 — Official 1Click TypeScript SDK pin and base-URL configurability

- Date: 2026-11-11. Decision owner: implementing agent (M00 stage), pending user review.
- Status: ACCEPTED
- Related: FR-03, FR-16, NFR-08, NFR-11; modules M00, M02, M07; tests T-016, T-018, T-020, T-021 (not owned by M00).

## Context and evidence

The pack requires pinning the exact official SDK at intake and stopping if it can no longer target a local base URL (`START-HERE.md`, `SOURCES.md` S-05).

Evidence (class: package source read from the npm registry; no 1Click API call was made):

- Package: `@defuse-protocol/one-click-sdk-typescript`, registry `latest` = `0.1.26`, published 2026-09-22T19:17:58.891Z, licence ISC, repository `github.com/defuse-protocol/one-click-sdk-typescript`, registry `gitHead` `414467b879863661e736eab338b316f567db68fe`, integrity `sha512-vYoBgEbppergtYd/H1IaJW9Jm5mPrX+jAwuuhMvDFstirJB53KFe2HnGLTg0KNyg6qztbOeDK0sA/oEAee+EAw==`.
- `dist/index.mjs` defines `var OpenAPI = { BASE: "https://1click.chaindefuser.com", VERSION: "0.1.10", TOKEN: void 0, HEADERS: void 0, ... }` and exports it; every service call passes this object to `request(OpenAPI, ...)`, which reads `BASE` per call. `OpenAPI.HEADERS` accepts a map or async resolver (adapter header injection point). `OpenAPI.TOKEN` is the documented JWT slot.
- Routes in this version: `POST /v0/quote`, `GET /v0/status?depositAddress&depositMemo`, `POST /v0/deposit/submit`, plus tokens, any-input withdrawals, generate-intent, submit-intent, orders, account, and auth routes (recorded in `packages/contracts/src/protocol/sdk-pin.ts`).
- `GetExecutionStatusResponse.status` enumerates exactly `KNOWN_DEPOSIT_TX, PENDING_DEPOSIT, INCOMPLETE_DEPOSIT, PROCESSING, SUCCESS, REFUNDED, FAILED` — the seven statuses the pack expects. No conflict found.
- Runtime check (local only): `packages/live-dry-adapter/test/sdk-pin.test.ts` sets `OpenAPI.BASE` to an in-test `127.0.0.1` server and observes `POST /v0/quote` and `GET /v0/status?depositAddress=...` arrive there with injected `x-routespec-*` headers and no `Authorization` header.

## Decision

Pin `@defuse-protocol/one-click-sdk-typescript@0.1.26` exactly, as a dependency of `packages/live-dry-adapter` only. The protocol profile `oneclick-v0@1.0.0` (`packages/contracts/src/protocol/oneclick-v0.ts`) is derived from its type declarations: request-known quote fields, response-assigned fields (including `quote.depositAddress`/`depositMemo`), display-only fields, commit material (`SubmitDepositTxRequest`), and reconciliation query. Only `/v0/quote`, `/v0/deposit/submit`, and `/v0/status` are supported; `submit-intent`, order mutation, and auth routes are classified PROHIBITED; all others UNSUPPORTED (typed denial, never pass-through).

**Base URL configurability: YES** for 0.1.26, via the exported mutable `OpenAPI.BASE`.

## Limits

This pin is the revision the contracts were derived from. It is not a claim that 0.1.26 is the current unqualified version at any later date, nor evidence that the hosted service behaves as the types describe (that is the separate `OFFICIAL_ENDPOINT_COMPATIBLE` axis, M07, which requires user-provided access and is BLOCKED for this stage). The registry `gitHead` was not cross-checked against GitHub source (no repository clone was performed).

## Invalidation

A new SDK version, a removed/immutable `OpenAPI.BASE`, a changed status enum, or new request-known fields require a new profile revision; the old profile remains for prior results.
