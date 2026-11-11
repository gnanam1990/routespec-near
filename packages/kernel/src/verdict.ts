/**
 * Verdict combination (TDD.md sections 11 and 14).
 *
 * - FAIL dominates: any FAIL is FAIL.
 * - No evaluation at all is NOT_RUN (never a substitute for an incomplete REVIEW).
 * - Otherwise any REVIEW, UNSUPPORTED (a required invariant that cannot be evaluated), or a
 *   NOT_RUN mixed with completed results is REVIEW.
 * - PASS only when every combined result is PASS.
 */
import type { Verdict } from '@routespec/contracts';

export function combineVerdicts(verdicts: readonly Verdict[]): Verdict {
  if (verdicts.length === 0) return 'NOT_RUN';
  if (verdicts.includes('FAIL')) return 'FAIL';
  if (verdicts.every((v) => v === 'NOT_RUN')) return 'NOT_RUN';
  if (verdicts.some((v) => v === 'REVIEW' || v === 'UNSUPPORTED' || v === 'NOT_RUN')) return 'REVIEW';
  return 'PASS';
}
