# ADR-0010 — Trace quarantine, capture-to-regression promotion, and corpus identity

- Date: 2026-11-11. Decision owner: RouteSpec engineering (M05 stage), pending user review.
- Status: ACCEPTED
- Related: FR-05, FR-10, FR-11, FR-12, FR-17, NFR-03, NFR-06, INV-08, INV-11, INV-12; module M05
  (T-029, T-030, T-031, T-032, T-033, T-039). Builds on ADR-0004 (journal), ADR-0006 (scenario
  DSL and replay digest), ADR-0007 (proxy and adapter), ADR-0009 (kernel).

## Context

The pack fixes the import state machine, the rule that raw source bytes never reach ordinary
persistence, and the requirement that promotion creates a new scenario and a new corpus identity
that the corrected installed client must then pass through the full product path. It leaves open
the trace format, how an installed capture is derived and protected against replacement, what a
"mapping" contains and how it is checked, what deterministic replay means for an import, how
review is bound, and how corpus revisions relate to each other.

## Decisions

1. **Package boundary.** `@routespec/regressions` orchestrates; the journal owns all SQL in
   `packages/store/src/imports.ts` (`ImportJournal`). The regressions sources import no network,
   DNS, HTTP, TLS, provider SDK, or model client, and only `replay.ts` may launch a process (the
   replay trial). A static audit test enforces this.
2. **Trace format `routespec.trace/1`.** One closed `.strict()` schema for installed captures and
   user files. Exchanges, events, evidence, subject reports, independent boundary observations,
   and proxy denials are separate arrays. Run operations and logical jobs are referenced by
   order-derived refs (`op-1`, `job-1`); exact identities exist only in `identity`. Free text is
   allowed only in `annotations`. Any unknown field (for example an attempt to carry
   `autoPromote` or `verdict`) fails the schema and rejects the source.
3. **Installed capture.** `captureInstalledCase` accepts only a case run ID. It requires the case's
   client input to be closed (teardown journaled), derives the trace deterministically from the
   journal (`readEvaluationSnapshot` plus proxy denials), streams the canonical bytes through the
   same bounded ingest and analysis as a user file, and records an `import_capture_bindings` row
   with the exact build/artifact/gate/case/session/scenario/manifest/policy/inventory/interceptor/
   adapter/epoch identity, an identity digest, and a capture digest. A user file is always
   `USER_FILE`; a document's own `origin` claim is corrected and flagged `ORIGIN_CLAIM_IGNORED`.
4. **Quarantine order.** Bytes are hashed while streaming with a byte cap; strict UTF-8; a
   recursive-descent bounded JSON reader (depth, string length, keys per object, node count,
   duplicate keys, prototype keys); secret scan over every key and value (configured values held
   in memory for the call, high-confidence credential patterns, credential-bearing key names);
   active-content neutralization; signed-material digesting (`txHash` is replaced by its profile
   digest); strict schema; record-count cap; then ordering/time determinism, reference and
   material resolution against the pinned profile, and identity checks.
   - Secret-bearing, oversized, or malformed sources are `REJECTED` with only the raw digest, byte
     count, and finding metadata. No sanitized form is kept (it could hold an unrecognized copy).
   - Unresolved material, nondeterminism, duplicate sequences, or identity mismatch keep the
     sanitized form for review but block mapping and promotion.
   - Active content, instruction text, unfetched URLs, digested signed material, unsafe paths, and
     ignored origin claims are advisory: neutralized and shown to the reviewer.
     An exchange and the lifecycle event it caused share one session sequence, so exchanges and
     events are each checked for strict order and uniqueness separately.
5. **Neutralization.** `<` and `>` become single guillemets; C0/C1 control characters and
   bidirectional controls become visible `\uXXXX` text. Content is preserved as reviewable text.
   `toDisplayText` additionally entity-escapes for display surfaces; renderers still use text
   nodes. Nothing in an annotation feeds any product decision.
6. **Findings.** Category, sanitized JSON path, count, blocking flag — never a value. The scan
   record is immutable (`import_scans`).
