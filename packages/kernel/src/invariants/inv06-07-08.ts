/**
 * INV-06 — Terminal outcomes do not regress.
 * INV-07 — Evidence is consumed once.
 * INV-08 — Missing or weak evidence cannot satisfy a stronger claim.
 */
import { foldOutcomes, type EvidenceReason } from '@routespec/contracts';
import { evaluatePredicate, judgeItem, proofPredicate, PREDICATE_SUBJECTS } from '../evidence.ts';
import { invariantResult } from '../result.ts';
import type { InvariantResult, KernelInput } from '../types.ts';

/**
 * INV-06: recompute the outcome fold from the verbatim raw statuses in journal order and compare
 * it with the stored outcome. A stored terminal that differs from the first accepted terminal was
 * silently replaced (FAIL); contradictory terminals or unknown raw values are REVIEW; a committed
 * operation without an accepted terminal is REVIEW.
 */
export function evaluateInv06(input: KernelInput): InvariantResult[] {
  const results: InvariantResult[] = [];
  for (const op of input.runOperations) {
    const statusEvents = input.events
      .filter(
        (e) =>
          e.runOperationId === op.runOperationId &&
          (e.kind === 'PROVIDER_STATUS' || e.kind === 'PROVIDER_STATUS_UNKNOWN') &&
          e.rawStatus !== null,
      )
      .sort((a, b) => a.sequence - b.sequence);
    const base = {
      invariantId: 'INV-06',
      runOperationId: op.runOperationId,
      factIds: statusEvents.map((e) => e.eventId),
    };
    if (op.commitBindingDigest === null && statusEvents.length === 0) {
      results.push(invariantResult({ ...base, code: 'INV06_NO_COMMIT' }));
      continue;
    }
    const fold = foldOutcomes(statusEvents.map((e) => e.rawStatus as string));
    const findings = [
      `OBSERVATIONS:${fold.observations}`,
      `IGNORED_REGRESSIONS:${fold.ignoredRegressions}`,
      `ACCEPTED_TERMINAL:${fold.acceptedTerminal ?? 'NONE'}`,
    ];
    const overwritten =
      op.acceptedTerminalStatus !== fold.acceptedTerminal ||
      (fold.outcome !== null && op.normalizedOutcome !== fold.outcome);
    if (overwritten) {
      results.push(
        invariantResult({
          ...base,
          code: 'INV06_TERMINAL_OVERWRITTEN',
          remediation: 'PRESERVE_TERMINAL_OUTCOME',
          findings: [
            ...findings,
            `STORED:${op.acceptedTerminalStatus ?? 'NONE'}/${op.normalizedOutcome ?? 'NONE'}`,
          ],
        }),
      );
    } else if (fold.contradictory) {
      results.push(
        invariantResult({
          ...base,
          code: 'INV06_CONTRADICTORY_TERMINAL',
          remediation: 'PRESERVE_TERMINAL_OUTCOME',
          reasons: ['CONTRADICTORY'],
          findings,
        }),
      );
    } else if (fold.unknownObserved) {
      results.push(
        invariantResult({
          ...base,
          code: 'INV06_UNKNOWN_RAW_STATUS',
          remediation: 'PRESERVE_TERMINAL_OUTCOME',
          reasons: ['UNSUPPORTED'],
          findings,
        }),
      );
    } else if (fold.acceptedTerminal === null) {
      results.push(
        invariantResult({
          ...base,
          code: 'INV06_TERMINAL_NOT_REACHED',
          remediation: 'COMPLETE_RECONCILIATION',
          missingPredicates: ['ACCEPTED_TERMINAL_STATUS'],
          reasons: ['MISSING'],
          findings,
        }),
      );
    } else {
      results.push(invariantResult({ ...base, code: 'INV06_TERMINAL_STABLE', findings }));
    }
  }
  if (results.length === 0) {
    results.push(invariantResult({ invariantId: 'INV-06', runOperationId: null, code: 'INV06_NO_COMMIT' }));
  }
  return results;
}

/**
 * INV-07: a single-use proof (one evidence item, or several items carrying the identical proof
 * payload, e.g. a duplicated ground-truth emission) may satisfy at most one run operation unless
 * an explicit allocation exactly partitions it.
 */
