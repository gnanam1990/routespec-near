# @routespec/client-adapter

Owner module: M02. Versioned subject-side adapter (`routespec-adapter@1.0.0`) for the exact pinned
official SDK `@defuse-protocol/one-click-sdk-typescript@0.1.26`.

`RouteSpecClientAdapter.attach({ OpenAPI, axios, packageName, packageVersion }, { origin, credentials })`
sets the SDK's documented `OpenAPI.BASE` to the loopback RouteSpec origin and installs request and
response interceptors on the axios instance the SDK imports. It injects correlation headers and
the one-time case token only for the RouteSpec origin, removes every `x-routespec-*` header for
any other origin, correlates the RouteSpec-assigned run operation by the response-assigned
deposit address, retries a no-response transport failure once with a new transport ID, and
supports `updateCredentials` (reconciliation-only token, epoch must advance), `reset` (next case),
and `detach` (restores the SDK configuration).

It has no dependency on the SDK itself (the caller passes its SDK handle) and no persistence.
