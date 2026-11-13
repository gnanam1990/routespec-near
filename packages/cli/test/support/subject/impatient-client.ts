/**
 * Installed subject build "impatient": an integration of the official SDK that stops reading the
 * execution status after three reads, whether or not the service has reported a terminal status.
 * A swap that settles later is never seen to settle by this client.
 */
import { runSubject, type Job } from './runtime.ts';

const TERMINAL = new Set(['SUCCESS', 'REFUNDED', 'FAILED']);
const PATIENCE = 3;

const job: Job = async (ctx, request) => {
  const quote = await ctx.sdk.OneClickService.getQuote(request.quote);
  const depositAddress = String(quote.quote.depositAddress);
  await ctx.sdk.OneClickService.submitDepositTx({ txHash: request.txHash, depositAddress });
  const statuses: string[] = [];
  for (let i = 0; i < PATIENCE; i++) {
    const s = await ctx.sdk.OneClickService.getExecutionStatus(depositAddress);
    statuses.push(s.status);
    if (TERMINAL.has(s.status)) return { result: 'SUBMITTED', statuses };
  }
  return { result: 'GAVE_UP', statuses };
};

runSubject(job);
