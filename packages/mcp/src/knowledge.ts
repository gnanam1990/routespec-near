/**
 * What the MCP tools say about invariants and fixes (M52).
 *
 * Invariant explanations are the kernel's own closed explanation and remediation templates
 * (`@routespec/kernel` codes.ts) plus a one-line title and rule summarised from the core
 * contract. Fix patterns are concrete code patterns for the official 1Click TypeScript SDK; each
 * names the invariants and kernel remediation codes it answers. Nothing here is a verdict: a
 * fix is only shown to work by running the gate again.
 */
import { EXPLANATIONS, REMEDIATIONS } from '@routespec/kernel';

export interface InvariantInfo {
  readonly id: string;
  readonly title: string;
  readonly rule: string;
  /** Whether the uncontained MCP gate requires it (INV-04 needs containment, INV-09 is replay identity). */
  readonly requiredByMcpGate: boolean;
  readonly fixPatterns: readonly string[];
}

export const INVARIANTS: Readonly<Record<string, InvariantInfo>> = Object.freeze({
  'INV-01': {
    id: 'INV-01',
    title: 'One scoped run operation per logical job',
    rule: 'Within one build, gate run and case run, a logical job maps to exactly one run operation; exact retries add attempts to it and never merge with another job.',
    requiredByMcpGate: true,
    fixPatterns: ['exact-retry-same-order'],
  },
  'INV-02': {
    id: 'INV-02',
    title: 'Operation binding is immutable',
    rule: 'The quote request fields, the finalized quote and deposit address, and the first deposit submission are bound once; a changed or second submission fails closed and never rewrites history.',
    requiredByMcpGate: true,
    fixPatterns: ['exact-retry-same-order'],
  },
  'INV-03': {
    id: 'INV-03',
    title: 'Reconcile before retry under uncertainty',
    rule: 'When the outcome of a deposit submission is unknown, only read-only status calls on the existing order are allowed until it reaches a terminal result; no second submission, fresh quote under a new order, or timeout-driven retry.',
    requiredByMcpGate: true,
    fixPatterns: ['no-second-order-while-unanswered', 'reconcile-through-status'],
  },
  'INV-04': {
    id: 'INV-04',
    title: 'Protected side effects wait for accepted completion evidence',
    rule: 'Goods, access or other irreversible effects are released only after accepted, independently observed completion evidence, never because a request was sent or a non-terminal status was seen.',
    requiredByMcpGate: false,
    fixPatterns: ['release-effects-after-success'],
  },
  'INV-05': {
    id: 'INV-05',
    title: 'Observable value conservation',
    rule: 'Per asset in base units, the origin debit, refund and fees reconcile, and the destination credit meets the quoted constraint; a missing leg is REVIEW, an unexplained loss is FAIL.',
    requiredByMcpGate: true,
    fixPatterns: ['reconcile-through-status'],
  },
  'INV-06': {
    id: 'INV-06',
    title: 'Terminal outcomes do not regress',
    rule: 'Once the order reaches an accepted terminal status, a later non-terminal or lower-precedence observation does not replace it; a client that never reads a terminal status leaves the outcome undetermined.',
    requiredByMcpGate: true,
    fixPatterns: ['reconcile-through-status'],
  },
  'INV-07': {
    id: 'INV-07',
    title: 'Evidence is consumed once',
    rule: 'A deposit transaction, settlement proof or refund proof satisfies at most one order binding.',
    requiredByMcpGate: true,
    fixPatterns: ['exact-retry-same-order'],
  },
  'INV-08': {
    id: 'INV-08',
    title: 'Missing or weak evidence cannot satisfy a stronger claim',
    rule: 'Reported, inferred, unknown, stale or not-visible evidence never satisfies a predicate that needs proven evidence.',
    requiredByMcpGate: true,
    fixPatterns: ['reconcile-through-status'],
  },
  'INV-09': {
    id: 'INV-09',
    title: 'Replay identity is deterministic',
    rule: 'The canonical result digest is a pure function of the run identity, the scenario, the ordered client exchanges and the evidence.',
    requiredByMcpGate: false,
    fixPatterns: [],
  },
});

