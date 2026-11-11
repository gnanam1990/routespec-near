---
project: RouteSpec
version: 2.0.0
artifact_status: SPECIFICATION_ONLY
product_runtime_status: NOT_RUN
repository_status: NOT_CREATED
updated_at: 2026-11-11
---

# RouteSpec build pack

RouteSpec is a proposed installable local-first and CI reliability product for teams integrating NEAR Intents 1Click. It binds the installed pinned official client artifact through a versioned adapter into isolated networkless cases, drives deterministic lifecycle failures, journals phased quote/commit/reconciliation behavior, and distinguishes subject effect reports from trust-root-attested independent boundary interception. It promotes sanitized installed traces into new immutable regressions and reruns the corrected client. The proxy and independent no-effect canary boundary are real product mechanisms, not demo mocks. v2 emits advisory/CI/required-check-unverified evidence only and never claims repository blocking.

This folder is documentation only. It does not establish that a repository, application, deployment, test result, NEAR integration, submission, or public product exists.

## Product thesis

Cross-chain payment clients are usually exercised on the happy path even though their dangerous failures occur between systems: a mutation may land after the caller times out, an accepted deposit may later refund, a terminal status may conflict with independently visible evidence, or a private leg may be impossible for a public observer to prove. RouteSpec makes the client integration—not an AI explanation—the test subject.

The central loop is:

`integration revision -> deterministic scenario -> recorded lifecycle -> invariant evaluation -> release decision -> reviewed failure becomes regression`

The product is a local developer and CI tool with a real CLI, control API, durable store, console, clean-install workflow, failure/recovery behavior, and separately isolated official live-dry compatibility adapter. It never needs custody, a spending key, an inline production gateway, or an AI model to determine PASS or FAIL. `REAL-PRODUCT-GATE.md` defines the evidence required before any working-product claim.

## Hard boundaries

- Default network binding is loopback only.
- `SIMULATE` and `REPLAY` accept mutation-shaped requests only inside a networkless scenario runtime with no upstream client or provider credential. `LIVE_DRY_PROBE` is a separately launched egress-capable adapter that may request `dry: true` quotes and explicitly allowed reads; it rejects every mutation before credential attachment, DNS, or socket creation.
- The tested client uses a one-time case token bound to exact build/client/gate/case/session/adapter/phase/epoch plus stable non-secret correlation headers; recovery revokes stale authority. Provider Authorization and local headers are stripped/redacted. A 1Click JWT exists only in separate dry-adapter memory after policy and never enters persistent or browser artifacts.
- Scenario and trace inputs are untrusted data. They cannot execute shell commands, JavaScript, templates, or arbitrary network calls.
- Missing, private, contradictory, stale, unsupported, or unverified evidence cannot become PASS.
- Operation identity separates immutable request-known fields from a profile-declared response-assigned set that finalizes atomically once; partial or changed re-finalization cannot rewrite history.
- Report checksums and optional NEAR hashes prove artifact identity only. No signing claim exists until a signing ADR is accepted, and neither checksum nor hash proves that the runner, scenario, upstream provider, or asserted outcome was truthful.
- RouteSpec's no-egress claim covers its networkless scenario processes. Covering the complete tested-client process tree requires a documented OS/container sandbox and process-tree DNS/socket instrumentation.
- RouteSpec does not score bridge solvency, operate a recovery service, insure transfers, move customer funds, or promise exactly-once behavior from third-party systems.

## Pack map

