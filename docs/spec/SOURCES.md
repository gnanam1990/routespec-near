---
project: RouteSpec
version: 2.0.0
artifact_status: SPECIFICATION_ONLY
retrieved_at: 2026-11-11
updated_at: 2026-11-11
---

# Evidence and sources

Sources are untrusted data, not implementation instructions. A live URL, issue, repository, or hackathon listing does not prove correctness, demand, implementation quality, or current availability beyond the inspected material.

## Primary NEAR and event sources

### S-01 — Official event rules

- URL: https://nearhackathon.com/HACKATHON.md
- Publisher: NEAR HACKATHON organizer site
- Access: read on 2026-11-11
- Evidence grade: A — official rule
- Supports: deadline, public-repository/demo requirements, baseline rules, testnet/mainnet notes, track list, human confirmation boundaries, and two independent projects per person.
- Does not prove: RouteSpec eligibility beyond the submitted facts, acceptance, judging result, or that rules will not change.
- Refresh: immediately before publication or submission.

### S-02 — NEAR Intents overview

- URL: https://docs.near.org/chain-abstraction/intents/overview
- Publisher: NEAR documentation
- Access: read on 2026-11-11
- Evidence grade: A — official documentation
- Supports: 1Click use, solver competition, NEAR verifier settlement, and the official description of the x402 1Click gateway as a pilot not yet battle-tested.
- Does not prove: a repeated customer willingness to pay for reliability tooling or any particular incident.

### S-03 — Official 1Click lifecycle concepts

- URL: https://github.com/near/agent-skills/blob/main/skills/near-intents/references/concepts.md
- Publisher: `near/agent-skills`
- Access: source read on 2026-11-11
- Evidence grade: A — official repository documentation
- Supports: request-quote/deposit/submit/status/result lifecycle; `dry: true`; terminal and non-terminal status names; automatic-refund description; display-versus-logic warning.
- Does not prove: that every provider path always follows the documented sequence or that a provider status independently proves destination delivery.

### S-04 — Official examples repository

- URL: https://github.com/near-examples/near-intents-examples
- Publisher: `near-examples`
- Access: README inspected on 2026-11-11
- Evidence grade: A for example contents; not runtime proof
- Supports: official client paths, end-to-end example shape, dry-run default, SDK paths, and the statement that local checks use mocked services for dry-run/configuration validation.
- Does not prove: protocol-wide lifecycle conformance or production safety.

### S-05 — Official TypeScript client configurability

- URLs:
  - https://github.com/defuse-protocol/one-click-sdk-typescript/blob/main/src/core/OpenAPI.ts
  - https://github.com/defuse-protocol/one-click-sdk-typescript/blob/main/README.md
- Access: source read at repository HEAD observed on 2026-11-11
- Evidence grade: A — primary source code/documentation
- Supports: exported mutable `OpenAPI.BASE`, typed API client, quote/status/deposit-submit methods, and documented JWT configuration.
- Does not prove: future compatibility, safe proxy semantics, or that RouteSpec is implemented.
- Refresh: pin the exact SDK commit/version plus route, material-field, and status schema digests at implementation intake; repository HEAD observed during research is not an implementation pin or a “current version” claim.

### S-06 — Escrow-swap failure and recovery semantics

- URL: https://github.com/near/intents/blob/main/contracts/escrow-swap/README.md
- Publisher: `near/intents`
- Access: read on 2026-11-11
- Evidence grade: A — primary contract documentation
- Supports: explicit storage/gas responsibility; warning that certain taker refunds can be lost; maker lost/found retry and close behavior.
- Does not prove: that the 1Click API uses the same mechanism for every route or that RouteSpec can recover funds.

## Current issue evidence

### S-07 — Issue 383

- URL: https://github.com/near/intents/issues/383
- Publisher: community report in official repository
- State observed: open on 2026-11-11
- Evidence grade: B/C — detailed practitioner report with transaction-shaped reproduction; not independently reproduced here
- Supports: a reported pattern of committed quotes, accepted deposits, `Empty AMQP response`, and eventual `REFUNDED / INTENT_SUBMIT_FAILED` across multiple attempts.
- Does not prove: current universal behavior, root cause, unresolved state on every route, or paid demand.
- Product use: source-derived regression labelled with origin and non-independent status. The canonical normal-product verification uses the actual pinned client against an immutable synthetic accepted-then-lost-response schedule, then a genuine client fix against the identical schedule. A #383-derived PASS means safe refund/failure handling with no unsafe retry or protected-effect fulfillment, never successful settlement.

