# ADR-0017 — End-to-end delivery verification (M12)

- Status: accepted
- Date: 2026-11-12
- Module: M12 (T-052, T-054, T-055)

## Context

M12 must show the installed product working end to end from a clean checkout, against
`REAL-PRODUCT-GATE.md` RP-01..RP-06 and RP-08, and must say exactly which parts cannot pass on
this host. Earlier modules verified their own boundaries; none ran the whole journey from a
fresh install, and none ran the corrected build through a regression promoted from a capture of
a reviewed core scenario through the public API.

## Decisions

1. **A delivery package, not more unit tests.** `packages/delivery` holds the clean-install
   recorder (`clean-install.ts`), the control service process wrapper (`control.ts`), the subject
   launchers (`subjects.ts`), and the journey (`journey.ts`). It is typechecked as its own
   `noEmit` project. Its acceptance tests are `packages/delivery/e2e/*.e2e.test.ts`, run by
   `pnpm run test:delivery` with `vitest.delivery.config.ts`. They are slow (a clone, an
   install, two builds, the journey, a regression batch, an uninstall and a reinstall), so they
   are not part of `pnpm run check`.
2. **Clean means a clone of the committed HEAD.** The suite clones `HEAD` with
   `git clone --no-hardlinks` into an empty temporary directory and checks the tree is clean
   before install and after build. Uncommitted work is never part of the evidence.
3. **Offline is enforced, not assumed.** Install, build, and every product command run with
   `pnpm --offline`, `npm_config_offline=true`, and every proxy variable pointing at
   `http://127.0.0.1:9` (a closed port), with `ROUTESPEC_*`, `NODE_OPTIONS`, and `npm_config_*`
   removed from the inherited environment. A registry or provider request would fail.
4. **Identity record.** Commit, dirty-tree digest, lockfile digest, tree digests of product
   sources, package manifests, emitted declarations, and the console bundle, toolchain
   (OS, arch, Node, pnpm, git, SQLite), and every command with its exit code. Built output is
   searched for the author checkout path and the install path.
5. **Roles in the journey.** The journey script plays the integrator and the operator only:
   public API calls, starting subject processes, delivering credentials over IPC, and reading
   results. The control service is started through its real entry point with `--handoff ipc`.
   No journal row is written directly and no verdict is supplied.
6. **Subject builds.** The two reviewed integrator builds of the M05 regression suite are reused
   (`baseline-client.ts`, `corrected-client.ts`); each build's artifact digest is the SHA-256 of
   its own bytes, so the fix is a different artifact with its own build registration, manifest,
   and policy. The M02 subject harness is the recovery probe (single SDK calls with a chosen
   credential). Reconciliation authority is handed to a client only when it waits for it (the
   corrected build); the baseline build never asks and finishes on its own, so its behaviour does
   not depend on timing.
7. **Capture of a synthetic schedule (product fix).** An installed capture whose source scenario
   is `SYNTHETIC` or `OFFICIAL_SPEC_DERIVED` is proposed as `INDEPENDENTLY_REPRODUCED` (the
   installed artifact reproduced the behaviour under RouteSpec; ADR-0010 allows only installed
   captures to claim it). A user file with such a source becomes `CUSTOMER_PROVIDED_REDACTED`.
   Before this, the source-scenario proposal copied `SYNTHETIC`, failed validation
   (`PROVENANCE_NOT_APPLICABLE`), and the API fell back to the observed-trace shape, which has no
   provider timeline or ground truth beyond what the failing client saw; a corrected client could
   then never reach a terminal status in the promoted regression.
8. **Lineage of a re-run of the captured build (product fix).** A gate run of the very build
   whose capture was promoted keeps its inherited cases `BASELINE` on the promotion corpus; the
   promoted scenario stays `PROMOTED_REGRESSION`. Regression status already ignored that build.
9. **Export overwrite window.** The bounded rename retry for a confirmed overwrite covers about
   8 s with a growing back-off; 1 s was not enough under full-suite load on Windows (T-057).
10. **No WORKING_LOCAL claim.** The journey uses the only coverage basis this host offers,
    `DECLARED_HOOKS_ONLY`, and the only build class the standalone service accepts over HTTP,
    `USER_ASSERTED_LOCAL`. Local launcher attestation (ADR-0013) needs a launcher the control
    host forks itself; the standalone entry point offers no such path, and there is no
    process-tree sandbox or independent interceptor. INV-04 (complete effect) therefore stays
    REVIEW for every build, the corrected decision is REVIEW, and the lineage is
    `CORRECTED_RUN_NOT_PASSING`. The tests assert this honestly: INV-04 is the only predicate the
    corrected build does not pass. RP-07 is separate and not run.
11. **Responsive journeys (T-052).** Headless Chromium on the real control service: 4 widths x
    2 color schemes x 3 contexts (default, reduced motion, forced colors) over the core routes,
    plus a keyboard drawer journey at every width and at 200 percent zoom. Zoom is emulated the
    way a browser applies it to layout: half the CSS viewport at device pixel ratio 2. Firefox,
    WebKit, touch devices, and other operating systems are not installed here and are NOT_RUN.
12. **Journey limits.** A gate run carries one effect-coverage policy, and a policy is bound to
    one scenario revision (DATA-MODEL), so the promoted case also reports
    `POLICY_IDENTITY_MISMATCH` under INV-04. It is REVIEW either way on this host; a per-case
    policy selection is left for the module that adds real interception.

## Consequences

- `pnpm run test:delivery` is the reproducible M12 evidence command; its record can be written
  to a file with `ROUTESPEC_DELIVERY_EVIDENCE=<path>`.
- A future host with a process-tree sandbox, an interceptor, and an enrolled launcher must
  change decision 10 and the T-055 assertions together, with the runtime evidence.
