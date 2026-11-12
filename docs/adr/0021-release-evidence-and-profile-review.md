# ADR-0021 — Release-evidence refusal and interceptor profile review (M16)

- Status: accepted
- Date: 2026-11-12
- Module: M16 (follow-up on the M14 `WORKING_LOCAL` gaps; RP-02, RP-06, RP-08; T-004, T-031,
  T-053, T-055)

## Context

After M14 two engineering gaps kept `WORKING_LOCAL` from being reconsidered:

1. RP-08 requires the product to "reject ... declared-hooks-only, interceptor-incomplete, or
   unreviewed captures" as release evidence, and FR-11 says such traces "can never enter a
   required corpus". M05/M12 promoted them with labelled limitations instead.
2. RP-02 and the API-SPEC effect-coverage policy text require a "reviewed independent
   interceptor profile" for `INDEPENDENT_BOUNDARY_INTERCEPT` and
   `TRUSTED_BUILD_INVENTORY_PLUS_INTERCEPT`. Profiles were stored as `DECLARED_UNREVIEWED` with
   no way to review them (the column admits only that value).

## Decisions

### Interceptor profile review (RP-02, RP-06)

1. **A reviewer is its own principal.** `profile_reviewers` (migration 009) holds a reviewer's
   label, Ed25519 public key (`x`), key digest, and validity window. Enrollment needs an
   authenticated control-plane call plus a distinct explicit local confirmation
   (`PROFILE_REVIEWER_ENROLL`, delivered over the operator channel, single use, bound to the exact
   plan digest). The private key never enters RouteSpec.
2. **Distinct from the operator, enforced both ways.** A key that is an enrolled launcher
   (`LOCAL_LAUNCHER_KEY`) key in any project cannot be enrolled as a reviewer key, and a reviewer
   key cannot later be enrolled as a launcher key (`RS_REVIEWER_NOT_INDEPENDENT`). The control
   token alone cannot create a review: only a signature by the reviewer's private key can.
   RouteSpec cannot prove that a different human holds that key; that remains the reviewer's
   and the operator's responsibility and is why the independent review is recorded `NOT_RUN`.
3. **Challenge, statement, signature.** `POST /interceptor-profiles/{id}/review-challenges`
   creates a single-use, short-lived challenge whose server-built canonical statement binds the
   project, the exact registered profile (digest and every declared field), the reviewer and its
   key digest, the decision (`APPROVED` or `REJECTED`), a closed review checklist, a nonce, and
   the expiry. The reviewer signs `routespec.interceptor-profile-review/1\n` + canonical JSON
   (Ed25519, no prehash) offline (`routespec profile review-sign` or their own tooling).
   `POST /profile-review-challenges/{id}/complete` verifies the signature against the enrolled
   key, consumes the challenge, and writes one immutable review (no update, no delete).
4. **Approval needs the whole checklist and a confining profile.** An `APPROVED` review must
   confirm every checklist item and is refused for a `DECLARED_HOOKS_ONLY` profile
   (`RS_PROFILE_REVIEW_INVALID`).
5. **Revocation is a separate, append-only record.** A review is revoked with a local
   confirmation (`PROFILE_REVIEW_REVOKE`); a reviewer is revoked the same way
   (`PROFILE_REVIEWER_REVOKE`), which makes every review it signed ineffective and blocks new
   challenges. Revocation only lowers trust, so the operator may do it.
6. **The state is derived, never stored.** `interceptor_profiles.review_state` keeps the declared
   state at registration (`DECLARED_UNREVIEWED`, immutable). The effective state
   (`DECLARED_UNREVIEWED`, `REVIEWED`, `REVIEW_REJECTED`, `REVIEW_REVOKED`) is computed by one
   shared rule (`effectiveProfileReview` in `@routespec/contracts`): a review counts only when it
   was recorded at or before the reference time, is not revoked, and its reviewer is not revoked
   and is inside its validity window; an effective rejection wins over an approval.
7. **Gates use it at evaluation (INV-04).** A complete-effect basis with a pinned profile needs
   an effective review recorded before the case input closed; otherwise INV-04 reports
   `INTERCEPTOR_PROFILE_UNREVIEWED`, `..._REVIEW_REJECTED`, or `..._REVIEW_REVOKED` and stays
   REVIEW. Policy creation is not refused for an unreviewed profile (a review may be revoked
   later anyway, so the check must happen at evaluation); its response reports the current review
   state. The evaluator revision is `routespec-kernel@1.1.0` (semantics digest re-pinned).