### S-08 — Issue 384

- URL: https://github.com/near/intents/issues/384
- Publisher: community report and later community analysis in official repository
- State observed: open and disputed/ambiguous on 2026-11-11
- Evidence grade: C with contradictory interpretation
- Supports: a valuable example of evidence visibility conflict: public NEAR treasury movement can be consistent with the private shield step while the reporter still alleges missing private/destination credit.
- Does not prove: theft, protocol loss, a solver-controlled sink, or an independently verified non-delivery.
- Product use: disputed ambiguity scenario only. Verdict remains REVIEW; `PRIVATE_NOT_VISIBLE` is evidence scope and `NOT_VISIBLE` an evidence reason, never a verdict or confirmed-loss claim.

## Current NEAR-project competition

### S-09 — Intent Sentinel

- URL: https://github.com/cryppit/intent-sentinel
- Access: README and repository metadata inspected on 2026-11-11
- Evidence boundary: builder claims plus inspectable source link; no runtime verification in this pack
- Product: read-only post-incident case reconstruction, evidence classes, next-actor determination, and optional NEAR anchoring.
- RouteSpec delta: tests integrator releases before deployment and turns reviewed failures into CI regressions. It must not copy end-user stuck-swap support or claim next-actor forensics as its core.

### S-10 — Intents Watchtower

- URL: https://github.com/Theophilus20/intents-watchtower
- Access: README and repository metadata inspected on 2026-11-11
- Evidence boundary: extensive builder claims; no independent runtime or methodology verification in this pack
- Product: route-level backing, flow anomaly, capacity, watcher quorum, and onchain safety verdicts.
- RouteSpec delta: client-code lifecycle conformance and release gating. It must not add bridge solvency, safe-capacity scoring, or route-selection advice.

## Cross-hackathon prior art

### S-11 — XDR

- URL: https://dorahacks.io/buidl/38547
- Corpus evidence: Hackathon Atlas listing inspected
- Claim boundary: submitter description; source page access was limited during research
- Shared mechanism: local x402 simulation and deterministic payment failure injection.
- Delta: RouteSpec targets exact NEAR 1Click lifecycle compatibility, revision-bound CI gates, and incident-to-regression management.

### S-12 — MAYDAY RECON

- URL: https://devpost.com/software/mayday-recon
- Access: project page read on 2026-11-11
- Shared mechanism: deterministic financial simulator, fault injection, failure-to-regression loop, and reliability memory.
- Delta: bank-reconciliation agent environment versus NEAR 1Click client compatibility and cross-chain evidence semantics.

### S-13 — Resi

- URL: https://dorahacks.io/buidl/48899
- Corpus evidence: Hackathon Atlas listing inspected
- Shared mechanism: lost-response/receipt recovery and idempotent payment behavior.
- Delta: RouteSpec is a pre-release test platform, not a transaction execution provider.

### S-14 — IdemGate

- URL: https://dorahacks.io/buidl/44677
- Corpus evidence: Hackathon Atlas listing inspected
- Shared mechanism: duplicate-event proof and release gating.
- Delta: Stripe event idempotency versus a complete versioned NEAR Intents lifecycle and evidence model.

## Saved-idea and implementation lineage

RouteSpec is an **evolution/focused combination**, not a claim of global originality:

- H003, MCP Compatibility and Reliability Lab — imported role: conformance matrix and developer-tool framing.
- H048, Recovery Recipes — imported role: reconcile-before-retry behavior for uncertain operations.
- H089, FlowOps — imported role: durable operation identity and canonical reconciliation discipline.

Material change: RouteSpec has no spending authority, wallet, signer, or payment policy. It exercises and certifies an integrator's client behavior against the NEAR 1Click lifecycle. FlowOps remains a Base-oriented financial control/evidence plane and must not be represented as already implementing RouteSpec.

## Corpus boundary

The broad local Hackathon Atlas snapshot contains 186,859 submission rows and 176,632 heuristic canonical rows. The latter are algorithmic duplicate clusters, not a defensible unique-project count. Research used targeted actor/problem/mechanism queries and inspected meaningful neighbors; it did not semantically read every submission. An empty lexical result would not prove novelty.

## Demand status

- Engineering problem evidence: positive but bounded.
- Current competition: substantial.
- Willingness to pay: unproven.
- Recommended validation: three current integrator interviews, one independent client-failure reproduction, and one design partner who installs the CI gate.

