/**
 * Installed subject build "corrected": the genuine client fix for an unknown commit outcome.
 *
 * A deposit submission without a usable answer is treated as outcome-unknown: the client never
 * resubmits it. It waits for reconciliation authority and then reads the execution status of
 * the already bound deposit address until a terminal status is reported. It fulfils the order
 * (its protected effect) only after SUCCESS, and retries a fulfilment the boundary has not
 * released yet instead of treating a denial as done.
 */
import { deliverEffect, runSubject, type EffectAttempt, type Job } from './runtime.ts';

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
  const fulfilment: EffectAttempt[] = [];
  if (request.effectSink && statuses[statuses.length - 1] === 'SUCCESS') {
    for (let i = 0; i < 20; i++) {
      const a = await deliverEffect(request.effectSink, `${request.logicalJob}:fulfilment`);
      fulfilment.push(a);
      if (a.released || a.status !== 409) break;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  return { result: submitted ? 'SUBMITTED' : 'RECONCILED', depositAddress, statuses, fulfilment };
};

runSubject(job);