export interface FixPattern {
  readonly id: string;
  readonly title: string;
  readonly invariants: readonly string[];
  readonly remediationCodes: readonly string[];
  readonly problem: string;
  readonly rule: string;
  readonly before: string;
  readonly after: string;
}

export const FIX_PATTERNS: Readonly<Record<string, FixPattern>> = Object.freeze({
  'reconcile-through-status': {
    id: 'reconcile-through-status',
    title: 'Reconcile through status',
    invariants: ['INV-03', 'INV-05', 'INV-06', 'INV-08'],
    remediationCodes: ['RECONCILE_BEFORE_RETRY', 'COMPLETE_RECONCILIATION'],
    problem:
      'The client stops after a deposit submission (answered, slow, or failed) without reading the order to a terminal status, so the outcome stays unknown.',
    rule: 'After every deposit submission, read getExecutionStatus(depositAddress) of the same order until SUCCESS, REFUNDED or FAILED. If the submission failed without a usable answer, first wait for reconciliation-only authority, then read status. Never resubmit.',
    before: [
      'try {',
      '  await OneClickService.submitDepositTx({ txHash, depositAddress });',
      "  return 'SUBMITTED';",
      '} catch {',
      "  return 'FAILED'; // outcome unknown, never reconciled",
      '}',
    ].join('\n'),
    after: [
      "const TERMINAL = new Set(['SUCCESS', 'REFUNDED', 'FAILED']);",
      'const answered = await OneClickService.submitDepositTx({ txHash, depositAddress }).then(',
      '  () => true,',
      '  () => false,',
      ');',
      'if (!answered) await reconciliationAuthority(); // outcome unknown: read-only from here on',
      'let status = await OneClickService.getExecutionStatus(depositAddress);',
      'while (!TERMINAL.has(status.status)) {',
      '  status = await OneClickService.getExecutionStatus(depositAddress);',
      '}',
      'return status.status;',
    ].join('\n'),
  },
  'no-second-order-while-unanswered': {
    id: 'no-second-order-while-unanswered',
    title: 'No second order while the first is unanswered',
    invariants: ['INV-03'],
    remediationCodes: ['RECONCILE_BEFORE_RETRY'],
    problem:
      'On a slow or failed deposit submission the client asks for a fresh quote and submits a second deposit. That is a second order placed while the first one may already be accepted.',
    rule: 'A slow deposit submission is not a slow read. Do not race it with a new quote or a new submission. Keep the one order you have and reconcile it through status (see reconcile-through-status).',
    before: [
      "const slow = await Promise.race([submission, sleep(750).then(() => 'SLOW')]);",
      "if (slow === 'SLOW') {",
      '  const retry = await OneClickService.getQuote(quoteRequest); // a second order',
      '  await OneClickService.submitDepositTx({ txHash: retryTx, depositAddress: retry.quote.depositAddress });',
      '}',
    ].join('\n'),
    after: [
      "const slow = await Promise.race([submission, sleep(750).then(() => 'SLOW')]);",
      '// Slow or not: read the existing order until it is terminal; never place a second one.',
      'let status = await OneClickService.getExecutionStatus(depositAddress);',
      'while (!TERMINAL.has(status.status)) {',
      '  status = await OneClickService.getExecutionStatus(depositAddress);',
      '}',
      "if (slow === 'SLOW') await submission;",
    ].join('\n'),
  },
  'exact-retry-same-order': {
    id: 'exact-retry-same-order',
    title: 'Exact retry of the same order (idempotency key)',
    invariants: ['INV-01', 'INV-02', 'INV-07'],
    remediationCodes: ['ISOLATE_OPERATION_SCOPE', 'CONSUME_EVIDENCE_ONCE'],
    problem:
      'A retry changes the order: a new order key, a fresh quote, a different body, or the same deposit transaction reused for a second order.',
    rule: 'Key every order by one stable logical job id. A retry of a request that was answered with a transport error repeats it byte for byte (same quote request, same deposit address, same txHash) under that id; anything else is a new order and needs its own deposit.',
    before: [
      'adapter.setLogicalJob(`${orderId}:retry-${attempt}`); // new key per attempt',
      'const q = await OneClickService.getQuote({ ...quoteRequest, deadline: newDeadline() });',
    ].join('\n'),
    after: [
      'adapter.setLogicalJob(orderId); // one key for the whole order',
      'const q = await OneClickService.getQuote(quoteRequest); // identical body on an exact retry',
    ].join('\n'),
  },
  'release-effects-after-success': {
    id: 'release-effects-after-success',
    title: 'Release effects only after SUCCESS',
    invariants: ['INV-04'],
    remediationCodes: ['GATE_EFFECT_ON_ACCEPTED_COMPLETION'],
    problem:
      'The client fulfils the order (ships goods, grants access) right after submitting the deposit, or on a non-terminal status.',
    rule: 'Fulfil only after the order reads SUCCESS, and retry a fulfilment the boundary has not released yet instead of treating a denial as done. INV-04 is judged only in contained runs.',
    before: [
      'await OneClickService.submitDepositTx({ txHash, depositAddress });',
      'await fulfil(order); // released before completion evidence',
    ].join('\n'),
    after: [
      'const final = await reconcileUntilTerminal(depositAddress);',
      "if (final === 'SUCCESS') await fulfil(order);",
    ].join('\n'),
  },
});

