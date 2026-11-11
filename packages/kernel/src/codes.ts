/**
 * Closed explanation and remediation codes with deterministic templates (FR-09, TB-04).
 *
 * Explanations are rendered only from these templates and the result's own fields. Free text
 * from any optional model is never part of a result or its digest.
 */
import type { Verdict } from '@routespec/contracts';

interface CodeSpec {
  readonly verdict: Verdict;
  readonly template: string;
}

const spec = (verdict: Verdict, template: string): CodeSpec => Object.freeze({ verdict, template });

export const EXPLANATIONS = Object.freeze({
  INV01_OPERATIONS_ISOLATED: spec(
    'PASS',
    'Every run operation is scoped to this exact build, gate run, and case run.',
  ),
  INV01_NO_OPERATIONS: spec('PASS', 'The case created no run operation, so no operation scope could merge.'),
  INV01_OPERATION_SCOPE_MISMATCH: spec(
    'FAIL',
    'A run operation is bound to a different build, gate run, case run, or session.',
  ),
  INV02_BINDINGS_IMMUTABLE: spec(
    'PASS',
    'Each quote finalization and commit binding was written once and never rewritten.',
  ),
  INV02_BINDING_INCONSISTENT: spec(
    'FAIL',
    'A run operation records a commit without a finalization, or a binding that differs from its first write.',
  ),
  INV03_NO_COMMIT: spec('PASS', 'No commit mutation was accepted, so no second mutation was possible.'),
  INV03_NO_UNCERTAINTY: spec(
    'PASS',
    'Every accepted commit had a delivered response; no outcome was uncertain.',
  ),
  INV03_RECONCILED_WITHOUT_SECOND_MUTATION: spec(
    'PASS',
    'After an unknown commit outcome the case was fenced, reconciled read-only to a terminal result, and no second mutation was accepted.',
  ),
  INV03_SECOND_MUTATION_UNDER_UNCERTAINTY: spec(
    'FAIL',
    'A mutation was accepted while a commit outcome was still unknown, before reconciliation reached a terminal result.',
  ),
  INV03_MUTATION_AUTHORITY_REISSUED: spec(
    'FAIL',
    'Mutation-capable authority was issued after an unknown commit outcome instead of a reconciliation-only token.',
  ),
  INV03_RECONCILIATION_INCOMPLETE: spec(
    'REVIEW',
    'A commit outcome is unknown and reconciliation has not reached an accepted terminal result.',
  ),
  INV03_RECOVERY_FENCE_MISSING: spec(
    'REVIEW',
    'A commit outcome is unknown but the journal does not show the stale token revoked and the fencing epoch advanced.',
  ),
  INV03_RETRY_JOINED_BEFORE_FENCE: spec(
    'REVIEW',
    'An exact commit retry joined the uncertain operation before the recovery fence took effect.',
  ),
  INV04_NO_PROTECTED_EFFECTS: spec(
    'PASS',
    'The effect policy requires no protected sink and none was attempted or reported.',
  ),
  INV04_COMPLETE_INDEPENDENT_COVERAGE: spec(
    'PASS',
    'An attested independent interceptor covered every required sink; effects were blocked until accepted completion evidence and released only after it.',
  ),
  INV04_FORBIDDEN_RELEASE_OBSERVED: spec(
    'FAIL',
    'The independent boundary interceptor observed a protected effect released before accepted completion evidence.',
  ),
  INV04_COVERAGE_INCOMPLETE: spec(
    'REVIEW',
    'Independent effect coverage is incomplete; self-reported or partial coverage cannot prove the effect waited for completion.',
  ),
  INV04_DECLARED_HOOKS_ONLY: spec(
    'REVIEW',
    'Declared hooks only — REVIEW. Subject-reported hooks do not prove coverage.',
  ),
  INV05_NO_VALUE_MOVEMENT: spec(
    'PASS',
    'No run operation committed or observed value, so there is nothing to conserve.',
  ),
  INV05_CONSERVED: spec(
    'PASS',
    'Origin debit, refund, fee, and locked value reconcile in base units, and destination credit meets the quoted asset and amount (proven within scenario).',
  ),
  INV05_UNEXPLAINED_LOSS: spec(
    'FAIL',
    'Proven origin-asset legs leave a positive unexplained loss in base units.',
  ),
  INV05_BASE_UNIT_DRIFT: spec(
    'FAIL',
    'Proven origin-asset legs account for more than the debit: base-unit drift.',
  ),
  INV05_WRONG_DESTINATION_ASSET: spec(
    'FAIL',
    'Proven destination credit is in an asset other than the quoted destination asset.',
  ),
  INV05_QUOTE_SHORTFALL: spec('FAIL', 'Proven destination credit is below the quoted amount constraint.'),
  INV05_WRONG_RECIPIENT: spec(
    'FAIL',
    'Proven destination credit reached a recipient other than the quoted recipient.',
  ),
  INV05_LEG_NOT_VISIBLE: spec(
    'REVIEW',
    'A required value leg is private or not visible; conservation cannot be proven.',
  ),
  INV05_LEG_MISSING: spec(
    'REVIEW',
    'A required value leg is missing or weakly evidenced; conservation cannot be proven.',
  ),
  INV05_OUTCOME_UNDETERMINED: spec(
    'REVIEW',
    'Whether the swap delivered or refunded is not established, so the destination obligation is undetermined.',
  ),
  INV06_NO_COMMIT: spec('PASS', 'No commit was bound, so no terminal outcome exists to regress.'),
  INV06_TERMINAL_STABLE: spec(
    'PASS',
    'The first accepted terminal outcome was never replaced by a later observation.',
  ),
  INV06_TERMINAL_OVERWRITTEN: spec(
    'FAIL',
    'The stored outcome differs from the first accepted terminal outcome: it was silently replaced.',
  ),
  INV06_CONTRADICTORY_TERMINAL: spec('REVIEW', 'Contradictory terminal statuses were observed.'),
  INV06_UNKNOWN_RAW_STATUS: spec(
    'REVIEW',
    'An unknown raw provider status was observed; it is preserved verbatim and fails closed.',
  ),
  INV06_TERMINAL_NOT_REACHED: spec(
    'REVIEW',
    'A committed operation never reached an accepted terminal status.',
  ),
  INV07_SINGLE_USE_RESPECTED: spec('PASS', 'No single-use proof satisfied more than one operation binding.'),
  INV07_EVIDENCE_REUSED: spec(
    'FAIL',
    'One single-use proof satisfied more than one operation binding without a modelled allocation.',
  ),
  INV07_ALLOCATION_INVALID: spec(
    'FAIL',
    'An aggregate allocation does not exactly partition its evidence amount.',
  ),
  INV08_NO_UPGRADE: spec(
    'PASS',
    'Every required predicate was satisfied by acceptable evidence and no fact claims more than its evidence.',
  ),
  INV08_FACT_UPGRADED_WITHOUT_PROOF: spec('FAIL', 'A fact claims proof that its evidence does not provide.'),
  INV08_REQUIRED_EVIDENCE_WEAK: spec(
    'REVIEW',
    'A required predicate has only weak, reported, private, stale, or unsupported evidence.',
  ),
  INV08_REQUIRED_EVIDENCE_MISSING: spec('REVIEW', 'A required predicate has no evidence.'),
  EVALUATOR_NOT_AVAILABLE: spec('NOT_RUN', 'This evaluator revision has no evaluator for this invariant.'),
} satisfies Record<string, CodeSpec>);

