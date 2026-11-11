/** Construction of immutable, canonically ordered invariant results. */
import type { EvidenceReason } from '@routespec/contracts';
import { EXPLANATIONS, type ExplanationCode, type RemediationCode } from './codes.ts';
import type { InvariantResult } from './types.ts';

function sortedUnique<T extends string>(values: Iterable<T>): T[] {
  return [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

export function invariantResult(input: {
  invariantId: string;
  runOperationId: string | null;
  code: ExplanationCode;
  remediation?: RemediationCode | null;
  factIds?: Iterable<string>;
  evidenceIds?: Iterable<string>;
  missingPredicates?: Iterable<string>;
  reasons?: Iterable<EvidenceReason>;
  findings?: Iterable<string>;
}): InvariantResult {
  return deepFreeze({
    invariantId: input.invariantId,
    runOperationId: input.runOperationId,
    verdict: EXPLANATIONS[input.code].verdict,
    explanationCode: input.code,
    remediationCode: input.remediation ?? null,
    factIds: sortedUnique(input.factIds ?? []),
    evidenceIds: sortedUnique(input.evidenceIds ?? []),
    missingPredicates: sortedUnique(input.missingPredicates ?? []),
    reasons: sortedUnique(input.reasons ?? []),
    findings: sortedUnique(input.findings ?? []),
  });
}
