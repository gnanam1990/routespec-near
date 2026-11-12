/**
 * Installed subject build "baseline": a naive integration of the official SDK.
 *
 * When the deposit submission gets no usable answer it resubmits once more and then gives up,
 * reporting a local failure. It never reconciles the outcome through the read-only status
 * route, so an accepted-then-lost commit is left unresolved. When it has a fulfilment sink it
 * fulfils the order right after submitting, whatever the outcome (an unsafe early release).
 */
import { deliverEffect, runSubject, type EffectAttempt, type Job } from './runtime.ts';

const job: Job = async (ctx, request) => {
  const quote = await ctx.sdk.OneClickService.getQuote(request.quote);
  const depositAddress = String(quote.quote.depositAddress);
  const attempts: Array<{ status: number | null; code: string | null }> = [];
  const fulfil = async (): Promise<EffectAttempt[]> =>
    request.effectSink ? [await deliverEffect(request.effectSink, `${request.logicalJob}:fulfilment`)] : [];
  for (let i = 0; i < 2; i++) {
    try {
      await ctx.sdk.OneClickService.submitDepositTx({ txHash: request.txHash, depositAddress });
      return { result: 'SUBMITTED', depositAddress, attempts, fulfilment: await fulfil() };
    } catch (error) {
      attempts.push(ctx.errorOf(error));
    }
  }
  return { result: 'GAVE_UP', depositAddress, attempts, fulfilment: await fulfil() };
};

runSubject(job);
