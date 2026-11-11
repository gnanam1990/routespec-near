/**
 * Installed subject build "naive": when a deposit submission gets no usable answer it resubmits
 * once and then gives up without reconciling; an accepted-then-lost commit stays unresolved.
 * When the submission is answered it polls the execution status like any client.
 */
import { runSubject, type Job } from './runtime.ts';

const TERMINAL = new Set(['SUCCESS', 'REFUNDED', 'FAILED']);

const job: Job = async (ctx, request) => {
  const quote = await ctx.sdk.OneClickService.getQuote(request.quote);
  const depositAddress = String(quote.quote.depositAddress);
  for (let i = 0; i < 2; i++) {
    try {
      await ctx.sdk.OneClickService.submitDepositTx({ txHash: request.txHash, depositAddress });
      const statuses: string[] = [];
      for (let j = 0; j < 8; j++) {
        const s = await ctx.sdk.OneClickService.getExecutionStatus(depositAddress);
        statuses.push(s.status);
        if (TERMINAL.has(s.status)) break;
      }
      return { result: 'SUBMITTED', statuses };
    } catch {
      // resubmit once without reconciling
    }
  }
  return { result: 'GAVE_UP' };
};

runSubject(job);
