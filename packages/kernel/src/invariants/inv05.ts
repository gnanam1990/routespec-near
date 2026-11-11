/**
 * INV-05 — Observable value conservation (TDD.md section 12).
 *
 * Per run operation, amounts are base-unit integer strings parsed as BigInt and partitioned by
 * canonical asset identity. Unlike assets are never added and display (USD) values are never
 * read: the quote's display extensions are not part of the kernel input at all.
 *
 * Origin ledger (quoted origin asset only):
 *     debit = consumed + refund + fee + locked
 * where `consumed` is the finalized quote's amountIn when the swap delivered and 0 when it did
 * not. Positive remainder is an unexplained loss (FAIL); negative is base-unit drift (FAIL).
 *
 * Destination obligation (only when the swap delivered): every credit must be in the quoted
 * destination asset (else FAIL), reach the quoted recipient (else FAIL), and total at least the
 * quoted minimum (EXACT_INPUT/FLEX_INPUT) or exactly the quoted output (EXACT_OUTPUT) (else FAIL).
 *
 * A leg in a third asset (e.g. a provider fee) is a separate ledger and cannot explain an
 * origin-asset loss. Missing, private, stale, or weak legs make the operation REVIEW (with
 * NOT_VISIBLE or MISSING reasons), unless a proven fact already establishes a violation that no
 * missing leg could repair (wrong destination asset or recipient), which is FAIL.
 */
import { digestValue, type EvidenceReason } from '@routespec/contracts';
import { judgeItem, proofPredicate } from '../evidence.ts';
import { invariantResult } from '../result.ts';
import type { EvidenceRecord, InvariantResult, KernelInput, RunOperationRecord } from '../types.ts';

const ID = 'INV-05';
const BASE_UNITS = /^(0|[1-9][0-9]{0,77})$/;

export const VALUE_SUBJECTS = Object.freeze({
  debit: 'origin_debit',
  refund: 'refund_settlement',
  fee: 'origin_fee',
  locked: 'locked_value',
  credit: 'destination_credit',
});

const ALL_VALUE_SUBJECTS: readonly string[] = Object.values(VALUE_SUBJECTS);

/** Recipient digest domain shared with the journal's evidence recipient binding. */
export function recipientDigest(recipient: string): string {
  return digestValue('routespec.evidence-recipient/1', recipient);
}

function amountOf(e: EvidenceRecord): bigint | null {
  return e.amount !== null && BASE_UNITS.test(e.amount) ? BigInt(e.amount) : null;
}

