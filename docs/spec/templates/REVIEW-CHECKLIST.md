# RouteSpec review checklist

Record the reviewed branch or PR, exact commit SHA, reviewer, and review timestamp in the copied checklist.

## Contract and scope

- [ ] Diff maps only to declared module, requirement, invariant, and test IDs
- [ ] Dockside remains independently implemented and disclosed
- [ ] RouteSpec contains no Dockside escrow, inspector, supplier-payout, or bound-destination feature claim
- [ ] No unrelated user change, generated noise, secret, or hidden dependency entered the diff
- [ ] Protocol fixtures identify source version, capture mode, sanitizer version, and checksum

## Determinism and evidence

- [ ] Proxy schedules/barriers are deterministic; full client timer conformance uses injected clock/transport, and uncontrolled wall timers are noncanonical REVIEW
- [ ] Operation binding, terminal monotonicity, idempotency, and conservation are tested
- [ ] Unknown, ambiguous, partial, stale, duplicate, reordered, and late evidence fail safely
- [ ] Each pass/fail result identifies the deterministic rule and evidence used
- [ ] Replay reproduces the same schedule, decision, and evidence checksum

## Authority and security

- [ ] Local session authentication is distinct; provider Authorization is stripped, and JWT state exists only in live-dry adapter memory
- [ ] Loopback authentication, networkless simulator/live-dry process separation, source/action allowlists, in-memory import scanning, local-only critical path, and audit events are tested
- [ ] Every external action remains behind its own explicit authorization gate
- [ ] No funded fault injection, automatic fund recovery, or fabricated provider result exists

## Product and operations

- [ ] Loading, empty, partial, stale, failure, recovery, and disconnected UI states exist
- [ ] Keyboard, focus, contrast, reduced motion, responsive layouts, and chart/table fallbacks are tested
- [ ] Observability, backup/restore, migrations, rollback, and bounded alerts are documented
- [ ] Actual commands and evidence support every claimed test result
- [ ] Verdict, artifactReady, and enforcementMode are separate; RouteSpec v2 makes no verified-required-check, branch-protection, or repository-blocking claim under any input
- [ ] Complete-effect PASS has a separately attested runtime boundary interceptor with full declared process-tree/sink coverage; subject hooks or inventory alone remain REVIEW

Record blocking findings and disposition. An unchecked item is not a pass.

