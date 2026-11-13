/**
 * Demo client, before the fix: a typical first integration of the official 1Click SDK.
 *
 * It treats a slow deposit submission like a slow read: when the submission has not answered
 * within 750 ms it "retries" by asking for a fresh quote and submitting a second deposit. A
 * deposit submission is a mutation, so that retry is a second order placed while the first
 * order's outcome is unknown. When the submission fails outright it gives up without ever
 * reading the order's status.
 */
import type { ClientJob } from '../../../packages/mcp/src/subject/runtime.ts';

const RETRY_AFTER_MS = 750;

const swap: ClientJob = async (ctx, request) => {
  const quote = await ctx.sdk.OneClickService.getQuote(request.quote);
  const depositAddress = String(quote.quote.depositAddress);
  const submission = ctx.sdk.OneClickService.submitDepositTx({
    txHash: request.txHash,
    depositAddress,
  }) as Promise<unknown> & { cancel?: () => void };
  const first = submission.then(
    () => 'ANSWERED' as const,
    () => 'ERROR' as const,
  );
  const raced = await Promise.race([
    first,
    new Promise<'SLOW'>((r) => setTimeout(() => r('SLOW'), RETRY_AFTER_MS)),
  ]);
  if (raced === 'ANSWERED') return { result: 'SUBMITTED', depositAddress };
  if (raced === 'ERROR') return { result: 'FAILED', depositAddress };

  // Slow answer: retry with a fresh quote and a second deposit submission.
  ctx.adapter.setLogicalJob(`${request.logicalJob}:retry`);
  const retryQuote = await ctx.sdk.OneClickService.getQuote(request.quote);
  const retryAddress = String(retryQuote.quote.depositAddress);
  try {
    await ctx.sdk.OneClickService.submitDepositTx({
      txHash: `${request.txHash}-retry`,
      depositAddress: retryAddress,
    });
  } catch {
    // ignore: the first submission may still answer
  }
  // Keep the retry and drop the slow first submission.
  submission.cancel?.();
  return { result: 'RETRIED', depositAddress, retryDepositAddress: retryAddress };
};

export default swap;
