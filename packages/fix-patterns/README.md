# @routespec/fix-patterns

Owner module: M53. Revision `routespec-fix-patterns@1.0.0`.

On FAIL or REVIEW, links each violated invariant result to a concrete client-code pattern, lists
the official 1Click SDK usage found in the subject source, and builds a suggested diff against it.
Advisory only: nothing here is part of a verdict or a digest the gate decides on.

- `FIX_PATTERNS`, `CODE_PATTERNS`, `patternsForCode(code)`: the closed catalogue
  (`RECONCILE_THROUGH_STATUS`, `IDEMPOTENCY_KEY`, `NO_SECOND_ORDER_WHILE_UNANSWERED`) and the
  kernel explanation codes each one addresses.
- `scanSdkUsage(path, text)`: every `getQuote` / `submitDepositTx` / `getExecutionStatus` call
  with its real line, and the closed code shapes derived from them. Syntax only; nothing runs.
- `buildFixAdvice(input)`: the `routespec.fix-advice/1` document (links, patterns, usage found,
  suggested unified diff, digest). `renderFixAdviceMarkdown`, `fixAdviceSarifFindings`.
- `unifiedDiff(path, text, edits)`: a git-applicable diff built from exact edits.

The runner's `gateFixAdviceInput(store, evaluation)` feeds it from a persisted gate evaluation
(read-only kernel re-run, used only when it reproduces the stored result digest). This package
loads the TypeScript compiler, so the CLI imports it only when advice is asked for. The CLI exposes it with `--fix-out`, `--fix-md`, `--source`, `fix patterns`, and
`fix show`.

Tests: `npx vitest run packages/fix-patterns packages/cli/test/m53-fix-advice.test.ts`.
Decisions: `docs/adr/0031-fix-patterns.md`. Status: `docs/status/M53.md`.
