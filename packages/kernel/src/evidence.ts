/**
 * Evidence predicates over orthogonal class / scope / reason axes (FR-10, INV-08).
 *
 * A predicate names a subject, the exact run operation it must bind (when any), and the
 * evidence classes and scopes it declares acceptable. An item satisfies it only when:
 *
 * - every mandatory identity field equals the case identity (integration revision, build,
 *   artifact, gate run, case run, session, scenario, effect policy, effect manifest);
 * - it binds the predicate's run operation (unbound items are never promoted to bound ones);
 * - its class and scope are both declared acceptable, and `PROVEN` is only ever acceptable in
 *   an independent proof scope (simulated ground truth or public chain observation);
 * - it carries no disqualifying reason (`NOT_VISIBLE`, `PRIVATE`, `STALE`, `MISSING`, ...);
 * - its payload/integrity digest is well formed.
 *
 * A reason is never a verdict, and "some evidence exists" never substitutes for the predicate.
 */
import { isDigest, type EvidenceClass, type EvidenceReason, type EvidenceScope } from '@routespec/contracts';
import type { EvidenceRecord, KernelIdentity } from './types.ts';

/** Scopes in which `PROVEN` evidence is independent of the subject and the provider. */
export const PROOF_SCOPES: readonly EvidenceScope[] = Object.freeze([
  'SIMULATED_GROUND_TRUTH',
  'PUBLIC_CHAIN_OBSERVATION',
]);

/** Reasons that disqualify an item from satisfying any predicate. */
export const DISQUALIFYING_REASONS: readonly EvidenceReason[] = Object.freeze([
  'NOT_VISIBLE',
  'MISSING',
  'CONTRADICTORY',
  'PRIVATE',
  'STALE',
  'UNSUPPORTED',
  'UNATTESTED_BUILD',
  'IDENTITY_MISMATCH',
  'EFFECT_COVERAGE_MISSING',
]);

export interface EvidencePredicate {
  readonly predicateId: string;
  readonly subject: string;
  /** The run operation the evidence must bind; null for case-scoped predicates. */
  readonly runOperationId: string | null;
  readonly acceptClasses: readonly EvidenceClass[];
  readonly acceptScopes: readonly EvidenceScope[];
}

export type PredicateStatus = 'SATISFIED' | 'WEAK' | 'MISSING';

export interface PredicateOutcome {
  readonly predicateId: string;
  readonly subject: string;
  readonly runOperationId: string | null;
  readonly status: PredicateStatus;
  /** Items that satisfy the predicate (ordered by journal sequence). */
  readonly satisfiedBy: readonly string[];
  /** Candidate items that were present but could not satisfy it. */
  readonly weak: readonly string[];
  readonly reasons: readonly EvidenceReason[];
  readonly findings: readonly string[];
}

export type ItemJudgement =
  | { readonly kind: 'IRRELEVANT' }
  | { readonly kind: 'SATISFIES' }
  | {
      readonly kind: 'WEAK';
      readonly reasons: readonly EvidenceReason[];
      readonly findings: readonly string[];
    };

const IDENTITY_FIELDS = [
  ['integrationRevisionId', 'integrationRevisionId'],
  ['buildRevisionId', 'buildRevisionId'],
  ['artifactDigest', 'artifactDigest'],
  ['gateRunId', 'gateRunId'],
  ['caseRunId', 'caseRunId'],
  ['sessionId', 'sessionId'],
  ['scenarioRevisionId', 'scenarioRevisionId'],
  ['effectCoveragePolicyDigest', 'effectCoveragePolicyDigest'],
  ['effectManifestDigest', 'effectManifestDigest'],
] as const satisfies ReadonlyArray<readonly [keyof EvidenceRecord, keyof KernelIdentity]>;

/** Identity fields of an evidence item that differ from the case identity (sorted). */
export function evidenceIdentityMismatches(e: EvidenceRecord, identity: KernelIdentity): string[] {
  const out: string[] = [];
  for (const [ev, id] of IDENTITY_FIELDS) if (e[ev] !== identity[id]) out.push(ev);
  return out.sort();
}

