# @routespec/kernel

Owner module: M04. Revision `routespec-kernel@1.0.0`.

Pure deterministic invariant kernel and evidence classification. It depends only on
`@routespec/contracts` and has no network, clock, randomness, database, UI, or model access.

- `snapshotFromJournal(store.readEvaluationSnapshot(caseRunId))` maps one consistent journal read
  into an immutable `KernelInput`.
- `evaluateCase(input)` returns PASS / FAIL / REVIEW / NOT_RUN / UNSUPPORTED per invariant
  (INV-01..INV-08 in this revision) and per case, with separate evidence class, scope, and reason,
  missing predicates, explanation and remediation codes, and input/result digests.
- `toPersistableEvaluation` produces the canonical case result and invariant rows for
  `store.persistCaseEvaluation`.
- `explainWithOptionalModel` keeps any model output in a separate, non-authoritative annotation.

Tests: `npx vitest run packages/kernel`. Decisions: `docs/adr/0009-invariant-kernel-evidence.md`.
Status: `docs/status/M04.md`.
