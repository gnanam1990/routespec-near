# Recorded coding agent session: RouteSpec gate, fix, gate

Recorded by `examples/agent-skill/demo/agent-session.ts`. The agent part (what to call and
the edit) is scripted; the MCP server, the gate runs, the official SDK client processes and
every verdict are real. Durations, identifiers and digests are those of this recording.

Result: first run **FAIL**, run after the fix **PASS**.

Connected to MCP server `routespec` 0.1.0.

> The task changed `swap-client.ts`, which calls the 1Click SDK. The skill says: run the gate before shipping.

**Agent → `run_gate`** `{"client":"swap-client.ts"}`  
_2808 ms_

```text
Gate FAIL for swap-client.ts (run-1).

{
  "runId": "run-1",
  "client": "swap-client.ts",
  "decision": "FAIL",
  "exitCode": 2,
  "artifactDigest": "sha256:01d9fbdaeddb0f0c8c234bdb234fd75a604daa9c0f4debe10502a5b08dc689f3",
  "decisionDigest": "sha256:b005a4af2f03f89e03723f158d4948921cf18cdc9f43e162ac9226b024aaeeac",
  "counts": {
    "total": 3,
    "required": 3,
    "pass": 0,
    "fail": 1,
    "review": 2,
    "notRun": 0,
    "unsupported": 0
  },
  "cases": [
    {
      "ordinal": 0,
      "scenario": "happy-path",
      "contribution": "REVIEW",
      "failing": [
        "INV-06:REVIEW"
      ],
      "clientError": null
    },
    {
      "ordinal": 1,
      "scenario": "accepted-then-lost-response",
      "contribution": "REVIEW",
      "failing": [
        "INV-03:REVIEW",
        "INV-06:REVIEW"
      ],
      "clientError": null
    },
    {
      "ordinal": 2,
      "scenario": "slow-deposit-answer",
      "contribution": "FAIL",
      "failing": [
        "INV-03:FAIL",
        "INV-05:REVIEW",
        "INV-06:REVIEW",
        "INV-08:REVIEW"
      ],
      "clientError": null
    }
  ],
  "gateFindings": [
    "BUILD_USER_ASSERTED_LOCAL"
  ],
  "requiredInvariants": [
    "INV-01",
    "INV-02",
    "INV-03",
    "INV-05",
    "INV-06",
    "INV-07",
    "INV-08"
  ],
  "containment": "UNCONTAINED_DECLARED_HOOKS_ONLY",
  "evidenceUse": "DIAGNOSTIC_ONLY",
  "durationMs": 2806,
  "error": null,
  "next": "Call list_findings for the violated invariants and the fix patterns."
}
```

> The gate says FAIL. Listing the findings.

**Agent → `list_findings`** `{}`  
_9 ms_