function evaluateOperation(input: KernelInput, op: RunOperationRecord): InvariantResult {
  const id = input.identity;
  const legs = input.evidence.filter(
    (e) => e.runOperationId === op.runOperationId && ALL_VALUE_SUBJECTS.includes(e.subject),
  );
  const proven: EvidenceRecord[] = [];
  const weak: EvidenceRecord[] = [];
  const reasons = new Set<EvidenceReason>();
  const findings: string[] = [];
  for (const e of legs) {
    const j = judgeItem(e, proofPredicate('VALUE_LEG', e.subject, op.runOperationId), id);
    if (j.kind === 'SATISFIES' && amountOf(e) !== null && e.assetId !== null) proven.push(e);
    else if (j.kind !== 'IRRELEVANT') {
      weak.push(e);
      if (j.kind === 'WEAK') for (const r of j.reasons) reasons.add(r);
      if (j.kind === 'SATISFIES') findings.push(`LEG_WITHOUT_AMOUNT:${e.evidenceId}`);
    }
  }
  const evidenceIds = legs.map((e) => e.evidenceId);
  const q = op.quote;
  const of = (subject: string) => proven.filter((e) => e.subject === subject);
  const weakOf = (subject: string) => weak.filter((e) => e.subject === subject);
  const sumIn = (items: EvidenceRecord[], asset: string) =>
    items.filter((e) => e.assetId === asset).reduce((acc, e) => acc + (amountOf(e) as bigint), 0n);

  // Delivered or not: proven credit, proven refund, or the accepted terminal status.
  const credits = of(VALUE_SUBJECTS.credit);
  const refunds = of(VALUE_SUBJECTS.refund);
  const terminal = op.acceptedTerminalStatus;
  const delivered =
    credits.length > 0
      ? true
      : terminal === 'SUCCESS'
        ? true
        : refunds.length > 0 || terminal === 'REFUNDED' || terminal === 'FAILED'
          ? false
          : null;

  // Violations that no missing leg could repair.
  const fatal: Array<'INV05_WRONG_DESTINATION_ASSET' | 'INV05_WRONG_RECIPIENT'> = [];
  for (const c of credits) {
    if (c.assetId !== q.destinationAsset) {
      fatal.push('INV05_WRONG_DESTINATION_ASSET');
      findings.push(`CREDIT_ASSET:${c.evidenceId}`);
    }
    if (q.recipientDigest !== null && c.recipientDigest !== null && c.recipientDigest !== q.recipientDigest) {
      fatal.push('INV05_WRONG_RECIPIENT');
      findings.push(`CREDIT_RECIPIENT:${c.evidenceId}`);
    }
  }
  for (const r of refunds) {
    if (q.refundToDigest !== null && r.recipientDigest !== null && r.recipientDigest !== q.refundToDigest) {
      fatal.push('INV05_WRONG_RECIPIENT');
      findings.push(`REFUND_RECIPIENT:${r.evidenceId}`);
    }
  }
  for (const e of proven) {
    if (e.subject !== VALUE_SUBJECTS.credit && e.assetId !== q.originAsset)
      findings.push(`SEPARATE_ASSET_LEDGER:${e.assetId}`);
  }
  const base = { invariantId: ID, runOperationId: op.runOperationId, evidenceIds };
  if (fatal.length > 0) {
    return invariantResult({
      ...base,
      code: fatal.includes('INV05_WRONG_DESTINATION_ASSET')
        ? 'INV05_WRONG_DESTINATION_ASSET'
        : 'INV05_WRONG_RECIPIENT',
      remediation: 'RECONCILE_VALUE_LEGS',
      findings,
    });
  }

  // Weak/private legs, or a missing debit, can always explain a gap: REVIEW.
  const missing: string[] = [];
  if (of(VALUE_SUBJECTS.debit).length === 0) missing.push('ORIGIN_DEBIT');
  if (delivered === true && credits.length === 0) missing.push('DESTINATION_CREDIT');
  if (delivered === false && terminal === 'REFUNDED' && refunds.length === 0)
    missing.push('REFUND_SETTLEMENT');
  if (weak.length > 0 || missing.length > 0) {
    for (const s of Object.values(VALUE_SUBJECTS)) {
      if (weakOf(s).length > 0) missing.push(s.toUpperCase());
    }
    if (missing.length > 0) reasons.add('MISSING');
    const notVisible =
      reasons.has('NOT_VISIBLE') || weak.some((e) => e.evidenceScope === 'PRIVATE_NOT_VISIBLE');
    if (notVisible) reasons.add('NOT_VISIBLE');
    return invariantResult({
      ...base,
      code: notVisible ? 'INV05_LEG_NOT_VISIBLE' : 'INV05_LEG_MISSING',
      remediation: notVisible ? 'PROVIDE_INDEPENDENT_DELIVERY_EVIDENCE' : 'RECONCILE_VALUE_LEGS',
      missingPredicates: missing,
      reasons,
      findings,
    });
  }
  if (delivered === null || q.amountIn === null || !BASE_UNITS.test(q.amountIn)) {
    return invariantResult({
      ...base,
      code: 'INV05_OUTCOME_UNDETERMINED',
      remediation: 'COMPLETE_RECONCILIATION',
      missingPredicates: ['SWAP_OUTCOME'],
      reasons: ['MISSING'],
      findings,
    });
  }

  // All required legs proven: reconcile the origin ledger in the origin asset only.
  const debit = sumIn(of(VALUE_SUBJECTS.debit), q.originAsset);
  const refund = sumIn(refunds, q.originAsset);
  const fee = sumIn(of(VALUE_SUBJECTS.fee), q.originAsset);
  const locked = sumIn(of(VALUE_SUBJECTS.locked), q.originAsset);
  const consumed = delivered ? BigInt(q.amountIn) : 0n;
  const remainder = debit - (consumed + refund + fee + locked);
  findings.push(`ORIGIN_REMAINDER:${remainder.toString()}`);
  if (remainder > 0n) {
    return invariantResult({
      ...base,
      code: 'INV05_UNEXPLAINED_LOSS',
      remediation: 'RECONCILE_VALUE_LEGS',
      findings,
    });
  }
  if (remainder < 0n) {
    return invariantResult({
      ...base,
      code: 'INV05_BASE_UNIT_DRIFT',
      remediation: 'RECONCILE_VALUE_LEGS',
      findings,
    });
  }
  if (delivered) {
    const credited = sumIn(credits, q.destinationAsset);
    const exactOutput = q.swapType === 'EXACT_OUTPUT';
    const bound = exactOutput ? q.amountOut : q.minAmountOut;
    if (bound === null || !BASE_UNITS.test(bound)) {
      return invariantResult({
        ...base,
        code: 'INV05_OUTCOME_UNDETERMINED',
        missingPredicates: ['QUOTED_DESTINATION_CONSTRAINT'],
        reasons: ['MISSING'],
        findings,
      });
    }
    const shortfall = exactOutput ? credited !== BigInt(bound) : credited < BigInt(bound);
    findings.push(`DESTINATION_CREDITED:${credited.toString()}`);
    if (shortfall) {
      return invariantResult({
        ...base,
        code: 'INV05_QUOTE_SHORTFALL',
        remediation: 'RECONCILE_VALUE_LEGS',
        findings,
      });
    }
  }
  return invariantResult({ ...base, code: 'INV05_CONSERVED', findings });
}

export function evaluateInv05(input: KernelInput): InvariantResult[] {
  const ops = input.runOperations.filter(
    (op) =>
      op.commitBindingDigest !== null ||
      input.evidence.some(
        (e) => e.runOperationId === op.runOperationId && ALL_VALUE_SUBJECTS.includes(e.subject),
      ),
  );
  const unbound = input.evidence.filter(
    (e) => e.runOperationId === null && ALL_VALUE_SUBJECTS.includes(e.subject),
  );
  const results = ops.map((op) => evaluateOperation(input, op));
  if (unbound.length > 0) {
    results.push(
      invariantResult({
        invariantId: ID,
        runOperationId: null,
        code: 'INV05_LEG_MISSING',
        remediation: 'RECONCILE_VALUE_LEGS',
        evidenceIds: unbound.map((e) => e.evidenceId),
        missingPredicates: ['OPERATION_BOUND_VALUE_LEG'],
        reasons: ['MISSING'],
        findings: unbound.map((e) => `UNBOUND_VALUE_LEG:${e.evidenceId}`),
      }),
    );
  }
  if (results.length === 0) {
    return [invariantResult({ invariantId: ID, runOperationId: null, code: 'INV05_NO_VALUE_MOVEMENT' })];
  }
  return results;
}
