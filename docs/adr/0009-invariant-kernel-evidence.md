# ADR-0009 — Pure invariant kernel, evidence axes, and protected-effect coverage semantics

- Date: 2026-11-11. Decision owner: RouteSpec engineering (M04 stage), pending user review.
- Status: ACCEPTED
- Related: FR-07, FR-08, FR-09, FR-10, NFR-01, NFR-12, INV-03..INV-08; module M04 (T-003, T-004,
  T-005, T-008, T-018, T-019, T-043, T-059). Builds on ADR-0003 (canonical encoding), ADR-0004
  (journal), ADR-0005 (status normalization), ADR-0006 (scenario runtime), ADR-0007 (proxy and
  interceptor channel).

## Context

M04 owns factual verdicts. The pack fixes the vocabulary (verdicts, evidence class/scope/reason,
coverage bases) but leaves open how the kernel receives a stable snapshot, how release timing is
ordered against completion evidence, what counts as accepted completion for a protected effect,
how conservation is partitioned, which invariants this revision evaluates, and how an optional
explanation is kept non-authoritative.

## Decisions

1. **Package boundary.** `@routespec/kernel` depends only on `@routespec/contracts`. A static audit
   test fails on any other import, on `Date`, `Math.random`, `fetch`, `process`, `require`, or
   dynamic `import`. Store, proxy, and scenario are dev dependencies for journal-backed tests only.
2. **Snapshot.** The journal exposes `readEvaluationSnapshot(caseRunId)`: one synchronous read on
   the single writer connection, returning plain rows. The kernel's `snapshotFromJournal` validates
   and maps them (unexpected shape fails closed with `RS_KERNEL_INPUT_INVALID`). Display values
   (USD, formatted amounts, response extensions) are never mapped, so they cannot influence a
   verdict. The only time reference is the journal's input-closed time (`asOfMs`), used for
   attestation expiry.
3. **Evidence predicates.** An item satisfies a predicate only if every mandatory identity field
   matches (integration revision, build, artifact, gate, case, session, scenario, policy, manifest),
   it binds the predicate's run operation, its class and scope are declared acceptable, it carries
   no disqualifying reason (`NOT_VISIBLE`, `MISSING`, `CONTRADICTORY`, `PRIVATE`, `STALE`,
   `UNSUPPORTED`, `UNATTESTED_BUILD`, `IDENTITY_MISMATCH`, `EFFECT_COVERAGE_MISSING`), and its
   payload digest is well formed. `PROVEN` is acceptable only in `SIMULATED_GROUND_TRUTH` or
   `PUBLIC_CHAIN_OBSERVATION`, whatever a predicate declares; `PRIVATE_NOT_VISIBLE` always implies
   `NOT_VISIBLE`. `NONCANONICAL_TIMER` alone does not disqualify a value leg (it is a timer
   conformance finding).
4. **Verdict combination.** FAIL dominates; all NOT_RUN (or nothing) is NOT_RUN; any REVIEW,
   UNSUPPORTED, or NOT_RUN mixed with results is REVIEW; PASS only when all PASS. A case combines its
   required invariants (`case_runs.required_invariants_json`). A case whose input is not closed or
   whose lifecycle is not RUNNING/EVALUATING/COMPLETED can never PASS (`CASE_INCOMPLETE`). Each
   explanation code carries its verdict, so a verdict is never set independently of its reason.
5. **Implemented invariants.** This revision evaluates INV-01..INV-08. INV-01 and INV-02 are
   reusable snapshot re-checks of the M01 binding guards. A required invariant without an evaluator
   (INV-09..INV-12) is reported `NOT_RUN` / `EVALUATOR_NOT_AVAILABLE`, which makes the case REVIEW.
6. **INV-03.** For each commit attempt left `SENT_OUTCOME_UNKNOWN` (or later `RECONCILED`): FAIL on
   any quote finalization or new commit binding accepted after it and before the operation's first
   accepted terminal provider status, or on an EXECUTION token at a later epoch; REVIEW if the epoch-e
   tokens are not all revoked, the epoch not advanced, or no RECONCILIATION_ONLY token issued; REVIEW
   if an exact retry joined before the fence; REVIEW until a terminal status is reached. Lifecycle
   cancellation, crash, timeout, or assertion is never a terminal.
7. **INV-04 ordering and completion.** Migration 004 (additive) gives every boundary observation a
   session sequence (`boundary_observation_order`) and journals the runner's
   `effect_release_authorizations` (citing completion evidence) at a session sequence. An
   authorization is valid only if it cites at least one `effect_completion` or `destination_credit`
   item that satisfies the proof predicate and precedes it. A boundary `RELEASED` frame before the
   first valid authorization is a forbidden release. FAIL needs only one such frame from an
   interceptor whose binding matches the case and whose profile matches the policy's pinned profile
   (when the policy pins none, the binding alone; the instance is the digest-verified reviewed
   artifact launched by RouteSpec, reachable only over its private channel). Attestation is not
   required for FAIL: it strengthens completeness, not violation proof.