```text
Gate FAIL (run-1): 7 finding(s). Fix patterns to apply: no-second-order-while-unanswered, reconcile-through-status.

{
  "runId": "run-1",
  "client": "swap-client.ts",
  "artifactDigest": "sha256:01d9fbdaeddb0f0c8c234bdb234fd75a604daa9c0f4debe10502a5b08dc689f3",
  "decision": "FAIL",
  "gateFindings": [
    "BUILD_USER_ASSERTED_LOCAL"
  ],
  "cases": [
    {
      "ordinal": 0,
      "scenario": "happy-path",
      "contribution": "REVIEW",
      "caseFindings": [
        "CASE_REVIEW",
        "EVIDENCE_REASON:MISSING",
        "INVARIANT_REVIEW:INV-06",
        "MISSING:INV-06:ACCEPTED_TERMINAL_STATUS"
      ],
      "invariants": [
        {
          "invariantId": "INV-06",
          "title": "Terminal outcomes do not regress",
          "verdict": "REVIEW",
          "explanationCode": "INV06_TERMINAL_NOT_REACHED",
          "explanation": "A committed operation never reached an accepted terminal status.",
          "remediationCode": "COMPLETE_RECONCILIATION",
          "remediation": "Continue read-only reconciliation of the existing run operation to an accepted terminal result.",
          "missingPredicates": [
            "ACCEPTED_TERMINAL_STATUS"
          ],
          "occurrences": 1,
          "fixPatterns": [
            "reconcile-through-status"
          ]
        }
      ],
      "clientOutcome": {
        "result": "SUBMITTED",
        "depositAddress": "sim-deposit-b52c944f6e426ded6475"
      },
      "clientError": null
    },
    {
      "ordinal": 1,
      "scenario": "accepted-then-lost-response",
      "contribution": "REVIEW",
      "caseFindings": [
        "CASE_REVIEW",
        "EVIDENCE_REASON:MISSING",
        "INVARIANT_REVIEW:INV-03",
        "INVARIANT_REVIEW:INV-06",
        "MISSING:INV-03:ACCEPTED_TERMINAL_STATUS",
        "MISSING:INV-06:ACCEPTED_TERMINAL_STATUS"
      ],
      "invariants": [
        {
          "invariantId": "INV-03",
          "title": "Reconcile before retry under uncertainty",
          "verdict": "REVIEW",
          "explanationCode": "INV03_RECONCILIATION_INCOMPLETE",
          "explanation": "A commit outcome is unknown and reconciliation has not reached an accepted terminal result.",
          "remediationCode": "COMPLETE_RECONCILIATION",
          "remediation": "Continue read-only reconciliation of the existing run operation to an accepted terminal result.",
          "missingPredicates": [
            "ACCEPTED_TERMINAL_STATUS"
          ],
          "occurrences": 1,
          "fixPatterns": [
            "reconcile-through-status"
          ]
        },
        {
          "invariantId": "INV-06",
          "title": "Terminal outcomes do not regress",
          "verdict": "REVIEW",
          "explanationCode": "INV06_TERMINAL_NOT_REACHED",
          "explanation": "A committed operation never reached an accepted terminal status.",
          "remediationCode": "COMPLETE_RECONCILIATION",
          "remediation": "Continue read-only reconciliation of the existing run operation to an accepted terminal result.",
          "missingPredicates": [
            "ACCEPTED_TERMINAL_STATUS"
          ],
          "occurrences": 1,
          "fixPatterns": [
            "reconcile-through-status"
          ]
        }
      ],
      "clientOutcome": {
        "result": "FAILED",
        "depositAddress": "sim-deposit-06b619cb117becec2d87"
      },
      "clientError": null
    },
    {
      "ordinal": 2,
      "scenario": "slow-deposit-answer",
      "contribution": "FAIL",
      "caseFindings": [
        "CASE_FAIL"
      ],
      "invariants": [
        {
          "invariantId": "INV-03",
          "title": "Reconcile before retry under uncertainty",
          "verdict": "FAIL",
          "explanationCode": "INV03_SECOND_MUTATION_UNDER_UNCERTAINTY",
          "explanation": "A mutation was accepted while a commit outcome was still unknown, before reconciliation reached a terminal result.",
          "remediationCode": "RECONCILE_BEFORE_RETRY",
          "remediation": "Reconcile the existing run operation read-only until a terminal result before any new mutation.",
          "missingPredicates": [],
          "occurrences": 1,
          "fixPatterns": [
            "no-second-order-while-unanswered",
            "reconcile-through-status"
          ]
        },
        {
          "invariantId": "INV-05",
          "title": "Observable value conservation",
          "verdict": "REVIEW",
          "explanationCode": "INV05_LEG_MISSING",
          "explanation": "A required value leg is missing or weakly evidenced; conservation cannot be proven.",
          "remediationCode": "RECONCILE_VALUE_LEGS",
          "remediation": "Account for every origin-asset leg in base units and meet the quoted destination constraint.",
          "missingPredicates": [
            "OPERATION_BOUND_VALUE_LEG",
            "ORIGIN_DEBIT"
          ],
          "occurrences": 3,
          "fixPatterns": [
            "reconcile-through-status"
          ]
        },
        {
          "invariantId": "INV-06",
          "title": "Terminal outcomes do not regress",
          "verdict": "REVIEW",
          "explanationCode": "INV06_TERMINAL_NOT_REACHED",
          "explanation": "A committed operation never reached an accepted terminal status.",
          "remediationCode": "COMPLETE_RECONCILIATION",
          "remediation": "Continue read-only reconciliation of the existing run operation to an accepted terminal result.",
          "missingPredicates": [
            "ACCEPTED_TERMINAL_STATUS"
          ],
          "occurrences": 2,
          "fixPatterns": [
            "reconcile-through-status"
          ]
        },
        {
          "invariantId": "INV-08",
          "title": "Missing or weak evidence cannot satisfy a stronger claim",
          "verdict": "REVIEW",
          "explanationCode": "INV08_REQUIRED_EVIDENCE_WEAK",
          "explanation": "A required predicate has only weak, reported, private, stale, or unsupported evidence.",

… (truncated)
```

