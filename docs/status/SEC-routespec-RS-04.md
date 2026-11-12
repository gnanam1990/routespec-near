# SEC RS-04 — Import quarantine dropped blocking findings past 512 records: status evidence

- Source: external security audit, finding RS-04 (LOW). Re-confirmed with a failing test on the
  real pipeline and journal before any change.
- State: **FIXED** on `feat/routespec-m26-import-findings-cap` (base `c588307`, `main` merged in
  before the final runs).
- ADR: none. No protocol, schema or persisted format changed; finding categories, the path
  alphabet and the journal limit of 512 finding records are unchanged.

## Finding (verified)

`FindingSet.add` (`packages/regressions/src/findings.ts`) stopped recording any new
(category, path) pair once 512 were held, for every category. `analyzeTrace` adds the advisory
active-content findings (step 4) before the step-7 ordering, time, reference, material and
identity checks. A user trace with 64 annotation notes, each matching eight advisory categories,
filled the set with 512 advisory records, so `DUPLICATE_SEQUENCE`, `NONDETERMINISTIC_*`,
`UNRESOLVED_*` and `IDENTITY_MISMATCH` were silently discarded. The journal computed
`blockingCount = 0` from that list, and `saveMapping` / `promoteIn` gate on `blockingCount`
alone, so a trace that step 7 says can never be mapped reached `MAPPED`, and the reviewer saw no
blocking entry and no sign of truncation.

## Change

`FindingSet` keeps distinct (category, path) records up to `MAX_PATH_FINDINGS`
(`MAX_FINDING_RECORDS` 512 minus one slot per category minus 8 of headroom = 465). After that a
new path is not dropped: it is counted under one path-less `$` record for its category, which
keeps its blocking flag. So:

- a blocking or rejecting finding always survives, whatever number of advisory findings came
  first, and `blockingCount` stays above zero for a defective trace;
- the overflow is visible to the reviewer as `$` records whose counts carry the merged paths;
- the list stays within the journal's 512-record limit (at most 465 + 39 categories), with room
  for the findings an import adds outside the analysis (`PATH_UNSAFE`). Before the change, 512
  analysis findings plus `PATH_UNSAFE` would have exceeded that limit and failed the import.

The gate stays at the journal (`blockingCount > 0` refuses mapping and promotion); the fix is at
the last point where the findings themselves are decided.

## Test (red, green)

`packages/regressions/test/sec-import-findings-cap.test.ts`:

- unit: 2000 advisory findings at distinct paths, then every blocking category and
  `RESOURCE_KEYS`; every one is present and blocking, the set is rejecting, the list is within
  512, and the advisory counts still total 2000;
- import: a `USER_FILE` trace with a duplicated STATUS sequence naming a missing operation, with
  0, 63 and 64 noisy notes. Each import is `SANITIZED`, keeps `DUPLICATE_SEQUENCE`,
  `NONDETERMINISTIC_ORDER` and `UNRESOLVED_REFERENCE` as blocking, holds at most 512 records, shows
  merged `$` records exactly when notes are present, and `saveImportMapping` is refused with
  `RS_IMPORT_BLOCKED`.

| Step                                                                                                   | Exit | Result                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------ | ---- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `npx vitest run packages/regressions/test/sec-import-findings-cap.test.ts`, before (limit read as 512) | 1    | 2 failed, 2 passed (4): unit lost `UNRESOLVED_MATERIAL`; 64 notes lost `DUPLICATE_SEQUENCE` (0 and 63 notes passed, isolating the cap) |
| same, after                                                                                            | 0    | 4 passed (4)                                                                                                                           |

## Full regression (after `git merge main`)

Environment: `ROUTESPEC_TEST_PORT_BASE=9730` (ports 9730-9739); everything else binds OS-assigned
loopback ports. Containment, control-api, proxy and runner sources are not touched, so
`test:containment` and `test:delivery` were not required.

| Command          | Exit | Result                                                                                                            |
| ---------------- | ---- | ----------------------------------------------------------------------------------------------------------------- |
| `pnpm run check` | 0    | typecheck, lint, format clean; 82 test files, 707 passed, 2 skipped (709); secret-scan clean (515 files, 8 rules) |

During a first full run before the merge, `packages/cli/test/t025-interrupted-evaluation.test.ts`
failed once under load (an evaluation-ordering comparison, unrelated to imports); it passed 5/5
when run on its own and in the final full run.
