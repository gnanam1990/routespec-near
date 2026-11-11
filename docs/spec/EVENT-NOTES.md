---
project: RouteSpec
version: 2.0.0
artifact_status: SPECIFICATION_ONLY
event_fact_status: POINT_IN_TIME_2026-11-11
submission_status: NOT_RUN
updated_at: 2026-11-11
---

# NEAR HACKATHON event notes

These notes summarize the official `HACKATHON.md` retrieved on 2026-11-11. They are point-in-time facts. The official file explicitly says to read it again before submitting.

## Current official facts

| Item | Current rule |
|---|---|
| Event | NEAR HACKATHON |
| Development/submission deadline | `2026-11-14T23:59:00Z` |
| India conversion | `2026-11-15 05:29:00 IST` |
| Repository | Must be public before the deadline and remain public through judging |
| Submission count | One submission per project; one person may submit at most two different projects |
| Two-project rule | Projects must be independent and disclosed; each README names the other project |
| Existing work | Allowed with baseline disclosure; only qualifying in-window work is judged |
| Intents testnet | Official rules say no Intents testnet; use mainnet with tiny amounts or `dry: true` quotes |
| Testnet-only eligibility | Eligible for all tracks where the integration supports it |
| Local demo | Allowed with reproducible public repository and public X demo video; hosted demo is a plus |
| Human-controlled actions | Publication, repository visibility, wallet/signing, spending, and submission require explicit human action/confirmation |
| Required public artifact | X post naming the event, tagging `@NEARProtocol` and `#NEARHackathon`, with demo video or screenshots |

Source: https://nearhackathon.com/HACKATHON.md

## RouteSpec track selection

Recommended truthful selection:

1. `open` — primary; RouteSpec creates chain-abstraction reliability infrastructure.
2. `security` — conditional only if the working submission demonstrates a real agent-security adapter and its security claim, not merely generic release safety.
3. `agents` — select only if the working product contains and demonstrates a real agent/x402 integration adapter. Do not select it based on roadmap copy.

Do not add `defi`, `business`, `privacy`, or `realworld` merely because the tested integrations may operate in those domains.

## Sibling disclosure text

The README of each eventual public repository should use substantively equivalent language, updated with real URLs only after they exist:

> This is one of two independent NEAR HACKATHON projects proposed by the same lead. The other project is Dockside. RouteSpec is a local reliability and release-regression product for engineers integrating NEAR Intents 1Click. Dockside is a separate supplier-trade escrow product for importers, suppliers, and named inspectors. They use separate repositories, codebases, state, contracts, demos, and submissions; neither is a second submission of the same product.

This pack contains no repository URLs because none are established here. Do not invent them.

## Independence requirements

- Separate repositories and root histories.
- Separate product names, users, economic buyers, data models, and critical paths.
- No shared frontend presented with two labels.
- No copied commit history or branch submitted twice.
- If a pre-existing generic library is reused, disclose its original repository, license, baseline commit, and each project's new integration.
- RouteSpec must not include solver lending, liquidity pools, repayment waterfalls, or underwriting.
- Dockside must not present RouteSpec's conformance runner, regression corpus, release decision, or developer-console workflow as its core.
- RouteSpec must not present Dockside's escrow, inspection attestation, payout-address binding, or supplier-payment workflow as its own feature.

## RouteSpec continuity disclosure

This build pack is `SPECIFICATION_ONLY` and does not establish a code baseline. If implementation begins, the public README must state:

- repository creation date and first commit;
- any files copied from prior projects and their exact license/origin;
- any FlowOps or other existing code reused, with baseline commit and material RouteSpec-specific changes;
- AI coding tools used and human verification performed;
- exact tested commit and what remains simulated, dry-only, unsupported, or not run.

## Required submission artifacts

- Public repository with license, truthful README, setup, “do X / see Y” verification, architecture diagram, test evidence, baseline disclosure, and sibling disclosure.
- Public demo post produced and published by the human.
- A real demo video is mandatory for this local-only product; screenshots may supplement it but do not replace it, even if the event's general rule allows screenshots.
- Product recording made after the normal path passes `REAL-PRODUCT-GATE.md`: actual pinned official client redirected to the installed local proxy, a deterministic unsafe retry exposed, genuine client code or configuration fixed, the identical immutable regression passing, and an ambiguous case remaining blocked.
- Submission description explaining the problem, the working product, and NEAR's concrete role.
- Mainnet NEAR payout address supplied by the human.
- Contact consent explicitly accepted by the human.

## Submission safety

This pack does not authorize:

- making a repository public;
- pushing or force-pushing;
- posting to X;
- signing or funding any transaction;
- creating partner credentials;
- submitting or changing an event application.

Immediately before submission, refresh the official rules, inspect the final repository at the exact submitted HEAD, verify the public demo URL, print the complete submission payload without secrets, and obtain explicit human confirmation. A network retry must reuse the same request ID; a saved submission error is corrected through the official change-request flow, not a duplicate submission.

## Deadline versus product scope

RouteSpec's category vision remains large. The deadline does not justify hard-coded success, a fake hosted dashboard, unreviewed incident claims, or real-fund fault injection. If complete critical-path proof is unavailable, report the actual implemented boundary and `NOT_RUN`/`UNVERIFIED` areas rather than presenting the roadmap as shipped.