### Release-evidence refusal (RP-08)

8. **One classification from the journal.** `classifyCaptureEvidence` derives, for an import,
   the stable refusal codes `NOT_INSTALLED_CAPTURE`, `DECLARED_HOOKS_ONLY`,
   `PROCESS_TREE_NOT_CONFINED`, `NO_INDEPENDENT_BOUNDARY_OBSERVATION`,
   `INTERCEPTOR_PROFILE_UNPINNED`, `INTERCEPTOR_PROFILE_NOT_REVIEWED` (checked again at the
   current time, so a revocation after the run still refuses), `UNATTESTED_IDENTITY`, and
   `INTERCEPTOR_COVERAGE_INCOMPLETE` (from INV-04 over the current journal; a FAIL whose only
   findings are independently observed forbidden releases is complete). No code: release
   evidence.
9. **Promotion refuses by default.** `evidenceUse` defaults to `RELEASE_EVIDENCE`; inside the
   promotion transaction any refusal code fails the promotion with
   `RS_CAPTURE_NOT_RELEASE_EVIDENCE` (HTTP 422, CLI exit 6) and the reasons; nothing is created.
   `DIAGNOSTIC_ONLY` is the explicit alternative and may only add an `ADVISORY` case. The class
   (use, reasons, profile, review) is stored immutably in `promotion_evidence_classes`.
10. **Corpora never make it required.** Creating or revising a corpus with a `REQUIRED` case whose
    scenario revision is a promoted capture that is not release evidence is refused with the same
    code. A promotion recorded before M16 has no class row and is `UNCLASSIFIED`, which is never
    release evidence (fail closed for older data directories).
11. **Gate aggregation never passes it.** The gate snapshot carries each corpus case's evidence
    class; a required `DIAGNOSTIC_ONLY` or `UNCLASSIFIED` case gets
    `CAPTURE_NOT_RELEASE_EVIDENCE:<class>` and cannot contribute PASS (a valid FAIL still
    dominates). Aggregator revision `routespec-gate@1.1.0`.
12. **Bundles declare their use.** `POST /exports` and `routespec export plan` take `evidenceUse`
    (default `RELEASE_EVIDENCE`). A release-evidence plan for a gate whose corpus contains any
    promoted capture that is not release evidence is refused with
    `RS_CAPTURE_NOT_RELEASE_EVIDENCE`; `DIAGNOSTIC_ONLY` writes a labelled bundle. Bundle format
    `routespec.bundle/2` adds `evidence/release-evidence.json` (per-case classes, refusals, and
    every signed review of the gate's interceptor profile with statement, signature, and reviewer
    public key) and `manifest.evidenceUse`. `verify` checks the declared use against the
    classification it recomputes, and every bundled review signature offline. Checksums are still
    not signatures: a full rewrite of a bundle is not detected (unchanged from ADR-0012).
13. **Surfaces.** API: reviewer, challenge, review, and revocation routes, profile list/detail
    with the effective state, `GET /imports/{id}/release-evidence`, `releaseEvidence` in the
    import detail, `interceptorReviewState` in effect coverage. CLI: `profile review-status`,
    `profile review-sign`, `regression evidence`, `regression promote [--diagnostic-only]`,
    `export plan --evidence-use`. Console: the regression review shows "Not release evidence"
    with the service's reasons, the promotion dialog offers release evidence only when the
    service allows it, a promoted case shows its evidence use, and export planning has a bundle
    use choice that shows the service's refusal.

## Consequences

- The M12 uncontained journey now records the promotion and export refusals and continues with
  explicit diagnostic-only promotion and export. The M14 contained journey enrolls a local test
  reviewer (the launcher key is refused as a reviewer), reviews the profile before any case, and
  its capture is release evidence end to end.
- Existing data directories migrate additively (schema 9). Old gate runs pinned to
  `routespec-kernel@1.0.0` are `GATE_EVALUATOR_STALE` under the new evaluator; old promotions are
  `UNCLASSIFIED`.
- Not established: that any reviewer is independent of the operator. The workflow is real and
  tested with a locally generated test reviewer key; the independent human review of the canary
  interceptor profile remains `NOT_RUN` and is the user's action (`docs/USER-NEXT-STEPS.md`).
