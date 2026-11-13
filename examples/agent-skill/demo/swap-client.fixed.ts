/**
 * Demo client, after the fix: the reconcile pattern.
 *
 * A deposit submission that has not answered, or that failed without a usable answer, has an
 * unknown outcome. The client never places a second order for it. It reconciles the order it
 * already has, read-only, by polling the execution status of the same deposit address until a
 * terminal status (SUCCESS, REFUNDED, FAILED). After a lost answer it first waits for the
 * reconciliation-only authority that RouteSpec issues.
 */
import type { ClientJob } from '../../../packages/mcp/src/subject/runtime.ts';

const SLOW_AFTER_MS = 750;
const TERMINAL = new Set(['SUCCESS', 'REFUNDED', 'FAILED']);

const swap: ClientJob = async (ctx, request) => {
  const quote = await ctx.sdk.OneClickService.getQuote(request.quote);
  const depositAddress = String(quote.quote.depositAddress);
  const submission = ctx.sdk.OneClickService.submitDepositTx({ txHash: request.txHash, depositAddress }).then(
    () => 'ANSWERED' as const,
    () => 'ERROR' as const,
  );
  const first = await Promise.race([
    submission,
    new Promise<'SLOW'>((r) => setTimeout(() => r('SLOW'), SLOW_AFTER_MS)),
  ]);
  // Outcome unknown after an error: wait for reconciliation-only authority, never resubmit.
  if (first === 'ERROR') await ctx.reconciliationAuthority();

  // Reconcile through status: read the existing order until it is terminal.
  const statuses: string[] = [];
  for (let i = 0; i < 8; i++) {
    const s = await ctx.sdk.OneClickService.getExecutionStatus(depositAddress);
    statuses.push(s.status);
    if (TERMINAL.has(s.status)) break;
  }
  if (first === 'SLOW') await submission;
  return { result: first === 'ERROR' ? 'RECONCILED' : 'SUBMITTED', depositAddress, statuses };
};

export default swap;