export type ExplanationCode = keyof typeof EXPLANATIONS;

export const CASE_EXPLANATIONS = Object.freeze({
  CASE_PASS: spec('PASS', 'Every required invariant passed for this exact case identity.'),
  CASE_FAIL: spec('FAIL', 'At least one required invariant failed.'),
  CASE_REVIEW: spec('REVIEW', 'At least one required invariant needs review; the case cannot pass.'),
  CASE_INCOMPLETE: spec(
    'REVIEW',
    'The case did not close its input under a complete lifecycle; it cannot pass.',
  ),
  CASE_NOT_RUN: spec('NOT_RUN', 'No required invariant was evaluated.'),
} satisfies Record<string, CodeSpec>);

export type CaseExplanationCode = keyof typeof CASE_EXPLANATIONS;

export const REMEDIATIONS = Object.freeze({
  RECONCILE_BEFORE_RETRY:
    'Reconcile the existing run operation read-only until a terminal result before any new mutation.',
  COMPLETE_RECONCILIATION:
    'Continue read-only reconciliation of the existing run operation to an accepted terminal result.',
  GATE_EFFECT_ON_ACCEPTED_COMPLETION:
    'Release protected effects only after accepted, independently proven completion evidence.',
  CONFIGURE_INDEPENDENT_INTERCEPTOR:
    'Run an attested independent boundary interceptor that confines the subject process tree and covers every required sink.',
  PROVIDE_INDEPENDENT_DELIVERY_EVIDENCE:
    'Provide independent destination delivery evidence; a provider report alone does not prove delivery.',
  RECONCILE_VALUE_LEGS:
    'Account for every origin-asset leg in base units and meet the quoted destination constraint.',
  PRESERVE_TERMINAL_OUTCOME: 'Keep the first accepted terminal outcome and route contradictions to review.',
  CONSUME_EVIDENCE_ONCE:
    'Bind each single-use proof to exactly one operation or model an explicit allocation.',
  REQUIRE_PROVEN_EVIDENCE:
    'Supply evidence in the declared acceptable class and scope for each required predicate.',
  ISOLATE_OPERATION_SCOPE: 'Create a new run operation per build, gate run, and case run.',
  ADD_EVALUATOR_REVISION:
    'Use an evaluator revision that evaluates this invariant, or mark it non-required for the scenario.',
  COMPLETE_CASE_RUN: 'Close the case input under a complete lifecycle before evaluation.',
} satisfies Record<string, string>);

export type RemediationCode = keyof typeof REMEDIATIONS;