> The first finding names `no-second-order-while-unanswered`. Reading it.

**Agent → `show_fix_pattern`** `{"pattern":"no-second-order-while-unanswered"}`  
_0 ms_

```text
Fix pattern no-second-order-while-unanswered: No second order while the first is unanswered

{
  "patterns": [
    {
      "id": "no-second-order-while-unanswered",
      "title": "No second order while the first is unanswered",
      "invariants": [
        "INV-03"
      ],
      "remediationCodes": [
        "RECONCILE_BEFORE_RETRY"
      ],
      "problem": "On a slow or failed deposit submission the client asks for a fresh quote and submits a second deposit. That is a second order placed while the first one may already be accepted.",
      "rule": "A slow deposit submission is not a slow read. Do not race it with a new quote or a new submission. Keep the one order you have and reconcile it through status (see reconcile-through-status).",
      "before": "const slow = await Promise.race([submission, sleep(750).then(() => 'SLOW')]);\nif (slow === 'SLOW') {\n  const retry = await OneClickService.getQuote(quoteRequest); // a second order\n  await OneClickService.submitDepositTx({ txHash: retryTx, depositAddress: retry.quote.depositAddress });\n}",
      "after": "const slow = await Promise.race([submission, sleep(750).then(() => 'SLOW')]);\n// Slow or not: read the existing order until it is terminal; never place a second one.\nlet status = await OneClickService.getExecutionStatus(depositAddress);\nwhile (!TERMINAL.has(status.status)) {\n  status = await OneClickService.getExecutionStatus(depositAddress);\n}\nif (slow === 'SLOW') await submission;"
    }
  ]
}
```

> Applying the reconcile pattern: no second order while the first is unanswered; read the same order to a terminal status; wait for reconciliation authority after a lost answer.

**Agent edits `swap-client.ts`:**

