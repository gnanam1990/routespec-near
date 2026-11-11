# RouteSpec coding-agent contract

This directory is a `SPECIFICATION_ONLY` handoff. It contains no implementation, no executed product tests, no deployment evidence, and no market validation. Read `START-HERE.md`, `CORE-CONTRACT.md`, `PRD.md`, `TDD.md`, `SECURITY.md`, `TEST-PLAN.md`, `DELIVERY.md`, and every dependency-ordered module prompt before writing code.

## Non-negotiable boundaries

- The mandatory control plane is loopback-local. The 1Click JWT may exist only in the separately launched live-dry adapter's memory after policy; it never enters the networkless scenario proxy, local database, console, or artifacts.
- The deterministic invariant kernel, not a language model, owns pass/fail results.
- RouteSpec has no funded mode. Live integration is limited to allowlisted read-only or `dry: true` probes; user approval cannot convert this product into a funded runner.
- Verdict is `PASS|FAIL|REVIEW|NOT_RUN|UNSUPPORTED`; evidence class and scope/reason are separate. `NOT_VISIBLE` is an evidence reason, and partial/private/stale/unsupported/missing required evidence is REVIEW unless FAIL dominates.
- Never send a transaction, spend funds, expose a repository, push a branch, open or merge a pull request, deploy, post publicly, or submit to the event without the user's explicit approval for that exact action.
- Do not add automated fund recovery, insurance, route-backing claims, AI-generated production patches, or a decorative on-chain anchor.
- Never commit secrets, personal data, raw authorization headers, recipient identifiers, or unsanitized production captures.

## Implementation discipline

1. Run the documented preflight and record versions and missing dependencies without guessing.
2. Work module by module in the dependency order declared in `requirements.json`.
3. Before a module, restate its mapped requirements, invariants, tests, and dependencies.
4. Write a failing test, implement the smallest coherent behavior, then refactor while keeping the test green.
5. Keep proxy schedules, response barriers, and injected client clocks/transports deterministic. Uncontrolled external wall timers are noncanonical REVIEW evidence, not canonical conformance.
6. Preserve exact integer amounts and four-phase operation bindings: quote request excludes assigned deposit address; quote response finalizes atomically; first commit material binds once; reconciliation is read-only. Logical jobs never merge build/gate/case-scoped run operations.
7. Use durable state transitions, idempotency keys, checksums, redaction, and checksummed evidence manifests. Do not claim signatures until a signing ADR exists.
8. Update evidence records only with commands actually run and outputs actually observed.
9. Stop when an external credential, provider capability, production trace, legal conclusion, or user authorization is required. Mark the gate `UNVERIFIED` or `NOT_RUN`; do not fabricate a substitute.
10. Use distinct control and one-time case/recovery tokens bound to build/client/case/epoch plus stable correlation headers; revoke stale authority before recovery; strip provider Authorization/local headers; keep networkless core separate from live dry.
11. Emit only local-advisory, CI-check, or required-check-unverified state. Never claim repository blocking or trust caller-supplied protection state.
12. Keep build registration immutable and user-asserted; trusted build/case/inventory/interceptor claims are separate immutable attestations from enrolled trust roots with freshness and revocation checks.
13. Treat subject effect hooks and call-site inventory as insufficient for completeness. Complete-effect PASS requires a separately attested runtime boundary interceptor outside the subject; otherwise force REVIEW. Never execute a real downstream effect in tests.

## Repository workflow

The proposed remote is `gnanam1990/routespec-near`, initially private. Verify the owner, name availability, authentication state, and default-branch policy before proposing any remote mutation. Local repository initialization and local commits may follow `DELIVERY.md`; remote creation, push, visibility change, pull-request creation, merge, deployment, live dry-provider access, X post, and event submission each require explicit user authorization. Funded actions remain outside the product even with approval.

Keep `main` protected. Use one focused branch per module, conventional commits, the supplied PR template, and a true review record. Do not force-push or rewrite shared history. A document/checker pass never counts as implementation or product-test evidence.

