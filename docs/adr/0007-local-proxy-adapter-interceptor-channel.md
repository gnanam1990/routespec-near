# ADR-0007 — Networkless proxy, versioned client adapter, and interceptor channel transport

- Date: 2026-11-11. Decision owner: RouteSpec engineering (M02 stage), pending user review.
- Status: ACCEPTED
- Related: FR-02, FR-03, FR-04, FR-07, FR-17, NFR-02, NFR-03, NFR-09, INV-10, INV-11; module M02
  (T-010, T-016, T-017); supports T-004 (owned by M04). Builds on ADR-0002 (SDK pin), ADR-0004
  (journal), ADR-0006 (scenario runtime).

## Context

M02 needs a loopback proxy that the exact pinned official SDK can drive, with no upstream path,
plus a subject-side adapter and the transport foundation for an independent effect interceptor.
The pack leaves open where the adapter lives, how the SDK is hooked, what "SDK-internal retry"
means for an SDK that has none, how teardown differs from abort, and how interceptor containment
is labelled on a host without an OS sandbox.

## Decisions

1. **Proxy process (`packages/proxy`).** `ScenarioProxy` binds `127.0.0.1` with `exclusive: true`
   and verifies the bound address is IPv4 loopback. It accepts only origin-form targets in normal
   form, Host `127.0.0.1:<port>`/`localhost:<port>`, no `Origin`/`Sec-Fetch-Site`, `application/json`
   bodies without content encoding, a 16 KiB body cap and depth 16. Only the profile's three routes
   resolve; every other method/path (including the control prefix and prohibited SDK routes) is
   `RS_UNSUPPORTED_ROUTE` with `upstreamAttempted: false`, journaled as a `PROXY_REQUEST_DENIED`
   audit event with safe fields only. LIVE_DRY_PROBE is refused at construction.
2. **Authorization order.** Token and bound identity are verified (read-only transaction) before
   the scenario may plan a step or a runtime is even consulted, so a revoked, copied, foreign, or
   torn-down case is refused for its credentials first and never consumes a scenario step. The
   exchange is then journaled through M01's atomic phase bindings before the response is applied.
3. **Unknown outcome.** When an accepted commit's response is dropped, abandoned at a barrier, or
   the client disconnects, the proxy notifies the supervisor synchronously before the socket
   closes. The supervisor fences the case (`requireRecovery`) and issues exactly one
   RECONCILIATION_ONLY token bound to the same client instance, pushed over the launcher channel.
4. **Teardown vs abort.** New store operation `closeCaseInput(fence)` revokes active case tokens and
   records the teardown time while leaving the lifecycle RUNNING for the evaluator (M04).
   `CaseSupervisor.teardown` finishes scenario input (recording evidence) and calls it. Abort
   remains a separate, verdict-free terminal path.
5. **Client adapter (`packages/client-adapter`).** The subject-side adapter is its own package with
   no dependency on the SDK: the caller passes `{ OpenAPI, axios, packageName, packageVersion }`.
   `attach` refuses anything but `@defuse-protocol/one-click-sdk-typescript@0.1.26` with embedded
   API version `0.1.10`. It uses only the SDK's documented `OpenAPI.BASE` and the axios instance
   the SDK imports (request/response interceptors); it does not wrap or replace service calls.
   The SDK is a devDependency of `packages/proxy` for tests only (static audit covers `src/`).
6. **Correlation.** Per transport attempt the adapter sends session, case run, adapter revision,
   fencing epoch, client instance, case token, and a fresh `tr-<uuid>` transport ID; the logical
   job on quotes; the RouteSpec-assigned run operation (learned from the quote response header
   and keyed by the response-assigned deposit address) on commit and status. For any origin other
   than the configured loopback RouteSpec origin every `x-routespec-*` header is removed.
7. **Retry.** The pinned SDK 0.1.26 sends each request once (its `request` has no retry). The adapter
   retries a request that received no HTTP response at most once, same method/URL/body/run
   operation, new transport ID. HTTP responses (including RouteSpec denials) are never retried.
   T-016 labels this an adapter transport retry through the SDK's own pipeline, not an SDK feature.
8. **Credential updates.** `updateCredentials` must keep session/case/client and strictly advance
   the epoch (so an old token cannot be re-installed); `reset` requires a fresh session, case, and
   client instance with an EXECUTION token and clears all correlation.
9. **Interceptor transport.** `InterceptorHost.launch` checks the LF-normalized text digest of the
   reviewed self-contained artifact (`src/interceptor/canary-interceptor.ts`, pinned in
   `CANARY_INTERCEPTOR_ARTIFACT_DIGEST`) before spawning, forks it with an inherited IPC pipe and a
   minimal environment, sends a random 256-bit channel key over the pipe only (the journal keeps
   its digest), verifies the peer pid, and registers the instance under the case fence (migration
   003). Each sink attempt is journaled ATTEMPTED and then BLOCKED (before release) or RELEASED to a
   no-effect canary (after release) and the subject is answered only after the journal acknowledges
   the frame; any rejection fails closed. Teardown records `TEARDOWN`; pipe loss records
   `CHANNEL_LOST`.
10. **Containment.** No OS/container sandbox confining the subject process tree is integrated on
    any platform, so `detectContainment()` always returns `DECLARED_HOOKS_ONLY`
    (`NO_PROCESS_TREE_SANDBOX`). M02 never claims complete boundary coverage.

## Consequences and limits

- No-egress evidence is scoped to the RouteSpec proxy process (tripwire on `node:dns`, `node:net`,
  `net.client.socket`, and undici). It says nothing about the subject client process tree.
- The interceptor is an opt-in sink endpoint; a subject that calls a real target directly bypasses
  it, which is exactly why containment stays `DECLARED_HOOKS_ONLY`.
- Changing the interceptor artifact requires re-review and a new pinned digest.

## Invalidation

A new SDK version or a change to its `OpenAPI`/axios integration points, a new profile route, a
sandbox integration that can enforce process-tree confinement, or a change to the token/fence
model in M01 requires revisiting this ADR.
