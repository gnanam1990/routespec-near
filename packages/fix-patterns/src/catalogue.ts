/**
 * The closed fix-pattern catalogue (M53).
 *
 * A fix pattern is a concrete client-code pattern for a 1Click integration. Each violated
 * invariant result (an explanation code from the kernel) links to the patterns that remove that
 * failure in client code. Codes that describe RouteSpec's own harness, evidence, or
 * configuration (for example a missing interceptor or weak evidence) have no client pattern and
 * keep only their remediation text.
 *
 * Patterns are advisory text. They are never part of a verdict, a result digest, or a gate
 * decision.
 */

export const FIX_PATTERNS_REVISION = 'routespec-fix-patterns@1.0.0' as const;

export type FixPatternId =
  | 'RECONCILE_THROUGH_STATUS'
  | 'IDEMPOTENCY_KEY'
  | 'NO_SECOND_ORDER_WHILE_UNANSWERED';

export interface FixPattern {
  readonly id: FixPatternId;
  readonly title: string;
  /** One sentence: the rule the client code follows. */
  readonly rule: string;
  /** Why the rule exists, in plain words. */
  readonly why: string;
  /** Concrete steps in client code. */
  readonly steps: readonly string[];
  /** A short, self-contained TypeScript example against the official 1Click SDK. */
  readonly example: string;
}

const pattern = (p: FixPattern): FixPattern => Object.freeze({ ...p, steps: Object.freeze([...p.steps]) });

export const FIX_PATTERNS: Readonly<Record<FixPatternId, FixPattern>> = Object.freeze({
  RECONCILE_THROUGH_STATUS: pattern({
    id: 'RECONCILE_THROUGH_STATUS',
    title: 'Reconcile through status',
    rule: 'When a deposit submission has no usable answer, treat its outcome as unknown and read the execution status of the same deposit address until SUCCESS, REFUNDED, or FAILED.',
    why: 'An error or a timeout on submitDepositTx does not mean the order failed: the service may have accepted it. Only the status of that deposit address tells you what happened.',
    steps: [
      'Catch the error of submitDepositTx, but do not treat it as a failure and do not resubmit.',
      'Call getExecutionStatus with the deposit address of the order you already submitted.',
      'Keep reading (with a back-off) until a terminal status: SUCCESS, REFUNDED, or FAILED. A poll count or a read error is not an outcome.',
      'Act on the terminal status (fulfil only on SUCCESS).',
    ],
    example: [
      "const TERMINAL = new Set(['SUCCESS', 'REFUNDED', 'FAILED']);",
      'try {',
      '  await OneClickService.submitDepositTx({ txHash, depositAddress });',
      '} catch {',
      '  // Outcome unknown: do not resubmit.',
      '}',
      'for (let attempt = 0; ; attempt++) {',
      '  const { status } = await OneClickService.getExecutionStatus(depositAddress);',
      '  if (TERMINAL.has(status)) break;',
      '  await new Promise((r) => setTimeout(r, Math.min(250 * 2 ** attempt, 5_000)));',
      '}',
    ].join('\n'),
  }),
  IDEMPOTENCY_KEY: pattern({
    id: 'IDEMPOTENCY_KEY',
    title: 'One idempotency key per order',
    rule: 'Give each logical order one key, one quote, one deposit address, and one deposit transaction; a retry of that order reuses the same key and the same deposit address.',
    why: 'A new key or a new quote for the same order turns a retry into a second order, so the same intent can be paid twice.',
    steps: [
      'Derive the order key from your own order (for example the order id), not from the attempt.',
      'Store the quote and deposit address with that key before submitting.',
      'On a retry, look the order up by its key and reuse its deposit address; never request a fresh quote for it.',
    ],
    example: [
      'const order = await orders.get(orderId); // persisted before the first submit',
      'const depositAddress = order.depositAddress; // the same address on every retry',
      'await OneClickService.submitDepositTx({ txHash: order.txHash, depositAddress });',
    ].join('\n'),
  }),
  NO_SECOND_ORDER_WHILE_UNANSWERED: pattern({
    id: 'NO_SECOND_ORDER_WHILE_UNANSWERED',
    title: 'No second order while the first is unanswered',
    rule: 'Never request a new quote or submit another deposit for the same intent while an earlier deposit submission has no answer.',
    why: 'A deposit submission is a mutation, not a read. Hedging or racing it places a second order; if the first one also settles, the user pays twice.',
    steps: [
      'Do not race, hedge, or time out a submitDepositTx into a fresh quote and a second submission.',
      'While the first submission is unanswered, only read its status.',
      'Start a new order only after the first one reached REFUNDED or FAILED.',
    ],
    example: [
      'await OneClickService.submitDepositTx({ txHash, depositAddress }).catch(() => undefined);',
      '// No fresh quote here: reconcile the first order instead.',
      'const { status } = await OneClickService.getExecutionStatus(depositAddress);',
    ].join('\n'),
  }),
});

/**
 * Kernel explanation codes (FAIL or REVIEW) that a client code pattern addresses, in the order
 * the patterns should be read. Codes not listed have no client code pattern.
 */
export const CODE_PATTERNS: Readonly<Record<string, readonly FixPatternId[]>> = Object.freeze({
  INV02_BINDING_INCONSISTENT: Object.freeze(['IDEMPOTENCY_KEY'] as const),
  INV03_SECOND_MUTATION_UNDER_UNCERTAINTY: Object.freeze([
    'NO_SECOND_ORDER_WHILE_UNANSWERED',
    'RECONCILE_THROUGH_STATUS',
    'IDEMPOTENCY_KEY',
  ] as const),
  INV03_RECONCILIATION_INCOMPLETE: Object.freeze(['RECONCILE_THROUGH_STATUS'] as const),
  INV03_RETRY_JOINED_BEFORE_FENCE: Object.freeze(['IDEMPOTENCY_KEY', 'RECONCILE_THROUGH_STATUS'] as const),
  INV05_OUTCOME_UNDETERMINED: Object.freeze(['RECONCILE_THROUGH_STATUS'] as const),
  INV06_TERMINAL_NOT_REACHED: Object.freeze(['RECONCILE_THROUGH_STATUS'] as const),
  INV07_EVIDENCE_REUSED: Object.freeze(['IDEMPOTENCY_KEY'] as const),
});

export function patternsForCode(explanationCode: string): readonly FixPattern[] {
  return (CODE_PATTERNS[explanationCode] ?? []).map((id) => FIX_PATTERNS[id]);
}

export function listFixPatterns(): readonly FixPattern[] {
  return Object.values(FIX_PATTERNS);
}

export function getFixPattern(id: string): FixPattern | null {
  return Object.hasOwn(FIX_PATTERNS, id) ? FIX_PATTERNS[id as FixPatternId] : null;
}
