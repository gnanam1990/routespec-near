---
project: RouteSpec
version: 2.0.0
artifact_status: SPECIFICATION_ONLY
product_runtime_status: NOT_RUN
updated_at: 2026-11-11
---

# RouteSpec master implementation prompt

You are implementing RouteSpec from a specification-only build pack. At handoff, no product runtime, repository, passing test, deployment, provider integration, or event submission is established. Read and enforce `REAL-PRODUCT-GATE.md`. Never convert a plan, scaffold, mock, fixture, seeded state, document check, recording, or hosted preview into a claim that the product works.

## 1. Authority and reading order

Before touching code, read the repository's actual `AGENTS.md` and other local rules, then read this pack in the order declared by `START-HERE.md`. `CORE-CONTRACT.md` and `requirements.json` are the implementation-facing requirement registry; `PRD.md` is authoritative for product meaning; `TDD.md`, `ARCHITECTURE.md`, `API-SPEC.md`, `DATA-MODEL.md`, `UI-SPEC.md`, and `SECURITY.md` define the proposed design and safety boundary; `TEST-PLAN.md` owns canonical test titles and evidence intent.

If current provider behavior, repository constraints, or an implemented dependency contradicts the pack, stop and report the exact conflict. Do not silently weaken the contract, rename a failure to success, or edit tests merely to make an implementation pass.

## 2. Mandatory repository intake

Report before coding:

- absolute repository path;
- current branch and exact HEAD;
- remotes;
- dirty, staged, and untracked state;
- applicable repository instructions;
- installed Node/package-manager/browser/database tool versions;
- existing package/workspace structure;
- current test/build/lint commands and their baseline outcomes;
- pre-existing user changes that must be preserved;
- whether any implementation already claims these requirement/test IDs.

Work around unrelated user changes. Do not reset, discard, overwrite, or reformat them. If there is no intended repository, stop; this pack does not authorize creating a remote repository.

## 3. Global safety contract

- Supported runtime modes are `SIMULATE`, `REPLAY`, and `LIVE_DRY_PROBE` only. SIMULATE/REPLAY run in a networkless scenario process that may accept mutation-shaped requests locally but has no upstream client or provider credentials; LIVE_DRY_PROBE is a separately launched egress-capable adapter.
- Real committed quote, deposit-submit, transfer, withdrawal, signing, wallet, contract mutation, or fund-moving behavior is prohibited.
- In LIVE_DRY_PROBE, denial must occur before provider credential attachment, DNS, socket creation, or upstream body transfer.
- The tested client uses a one-time case token bound to exact build/artifact/gate/case/session/client/adapter/phase/epoch plus stable non-secret correlation headers. Recovery revokes stale authority and issues only reconciliation scope. Strip/redact provider Authorization and every local header before a live boundary.
- RouteSpec must not execute arbitrary project commands, imported code, scenario scripts, issue text, templates, or URLs.
- Deterministic state machines own the single execution lifecycle and the deterministic kernel owns the separate verdict. Keep lifecycle, verdict (`PASS|FAIL|REVIEW|NOT_RUN|UNSUPPORTED`), evidence class, evidence scope/reason, provider fact, effect-coverage basis, subject report, independent boundary observation, probe result, `artifactReady`, and `enforcementMode` separate; `NOT_VISIBLE` is never a verdict.
- Zero started required cases is NOT_RUN; FAIL dominates; otherwise incomplete/cancelled/recovery-pending/unattested/uninstrumented/private/missing/stale/unsupported/contradictory/identity-mismatched evidence is REVIEW; artifact readiness never changes the decision.
- Proxy schedule/barrier determinism does not prove an uncontrolled external wall timer. Full timer conformance requires an injected client clock/transport; otherwise record noncanonical REVIEW evidence.
- Enforcement is capped at `REQUIRED_CHECK_UNVERIFIED`; v2 has no repository-settings verification adapter, never trusts caller-supplied protection state, never claims blocking, and must not configure repository settings.
- Build rows are immutable `USER_ASSERTED_LOCAL` registrations. Trusted build, case, call-site inventory, and interceptor identity exist only as separate immutable attestations from explicitly enrolled local-launcher or CI OIDC trust roots with signature/claim, freshness, challenge-scope, and revocation checks. Never upgrade a build or GateRun in place.
- Subject effect hooks are correlation only. A complete-effect PASS requires a separately attested runtime boundary interceptor outside the subject, covering the full declared process tree and sink classes. Trusted build-time inventory is supplemental. `DECLARED_HOOKS_ONLY`, inventory without interception, unsupported analyzer paths, missing/forged/stale interceptor, bypass, channel loss, or incomplete teardown is REVIEW. Test effects use a no-effect canary and never contact the real downstream target.
- No real-money transaction is permitted for a demo or test, even at a small amount.

## 4. Module DAG

Implement modules through their dedicated prompt files and do not begin a module until every declared dependency has a complete handoff and its required tests remain green.

```text
M00 Foundation and protocol contracts
  -> M01 Domain states and persistence
       -> M02 Local proxy/recording/redaction
       -> M03 Scenario DSL/virtual faults
            -> M04 Invariant kernel/evidence
                 -> M05 Capture-to-regression
                      -> M06 Runner/CLI/reports/gates
                           -> M08 Local control API/project-revision-build matrix
                                -> M09 Modern web console
                                -> M10 GitHub Action/CI
  M02 + M03 + M04 -> M07 Official live dry adapter
  M02 + M03 + M05 + M06 + M08 + M09 + M10 -> M11 Core security/observability/hardening
  M09 + M10 + M11 -> M12 End-to-end WORKING_LOCAL verification/delivery
  M07 remains an independent OFFICIAL_ENDPOINT_COMPATIBLE path
```

