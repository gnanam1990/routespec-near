---
name: routespec-gate
description: Before shipping code that calls the NEAR Intents 1Click API (the official 1Click TypeScript SDK, OneClickService.getQuote / submitDepositTx / getExecutionStatus), run the RouteSpec gate on it. On FAIL or REVIEW, apply the reconcile pattern and run the gate again until it is PASS.
---

# RouteSpec gate for 1Click client code

Use this skill whenever you write or change code that places or follows a NEAR Intents 1Click
swap: anything that calls `OneClickService.getQuote`, `OneClickService.submitDepositTx` or
`OneClickService.getExecutionStatus`, or that retries, times out, or gives up on those calls.

RouteSpec runs the client against a local simulated 1Click service with scripted faults (a lost
answer, a slow answer) and judges what the client actually sent with fixed invariants. It is
local and networkless. It does not move funds and needs no keys.

## Rule

**Before shipping 1Click code, run the gate. On FAIL, apply the reconcile pattern.** Do not
report the work as done while the gate says FAIL or REVIEW.

## Tools

The RouteSpec MCP server (`routespec mcp`) provides five tools:

| Tool                 | Use it to                                                                                             |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| `run_gate`           | Run the gate on a client module. Returns `PASS`, `FAIL`, `REVIEW`, `NOT_RUN` and a `runId`.           |
| `list_findings`      | See which invariant each failing case broke, in the kernel's words, and which fix patterns answer it. |
| `explain_invariant`  | Read what an invariant (for example `INV-03`) requires and what each of its codes means.              |
| `show_fix_pattern`   | Get the before/after code of a fix pattern for the official SDK.                                      |
| `verify_certificate` | Check a published release certificate on the NEAR registry (read-only).                               |

If the tools are not available, the same gate runs from a shell; see `README.md` next to this
file.

## Steps

1. **Make the client runnable by the gate.** The gate runs a client module: a `.ts` or `.mjs`
   file whose default export is `async (ctx, request) => result`. Inside it, call the official
   SDK through `ctx.sdk.OneClickService` (it is already pointed at the RouteSpec proxy). Use
   `request.quote` as the quote request and `request.txHash` as the deposit transaction hash.
   If the real code lives in a larger module, export the swap flow as a function and wrap it in
   such a module; do not copy the logic into a separate test-only version.
2. **Run the gate:** `run_gate` with `client` set to the module path (relative to the
   repository root). The default scenarios are `happy-path`, `accepted-then-lost-response` and
   `slow-deposit-answer`.
3. **Read the result.**
   - `PASS`: every required invariant held on every scenario. Go on.
   - `FAIL` or `REVIEW`: call `list_findings`. Each finding names the invariant, the kernel's
     explanation, the remediation, and `fixPatterns`. `nextFixPatterns` is the order to apply
     them in.
4. **Apply the fix pattern** (`show_fix_pattern`). The usual one is the reconcile pattern:
   - Never send a second deposit submission, and never ask for a fresh quote for a new order,
     while the first submission has not answered (`no-second-order-while-unanswered`).
   - After a submission that failed without a usable answer, wait for
     `ctx.reconciliationAuthority()`, then read status. After any submission, read
     `getExecutionStatus(depositAddress)` of the same order until `SUCCESS`, `REFUNDED` or
     `FAILED` (`reconcile-through-status`).
   - Fulfil an order only after `SUCCESS` (`release-effects-after-success`).
5. **Run the gate again** on the changed module. Repeat 3 to 5 until it is `PASS`.
6. **Report** the final decision and the `runId`s of the failing and the passing runs. Say that
   the run was uncontained and diagnostic: it is not release evidence.

## Do not

- Do not change the scenario list or drop a scenario to get a PASS.
- Do not catch and hide the error of a deposit submission and report success.
- Do not treat a timeout as a failed order: its outcome is unknown until status says otherwise.
- Do not claim a release certificate from an MCP gate run. Release evidence needs a contained
  run (`docs/runbooks/` in the RouteSpec repository) and a published certificate, which you can
  check with `verify_certificate`.

## Example

`demo/swap-client.naive.ts` retries a slow deposit submission with a fresh quote. The gate
FAILs it on `slow-deposit-answer` with `INV-03 FAIL` (`INV03_SECOND_MUTATION_UNDER_UNCERTAINTY`).
`demo/swap-client.fixed.ts` applies the reconcile pattern and the gate PASSes it.
`demo/TRANSCRIPT.md` is a recorded session of exactly that.
