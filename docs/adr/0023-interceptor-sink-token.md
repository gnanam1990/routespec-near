# ADR-0023 — The interceptor sink requires a per-instance token (SEC RS-01)

- Status: accepted
- Date: 2026-11-12
- Module: security follow-up on M02/M14 (interceptor channel and contained cases; amends the
  sink behaviour in ADR-0007 and the interceptor launch in ADR-0019)

## Context

An external security audit (finding RS-01, medium) reported that any local process could cause
boundary observations for a running case. The canary interceptor listens on `127.0.0.1` on an
ephemeral port and accepted `POST /sink/<class>` with no credential. It framed each request as
ATTEMPTED, then BLOCKED or RELEASED, and sent the frames to its parent over the private IPC pipe
with the channel key. The store therefore journaled them as authentic, immutable observations for
the case's interceptor instance. A forged observation also removed INV-04's
`REQUIRED_SINK_UNOBSERVED:<sink>` gap. In contained mode, the first ATTEMPTED frame also made the
host's one-shot release decision, so a forger could use it up.

The IPC channel was authenticated, but the sink in front of it was not. Loopback TCP has no peer
check, so the private-channel guarantee in SECURITY.md ("no case token, control token or subject
path can write observations") did not cover who caused a frame.

## Decision

1. `InterceptorHost.launch` generates a random per-instance sink token (32 bytes, base64url), or
   takes one from the caller (`sinkToken`), and sends it to the interceptor in the `bind` message
   over the inherited pipe. It is never placed in argv or the environment and is not journaled.
2. The reviewed canary interceptor refuses every sink request that does not present the exact token
   in the `x-routespec-sink-token` header. The comparison is constant-time. The refusal is
   `401 {denied: true, reason: "SINK_UNAUTHENTICATED"}` and happens before the body is read or
   anything is framed, so no observation, ack, `onFrame` call or release decision follows. A bind
   without a well-formed token is refused, and the listener never opens.
3. In contained mode the control host issues the token when the case starts. It hands the token
   only to the contained subject, in the `effectSink` of its run request over the container's
   private channel, and passes the same token to `InterceptorHost.launch` when the subject first
   connects to the sink tunnel. The token is not part of any HTTP view or journal record.
4. `InterceptorHost` exposes `sinkToken` and `sinkHeaders` so an in-process caller can give the
   token to the subject it launches. Subjects send the header with each sink request.
5. The artifact changed, so the pinned `CANARY_INTERCEPTOR_ARTIFACT_DIGEST` is updated with this
   review. The profile digest derives from it, so profiles registered against the old artifact
   digest no longer match. That is the intended behaviour of the pin.

## Consequences

- An unrelated local process, with or without RouteSpec credentials, can no longer journal boundary
  observations, clear the sink-coverage gap, or use up the contained release decision.
- A process that can read the bound subject's memory or its run request can still present the
  token. Under containment that is the subject itself, which is the principal the sink exists for.
  Uncontained (`DECLARED_HOOKS_ONLY`) runs were never complete-coverage evidence.
- A local process can still connect to the loopback port and get a 401. Requests that fail
  authentication do not spend any journal or release state.
- Tests: `packages/proxy/test/interceptor-channel.test.ts` (forger in a separate process with an
  empty environment gets 401, and nothing is framed or journaled) and
  `packages/kernel/test/t004-protected-effect.test.ts` (INV-04 keeps
  `REQUIRED_SINK_UNOBSERVED` after a forged request). Existing subject paths send the header.
- Evidence: `docs/status/SEC-routespec-RS-01.md`.
