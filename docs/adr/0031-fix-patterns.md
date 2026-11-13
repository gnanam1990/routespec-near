# ADR-0031 — Fix patterns on FAIL and REVIEW (M53)

- Status: accepted
- Date: 2026-11-13
- Module: M53 (fix patterns). Builds on ADR-0009 (invariant kernel and evidence) and ADR-0012
  (runner, CLI, release gates). Changes neither.

## Context

A FAIL or REVIEW told an integrator which invariant broke and gave a one-line remediation code.
It did not say what to change in their client. The specification pack has no fix patterns, so
the decisions below go beyond it. None of them changes a verdict, a result digest, a decision
digest, the kernel, the proxy, or the adapter.

## Decisions

1. **A closed catalogue of three client-code patterns.** `@routespec/fix-patterns` names
   `RECONCILE_THROUGH_STATUS`, `IDEMPOTENCY_KEY` and `NO_SECOND_ORDER_WHILE_UNANSWERED`, each with
   a rule, the reason, steps, and a short SDK example. A fixed table maps kernel explanation codes
   (FAIL or REVIEW only) to patterns. Codes about RouteSpec's own harness, evidence or
   configuration (for example `INV04_DECLARED_HOOKS_ONLY`, `INV08_*`) map to no pattern and keep
   only their remediation text. A test checks that every mapped code is a real kernel FAIL/REVIEW
   code and that no PASS code maps to anything.
2. **Explanation codes come from a reproduced evaluation.** The stored canonical case result keeps
   each invariant's verdict but not its explanation code. The runner re-runs the pure kernel over
   the same journal snapshot, read-only, and uses that evaluation only when its canonical result
   digest equals the stored result digest. Otherwise the case is listed as `RESULT_NOT_REPRODUCED`
   (or `NO_CASE_RESULT`, `SNAPSHOT_UNREADABLE`) and links no pattern. Nothing is written.
3. **SDK usage is found by parsing, not by running.** The subject source is parsed with the
   TypeScript compiler (syntax only). Every call to `getQuote`, `submitDepositTx` and
   `getExecutionStatus` is recorded with its real line. Seven closed code shapes are derived from
   those call sites (for example `COMMIT_RETRIED_IN_LOOP`, `REPEATED_QUOTE_CALL`,
   `STATUS_POLL_BOUNDED`). A shape is shown only when a violated invariant's code links to a
   pattern that the shape is evidence for. A shape is a fact about the text, never a verdict.
4. **A suggested diff from three syntax-level rewrite rules.** `RECONCILE_ON_UNKNOWN_COMMIT`,
   `SINGLE_ORDER` and `UNBOUNDED_STATUS_POLL` rewrite the statements found and insert one
   `reconcileThroughStatus` helper. The unified diff is built from the exact edits, so it applies
   with `git apply`. The patched text is re-parsed and its syntax error count is reported. It is
   not type-checked, run, or applied by RouteSpec. When a rule cannot apply (no `depositAddress`
   in the call, a second order spread over blocks), it is listed as skipped with the reason and no
   diff is invented.
5. **Advisory, separate output.** Fix advice is its own document, `routespec.fix-advice/1`, with
   its own digest. The gate report (`routespec.gate-report/1`), JUnit and decision digests are
   unchanged. The CLI writes it only when asked (`--fix-out`, `--fix-md`, `--source` on
   `gate run|evaluate|show`) and lists the catalogue with `fix patterns` and `fix show`.
6. **SARIF gets real locations only.** With `--source`, SARIF carries one result per shown shape,
   at its real line in that file. Without a source there are still zero results; no location is
   invented.
7. **No local paths.** The source path is shown relative to the working directory, or as its file
   name when it is outside it. The advice states whether the file's SHA-256 equals the gated
   artifact digest; when the artifact digest covers more than that one file it says `false`.

## Consequences

- The verdict of a patched build comes only from a new gate run. M53's tests apply each suggested
  diff with `git apply`, install the result as a new build, and gate it for real.
- The rewrite rules know the shapes RouteSpec's own subject builds show. Other code may get usage
  and patterns but no diff; that is reported, not hidden.
- `typescript` becomes a runtime dependency of `@routespec/fix-patterns` (same pinned 5.9.3 that
  the workspace already uses). The runner imports that package for types only and the CLI
  imports it lazily, so commands that ask for no advice do not load the compiler. (Loading it on
  every CLI start added startup time that broke the timing of the T-025 and T-057 kill tests.)
