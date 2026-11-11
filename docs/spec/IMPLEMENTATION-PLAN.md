# RouteSpec Implementation Plan

Status: **SPECIFICATION_ONLY**  
Implementation: **NOT_RUN**  
Feasibility: **CONDITIONAL_ON_PROJECT_GATES**

## Planning principles

- Build a real end-to-end product, not a presentation prototype.
- Large category vision is allowed; central claims must still be implemented and verified.
- Keep `RouteSpec` independent from sibling submission `Dockside`; do not import or claim its escrow, inspector, supplier-payout, or bound-destination workflow.
- Proposed repository is private under `gnanam1990/routespec-near`; existence and access are unverified until checked.
- Deadline recorded for planning is **2026-11-14T23:59:00Z**. Re-verify it before event actions.

## Phase 0 — evidence and baseline

1. Verify official rules and required NEAR integration.
2. Verify the critical provider/API/contract capability with a read-only or sandbox probe.
3. Record current repository existence, exact base SHA, working tree, license, and pre-event functionality.
4. Create `BUILD-STATUS.md` and the initial decision records.
5. Mark every dependency as VERIFIED, DOCUMENTED_ONLY, UNVERIFIED, BLOCKED, or NOT_APPLICABLE.

Kill or redesign the central claim if an unavoidable platform capability is unavailable, the control point is bypassable, or authoritative outcome evidence cannot be obtained.

## Phase 1 — foundations

- Repository/toolchain bootstrap
- Configuration validation and secret-safe startup
- Domain types and state machine
- Durable storage and migrations
- Authentication/authorization boundary
- Exact official SDK/schema/status-profile intake pin
- Single-writer SQLite queue, busy timeout, explicit transactions, fencing epochs, checkpoint/backup, and disk-full behavior
- Structured logs, trace/correlation IDs, and error taxonomy
- Unit-test and CI baseline

Exit evidence: clean build, migrations from empty state, authentication rejection tests, deterministic state-machine tests, and documented configuration.

## Phase 2 — critical product loop

Implement the smallest complete causal loop:

`trust-root-attested pinned 1Click client + versioned adapter + separately attested boundary interceptor → isolated GateRun/CaseRun → networkless proxy/no-effect canary → deterministic accepted-then-response-loss → durable phased operation/effect journal → fenced read-only reconciliation → invariant/gate evaluation → installed trace quarantine/review → new immutable scenario/corpus → corrected-client rerun with fresh interceptor`

Requirements:

- mandatory build/artifact/effect-manifest identity and launcher/CI attestation boundary; unattested local runs stay user-asserted;
- logical-job versus build/gate/case-scoped run-operation identity with typed lineage and no cross-case evidence merge;
- quote request, atomic quote finalization, one-time atomic commit material binding, and read-only reconciliation phases;
- per-case token/client/reset lifecycle, bounded parallelism, stale-token revocation, epoch fencing, and reconciliation-only recovery;
- effect policy/manifest plus separate subject reports and trust-root-attested runtime boundary interception over the complete declared process tree and sink classes; call-site inventory is supplemental, and declared hooks or inventory alone force REVIEW;
- mandatory local control API/project-revision-build matrix;
- the one shared `ExecutionLifecycle` plus separate Verdict and evidence class/scope/reason axes;
- no unsafe retry while outcome is uncertain;
- a separate optional live-dry compatibility probe outside the `WORKING_LOCAL` critical path;
- installed capture -> quarantine -> sanitize -> deterministic replay -> review -> new scenario/corpus -> corrected installed-client rerun;
- independent evidence sufficient for the product's claim;
- a normal user recovery path without hidden database edits.
- lease fencing limited to session/execution writes; administrative/project/import/export writes use the single writer with idempotency and optimistic revision.

The invariant kernel owns every authoritative verdict. Keep execution lifecycle, verdict, evidence, subject/interceptor attestation, effect-coverage basis/finding, `artifactReady`, capped enforcement, and official compatibility separate; NOT_VISIBLE is an evidence reason. Explanation models may summarize only.

## Phase 3 — product interface

- Task-oriented information hierarchy
- Connected authentic state
- Loading, empty, partial, success, failure, retry, permission-denied, offline/disconnected states
- Evidence drill-down with identifiers and provenance
- Keyboard operation, visible focus, accessible labels/contrast, reduced-motion behavior
- Responsive acceptance checks at relevant desktop and mobile widths

## Phase 4 — adversarial verification

Test at least:

- duplicate request/callback;
- timeout before outcome is known;
- late success after client timeout;
- stale or conflicting subject reports, forged/stale interceptor identity, process-tree escape, unsupported sink/dynamic call, channel loss, and missing interceptor teardown;
- restart during an in-flight operation;
- provider/network outage;
- unauthorized or over-limit action;
- malformed evidence;
- recovery replay;
- sibling-project isolation and configuration separation.

## Phase 5 — integration and operations

- CI build, lint, type, unit, integration and end-to-end checks
- Observability and bounded alerts
- Backup/restore and migration rollback
- Dependency pinning and vulnerability review
- Least-privilege credentials and secret rotation plan
- Local run/CI packaging and rollback; hosted collaboration remains future/excluded
- Architecture, threat model and runbook documentation

## Phase 6 — delivery and artifacts

- Focused module branches and commits
- One reviewed PR per coherent module or dependency chain
- Exact command/result evidence in `BUILD-STATUS.md`
- Real architecture diagram
- Reproducible setup
- Normal-product recording only after `REAL-PRODUCT-GATE.md` passes
- Sibling disclosure
- Final submission draft

## Branch and PR map

| Order | Suggested branch | Scope | Merge dependency | Evidence required |
|---:|---|---|---|---|
| 1 | `feat/foundation` | Toolchain, state model, storage, CI | None | Build/unit/migration |
| 2 | `feat/core-loop` | Critical workflow and NEAR integration | Foundation | Integration and real/sandbox trace |
| 3 | `feat/recovery` | Reconciliation, uncertainty, failure paths | Core loop | Fault-injection results |
| 4 | `feat/product-ui` | Complete operational UI | Core state contracts | UI and accessibility checks |
| 5 | `chore/operations` | Deployment, observability, security | Core/recovery | Runbook and smoke evidence |
| 6 | `docs/submission` | Architecture, verified-product recording, disclosure | Verified build and product gate | Artifact checklist |

Remote creation, push, PR opening, merge, deployment, visibility changes, live dry-provider access, public posting, and submission each require explicit authorization. Until authorized, prepare local branches, commits, diffs, and draft PR artifacts only. Funded behavior is not part of RouteSpec.

