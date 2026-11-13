# RouteSpec fix patterns

Gate run `13af4222-19e0-4bcf-afe3-344171f7f8ac`, decision **FAIL**.

> Advisory. Fix patterns and the suggested diff are not applied, compiled, or run by RouteSpec and are not part of any verdict or decision digest. Rerun the gate on the changed build to get a verdict.

## Violated invariants

- Case 0: **INV-03 FAIL** `INV03_SECOND_MUTATION_UNDER_UNCERTAINTY`. A mutation was accepted while a commit outcome was still unknown, before reconciliation reached a terminal result.
  - Fix pattern: No second order while the first is unanswered; Reconcile through status; One idempotency key per order. Remediation: Reconcile the existing run operation read-only until a terminal result before any new mutation.
- Case 0: **INV-04 REVIEW** (not required) `INV04_DECLARED_HOOKS_ONLY`. Declared hooks only — REVIEW. Subject-reported hooks do not prove coverage.
  - Fix pattern: none in client code. Remediation: Run an attested independent boundary interceptor that confines the subject process tree and covers every required sink.
- Case 0: **INV-05 REVIEW** `INV05_LEG_MISSING`. A required value leg is missing or weakly evidenced; conservation cannot be proven.
  - Fix pattern: none in client code. Remediation: Account for every origin-asset leg in base units and meet the quoted destination constraint.
- Case 0: **INV-06 REVIEW** `INV06_TERMINAL_NOT_REACHED`. A committed operation never reached an accepted terminal status.
  - Fix pattern: Reconcile through status. Remediation: Continue read-only reconciliation of the existing run operation to an accepted terminal result.
- Case 0: **INV-08 REVIEW** `INV08_REQUIRED_EVIDENCE_WEAK`. A required predicate has only weak, reported, private, stale, or unsupported evidence.
  - Fix pattern: none in client code. Remediation: Supply evidence in the declared acceptable class and scope for each required predicate.

## No second order while the first is unanswered

Violated: INV-03.

Never request a new quote or submit another deposit for the same intent while an earlier deposit submission has no answer.

A deposit submission is a mutation, not a read. Hedging or racing it places a second order; if the first one also settles, the user pays twice.

1. Do not race, hedge, or time out a submitDepositTx into a fresh quote and a second submission.
1. While the first submission is unanswered, only read its status.
1. Start a new order only after the first one reached REFUNDED or FAILED.

Found in `packages/cli/test/support/subject/hedging-client.ts`:

- line 35: The order key is changed after the first deposit submission. ``ctx.adapter.setLogicalJob(`${request.logicalJob}:hedge`)``
- line 36: A second getQuote call site after a deposit submission: a fresh quote for the same intent. `ctx.sdk.OneClickService.getQuote(request.quote)`
- line 40: A second submitDepositTx call site in the same function: a second deposit for one intent. ``ctx.sdk.OneClickService.submitDepositTx({ txHash: `${request.txHash}-hedge`, depositAddress: hedgeAddress, })``

```ts
await OneClickService.submitDepositTx({ txHash, depositAddress }).catch(() => undefined);
// No fresh quote here: reconcile the first order instead.
const { status } = await OneClickService.getExecutionStatus(depositAddress);
```

## Reconcile through status

Violated: INV-03, INV-06.

When a deposit submission has no usable answer, treat its outcome as unknown and read the execution status of the same deposit address until SUCCESS, REFUNDED, or FAILED.

An error or a timeout on submitDepositTx does not mean the order failed: the service may have accepted it. Only the status of that deposit address tells you what happened.

1. Catch the error of submitDepositTx, but do not treat it as a failure and do not resubmit.
1. Call getExecutionStatus with the deposit address of the order you already submitted.
1. Keep reading (with a back-off) until a terminal status: SUCCESS, REFUNDED, or FAILED. A poll count or a read error is not an outcome.
1. Act on the terminal status (fulfil only on SUCCESS).

Found in `packages/cli/test/support/subject/hedging-client.ts`:

- line 19: This function submits a deposit but never calls getExecutionStatus. `ctx.sdk.OneClickService.submitDepositTx({ txHash: request.txHash, depositAddress, })`

```ts
const TERMINAL = new Set(['SUCCESS', 'REFUNDED', 'FAILED']);
try {
  await OneClickService.submitDepositTx({ txHash, depositAddress });
} catch {
  // Outcome unknown: do not resubmit.
}
for (let attempt = 0; ; attempt++) {
  const { status } = await OneClickService.getExecutionStatus(depositAddress);
  if (TERMINAL.has(status)) break;
  await new Promise((r) => setTimeout(r, Math.min(250 * 2 ** attempt, 5_000)));
}
```

## One idempotency key per order