```diff
  /**
+  * Demo client, after the fix: the reconcile pattern.
-  * Demo client, before the fix: a typical first integration of the official 1Click SDK.
   *
+  * A deposit submission that has not answered, or that failed without a usable answer, has an
+  * unknown outcome. The client never places a second order for it. It reconciles the order it
+  * already has, read-only, by polling the execution status of the same deposit address until a
+  * terminal status (SUCCESS, REFUNDED, FAILED). After a lost answer it first waits for the
+  * reconciliation-only authority that RouteSpec issues.
-  * It treats a slow deposit submission like a slow read: when the submission has not answered
-  * within 750 ms it "retries" by asking for a fresh quote and submitting a second deposit. A
-  * deposit submission is a mutation, so that retry is a second order placed while the first
-  * order's outcome is unknown. When the submission fails outright it gives up without ever
-  * reading the order's status.
   */
  import type { ClientJob } from '../../../packages/mcp/src/subject/runtime.ts';

+ const SLOW_AFTER_MS = 750;
+ const TERMINAL = new Set(['SUCCESS', 'REFUNDED', 'FAILED']);
- const RETRY_AFTER_MS = 750;

  const swap: ClientJob = async (ctx, request) => {
    const quote = await ctx.sdk.OneClickService.getQuote(request.quote);
    const depositAddress = String(quote.quote.depositAddress);
+   const submission = ctx.sdk.OneClickService.submitDepositTx({ txHash: request.txHash, depositAddress }).then(
-   const submission = ctx.sdk.OneClickService.submitDepositTx({
-     txHash: request.txHash,
-     depositAddress,
-   }) as Promise<unknown> & { cancel?: () => void };
-   const first = submission.then(
      () => 'ANSWERED' as const,
      () => 'ERROR' as const,
    );
+   const first = await Promise.race([
+     submission,
+     new Promise<'SLOW'>((r) => setTimeout(() => r('SLOW'), SLOW_AFTER_MS)),
-   const raced = await Promise.race([
-     first,
-     new Promise<'SLOW'>((r) => setTimeout(() => r('SLOW'), RETRY_AFTER_MS)),
    ]);
+   // Outcome unknown after an error: wait for reconciliation-only authority, never resubmit.
+   if (first === 'ERROR') await ctx.reconciliationAuthority();
-   if (raced === 'ANSWERED') return { result: 'SUBMITTED', depositAddress };
-   if (raced === 'ERROR') return { result: 'FAILED', depositAddress };

+   // Reconcile through status: read the existing order until it is terminal.
+   const statuses: string[] = [];
+   for (let i = 0; i < 8; i++) {
+     const s = await ctx.sdk.OneClickService.getExecutionStatus(depositAddress);
+     statuses.push(s.status);
+     if (TERMINAL.has(s.status)) break;
-   // Slow answer: retry with a fresh quote and a second deposit submission.
-   ctx.adapter.setLogicalJob(`${request.logicalJob}:retry`);
-   const retryQuote = await ctx.sdk.OneClickService.getQuote(request.quote);
-   const retryAddress = String(retryQuote.quote.depositAddress);
-   try {
-     await ctx.sdk.OneClickService.submitDepositTx({ txHash: `${request.txHash}-retry`, depositAddress: retryAddress });
-   } catch {
-     // ignore: the first submission may still answer
    }
+   if (first === 'SLOW') await submission;
+   return { result: first === 'ERROR' ? 'RECONCILED' : 'SUBMITTED', depositAddress, statuses };
-   // Keep the retry and drop the slow first submission.
-   submission.cancel?.();
-   return { result: 'RETRIED', depositAddress, retryDepositAddress: retryAddress };
  };

  export default swap;

```

> Running the gate again on the changed client.

**Agent → `run_gate`** `{"client":"swap-client.ts"}`  
_4167 ms_

```text
Gate PASS for swap-client.ts (run-2).

{
  "runId": "run-2",
  "client": "swap-client.ts",
  "decision": "PASS",
  "exitCode": 0,
  "artifactDigest": "sha256:f4c0a2d9980427b487328c16a1107b4f4e8f74d8cc6cd75cb6d044fd1af80f70",
  "decisionDigest": "sha256:b907aae08ea49c04bc4c817e740ea5a35a60a6f2e4c6ee63b086e5b63ae9bdd1",
  "counts": {
    "total": 3,
    "required": 3,
    "pass": 3,
    "fail": 0,
    "review": 0,
    "notRun": 0,
    "unsupported": 0
  },
  "cases": [
    {
      "ordinal": 0,
      "scenario": "happy-path",
      "contribution": "PASS",
      "failing": [],
      "clientError": null
    },
    {
      "ordinal": 1,
      "scenario": "accepted-then-lost-response",
      "contribution": "PASS",
      "failing": [],
      "clientError": null
    },
    {
      "ordinal": 2,
      "scenario": "slow-deposit-answer",
      "contribution": "PASS",
      "failing": [],
      "clientError": null
    }
  ],
  "gateFindings": [
    "BUILD_USER_ASSERTED_LOCAL"
  ],
  "requiredInvariants": [
    "INV-01",
    "INV-02",
    "INV-03",
    "INV-05",
    "INV-06",
    "INV-07",
    "INV-08"
  ],
  "containment": "UNCONTAINED_DECLARED_HOOKS_ONLY",
  "evidenceUse": "DIAGNOSTIC_ONLY",
  "durationMs": 4165,
  "error": null,
  "next": "All required invariants passed on every scenario."
}
```

> PASS on every scenario (run-1 FAIL, run-2 PASS). This run was uncontained and diagnostic, not release evidence.
