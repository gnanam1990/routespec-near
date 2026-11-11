# @routespec/proxy

Owner module: M02. Status: **VERIFIED_BOUNDED** on win32/x64 (see `docs/status/M02.md`).

Networkless loopback 1Click-compatible scenario proxy for SIMULATE and REPLAY, with:

- `ScenarioProxy` — binds `127.0.0.1` only, strict Host/Origin and request-target checks, bounded
  JSON parsing, only the three profile routes (`POST /v0/quote`, `POST /v0/deposit/submit`,
  `GET /v0/status`); everything else is a typed local denial with `upstreamAttempted: false`.
- `Redactor` — strips provider `Authorization`/cookies and every `x-routespec-*` header before
  recording; rejects configured secret values, JWT/bearer/private-key patterns, and secret-named
  fields before persistence.
- `CaseSupervisor` — one scenario runtime per case, unknown-outcome fencing with exactly one
  reconciliation-only token, teardown, and ground-truth evidence recording.
- `installNetworkTripwire` — counts DNS/socket/undici attempts in the RouteSpec process.
- `InterceptorHost` — launches the reviewed canary interceptor artifact over a private inherited
  pipe, binds it to the exact case identity, and labels containment `DECLARED_HOOKS_ONLY`.

This package never imports an upstream HTTP client, TLS, or the official SDK (static audit in
T-010). LIVE_DRY_PROBE is refused; it belongs to the separately launched M07 adapter.