Violated: INV-03.

Give each logical order one key, one quote, one deposit address, and one deposit transaction; a retry of that order reuses the same key and the same deposit address.

A new key or a new quote for the same order turns a retry into a second order, so the same intent can be paid twice.

1. Derive the order key from your own order (for example the order id), not from the attempt.
1. Store the quote and deposit address with that key before submitting.
1. On a retry, look the order up by its key and reuse its deposit address; never request a fresh quote for it.

Found in `packages/cli/test/support/subject/hedging-client.ts`:

- line 35: The order key is changed after the first deposit submission. ``ctx.adapter.setLogicalJob(`${request.logicalJob}:hedge`)``
- line 36: A second getQuote call site after a deposit submission: a fresh quote for the same intent. `ctx.sdk.OneClickService.getQuote(request.quote)`
- line 40: A second submitDepositTx call site in the same function: a second deposit for one intent. ``ctx.sdk.OneClickService.submitDepositTx({ txHash: `${request.txHash}-hedge`, depositAddress: hedgeAddress, })``

```ts
const order = await orders.get(orderId); // persisted before the first submit
const depositAddress = order.depositAddress; // the same address on every retry
await OneClickService.submitDepositTx({ txHash: order.txHash, depositAddress });
```

## SDK usage found

`packages/cli/test/support/subject/hedging-client.ts` (sha256:2c71a7f00551fef41cdf78ffb4b98cb7b8d552a706e64d73c0f5e64f0b6778bd)

- line 17: `getQuote` on `ctx.sdk.OneClickService`
- line 19: `submitDepositTx` on `ctx.sdk.OneClickService`
- line 36: `getQuote` on `ctx.sdk.OneClickService`
- line 40: `submitDepositTx` on `ctx.sdk.OneClickService`

## Suggested diff

- lines 35-46: 4 statement(s) that place or use a second order are removed; the first order is reconciled through status on its own deposit address. The returned object no longer carries the second order and gains terminalStatus.

Patched text parse errors: 0 (syntax only; not type-checked or run).

```diff
--- a/packages/cli/test/support/subject/hedging-client.ts
+++ b/packages/cli/test/support/subject/hedging-client.ts
@@ -9,6 +9,24 @@
  */
 import { runSubject, type Job } from './runtime.ts';

+const RECONCILE_TERMINAL_STATUSES = new Set(['SUCCESS', 'REFUNDED', 'FAILED']);
+
+/** Reconcile through status: read the status of the same deposit address until it is terminal. */
+async function reconcileThroughStatus(
+  service: { getExecutionStatus(depositAddress: string): Promise<{ status: string }> },
+  depositAddress: string,
+): Promise<string> {
+  for (let attempt = 0; ; attempt++) {
+    try {
+      const { status } = await service.getExecutionStatus(depositAddress);
+      if (RECONCILE_TERMINAL_STATUSES.has(status)) return status;
+    } catch {
+      // A failed status read is not an outcome: keep reconciling.
+    }
+    await new Promise((resolve) => setTimeout(resolve, Math.min(250 * 2 ** attempt, 5_000)));
+  }
+}
+
 const HEDGE_AFTER_MS = 750;

 type Cancelable = Promise<unknown> & { cancel?: () => void };
@@ -31,28 +49,14 @@
   if (raced !== 'SLOW') {
     return { result: raced === 'ANSWERED' ? 'SUBMITTED' : 'FAILED', depositAddress };
   }
-  // The hedge: a fresh order key, a fresh quote, and a second deposit submission.
-  ctx.adapter.setLogicalJob(`${request.logicalJob}:hedge`);
+  // One order per intent: never place a second order while the first is unanswered.
+  // Reconcile the first order through status on its own deposit address instead.
+  const terminalStatus = await reconcileThroughStatus(ctx.sdk.OneClickService, depositAddress);
-  const hedgeQuote = await ctx.sdk.OneClickService.getQuote(request.quote);
-  const hedgeAddress = String(hedgeQuote.quote.depositAddress);
   let hedge: { status: number | null; code: string | null } = { status: 200, code: null };
-  try {
-    await ctx.sdk.OneClickService.submitDepositTx({
-      txHash: `${request.txHash}-hedge`,
-      depositAddress: hedgeAddress,
-    });
-  } catch (error) {
-    hedge = ctx.errorOf(error);
-  }
   // Keep the hedge, cancel the slow first submission.
   first.cancel?.();
   await firstSettled;
-  return {
-    result: 'HEDGED',
-    depositAddress,
-    hedgeDepositAddress: hedgeAddress,
-    attempts: [hedge],
-  };
+  return { result: 'HEDGED', depositAddress, attempts: [hedge], terminalStatus };
 };

 runSubject(job);
```
