# ADR-0006 — Scenario DSL v1.0, data-only parsing, and deterministic scheduler semantics

- Date: 2026-11-11. Decision owner: implementing agent (M03 stage), pending user review.
- Status: ACCEPTED
- Related: FR-05, FR-06, NFR-01, NFR-06, NFR-08, INV-09; module M03 (T-009, T-013, T-014, T-015).

## Context

TDD.md section 6 names the required top-level fields and says the step enum is closed "such as"
`respond`, `delay_virtual`, `transport_error`, `provider_status`, `ground_truth`, `assert_request`, `end`;
the M03 prompt adds response drop, connection barrier, duplicate, reorder, late-success,
incomplete-deposit, and refund. The pack does not fix step execution semantics, the YAML library,
or how polling interacts with virtual time.

## Decision

1. **Package.** `packages/scenario` (`@routespec/scenario`). It depends only on
   `@routespec/contracts`, `yaml@2.8.1` (ISC, pure JS, exact pin), and `node:crypto`. A static
   test forbids every other import plus eval, dynamic import, timers, wall clock, `Math.random`,
   `fetch`, and environment access in its source.
2. **Parsing.** YAML 1.2 core schema, `merge: false`, `uniqueKeys: true`, `strict: true`. Any
   explicit tag (including `!!str`) is `RS_SCENARIO_UNSAFE_CONSTRUCT`; aliases default to disabled
   (`maxAliases: 0`) and are capped at 64. JSON depth is measured by a linear scan before
   `JSON.parse`. Prototype-polluting keys, non-finite numbers, and non-plain objects fail closed.
   Fields whose names look executable (`script`, `command`, `url`, `file`, `regex`, `template`, ...)
   are reported as unsafe before schema validation; every other unknown field is
   `RS_SCENARIO_INVALID` (`unknown-field`).
3. **Versions.** Only schema `1.0` compiles. A newer major or minor fails closed with
   `RS_SCHEMA_VERSION_UNSUPPORTED`.
4. **Budgets.** `DEFAULT_BUDGET` and `HARD_CAPS` (budget.ts) bound bytes, depth, aliases, steps,
   ground-truth events, runtime events, total declared virtual duration, strings, body bytes, and
   requests. A declared budget may lower but never raise a limit above its hard cap.
5. **Step semantics.** Steps run in order with one cursor. _Request steps_ (`respond`,
   `drop_response`, `connection_barrier`, `transport_error`) each consume one matching client
   request. All other steps are _timeline_ steps and run when the next request arrives (or at
   `finish()`), before matching. Matching is route plus exact equality on selected top-level
   profile fields; there are no regular expressions. A status poll that does not meet a `STATUS`
   step is answered from the provider status queue (unscripted poll), and any other
   non-matching request is `RS_SCENARIO_UNEXPECTED_REQUEST`. Provider statuses form a FIFO
   queue; `late_success` entries become visible only once virtual time reaches their due time.
   Each unscripted poll charges `statusPollIntervalMs` (default 1000) of virtual time, which
   models polling cadence and keeps an endless poll loop bounded by `maxVirtualDurationMs`.
6. **Two-phase runtime.** `planRequest` computes a decision on a copy of the state; the proxy
   commits it only after the journal accepted the request, or calls `deny`, which records
   `REQUEST_DENIED` without consuming a step. A refused request can therefore never shift the
   schedule.
7. **Determinism.** sfc32 PRNG seeded from a domain-separated SHA-256 of the seed; integer
   virtual milliseconds rendered against a fixed epoch (2026-01-01T00:00:00Z). Generated quote
   identity (correlation ID, deposit address, signature) is cached per logical job and material,
   so an exact client retry receives the identical finalized quote. Transport request IDs,
   session IDs, wall time, and host data never enter the runtime.
8. **Timers.** A repeated mutation-shaped request under `clientClock: EXTERNAL_WALL` emits
   `CLIENT_TIMER_NONCANONICAL` and sets `canonicalTimer: false` (REVIEW evidence for M04). Under
   `INJECTED` the same retry is canonical.
9. **Identity.** The compiler computes the scenario revision digest with the same domain and
   fields as the journal's `createScenarioRevision`, which T-013 checks. The replay digest
   (`routespec.replay-result/1`) covers a strict mandatory identity, the runtime revision, the
   ordered exchanges and denials, every decision, and the event-log digest.
10. **Build order.** M03 was built before M02 in this stage because the networkless proxy (M02)
    hosts this runtime to produce protocol responses. Both depend only on M00/M01 per
    requirements.json; the extra M02 → M03 edge is recorded here.

## Consequences

- Changing compile or runtime semantics changes the golden vectors (T-009, T-013) and requires
  a new `COMPILER_REVISION` / `RUNTIME_REVISION`.
- Cross-OS byte stability (Linux, macOS) is NOT_RUN until the M10 CI matrix or a user run.
