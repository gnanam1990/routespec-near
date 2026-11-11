---
project: RouteSpec
version: 2.0.0
artifact_status: SPECIFICATION_ONLY
product_runtime_status: NOT_RUN
updated_at: 2026-11-11
---

# Start here

RouteSpec is currently a product specification. Do not infer a repository, implementation, deployment, passing test, partner access, customer, or hackathon submission from this folder.

## Read in this order

1. `README.md` for the product boundary and status vocabulary.
2. `PRD.md` for authoritative functional requirements (`FR-01`–`FR-18`), non-functional requirements (`NFR-01`–`NFR-12`), and invariants (`INV-01`–`INV-12`).
3. `REAL-PRODUCT-GATE.md` before planning implementation or accepting any working-product claim.
4. `SECURITY.md` before selecting any network, credential, trace-capture, or deployment behavior.
5. `TDD.md`, `ARCHITECTURE.md`, `API-SPEC.md`, and `DATA-MODEL.md` for the proposed design.
6. `UI-SPEC.md` for observable product behavior and accessibility.
7. `TEST-PLAN.md` before writing product code. Every listed test begins `NOT_RUN`.
8. `EVENT-NOTES.md` immediately before any event-related publication or submission decision; refresh its live official source.
9. `SOURCES.md` before repeating a market, protocol, competition, or novelty claim.

## Intended implementation posture

The future implementation should be test-driven and evidence-first:

1. Establish a clean repository baseline and record the exact revision.
2. Implement the canonical data types, state machines, and invariant kernel before the dashboard.
3. Make each required test fail for the intended reason before implementing its behavior.
4. Add the networkless scenario proxy, deterministic response barriers, and mandatory local control API/project-revision-build matrix.
5. Prove crash/restart, replay identity, redaction, and safe-mode network denial.
6. Add CI outputs and the product UI using the same persisted evaluator results.
7. Run the `REAL-PRODUCT-GATE.md` clean-checkout, actual-client failure/fix, restart, security, CLI/UI/CI, and reproducibility verification without committed quotes or real-fund mutations.

The proposed implementation stack is Node.js 22 and TypeScript for the proxy, runner, CLI, and web application; SQLite in WAL mode for the local evidence store; React for the console; and Vitest, fast-check, and Playwright for verification. This is a design decision to confirm against the actual repository and installed toolchain at implementation intake, not an existing dependency claim.

## Non-negotiable safety gates

- Bind the control service to `127.0.0.1` by default.
- Let `SIMULATE` and `REPLAY` accept mutation-shaped requests only in the networkless scenario runtime, never upstream or with provider credentials. Treat the separately launched `LIVE_DRY_PROBE` adapter as the only live upstream mode and reject every committed/mutating request before provider credential attachment, DNS, or socket creation.
- Use a one-time case token bound to exact build/client/gate/case/session/adapter/phase/epoch plus stable non-secret correlation headers; revoke stale authority before recovery; strip/redact provider Authorization and every local header at live boundaries. A 1Click JWT exists only in the separately launched dry adapter after policy.
- Redact authorization headers and sensitive query/body fields before any serialization.
- Do not execute imported code, project scripts, shell strings, templates, or network URLs from scenario and trace files.
- Keep execution, verdict, evidence, subject attestation, `artifactReady`, capped enforcement, and official compatibility separate. Zero started required cases is NOT_RUN; incomplete/cancelled/recovery-pending/unattested/uninstrumented/private/missing/stale/unsupported cases are REVIEW unless FAIL dominates; `NOT_VISIBLE` is an evidence reason.
- RouteSpec v2 emits only local-advisory, CI-check, or required-check-unverified state. It has no repository-settings verification adapter, never claims blocking, and authorizes no repository configuration.
- Build registration remains immutable and user-asserted. Trusted subject, inventory, and interceptor identity use separate attestation records from enrolled local-launcher or CI OIDC trust roots; no later record upgrades the build or GateRun.
- Subject effect hooks and call-site inventory cannot prove completeness. A complete-effect PASS requires a separately attested runtime boundary interceptor covering the declared process tree and sink classes; otherwise the result is REVIEW. Tests deny or redirect to a no-effect canary and never invoke the real downstream target.
- Do not add an AI evaluator to PASS/FAIL. An optional model may summarize an already determined result, clearly labelled as non-authoritative.

## Implementation intake checklist

Before code is authored, the implementing agent must report:

- repository path, branch, exact HEAD, remote, dirty/untracked state, and repository instructions;
- installed Node/package-manager/browser versions;
- whether a repository already exists and whether any pre-event baseline must be preserved;
- chosen package manager and lockfile policy;
- proposed dependency versions and licenses;
- exact official SDK commit/version selected and whether it still exports a configurable base URL;
- exact route/material-field/status schema digests, including request-known versus response-assigned field classification, one-time atomic finalization rules, mappings for `PENDING_DEPOSIT`, `KNOWN_DEPOSIT_TX`, `PROCESSING`, `SUCCESS`, `INCOMPLETE_DEPOSIT`, `REFUNDED`, and `FAILED`, plus unknown-value fail-closed behavior;
- current event rules and deadline if the event remains relevant;
- local ports, data directory, and retention defaults;
- any conflict between this pack and current provider behavior.

Stop and escalate rather than silently changing the product if the official SDK can no longer target a local base URL, the documented lifecycle materially changes, safe-mode rejection cannot be enforced before network I/O, or the required evidence cannot be represented without storing secrets.

## External-action boundary

This pack does not authorize account creation, partner/JWT registration, paid API use, wallet signing, real-fund transfer, deployment, repository creation, push, pull request, merge, publication, demo post, event submission, or contact with organizers or potential customers. Local implementation and local focused commits are authorized only when the user separately invokes the build instructions in an intended repository.

## Sibling independence

The intended second project is Dockside. RouteSpec and Dockside must not share a repository or present one combined product. RouteSpec owns client conformance and regression release evidence; Dockside owns trade escrow, inspection attestation, bound payout destination, and payout reconciliation. If a generic utility is later reused, its pre-existing origin, license, baseline commit, and project-specific integration must be disclosed independently. See `EVENT-NOTES.md`.