export function evaluateInv07(input: KernelInput): InvariantResult[] {
  const findings: string[] = [];
  const evidenceIds = new Set<string>();
  let reused = false;
  let badAllocation = false;
  const byId = new Map(input.evidence.map((e) => [e.evidenceId, e]));
  const proofOps = new Map<string, Set<string>>();
  for (const c of input.consumptions) {
    const e = byId.get(c.evidenceId);
    if (!e || !e.singleUse || c.allocationId !== null) continue;
    const key = e.payloadDigest;
    const ops = proofOps.get(key) ?? new Set<string>();
    ops.add(c.runOperationId);
    proofOps.set(key, ops);
    evidenceIds.add(e.evidenceId);
  }
  for (const [proof, ops] of proofOps) {
    if (ops.size > 1) {
      reused = true;
      findings.push(`PROOF_REUSED:${proof}:${ops.size}`);
    }
  }
  for (const a of input.allocations) {
    evidenceIds.add(a.evidenceId);
    const e = byId.get(a.evidenceId);
    let sum = 0n;
    const seen = new Set<string>();
    let malformed = false;
    for (const p of a.parts) {
      if (!/^[1-9][0-9]{0,77}$/.test(p.amount) || seen.has(p.runOperationId)) malformed = true;
      else sum += BigInt(p.amount);
      seen.add(p.runOperationId);
    }
    if (
      malformed ||
      !e ||
      e.amount === null ||
      e.assetId !== a.assetId ||
      a.totalAmount !== e.amount ||
      sum !== BigInt(e.amount) ||
      a.parts.length < 2
    ) {
      badAllocation = true;
      findings.push(`ALLOCATION_INVALID:${a.allocationId}`);
    }
  }
  const base = { invariantId: 'INV-07', runOperationId: null, evidenceIds, findings };
  if (reused)
    return [
      invariantResult({ ...base, code: 'INV07_EVIDENCE_REUSED', remediation: 'CONSUME_EVIDENCE_ONCE' }),
    ];
  if (badAllocation) {
    return [
      invariantResult({ ...base, code: 'INV07_ALLOCATION_INVALID', remediation: 'CONSUME_EVIDENCE_ONCE' }),
    ];
  }
  return [invariantResult({ ...base, code: 'INV07_SINGLE_USE_RESPECTED' })];
}

/** Facts that claim independent proof, and the evidence subject that must prove them. */
const PROVEN_FACT_SUBJECTS: Readonly<Record<string, string>> = Object.freeze({
  SUCCESS_PROVEN: 'destination_credit',
  REFUND_PROVEN: 'refund_settlement',
});

/**
 * INV-08: (a) a journal fact that claims proof (`SUCCESS_PROVEN`, `REFUND_PROVEN`) without a
 * satisfying proof item is an upgrade (FAIL); (b) every scenario-required predicate is evaluated
 * against its declared acceptable classes/scopes per committed run operation: weak-only is
 * REVIEW, absent is REVIEW, satisfied is PASS.
 */
export function evaluateInv08(input: KernelInput): InvariantResult[] {
  const id = input.identity;
  const upgrades: string[] = [];
  for (const ev of input.events) {
    const subject = ev.normalizedFact === null ? undefined : PROVEN_FACT_SUBJECTS[ev.normalizedFact];
    if (subject === undefined) continue;
    const backed = input.evidence.some(
      (e) => judgeItem(e, proofPredicate('PROVEN_FACT', subject, ev.runOperationId), id).kind === 'SATISFIES',
    );
    if (!backed) upgrades.push(`FACT_UPGRADED:${ev.eventId}:${ev.normalizedFact}`);
  }
  if (upgrades.length > 0) {
    return [
      invariantResult({
        invariantId: 'INV-08',
        runOperationId: null,
        code: 'INV08_FACT_UPGRADED_WITHOUT_PROOF',
        remediation: 'REQUIRE_PROVEN_EVIDENCE',
        findings: upgrades,
      }),
    ];
  }
  const committed = input.runOperations.filter((op) => op.commitBindingDigest !== null);
  const targets: Array<string | null> =
    committed.length > 0 ? committed.map((op) => op.runOperationId) : [null];
  const results: InvariantResult[] = [];
  for (const runOperationId of targets) {
    const evidenceIds = new Set<string>();
    const missing: string[] = [];
    const weakPreds: string[] = [];
    const reasons = new Set<EvidenceReason>();
    const findings: string[] = [];
    for (const req of input.requiredEvidence) {
      const subject = PREDICATE_SUBJECTS[req.predicate];
      if (subject === undefined) {
        missing.push(req.predicate);
        findings.push(`PREDICATE_UNKNOWN:${req.predicate}`);
        reasons.add('UNSUPPORTED');
        continue;
      }
      const outcome = evaluatePredicate(
        {
          predicateId: req.predicate,
          subject,
          runOperationId,
          acceptClasses: req.classes,
          acceptScopes: req.scopes,
        },
        input.evidence,
        id,
      );
      for (const e of [...outcome.satisfiedBy, ...outcome.weak]) evidenceIds.add(e);
      findings.push(...outcome.findings);
      if (outcome.status === 'SATISFIED') continue;
      for (const r of outcome.reasons) reasons.add(r);
      if (outcome.status === 'WEAK') weakPreds.push(req.predicate);
      else missing.push(req.predicate);
    }
    const base = {
      invariantId: 'INV-08',
      runOperationId,
      evidenceIds,
      missingPredicates: [...weakPreds, ...missing],
      reasons,
      findings,
    };
    if (weakPreds.length > 0) {
      results.push(
        invariantResult({
          ...base,
          code: 'INV08_REQUIRED_EVIDENCE_WEAK',
          remediation: 'REQUIRE_PROVEN_EVIDENCE',
        }),
      );
    } else if (missing.length > 0) {
      results.push(
        invariantResult({
          ...base,
          code: 'INV08_REQUIRED_EVIDENCE_MISSING',
          remediation: 'REQUIRE_PROVEN_EVIDENCE',
        }),
      );
    } else {
      results.push(invariantResult({ ...base, code: 'INV08_NO_UPGRADE' }));
    }
  }
  return results;
}