1. [START-HERE.md](START-HERE.md) — reading order, status vocabulary, and implementation intake gates.
2. [MASTER-PROMPT.md](MASTER-PROMPT.md) — root coding-agent operating contract and delivery sequence.
3. [PRD.md](PRD.md) — users, scope, numbered requirements, invariants, and acceptance gates.
4. [TDD.md](TDD.md) — proposed technical design, algorithms, state machines, and decision records.
5. [CORE-CONTRACT.md](CORE-CONTRACT.md) — canonical requirement, invariant, and test definitions.
6. [requirements.json](requirements.json) — machine-readable module-to-contract registry.
7. [ARCHITECTURE.md](ARCHITECTURE.md) — components, boundaries, data flow, deployment topology, and failure containment.
8. [API-SPEC.md](API-SPEC.md) — proxy, local control, event, export, and CLI contracts.
9. [DATA-MODEL.md](DATA-MODEL.md) — durable entities, identity, retention, redaction, and constraints.
10. [UI-SPEC.md](UI-SPEC.md) — developer console journeys, design system, responsive behavior, and accessibility.
11. [SECURITY.md](SECURITY.md) — threat model and real-money safety policy.
12. [TEST-PLAN.md](TEST-PLAN.md) — `NOT_RUN` unit, property, integration, restart, security, accessibility, and end-to-end cases.
13. [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md) — dependency-ordered build plan and completion gates.
14. [DELIVERY.md](DELIVERY.md) — repository, branch, commit, PR, review, and merge protocol.
15. [DEPLOYMENT.md](DEPLOYMENT.md) — local, CI, and separately authorized deployment procedures.
16. [DEMO-AND-SUBMISSION.md](DEMO-AND-SUBMISSION.md) — verified-product recording, publication, and submission runbook.
17. [RISKS-AND-GATES.md](RISKS-AND-GATES.md) — product, technical, security, event, and market stop gates.
18. [REAL-PRODUCT-GATE.md](REAL-PRODUCT-GATE.md) — runtime evidence required before working-product claims and forbidden demo substitutes.
19. [EVENT-NOTES.md](EVENT-NOTES.md) — current event rules, track fit, sibling disclosure, and external-action gates.
20. [SOURCES.md](SOURCES.md) — inspected evidence, prior art, and claim limits.
21. [AGENTS.md](AGENTS.md) — repository-local coding-agent instructions.
22. `prompts/` — one implementation prompt for each declared module.
23. `templates/` — build status, decision, PR, and review records.
24. [project-metadata.json](project-metadata.json) — pack status and proposed repository metadata.
25. [pack-check.json](pack-check.json) — structural validation policy.
26. [scripts/check-build-pack.mjs](scripts/check-build-pack.mjs) — bundled offline checker.
27. [PACK-QA.md](PACK-QA.md) — document-only validation record; runtime and fresh semantic evidence remain explicitly separate.
28. `PACK-INVENTORY.json` — generated file membership, sizes, and SHA-256 digests. Regenerate only during the final sealing pass after semantic review.

## Status vocabulary

| Label | Meaning |
|---|---|
| `SPECIFICATION_ONLY` | A design exists; implementation is not asserted. |
| `NOT_RUN` | Verdict when zero required cases started, or pack-level statement that runtime/test evidence has not been produced. Started-but-incomplete required work is REVIEW. |
| `DOCUMENTED_ONLY` | A provider capability appears in an inspected source but has not been exercised here. |
| `UNVERIFIED` | Required behavior or availability remains unchecked. |
| `UNSUPPORTED` | Deliberately outside the declared product contract. |
| `UNKNOWN` | Evidence class for an absent/unresolved fact; it is not a verdict. |
| `NOT_VISIBLE` | Evidence reason for a privacy/authorization boundary; it is not a verdict. |
| `REVIEW` | Verdict for partial, private, missing, stale, unsupported, or identity-mismatched required evidence unless FAIL dominates. |
| `RECOVERY_REQUIRED` | Execution state for interrupted work that cannot yet produce a terminal verdict. |
| `artifactReady` | Independent boolean for requested artifact completion; it never changes the test/evidence decision. |
| `enforcementMode` | `LOCAL_ADVISORY`, `CI_CHECK`, or `REQUIRED_CHECK_UNVERIFIED`; RouteSpec v2 never claims repository blocking. |
| `compatibilityStatus` | Separate `NOT_RUN`, `UNKNOWN`, `INCOMPATIBLE`, or `OFFICIAL_ENDPOINT_COMPATIBLE` result from the real live-dry adapter; it never upgrades the local gate. |

## Sibling-project disclosure

The proposed sibling submission is **Dockside**, a separate inspection-gated supplier escrow and payout-redirection-control product. RouteSpec serves integration engineering and reliability teams; Dockside serves importers, suppliers, and named inspectors. They must use separate repositories, state, code, commits, contracts, deployments, demos, and submissions. RouteSpec cannot claim Dockside's escrow or payout controls, and Dockside cannot claim RouteSpec's client conformance or release-gate workflow. This disclosure records intended independence; it does not claim either submission exists.

## Current evidence state

| Area | State |
|---|---|
| Official 1Click lifecycle/status documentation | `DOCUMENTED_ONLY` |
| Official TypeScript SDK base-URL configurability | `DOCUMENTED_ONLY` by source inspection |
| Issue-derived failure cases | Source reports inspected; no independent live reproduction in this pack |
| RouteSpec proxy, invariant kernel, CI gate, UI | `NOT_RUN` / not implemented |
| Real-money behavior | Prohibited by this specification's default modes |
| Event submission | Not created or authorized |

## Definition of done for a future implementation

A future repository is not complete merely because it builds. `WORKING_LOCAL` requires RP-01 through RP-06 and RP-08: the trust-root-attested pinned client must run isolated cases through the real proxy and a separately attested interceptor over a complete declared process-tree/sink boundary; deterministic response loss must expose unsafe behavior at a no-effect canary; fenced recovery must deny a second mutation; the installed failure must pass quarantine/review/promotion into a new corpus; only a genuine corrected-client full rerun may PASS; independent effect coverage and clean-checkout CLI/API/UI/CI evidence must agree. User-asserted/declared-hooks-only runs remain diagnostic REVIEW. RP-07 is a separate optional compatibility claim. A later video may record the verified path but cannot establish it.

