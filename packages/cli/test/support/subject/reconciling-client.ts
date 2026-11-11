/**
 * Installed subject build "reconciling": an integration of the official SDK that treats a
 * deposit submission without a usable answer as outcome-unknown. It never resubmits; it waits
 * for reconciliation authority and then reads the execution status of the already bound
 * deposit address until a terminal status is reported.
 */
import { runSubject, type Job } from './runtime.ts';

const TERMINAL = new Set(['SUCCESS', 'REFUNDED', 'FAILED']);

const job: Job = async (ctx, request) => {
  const quote = await ctx.sdk.OneClickService.getQuote(request.quote);
  const depositAddress = String(quote.quote.depositAddress);
  let submitted = true;
  try {
    await ctx.sdk.OneClickService.submitDepositTx({ txHash: request.txHash, depositAddress });
  } catch {
    submitted = false;
    await ctx.reconciliationAuthority();
  }
  const statuses: string[] = [];
  for (let i = 0; i < 8; i++) {
    const s = await ctx.sdk.OneClickService.getExecutionStatus(depositAddress);
    statuses.push(s.status);
    if (TERMINAL.has(s.status)) break;
  }
  return { result: submitted ? 'SUBMITTED' : 'RECONCILED', statuses };
};

runSubject(job);