The exact dependency lists and ownership mappings are in `requirements.json`. Every `T-001`–`T-059` has exactly one owner. Other modules may run a test as a regression but must not redefine or claim ownership of it. Hosted collaboration is future/excluded, not part of the critical DAG.

## 5. Failure-first TDD protocol

For every owned test:

1. Restate its canonical title and mapped requirements/invariants.
2. Add the smallest test that exercises observable behavior, not an implementation detail.
3. Run it before the fix and capture the intended red result. If it unexpectedly passes, explain whether behavior already exists and prove the relevant code path; do not fabricate red evidence.
4. Implement the minimum complete behavior with real domain logic and durable state where required.
5. Run the focused test to green.
6. Run the module suite and all dependency/regression suites.
7. Record exact command, exit code, test counts, bounded redacted output, and artifact digest/path.

Mocks may isolate an adapter but cannot sit on the central end-to-end proof path. The deterministic simulator and virtual scheduler are product behavior, not hard-coded success. No manual database repair or prerecorded UI transition may satisfy a test.

## 6. Engineering standards

- TypeScript strict mode; no unchecked `any` at trust boundaries.
- Closed, versioned schemas and exhaustive status handling.
- Arbitrary-precision base-unit amounts; never use display USD or floating point in economic logic.
- Pure invariant kernel with no network, clock, random, database, or model dependencies.
- Transactional single-writer SQLite journal with disk-full/checkpoint/backup handling. Fence case/session writes by build/client/token/epoch; use idempotency plus optimistic revision elsewhere. Separate logical jobs from run operations; atomically bind quote response then first commit material in distinct phases; recovery is read-only.
- Bounded inputs, concurrency, response sizes, virtual time, and retention.
- Structured redacted errors and logs.
- Accessible, responsive UI whose verdicts come from persisted server results.
- Cross-platform paths and commands; no author-machine absolute paths in product artifacts.
- Locked dependencies, licenses, SBOM, and supply-chain checks before release.

## 7. Branch, commit, and review discipline

When the user invokes implementation in an intended local repository, create or use one focused module branch such as `feat/routespec-m03-scenario-runtime`. Do not create a remote branch or push without separate authorization.

Each commit must be coherent, contain no secrets/generated noise/unrelated edits, and identify the module and owned IDs in its message/body. Before handoff provide:

- base SHA and final HEAD SHA;
- `git status --short` and `git diff --check`;
- commit list and changed-file inventory;
- requirement/invariant/test ownership completed;
- exact focused and regression commands with exit codes/counts;
- red evidence and green evidence or an honest reason red evidence was unavailable;
- security/privacy observations;
- remaining `NOT_RUN`, blocked, mocked, or unverified areas.

You may draft a PR body locally using the pack template. Push, PR creation, review submission, merge, deployment, publication, contest submission, account/credential creation, paid calls, or contact with anyone remain separate external actions requiring explicit user authorization. A green local branch is not merged or deployed.

## 8. Stop conditions

Stop the module and report evidence when:

- a dependency module is absent, incomplete, failing, or identity-mismatched;
- an owned ID conflicts with current authoritative documentation;
- safe-mode denial cannot be proven before network/credential attachment;
- implementation would require real funds, wallet signing, paid service, credential registration, or external mutation;
- a provider/schema capability is undocumented or no longer present;
- a secret enters persistence or an imported file can execute code/network;
- a required test would need fake success, manual database editing, or a mocked critical path;
- unrelated user work overlaps irreconcilably;
- the task requires changing the product boundary rather than implementing it.

Do not mark a module complete because time is short. Preserve honest `NOT_RUN` and blocked statuses.

## 9. Definition of module done

A module is done only when all mapped requirements/invariants are implemented at its boundary, every owned test has real passing evidence, dependency and regression suites remain green, persistent/API/schema changes are documented, threat implications are reviewed, a clean local diff exists, and the handoff record lets the next module reproduce the result. Scaffolding, typechecking, document QA, or UI screenshots alone are insufficient.

## 10. Final product verification

M12 must reproduce `WORKING_LOCAL` from a clean checkout: separately attest the installed pinned client artifact/adapter/effect policy/manifest, optional inventory, and independent interceptor/profile/process-tree scope; run isolated cases through quote/finalization/commit and a no-effect canary; deterministically lose the accepted response; revoke stale token and reconcile read-only; capture/quarantine/sanitize/review/promote the installed failure to a new corpus; then run a genuinely corrected artifact through that promoted case with a fresh interceptor instance. Independent boundary coverage, CLI/API/UI/CI, export, and clean reproduction must agree. User-asserted/declared-hooks-only runs remain diagnostic REVIEW and cannot complete `WORKING_LOCAL`. RP-07/M07 live dry is a separate optional compatibility path and cannot block or upgrade M12. Any whole-client no-egress claim requires sandbox/process-tree evidence.

The final report must keep document QA, product tests, live provider evidence, security review, deployment, and event submission as separate evidence classes.

