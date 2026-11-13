# ADR-0011 — Separately launched live-dry adapter, pinned egress, and the compatibility ledger

- Date: 2026-11-11. Decision owner: RouteSpec engineering (M07 stage), pending user review.
- Status: ACCEPTED
- Related: FR-03, FR-04, FR-10, FR-16, NFR-08, NFR-12, INV-08, INV-10; module M07 (T-020, T-021,
  T-038); RP-07. Builds on ADR-0002 (official SDK pin), ADR-0003 (canonical digests), ADR-0007
  (networkless proxy and client adapter).

## Context

M07 owns the only RouteSpec process allowed to reach the network: an explicit, user-initiated
dry quote to the official 1Click endpoint, used only to judge whether the pinned profile still
matches the live service. The pack requires that mutation denial, the route allowlist, redirect
rejection and the credential policy all run before credential attachment, DNS and sockets; that
the provider JWT exists only in this process's memory; that the result cannot upgrade a local
GateRun; and that everything except the real call is provable without network access.

## Decisions

1. **Process and entry.** `packages/live-dry-adapter/src/main.ts` is the production entry, started
   by `launch.ts` with `fork` and a sanitized environment (OS essentials only; never
   `NODE_OPTIONS`, proxy variables, `NODE_TLS_REJECT_UNAUTHORIZED` or `NODE_EXTRA_CA_CERTS`).
   It listens on `127.0.0.1` only. The pinned official SDK points `OpenAPI.BASE` at it and
   authenticates with an adapter-generated probe-session token (`x-routespec-probe-token`,
   compared by SHA-256 digest with `timingSafeEqual`). The provider `Authorization` header is
   never accepted as the local credential and is never forwarded.
2. **Order of checks.** Per request: loopback Host, no browser `Origin`, probe-session token,
   body bound (64 KiB); then the pure policy (`policy.ts`); then the probe budget; then egress.
   The policy has no inputs besides method, request target, headers and body bytes, so no
   scenario field or UI flag can widen it.
3. **Policy.** Only `POST /v0/quote`, origin-form, canonical path (no `%`, dot segments, double or
   trailing slash), no query, `application/json`, no content encoding. The body must parse as a
   strict, unambiguous object: duplicate keys at any depth, a BOM, invalid UTF-8, a non-object
   top level and nesting over 16 are refused (`JSON.parse` keeps the last duplicate, so
   `{"dry":true,"dry":false}` would otherwise read differently on each side). `dry` must be the
   boolean `true`; missing, string, number, null, array and false are each denied with their own
   reason. A request-side `depositAddress`/`depositMemo`, any commit or reconciliation material
   from the profile registry (`txHash`, `nearSenderAccount`, `memo`, ...) and known fund-moving
   names (`signedData`, `intent`, `transfer`, `withdrawal`, ...) are denied, then any field
   outside the profile's quote-request schema, then the profile validator. Every other SDK route
   is denied: deposit submit as `COMMITTED_MUTATION_ROUTE`, status as
   `STATUS_LOOKUP_DISABLED_BY_DEFAULT`, intent/order/auth routes as `PROHIBITED_ROUTE`, the rest
   as `ROUTE_NOT_ALLOWLISTED`; unknown paths are `RS_UNSUPPORTED_ROUTE`. A denial carries
   constant all-false `credentialAttached/dnsAttempted/socketAttempted/upstreamAttempted` flags.
4. **Allowance object.** The policy returns a frozen allowance and records it in a module-private
   `WeakSet`. The vault and the egress refuse anything else, including a field-for-field copy, so
   no code path can reach the credential or the network without passing the classifier. The
   forwarded body is re-serialized from the validated material, never the received bytes.
5. **Origin and addresses.** The only compilable origin is the pinned
   `https://1click.chaindefuser.com` (https, default port, DNS name, no userinfo/path/query, no
   IP literal or local-only suffix). The host is resolved once; every answer must be global
   unicast (`node:net` `BlockList` over loopback, RFC 1918, CGNAT, link-local/metadata,
   documentation, benchmarking, multicast, reserved, IPv4-mapped/compatible, NAT64, 6to4,
   Teredo/IETF, ULA including `fd00:ec2::254`, site-local, scoped). One bad answer rejects the
   whole set.
6. **Connection pinning (DNS rebinding).** The TLS socket is opened to the validated address with
   `servername` set to the pinned host; there is no DNS at connect time. HTTP is written over that
   socket through `http.request({ createConnection })` with no agent, so Node's proxy support
   cannot route it; preflight also deletes proxy variables.