7. **Mapping.** A typed `routespec.import-mapping/1` document: scenario timeline (M03 DSL steps
   and ground-truth events), the four-phase run-operation lineage, expected and forbidden
   behavior, evidence limits, required invariants, required sinks/hooks with coverage basis and
   limitations, and provenance. `proposeMapping` is non-authoritative; `validateMapping` decides:
   phases must equal the trace's; request steps must reproduce the observed exchange sequence
   (lost responses map to `drop_response`); evidence limits stay `PROVEN` in accepted scopes; a
   leg the trace shows as not visible must stay `PRIVATE`; coverage basis never exceeds what the
   trace independently shows (user files are always `DECLARED_HOOKS_ONLY`, imported observations
   are labelled not independent); contradictory or disputed evidence must become
   `DISPUTED_AMBIGUITY_CASE`, which may only expect REVIEW and may not assert visible credit or a
   proven outcome; `ISSUE_DERIVED_NOT_REPRODUCED` may not assert settlement and must forbid a
   second commit under uncertainty and effect release before completion; only an installed
   capture may claim `INDEPENDENTLY_REPRODUCED`; a trace is never `SYNTHETIC` or spec-derived.
   Every mapping revision is an immutable record; its digest binds the import revision.
8. **Replay verification.** The mapping compiles through the M03 compiler (its locator names the
   import, so the scenario identity is new). The trace's observed exchanges are replayed with
   `canonicalReplayDigest` under a fixed trial identity that pins the kernel's evaluator revision
   and depends only on import and mapping content. Default trials: two in-process plus one
   separately launched process (IPC only, distinct time zone). Verified only if every digest is
   equal, every observed exchange gets the same kind of decision and observed status, and no trial
   reports a non-canonical client timer, unexpected request, failed assertion, or limit breach.
9. **Review.** Eight explicit decisions plus a fixed local confirmation phrase. The review digest
   binds sanitized digest, scan, mapping digest, replay report digest, produced scenario digest,
   reviewer digest, and decisions; only the reviewer digest is stored.
10. **Promotion.** One journal transaction re-checks state, revision, review currency, replay
    stability and fidelity, scenario digest, provenance, and — inside the same transaction —
    re-derives an installed capture from the journal (a capture that no longer matches its source,
    for example after a late journal write, fails with `RS_IMPORT_CAPTURE_MISMATCH`). It then
    inserts a new `REVIEWED` scenario revision (refusing an existing digest), a new corpus
    revision whose cases are the base corpus cases unchanged plus the promoted case (refusing an
    existing corpus digest), a `corpus_lineage` row (`PROMOTION_INTO`), and an `import_promotions`
    row, and moves the import to `PROMOTED`.
11. **Corpus identity.** The corpus digest is the existing M01 formula over label and ordered
    cases. Explicit revisions (`reviseCorpus`) are new identities with `REVISION_OF` lineage;
    reusing an existing identity as a "revision" is refused. `diffCorpora` reports label changes,
    removed/added/reordered cases, scenario-revision changes of the same stable scenario, and
    policy changes. Gate runs pin a corpus revision; nothing follows a "latest" corpus.
12. **Completion requires the corrected client.** `regressionLineage` reports
    `PROMOTED_AWAITING_CORRECTED_RUN` until a gate run bound to the promoted corpus, from a build
    other than the captured one, completes the promoted case (`PROMOTED_REGRESSION`) with PASS.
13. **Incident scenarios.** issue-383 (`ISSUE_DERIVED_NOT_REPRODUCED`): lost commit response and a
    later refund, no destination credit, expected REFUNDED; PASS means safe refund handling.
    issue-384 (`DISPUTED_AMBIGUITY_CASE`): private destination credit, expected REVIEW.
14. **Export privacy scan.** `scanForExport` / `scanImportForExport` report credential,
    authorization-header, cookie, private-key, signed-payload, and sensitive-address findings
    without values; addresses block unless explicitly acknowledged. No bundle is written (M06/M08).
15. **Schema.** Migration 005 is additive: an import state-transition table and triggers on
    `imports` (state machine, frozen identity columns, revision +1 per update, sanitized content
    written once and cleared only by a purge, no deletes) and seven insert-only tables.

## Consequences

- The gate-level aggregation used in T-031 is the M04 `combineVerdicts` over the exact case
  verdicts; persisting a gate decision and reports belongs to M06.
- Retention purge (24 h default for rejected-import metadata) is modelled by the `PURGED` state
  but no scheduler runs it yet (M11).
- The HTTP endpoints and CLI commands for import, capture, mapping, verify-replay, and promote
  belong to M08/M06; this module provides the library and journal they call.
- Complete-effect coverage remains `DECLARED_HOOKS_ONLY` on this host (ADR-0009), so promoted
  cases that require INV-04 cannot PASS here.
