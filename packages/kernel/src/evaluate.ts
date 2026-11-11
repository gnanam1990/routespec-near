/**
 * The pure case evaluator (FR-09, NFR-01).
 *
 * `evaluateCase` is a deterministic function of its `KernelInput`: no clock, randomness, I/O,
 * network, database, UI, or model. It returns an immutable evaluation whose digest binds the
 * evaluator revision, the semantics digest, the input digest, the identity, and every invariant
 * result. Lifecycle never implies a verdict; an incomplete case can never PASS.
 */
import { RouteSpecError, digestValue, type Verdict } from '@routespec/contracts';
import { CASE_EXPLANATIONS, type CaseExplanationCode } from './codes.ts';
import { evaluateInv01, evaluateInv02 } from './invariants/inv01-02.ts';
import { evaluateInv03 } from './invariants/inv03.ts';
import { evaluateInv04 } from './invariants/inv04.ts';
import { evaluateInv05 } from './invariants/inv05.ts';
import { evaluateInv06, evaluateInv07, evaluateInv08 } from './invariants/inv06-07-08.ts';
import { deepFreeze, invariantResult } from './result.ts';
import { EVALUATOR_REVISION, KERNEL_SEMANTICS_DIGEST } from './revision.ts';
import type { InvariantResult, KernelIdentity, KernelInput } from './types.ts';
import { combineVerdicts } from './verdict.ts';

export const KERNEL_INPUT_DIGEST_DOMAIN = 'routespec.kernel-input/1';
export const KERNEL_RESULT_DIGEST_DOMAIN = 'routespec.kernel-result/1';

const EVALUATORS: Readonly<Record<string, (input: KernelInput) => InvariantResult[]>> = Object.freeze({
  'INV-01': evaluateInv01,
  'INV-02': evaluateInv02,
  'INV-03': evaluateInv03,
  'INV-04': evaluateInv04,
  'INV-05': evaluateInv05,
  'INV-06': evaluateInv06,
  'INV-07': evaluateInv07,
  'INV-08': evaluateInv08,
});

export interface InvariantSummary {
  readonly invariantId: string;
  readonly required: boolean;
  readonly verdict: Verdict;
}

export interface CaseEvaluation {
  readonly evaluatorRevision: typeof EVALUATOR_REVISION;
  readonly semanticsDigest: string;
  readonly inputDigest: string;
  readonly identity: KernelIdentity;
  readonly requiredInvariants: readonly string[];
  readonly invariantResults: readonly InvariantResult[];
  readonly summaries: readonly InvariantSummary[];
  readonly verdict: Verdict;
  readonly explanationCode: CaseExplanationCode;
  readonly resultDigest: string;
}

const INVARIANT_ID = /^INV-(0[1-9]|1[0-2])$/;

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function digestKernelInput(input: KernelInput): string {
  return digestValue(KERNEL_INPUT_DIGEST_DOMAIN, input);
}

/** Recompute the evaluation digest from its authoritative fields (used to detect tampering). */
export function digestEvaluation(e: Omit<CaseEvaluation, 'resultDigest'>): string {
  return digestValue(KERNEL_RESULT_DIGEST_DOMAIN, {
    evaluatorRevision: e.evaluatorRevision,
    semanticsDigest: e.semanticsDigest,
    inputDigest: e.inputDigest,
    identity: e.identity,
    requiredInvariants: e.requiredInvariants,
    invariantResults: e.invariantResults,
    summaries: e.summaries,
    verdict: e.verdict,
    explanationCode: e.explanationCode,
  });
}

export function evaluateCase(input: KernelInput): CaseEvaluation {
  if (input.identity.evaluatorRevision !== EVALUATOR_REVISION) {
    throw new RouteSpecError(
      'RS_IDENTITY_MISMATCH',
      'The gate run pinned a different evaluator revision; this kernel will not evaluate it.',
      { details: { pinned: input.identity.evaluatorRevision, kernel: EVALUATOR_REVISION } },
    );
  }
  for (const inv of input.caseState.requiredInvariants) {
    if (!INVARIANT_ID.test(inv)) {
      throw new RouteSpecError('RS_KERNEL_INPUT_INVALID', 'Required invariant identifier is invalid.', {
        details: { invariantId: inv },
      });
    }
  }
  const inputDigest = digestKernelInput(input);
  const required = [...new Set(input.caseState.requiredInvariants)].sort(cmp);
  const results: InvariantResult[] = [];
  for (const evaluator of Object.values(EVALUATORS)) results.push(...evaluator(input));
  for (const inv of required) {
    if (EVALUATORS[inv] === undefined) {
      results.push(
        invariantResult({
          invariantId: inv,
          runOperationId: null,
          code: 'EVALUATOR_NOT_AVAILABLE',
          remediation: 'ADD_EVALUATOR_REVISION',
        }),
      );
    }
  }
  results.sort(
    (a, b) => cmp(a.invariantId, b.invariantId) || cmp(a.runOperationId ?? '', b.runOperationId ?? ''),
  );

  const ids = [...new Set(results.map((r) => r.invariantId))].sort(cmp);
  const summaries: InvariantSummary[] = ids.map((invariantId) => ({
    invariantId,
    required: required.includes(invariantId),
    verdict: combineVerdicts(results.filter((r) => r.invariantId === invariantId).map((r) => r.verdict)),
  }));
  const requiredVerdict = combineVerdicts(summaries.filter((s) => s.required).map((s) => s.verdict));
  const complete =
    input.caseState.inputClosed &&
    (input.caseState.lifecycle === 'RUNNING' ||
      input.caseState.lifecycle === 'EVALUATING' ||
      input.caseState.lifecycle === 'COMPLETED');
  let explanationCode: CaseExplanationCode;
  if (requiredVerdict === 'FAIL') explanationCode = 'CASE_FAIL';
  else if (requiredVerdict === 'NOT_RUN') explanationCode = 'CASE_NOT_RUN';
  else if (!complete) explanationCode = 'CASE_INCOMPLETE';
  else if (requiredVerdict === 'PASS') explanationCode = 'CASE_PASS';
  else explanationCode = 'CASE_REVIEW';
  const verdict = CASE_EXPLANATIONS[explanationCode].verdict;

  const body = {
    evaluatorRevision: EVALUATOR_REVISION,
    semanticsDigest: KERNEL_SEMANTICS_DIGEST,
    inputDigest,
    identity: input.identity,
    requiredInvariants: required,
    invariantResults: results,
    summaries,
    verdict,
    explanationCode,
  };
  return deepFreeze({ ...body, resultDigest: digestEvaluation(body) });
}