7. **TLS and credential timing.** Certificate validation is on (`rejectUnauthorized`, TLS 1.2+),
   and the adapter separately requires `socket.authorized` after the handshake, so a connector
   that skips rejection still cannot send. With the system transport the socket's remote address
   must equal the pinned address. The credential is released into the request only after this
   point, for the issued allowance only.
8. **Response bounds.** Redirects (any 3xx) are rejected and `Location` is never read. Encoded
   responses are refused (no decompression at all, so no decompression ratio to bound), size is
   capped at 256 KiB (declared and streamed), headers at 16 KiB, DNS and connect at 5 s each and
   the whole exchange at 15 s. Nothing is retried; by default one dry quote is forwarded per
   adapter session (`PROBE_BUDGET_EXHAUSTED` afterwards).
9. **Credential.** `ROUTESPEC_PROVIDER_JWT` is read from the adapter's own environment only
   after preflight passes and is deleted as it is read. It must be a compact JWT; `exp`, when
   present, drives `EXPIRED`. States: `NOT_REQUIRED` (policy NONE, a supplied value is deleted and
   ignored), `OPTIONAL_ABSENT`, `PRESENT_IN_MEMORY`, `EXPIRED` (the probe stops before DNS with
   `RS_TOKEN_EXPIRED`). `toJSON`, `toString` and `util.inspect` expose the state only. Release
   (stop, disconnect, IPC `release`) drops the reference; physical erasure is not claimed. The
   value is never placed on argv, and the adapter starts no child process.
10. **Transport seam and labels.** Egress goes through an `EgressTransport` (`resolve`, `connect`).
    The built-in system transport (OS DNS, default CA store) is registered in a module-private
    `WeakSet`; only it can yield `OFFICIAL_ENDPOINT_COMPATIBLE`. Tests inject a transport that
    returns scripted answers and opens real TLS to a loopback emulator with a run-time test CA;
    a matching shape through it is stored as `UNKNOWN` with reason
    `INJECTED_TRANSPORT_NOT_OFFICIAL_ENDPOINT`. Labels: `DOCUMENTED_ONLY` when no probe ran;
    `INCOMPATIBLE` for a 2xx answer that is not the profile shape (non-JSON, unknown or missing
    field, request-echo mismatch, invalid value); `UNKNOWN` for transport failure, address or TLS
    refusal, timeout, redirect, encoding, oversize and provider 4xx/5xx.
11. **Separate compatibility ledger.** Results go to an append-only SQLite file owned by the
    adapter process (single writer), not to the gate journal: tables `compatibility_probes` and
    `policy_denials`, `STRICT`, with UPDATE/DELETE triggers and CHECK constraints (denial flags must
    be 0; `settlement_exercised` must be 0). No column refers to a gate run, case run, session,
    lifecycle, verdict or evidence scope. Stored: profile identity and digests, transport kind,
    label, shape result, reason code, HTTP status, quote-request digest, the type-only response
    shape (`$.quote.amountOut: string`, ...) and its digest, byte count, whether a
    response-assigned address was present, token state, credential-attached flag and
    DNS/connect/TTFB/total timing. Never stored: bodies, header values, the credential, error
    text. `CompatibilityLedger.toContractRecord` maps an entry to the shared
    `compatibility-probe` record. This also keeps M07 out of the store's migration sequence.
12. **Pins.** Preflight refuses to start unless the compiled profile integrity digest equals
    `PINNED_PROFILE_INTEGRITY_DIGEST`
    (`sha256:71e0c45dc0c4dbb775ff4271c78ddc17bfa56c1402654fd4c685deb52f4e3d05`) and the installed
    SDK is `@defuse-protocol/one-click-sdk-typescript@0.1.26`. A profile change requires a re-pin
    in review.
13. **Real probe.** `src/probe-cli.ts` (`probe:official`) runs the real RP-07 probe only with
    `--confirm-official-endpoint`, a dry request file, and a token the user placed in their own
    shell. It prints the redacted record only. It was not run in M07; M42 ran it with the owner's
    JWT and fixed the quote-finalization request-echo comparison (`docs/status/M42.md`); the
    record is `OFFICIAL_ENDPOINT_COMPATIBLE`. The echo-equivalence rules are validation logic and
    do not change the profile integrity digest above.

## Consequences

- T-021 and T-038 are provable networklessly against the real adapter process; T-020 is proven up
  to the network boundary and BLOCKED beyond it until a user runs the real probe.
- The status lookup stays disabled; enabling a reviewed exact-address lookup needs a new ADR.
- Windows environment names are case-insensitive; only one spelling of each proxy variable can
  exist there, which the T-038 test reflects.
- The local network tripwire (ADR-0007) counts DNS and sockets inside the adapter process in
  tests; it observes and does not sandbox.
