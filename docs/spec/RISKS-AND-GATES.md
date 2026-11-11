# RouteSpec Risks and Decision Gates

Status: **SPECIFICATION_ONLY**  
Risk controls tested: **NOT_RUN**  
Demand: **UNPROVEN**

## Critical gates

| Gate | Required evidence | Current state | Failure response |
|---|---|---|---|
| Official eligibility | Refreshed organizer rules and account eligibility | UNVERIFIED | Do not submit |
| Two-project allowance | Rule permits two independent entries and relationship is disclosed | DOCUMENTED_ONLY | Clarify or submit one |
| Protocol fidelity | Actual pinned official client, immutable scenarios, proxy, and adapters match current official 1Click schemas and statuses | NOT_RUN | Do not market compatibility |
| Authoritative outcome | Non-replayable evidence identifies the exact operation and outcome | NOT_RUN | Do not automate release/retry |
| Repository enforcement | RouteSpec v2 never claims verified required-check state, branch protection, or release blocking; it has no repository-settings verification adapter | OUT_OF_SCOPE_V2 | Report only LOCAL_ADVISORY/CI_CHECK/REQUIRED_CHECK_UNVERIFIED and reject caller-supplied protection state |
| Deterministic replay | Same scenario version produces the same schedule, decision, and evidence digest | NOT_RUN | Block release-gate use |
| Capture privacy | Local project/revision/session scoping, sanitizer allowlist, and review workflow reject secret or personal-data persistence | NOT_RUN | Disable import promotion/export |
| Release adoption | One real integrator can gate a build without changing its production client | UNPROVEN | Keep runner local and revise onboarding |
| Persistence/recovery | Restart, timeout, duplicate and late outcome tests | NOT_RUN | Block deployment |
| Security/privacy | Threat review, least privilege, secret and data handling checks | NOT_RUN | Block public/production use |
| Product usability | Clean-install fresh-user end-to-end run and failure/retry UI checks | NOT_RUN | Do not claim a working product |
| Deployment | Authorized target, exact SHA, smoke and rollback evidence | NOT_RUN | Keep local/private |
| Demand | Operator interviews, design partner or paid signal | UNPROVEN | Treat business model as hypothesis |

## Principal risks

### Platform and integration

- Official API/contract behavior may differ from documentation.
- Partner access, rate limits, KYC/KYB, test assets, or mainnet-only behavior may block the critical loop.
- Sponsor functionality may already absorb the proposed product.

Response: perform a bounded real probe first; keep the verdict conditional until observed evidence exists.

For RouteSpec, the bounded real probe is read-only discovery plus a dry quote through the isolated live-dry adapter. Incident issues establish scenario relevance, while the working-product claim requires the actual pinned client and full local proxy/journal/evaluator path from `REAL-PRODUCT-GATE.md`; neither establishes current provider failure or a successful funded integration.

### Financial and state integrity

- Duplicate execution, replay, stale status, partial settlement, unknown-after-submit, and incorrect reconciliation can cause loss.
- An unintended egress path could let the external client bypass RouteSpec or let the dry adapter send a mutating request.

Response: logical-job versus build/gate/case-scoped run-operation identity, atomic quote/commit phase binding, per-case token/client lifecycle, durable single-writer journal, fenced reconciliation-only recovery, effect policy/manifest plus independently attested boundary interception, explicit REVIEW states, networkless runtime, and separately evaluated live-dry policy. Subject hooks or inventory alone force REVIEW; do not claim full client-process no-egress without sandbox/process-tree evidence.

### Security and privacy

- Credential leakage, overbroad roles, insecure callbacks, supply-chain compromise, log leakage, and private-data retention.

Response: least privilege, allowlists, distinct local session auth, provider-Authorization stripping, memory-only live-dry JWT, secret-safe logs, dependency pinning, origin/auth checks, retention limits, and adversarial tests.

### Product and evidence

- A polished dashboard may hide mocked or stale state.
- A successful video may not reproduce.
- Testnet or dry-run behavior may be misrepresented as production.

Response: authentic connected state, visible evidence/provenance, recorded build SHA, reproducibility instructions, and explicit dependency labels.

### Competition and demand

- A name/title search can miss close competitors.
- Hackathon attention and prize pools do not establish buyer willingness to pay.
- Sponsor roadmaps may subsume the product.

Response: inspect nearest mechanisms and current products, interview target operators, and separate event fit from commercial validation.

### Legal and compliance

- Production captures may contain personal or commercially sensitive data, and provider terms may restrict probing or retention.

Response: RouteSpec must not move or recover customer funds. Obtain privacy/data-rights and provider-terms review before accepting production captures; raw traces remain local and hosted collaboration stays future/excluded.

### Delivery and sibling-project independence

- Shared code/history or duplicated narratives may undermine two independent submissions.
- Deadline pressure may encourage unreviewed merges or public actions.

Response: separate private repos, branches, PRs, deployments, videos and submissions; disclose shared generic templates; preserve separate product loops. Deadline **2026-11-14T23:59:00Z** never overrides authorization or truthfulness.

## Authorization gates

Explicit user permission is required for remote repo creation/change, push, PR open/update/merge, deployment, domain/cloud changes, public visibility, live dry-provider access, X/public posting, terms, and final submission. Each permission is scoped and non-transferable. Funded actions and wallet signing remain unsupported rather than becoming available through approval.

## Recommendation-flip record

Create a decision record whenever a gate changes the architecture, product claim, track, network, release, or submission plan. Do not silently waive a failed gate.

