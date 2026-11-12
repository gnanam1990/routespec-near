/**
 * Evaluator revision and semantics digest (deliverable 7).
 *
 * The semantics digest covers every declared rule table the verdicts depend on: explanation
 * codes and their verdicts, proof scopes, disqualifying reasons, predicate subjects, completion
 * and value subjects, the status mapping revision, and the implemented invariant set. A test pins
 * the digest for this revision, so any change to those tables without a new evaluator revision
 * fails the build instead of silently changing what an old revision meant.
 */
import { digestValue } from '@routespec/contracts';
import { CASE_EXPLANATIONS, EXPLANATIONS, REMEDIATIONS } from './codes.ts';
import { DISQUALIFYING_REASONS, PREDICATE_SUBJECTS, PROOF_SCOPES } from './evidence.ts';
import { COMPLETION_SUBJECTS, PROFILE_REVIEW_GAP } from './invariants/inv04.ts';
import { VALUE_SUBJECTS } from './invariants/inv05.ts';
import { STATUS_MAPPING_REVISION } from './provider-facts.ts';

export const EVALUATOR_REVISION = 'routespec-kernel@1.1.0' as const;

/** Invariants this revision evaluates. Others are reported NOT_RUN when a case requires them. */
export const IMPLEMENTED_INVARIANTS = Object.freeze([
  'INV-01',
  'INV-02',
  'INV-03',
  'INV-04',
  'INV-05',
  'INV-06',
  'INV-07',
  'INV-08',
] as const);

export const KERNEL_SEMANTICS = Object.freeze({
  evaluatorRevision: EVALUATOR_REVISION,
  implementedInvariants: IMPLEMENTED_INVARIANTS,
  explanations: Object.fromEntries(Object.entries(EXPLANATIONS).map(([k, v]) => [k, v.verdict])),
  caseExplanations: Object.fromEntries(Object.entries(CASE_EXPLANATIONS).map(([k, v]) => [k, v.verdict])),
  remediations: Object.keys(REMEDIATIONS).sort(),
  proofScopes: PROOF_SCOPES,
  disqualifyingReasons: DISQUALIFYING_REASONS,
  predicateSubjects: PREDICATE_SUBJECTS,
  completionSubjects: COMPLETION_SUBJECTS,
  interceptorProfileReviewGaps: PROFILE_REVIEW_GAP,
  valueSubjects: VALUE_SUBJECTS,
  statusMappingRevision: STATUS_MAPPING_REVISION,
  verdictCombination: 'FAIL>REVIEW|UNSUPPORTED|MIXED_NOT_RUN>ALL_NOT_RUN>PASS',
  caseCompleteness: 'INPUT_CLOSED_AND_RUNNING_OR_EVALUATING',
});

export const KERNEL_SEMANTICS_DIGEST = digestValue('routespec.kernel-semantics/1', KERNEL_SEMANTICS);
