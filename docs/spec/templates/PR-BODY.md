# RouteSpec pull-request body

## Outcome and scope

Describe the integrator outcome, module IDs, requirements, invariants, tests, dependencies, exclusions, and exact base/head SHAs. State whether this change touches the local proxy, capture/redaction, virtual time, invariant kernel, reports, local control API, project/revision/build matrix, or release gate.

## Evidence

List only commands actually run. For formatting, types, unit, integration, end-to-end, fault/recovery, and accessibility checks, provide the command, observed result, and evidence path. Label every dependency as local, deterministic replay, mocked, or dry probe. Funded flow is unsupported. Do not call replay evidence a live provider result.

## Safety review

- [ ] Local session authentication is distinct; provider Authorization is stripped, and any JWT exists only in live-dry adapter memory
- [ ] Integer amounts and operation bindings remain exact
- [ ] Unknown or unobservable outcomes never become pass
- [ ] Proxy schedules/response barriers are deterministic; client timer claims use injected clock/transport or are labelled noncanonical REVIEW
- [ ] Decision, artifactReady, and enforcementMode remain independent; RouteSpec v2 makes no verified-required-check, branch-protection, or repository-blocking claim under any input
- [ ] Subject effect reports and call-site inventory never substitute for independently attested runtime boundary interception; declared-hooks-only coverage remains REVIEW
- [ ] Imports are scanned in memory; secret-bearing source bytes are rejected and never uploaded or persisted
- [ ] No real-money fault injection, automatic recovery, or unsupported solvency claim was introduced

## Delivery state

Record migration and rollback steps, unresolved gates, sibling-project sharing, reviewer findings, and final CI state. A prepared body does not authorize push, PR creation, merge, deployment, live dry-provider access, publication, or submission.

