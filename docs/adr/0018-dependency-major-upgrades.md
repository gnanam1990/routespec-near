# ADR-0018 — Dependency major upgrades: zod 4, react-router 7, vitest 4 (M13)

- Status: accepted
- Date: 2026-11-12
- Module: M13 (follow-up to the M11 advisory triage)
- Supersedes: the zod 3.25.76 pin in ADR-0001 and the react-router-dom 6.30.6 pin in ADR-0008.

## Context

`docs/status/M11.md` left registry advisories open that only a major upgrade fixes: zod
3.25.76 (high, memory on oversized constrained collections), react-router 6.30.6 (2 moderate),
vitest 3.2.7 and @vitest/mocker (3 moderate), tinypool 1.1.1 (2 critical, through vitest 3).
node-forge 1.4.2 (dev only) was held back by a two-week cool-down for new releases.

## Decisions

1. **Versions.** zod 4.6.7 (published 2026-10-12), react-router 7.18.5 (2026-10-27), vitest
   4.1.12 (2026-10-15). Each is the newest release of the major that fixes the advisories and
   is older than two weeks today. Exact pins, as before. The next majors (react-router 8,
   vitest 5) are not taken here: they are not needed for the advisories.
2. **tinypool is removed, not upgraded.** vitest 4 runs its own worker pool and no longer
   depends on tinypool, so the "tinypool 2" step is satisfied by its removal: `pnpm why tinypool`
   is empty after the upgrade. The `pool: 'forks'` configuration is unchanged.
3. **node-forge stays at 1.4.2.** `npm view node-forge time` shows 1.4.3 published
   2026-11-04T01:06Z, 8 days before today (2026-11-12). The cool-down rule (at least 14 days)
   holds it back; it becomes eligible on 2026-11-18. Exposure is unchanged from M11: dev only,
   certificate generation for the live-dry test PKI, none of the affected modules used.
4. **Issue codes in error details are stable.** zod 4 folds several issue codes together
   (`invalid_format`, `invalid_value`, `invalid_key`, and `invalid_union` with a discriminator
   note). RouteSpec reports issue codes in `RS_SCHEMA_INVALID` details (control API
   `fields[].code`, CI config `issue`, scenario compile and replay `issues`), so
   `stableIssueCode()` in `packages/contracts/src/schemas/issues.ts` maps them back to the codes
   reported before: `invalid_string`, `invalid_enum_value` / `invalid_literal`,
   `invalid_union_discriminator`, and the key check's own code for a bad record key. Mapping one
   place keeps the API stable without spreading library details through the code.
   Two enum cases need the validated input, so `stableIssueCode(issue, input)` takes it and every
   caller passes it:
   - zod 4 reports an enum given an absent or non-string value as `invalid_value`; zod 3
     reported `invalid_type`. The function reads the value at the issue path and reports
     `invalid_type` in that case, `invalid_enum_value` for a string outside the enum.
   - zod 4 gives a single-value enum mismatch exactly the same issue as a literal mismatch
     (`invalid_value` with one value, the schema is not kept on the issue). The authoring schema
     has one such enum (`transport_error.error`, `CONNECTION_RESET`); it is built with
     `singleValueEnum()`, which gives its mismatch the library's own multi-value enum message,
     so it is recognised as an enum. A literal still reports `invalid_literal`. No other
     single-value enum exists in the code (checked over every exported constant array).
5. **Missing-value detection reads the input.** zod 4 drops `received` from `invalid_type`
   issues. `isMissingValueIssue()` walks the issue path in the input instead; a value that is
   absent (or whose parent is absent) is missing, a present `null` or wrong type is not. An enum
   given no value counts as missing too, as zod 3 reported it as `invalid_type` with
   `received: undefined`. It decides `RS_PARTIAL_FINALIZATION` versus `RS_MATERIAL_INVALID`,
   exactly as before.
6. **Nested defaults use `prefault`.** In zod 4, `.default({})` returns `{}` without parsing,
   so the inner defaults of the CI config `uploads` and `liveDry` blocks would be lost. Those
   two use `.prefault({})`, which parses the default and fills the inner defaults as zod 3 did.
7. **Deprecated helpers replaced** where the replacement is the same check:
   `z.string().datetime()` to `z.iso.datetime()`, `z.string().url()` to `z.url()`,
   `.passthrough()` to `.loose()`, `z.ZodIssueCode.custom` to `'custom'`. `.strict()`,
   `.superRefine()` and `ZodTypeAny` still exist and are kept to keep the change small.
8. **react-router 7.** Imports move from `react-router-dom` to `react-router`. The console
   already opted into `v7_startTransition` and `v7_relativeSplatPath`; those are the v7
   defaults, so the `future` prop is removed with no change in behaviour. No SSR, data routers
   or loaders are used.
9. **Parity is tested on both versions.** The M13 tests in `packages/ci`,
   `packages/control-api` and `packages/scenario` assert the defaults and issue codes the
   product produced on zod 3, through the product's own entry points. They were run against a
   detached checkout of the pre-upgrade `main` (zod 3.25.76, vitest 3.2.7) and pass there, pass
   on the upgraded tree, and fail on the upgraded tree if the mapping, the input check or
   `prefault` is removed. `packages/contracts/test/m13-validation-issues.test.ts` tests the
   mapping functions directly (it uses zod 4 APIs, so it runs on the upgraded tree only).

## Consequences

- Registry audit: 13 advisories before (2 critical, 1 high, 9 moderate, 1 low), 5 after
  (0 critical, 0 high, 4 moderate, 1 low): node-forge (4, cool-down) and minimatch 9.0.9 (1,
  through typescript-eslint, out of scope here).
- Human-readable issue messages inside error details change wording where a schema has no
  custom message (for example "Required" becomes "Invalid input: expected string, received
  undefined"). Codes, paths, RouteSpec error codes and custom messages do not change. Messages
  are diagnostics, not contract.
- Edge cases that zod 4 checks more strictly and that RouteSpec inputs cannot reach in
  practice: `.int()` also requires a safe integer (every integer field already caps at
  `Number.MAX_SAFE_INTEGER` or lower), datetime offsets need `HH:MM` (the API emits `Z`), and
  `z.url()` trims surrounding whitespace.
- The console bundle grows by the size difference of zod 4 over zod 3; no budget test fails.
