# ADR-0014 — Console wired to the real control API

- Date: 2026-11-12. Decision owner: M09 (console against the real API).
- Status: ACCEPTED
- Related: FR-15, FR-17, NFR-04, NFR-07, NFR-12; module M09 (owned tests T-047–T-051);
  builds on ADR-0008 (console shell) and ADR-0013 (local control API).

## Context

ADR-0008 shipped the console shell against a simulated loopback fixture and proposed a
contract to M08. M08 (ADR-0013) served the console same-origin with the strict CSP, added the
four extra read endpoints, and recorded that the run-operation detail, the import
detail/lineage, the gate-run mutation replies, and several request bodies did not match the
console. This stage closes those gaps so the console reads and changes the same persisted
records as the CLI and API, and replaces the fixture as acceptance evidence.

## Decisions

1. **The control API is the authority for shapes.** Where the console and the API disagreed,
   the console was changed to the API's request bodies (`POST /gate-runs` takes `gateId`,
   `buildAttestation`, `maxParallelCases`, optional inventory/interceptor digests; the service
   derives revision, adapter, and evaluator pins) and mutation replies (`validate` returns
   `{ ready, findings, gateRun }`, `start` returns `{ proxyBaseUrl, gateRun }`, capture,
   mapping, verify-replay, review, and promote return acknowledgements). The console treats a
   mutation reply as an acknowledgement and re-reads the authoritative record.
2. **Additive API detail views** (`packages/control-api/src/detail-views.ts`), read-only over
   persisted rows:
   - `GET /run-operations/{id}` now returns the full console shape: logical-job digest, typed
     lineage, the three phase bindings with masked locator fields (recipient, refund, deposit
     address and memo are always `masked`), reconciliation observation count, refused
     conflicts, provider raw status and normalized fact, the kernel's persisted case verdict as
     `evaluatedOutcome` (no per-operation verdict is derived), attempts and uncertainty, effect
     coverage, subject reports and independent boundary observations as separate lists,
     evidence items, and the latest persisted invariant results.
   - `GET /imports/{id}` adds the M05 lineage mapped to nine stages, sanitized source events,
     proposed events after a mapping is saved, `replayOnlyPass`, the regression status, the
     promotion, the corrected runs, and the review requirements (decision names and the exact
     confirmation sentence) published by the service.
3. **`POST /imports`** (API-SPEC lists it; M08 had not built it): a bounded JSON body
   `{ projectId, fileName, content }` (content at most 200,000 characters inside the 256 KiB
   request limit) handed to the M05 `importUserFile` ingest. The request parser never parses
   the trace; the reply is the quarantine row. A secret-bearing trace is stored as digest and
   finding classes only and is announced by the console as a blocked import.
4. **Lineage roles come from persisted promotions.** A gate run on a corpus produced by an
   import promotion runs the promoted scenario as `PROMOTED_REGRESSION` and inherited cases as
   `CORRECTED`; every other gate run is `BASELINE`. The caller cannot choose a role.
   `GateService.createGateRun` gained an optional `lineageRoleByScenario` (additive).
5. **Recovery is offered from persisted state only.** A case view offers the read-only
   reconciliation when the case is `RECOVERY_REQUIRED` or when an executing case's lease has
   expired (`reasonCode RS_LEASE_EXPIRED`). The recovery route itself is unchanged (M08).
6. **Gate-run view adds `gateId`**, so the console offers "Evaluate gate" only for runs created
   for a gate definition; it already carried `gateEvaluationId`, which enables "Plan export".
   Export writing stays a separate CLI/API step with its own confirmation.
7. **Timeline filter by phase, not by display kind.** The API filters on stored event kinds and
   phases; the console's display kinds are a mapping of stored kinds and cannot be inverted, so
   the timeline filters by operation phase through the server, and a filtered listing now
   reports the filtered total.
8. **Acceptance runs against the real service.** `apps/console/e2e-real` starts
   `support/service.ts` in its own Node process: a real `ControlServer` over a real SQLite
   journal serving `apps/console/dist`, seeded only through the public API and the real
   product path (separately launched official-SDK subjects, proxy, scenario runtime, kernel,
   gate aggregation, capture-to-regression pipeline). The fixture suite (`apps/console/e2e`)
   remains as SIMULATED development coverage for states the real service cannot produce on
   demand (an unsupported record schema, a concurrent-client race at a precise moment); its
   keyboard and error specs were removed because the real suite supersedes them.
9. **Dense-session bound.** One session cannot exceed the M03 runtime's hard request budget
   (`HARD_CAPS.maxRequests = 8192`), so the densest real session holds 8,191 events; the
   10,000-event load of NFR-04 is a 100-case gate run whose cases together journal 10,100
   events. The scenario runtime was not changed to reach a round number.
10. **Motion.** Timeline entrance animation moves position only; it no longer fades text,
    because a fading event row measured below the contrast ratio while animating.

## Consequences

- `apps/console/src/api/schemas.ts` and the parity test
  `packages/control-api/test/console-contract-parity.test.ts` now cover every route and
  mutation reply the console uses; a shape change on either side fails that test.
- The console never sends `revisionId`, `adapterRevision`, `evaluatorRevision`, or
  `configurationDigest`; those are server-derived pins shown on the gate run.

## Invalidation

Revisit if the API adds authenticated SSE (the console still polls), a mapping editor
endpoint beyond saving the proposed draft, or an export write flow intended for the browser.
