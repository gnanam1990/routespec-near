/**
 * Installed subject build "hedging" (M53): the M05 hedging build without a fulfilment sink.
 *
 * It treats a slow deposit submission like a slow read: when the submission has not answered
 * within HEDGE_AFTER_MS it requests a fresh quote under a new order key and submits that deposit
 * too, then cancels the slow one. A deposit submission is a mutation, so the hedge is a second
 * order placed while the first one's outcome is still unknown. It never reads the status of the
 * first order.
 */
import { runSubject, type Job } from './runtime.ts';

const HEDGE_AFTER_MS = 750;

type Cancelable = Promise<unknown> & { cancel?: () => void };

const job: Job = async (ctx, request) => {
  const quote = await ctx.sdk.OneClickService.getQuote(request.quote);
  const depositAddress = String(quote.quote.depositAddress);
  const first = ctx.sdk.OneClickService.submitDepositTx({
    txHash: request.txHash,
    depositAddress,
  }) as Cancelable;
  const firstSettled = first.then(
    () => 'ANSWERED' as const,
    () => 'ERROR' as const,
  );
  const raced = await Promise.race([
    firstSettled,
    new Promise<'SLOW'>((r) => setTimeout(() => r('SLOW'), HEDGE_AFTER_MS)),
  ]);
  if (raced !== 'SLOW') {
    return { result: raced === 'ANSWERED' ? 'SUBMITTED' : 'FAILED', depositAddress };
  }
  // The hedge: a fresh order key, a fresh quote, and a second deposit submission.
  ctx.adapter.setLogicalJob(`${request.logicalJob}:hedge`);
  const hedgeQuote = await ctx.sdk.OneClickService.getQuote(request.quote);
  const hedgeAddress = String(hedgeQuote.quote.depositAddress);
  let hedge: { status: number | null; code: string | null } = { status: 200, code: null };
  try {
    await ctx.sdk.OneClickService.submitDepositTx({
      txHash: `${request.txHash}-hedge`,
      depositAddress: hedgeAddress,
    });
  } catch (error) {
    hedge = ctx.errorOf(error);
  }
  // Keep the hedge, cancel the slow first submission.
  first.cancel?.();
  await firstSettled;
  return {
    result: 'HEDGED',
    depositAddress,
    hedgeDepositAddress: hedgeAddress,
    attempts: [hedge],
  };
};

runSubject(job);