/** Class/scope/reason acceptability of one item, independent of subject and identity. */
export function classAndScopeAcceptable(
  e: Pick<EvidenceRecord, 'evidenceClass' | 'evidenceScope' | 'reasons'>,
  acceptClasses: readonly EvidenceClass[],
  acceptScopes: readonly EvidenceScope[],
): { ok: boolean; reasons: EvidenceReason[]; findings: string[] } {
  const reasons = new Set<EvidenceReason>();
  const findings: string[] = [];
  if (!acceptClasses.includes(e.evidenceClass)) findings.push(`CLASS_NOT_ACCEPTED:${e.evidenceClass}`);
  if (!acceptScopes.includes(e.evidenceScope)) findings.push(`SCOPE_NOT_ACCEPTED:${e.evidenceScope}`);
  // PROVEN outside an independent proof scope is a contradiction in terms; it never proves.
  if (e.evidenceClass === 'PROVEN' && !PROOF_SCOPES.includes(e.evidenceScope)) {
    findings.push(`PROVEN_OUTSIDE_PROOF_SCOPE:${e.evidenceScope}`);
  }
  if (e.evidenceScope === 'PRIVATE_NOT_VISIBLE') reasons.add('NOT_VISIBLE');
  if (e.evidenceClass === 'STALE') reasons.add('STALE');
  if (e.evidenceClass === 'UNSUPPORTED') reasons.add('UNSUPPORTED');
  for (const r of e.reasons) {
    if (DISQUALIFYING_REASONS.includes(r)) {
      reasons.add(r);
      findings.push(`DISQUALIFYING_REASON:${r}`);
    }
  }
  const ok = findings.length === 0 && reasons.size === 0;
  return { ok, reasons: [...reasons].sort(), findings: findings.sort() };
}

export function judgeItem(
  e: EvidenceRecord,
  predicate: EvidencePredicate,
  identity: KernelIdentity,
): ItemJudgement {
  if (e.subject !== predicate.subject) return { kind: 'IRRELEVANT' };
  if (
    predicate.runOperationId !== null &&
    e.runOperationId !== null &&
    e.runOperationId !== predicate.runOperationId
  ) {
    return { kind: 'IRRELEVANT' };
  }
  const reasons = new Set<EvidenceReason>();
  const findings: string[] = [];
  const mismatched = evidenceIdentityMismatches(e, identity);
  if (mismatched.length > 0) {
    reasons.add('IDENTITY_MISMATCH');
    findings.push(...mismatched.map((f) => `IDENTITY_MISMATCH:${f}`));
  }
  if (predicate.runOperationId !== null && e.runOperationId === null) {
    reasons.add('MISSING');
    findings.push('OPERATION_UNBOUND');
  }
  if (!isDigest(e.payloadDigest)) findings.push('INTEGRITY_DIGEST_INVALID');
  const cs = classAndScopeAcceptable(e, predicate.acceptClasses, predicate.acceptScopes);
  for (const r of cs.reasons) reasons.add(r);
  findings.push(...cs.findings);
  if (findings.length === 0 && reasons.size === 0) return { kind: 'SATISFIES' };
  return { kind: 'WEAK', reasons: [...reasons].sort(), findings: [...new Set(findings)].sort() };
}

export function evaluatePredicate(
  predicate: EvidencePredicate,
  evidence: readonly EvidenceRecord[],
  identity: KernelIdentity,
): PredicateOutcome {
  const satisfiedBy: string[] = [];
  const weak: string[] = [];
  const reasons = new Set<EvidenceReason>();
  const findings = new Set<string>();
  for (const e of [...evidence].sort((a, b) => a.sequence - b.sequence)) {
    const j = judgeItem(e, predicate, identity);
    if (j.kind === 'IRRELEVANT') continue;
    if (j.kind === 'SATISFIES') {
      satisfiedBy.push(e.evidenceId);
      continue;
    }
    weak.push(e.evidenceId);
    for (const r of j.reasons) reasons.add(r);
    for (const f of j.findings) findings.add(`${e.evidenceId}:${f}`);
  }
  const status: PredicateStatus = satisfiedBy.length > 0 ? 'SATISFIED' : weak.length > 0 ? 'WEAK' : 'MISSING';
  if (status === 'MISSING') reasons.add('MISSING');
  return {
    predicateId: predicate.predicateId,
    subject: predicate.subject,
    runOperationId: predicate.runOperationId,
    status,
    satisfiedBy,
    weak,
    reasons: status === 'SATISFIED' ? [] : [...reasons].sort(),
    findings: [...findings].sort(),
  };
}

/** Scenario predicate names (compiled `requiredEvidence`) to evidence subjects. */
export const PREDICATE_SUBJECTS: Readonly<Record<string, string>> = Object.freeze({
  ORIGIN_DEBIT: 'origin_debit',
  DESTINATION_CREDIT: 'destination_credit',
  REFUND_SETTLEMENT: 'refund_settlement',
  ORIGIN_FEE: 'origin_fee',
  LOCKED_VALUE: 'locked_value',
  EFFECT_COMPLETION: 'effect_completion',
});

/** Default proof predicate: PROVEN in an independent proof scope. */
export function proofPredicate(
  predicateId: string,
  subject: string,
  runOperationId: string | null,
): EvidencePredicate {
  return { predicateId, subject, runOperationId, acceptClasses: ['PROVEN'], acceptScopes: PROOF_SCOPES };
}