8. **INV-04 completeness.** PASS requires all of: non-declared basis; policy/manifest identity;
   every required sink declared REQUIRED by the manifest; a non-user-asserted, acceptable build
   attestation; at least one interceptor with matching binding and pinned profile, current epoch,
   acceptable `EFFECT_INTERCEPTOR_LAUNCH` attestation, `PROCESS_TREE_ENFORCED` containment,
   support for every required sink, orderly `TEARDOWN`; no coverage findings; every required sink
   observed; every attempt resolved; every subject report matched by a boundary observation; for
   the inventory basis, a matching, attested inventory with no dynamic or unsupported call site and
   every call-site sink covered. Anything else is REVIEW (`INV04_DECLARED_HOOKS_ONLY` when the basis
   is declared hooks, else `INV04_COVERAGE_INCOMPLETE`) with the gaps as missing predicates.
   A subject-reported early release is REVIEW, never FAIL: self-report proves neither coverage nor
   violation.
9. **INV-05.** Per run operation and per canonical asset, BigInt only. Origin ledger:
   `debit = consumed + refund + fee + locked`, where `consumed` is the finalized `amountIn` when the
   swap delivered (proven credit, or accepted `SUCCESS`) and 0 when it did not. Positive remainder is
   `INV05_UNEXPLAINED_LOSS`, negative `INV05_BASE_UNIT_DRIFT`. Destination: wrong asset or recipient
   FAIL even if other legs are weak; below `minAmountOut` (or not exactly `amountOut` for
   `EXACT_OUTPUT`) FAIL. Third-asset legs are a separate ledger. Weak/private/missing legs REVIEW.
10. **INV-06/07/08.** INV-06 recomputes the profile fold from verbatim raw statuses and FAILs if the
    stored outcome differs (silent replacement). INV-07 groups single-use consumptions by proof
    payload digest across operations and validates allocations. INV-08 FAILs a journal fact claiming
    `SUCCESS_PROVEN`/`REFUND_PROVEN` without a satisfying proof item and REVIEWs scenario-required
    predicates that are weak or missing for each committed operation.
11. **Provider facts.** `deriveProviderFacts` keeps raw observations (verbatim text, mapping
    revision `oneclick-v0@1.0.0#<digest of the mapping table>`), the provider fold, and derived
    proof facts (`SUCCESS_PROVEN`, `REFUND_PROVEN`, or `NOT_VISIBLE`) as separate records; probe
    results pass through untouched and are never read by any predicate.
12. **Revision and digests.** `EVALUATOR_REVISION = routespec-kernel@1.0.0`. The kernel refuses an
    input whose gate pinned a different revision. `KERNEL_SEMANTICS_DIGEST` covers every rule table
    and is pinned by a test, so changed semantics require a new revision. Each evaluation carries an
    input digest and a result digest over all authoritative fields; it is deep-frozen.
13. **Explanation boundary.** `renderExplanation` uses closed templates only. The optional model
    receives a redacted frozen copy (codes, verdicts, counts, 8-character identifiers). Its output is
    reduced to bounded plain text in a separate annotation labelled non-authoritative; exceptions are
    swallowed; the evaluation digest is re-verified afterwards. The canonical case result schema is
    closed, so explanation text cannot be persisted inside it.
14. **Store additions (journal side, no verdicts).** `recordSubjectEffectReport` (case token,
    binding digest, idempotency by key digest, hook/manifest/policy/operation checks, always
    `SUBJECT_REPORTED`), `registerCallsiteInventory`, `recordEffectReleaseAuthorization` (execution
    fence), `recordCoverageFinding` (interceptor channel key only), `listSubjectEffectReports`,
    `readEvaluationSnapshot`, and error code `RS_EFFECT_HOOK_UNDECLARED` / `RS_KERNEL_INPUT_INVALID`.

## Consequences

- On this host no OS sandbox confines the subject process tree and no attester principal can be
  enrolled yet, so every live INV-04 result is REVIEW or FAIL; a live complete-effect PASS is not
  claimable. The PASS path is exercised by the pure kernel on a real journal snapshot with only
  those two facts supplied, and is labelled as kernel-semantics evidence.
- The runner (M06) must journal completion evidence and a release authorization before releasing
  an interceptor; the supervisor currently records ground truth at `finishInput`.
- Gate aggregation over cases (TDD section 14) is M06; the kernel provides `combineVerdicts`.

## Alternatives considered

- Wall-clock ordering of releases versus evidence: rejected (non-canonical, NFR-01).
- Treating subject-reported early release as FAIL: rejected (self-report is never proof).
- Requiring an attested interceptor for FAIL: rejected; it would let an unattested but reviewed
  interceptor's direct observation of a violation be downgraded to REVIEW.