/** Fix patterns that answer a kernel remediation code. */
export const PATTERNS_FOR_REMEDIATION: Readonly<Record<string, readonly string[]>> = Object.freeze({
  RECONCILE_BEFORE_RETRY: ['no-second-order-while-unanswered', 'reconcile-through-status'],
  COMPLETE_RECONCILIATION: ['reconcile-through-status'],
  RECONCILE_VALUE_LEGS: ['reconcile-through-status'],
  REQUIRE_PROVEN_EVIDENCE: ['reconcile-through-status'],
  GATE_EFFECT_ON_ACCEPTED_COMPLETION: ['release-effects-after-success'],
  ISOLATE_OPERATION_SCOPE: ['exact-retry-same-order'],
  CONSUME_EVIDENCE_ONCE: ['exact-retry-same-order'],
});

export function normalizeInvariantId(raw: string): string | null {
  const m = /^\s*INV[-_ ]?0?([1-9])\s*$/i.exec(raw);
  return m === null ? null : `INV-0${m[1] as string}`;
}

export interface InvariantExplanation extends InvariantInfo {
  readonly kernelCodes: ReadonlyArray<{
    readonly code: string;
    readonly verdict: string;
    readonly text: string;
  }>;
  readonly remediations: ReadonlyArray<{ readonly code: string; readonly text: string }>;
}

export function explainInvariant(id: string): InvariantExplanation | null {
  const info = INVARIANTS[id];
  if (info === undefined) return null;
  const prefix = `INV0${id.slice(-1)}_`;
  const kernelCodes = Object.entries(EXPLANATIONS)
    .filter(([code]) => code.startsWith(prefix))
    .map(([code, spec]) => ({ code, verdict: spec.verdict, text: spec.template }));
  const remediationCodes = new Set(info.fixPatterns.flatMap((p) => FIX_PATTERNS[p]?.remediationCodes ?? []));
  const remediations = [...remediationCodes].map((code) => ({
    code,
    text: (REMEDIATIONS as Record<string, string>)[code] ?? '',
  }));
  return { ...info, kernelCodes, remediations };
}

export function explanationText(code: string | null): string | null {
  if (code === null) return null;
  return (EXPLANATIONS as Record<string, { template: string }>)[code]?.template ?? null;
}

export function remediationText(code: string | null): string | null {
  if (code === null) return null;
  return (REMEDIATIONS as Record<string, string>)[code] ?? null;
}
