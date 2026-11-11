# ADR-0012 — Gate runner, CLI, release-gate aggregation, reports, and evidence bundles

- Date: 2026-11-11. Decision owner: RouteSpec engineering (M06 stage), pending user review.
- Status: ACCEPTED
- Related: FR-07, FR-12, FR-13, FR-14, FR-17, FR-18, NFR-04, NFR-05, NFR-09, INV-09, INV-12;
  module M06 (T-012, T-025, T-034, T-035, T-041, T-046, T-053, T-057). Builds on ADR-0004
  (journal), ADR-0006 (scenario runtime), ADR-0007 (proxy, adapter, supervisor), ADR-0009
  (kernel), ADR-0010 (regressions privacy scan).

## Context

The pack fixes the release-gate precedence, the stable exit codes, the separation of decision,
artifact readiness, and enforcement mode, and the rule that RouteSpec never launches integrator
commands. It leaves open how a gate run reaches the actual client, what exactly a gate decision
binds and how a stale or interrupted case is detected, how reports agree, what a bundle is, and
how export confirmation works on a command line.

## Decisions

1. **Package boundary.** `@routespec/runner` orchestrates the real modules (journal, proxy and
   case supervisor, scenario runtime, kernel, regressions privacy scan) and owns no verdict. The
   gate aggregator (`aggregate.ts`) is pure. `@routespec/cli` is the `routespec` command and the
   reviewed launcher adapter. All gate SQL lives in `packages/store/src/gates.ts`
   (`GateJournal`) and additive migration 006.
2. **Reaching the client: the reviewed launcher channel.** `routespec gate run` never executes a
   shell string, package script, or project binary. It hosts the networkless proxy and hands each
   started case to a `CaseDriver`. The shipped driver (`IpcCaseDriver`) uses the inherited IPC
   pipe of a process started by the reviewed launcher (`runWithLauncher` in `@routespec/cli`),
   which only starts the RouteSpec CLI entry point and relays handoffs to the caller (a CI step
   or a test harness that connects its separately started client). The one-time execution token
   and any reconciliation-only token cross only that pipe: never argv, environment, stdout, a
   file, or the journal (digest only). Without a launcher channel, `gate run` refuses
   (`RS_LAUNCHER_UNAVAILABLE`, exit 4) unless `--plan-only`, which validates and then aborts
   before any case starts (decision NOT_RUN, exit 3).
3. **Per-case lifecycle and bounded parallelism.** Each case gets a fresh session, a fresh client
   instance, and a one-time token (M01/M02). The scheduler runs at most the gate's
   `max_parallel_cases` workers (the journal enforces the same bound). A cancelled or failed case
   is aborted (tokens revoked, teardown recorded); unstarted cases of a cancelled gate become
   ABORTED without a session; the gate run becomes ABORTED.
4. **Gate definitions.** `gate create` records an immutable gate definition revision (project,
   pinned corpus, enforcement mode, build attestation policy). `gate run --gate <id>` binds the
   latest revision into the GateRun identity (optional `gateDefinitionRevisionId` added to
   `createGateRun`, additive).
5. **What a decision binds (INV-12).** The gate identity is the GateRun row (project, integration
   revision and its configuration digest, build/artifact, attestation class/id, corpus, protocol
   profile, adapter/evaluator/proxy revisions, effect manifest/policy, inventory/interceptor
   digests, parallelism, gate definition), the journal schema version, the canonical result
   schema version, and the ordered case runs with sessions and fencing epochs. Every stored case
   result is re-parsed through the closed contract schema and re-digested; each identity field of
   the canonical result must equal the gate run / case run it is counted for. The decision
   digest covers the aggregator revision, identity digest, runtime revisions, every case outcome,
   the decision, and the findings; enforcement mode has its own digest; artifact readiness is not
   an input. Re-evaluating identical state returns the existing evaluation; any changed identity
   is a new GateRun whose decision comes only from its own cases.
6. **Precedence.** FAIL from a complete, identity-valid, digest-valid required case dominates.
   Zero started required cases is NOT_RUN. Otherwise any missing, queued-while-others-ran,
   running/evaluating, recovery-pending, aborted, errored, interrupted, teardown-missing,
   client-reusing, identity-mismatched, stale (evaluator/proxy), tampered, REVIEW, UNSUPPORTED,
   or NOT_RUN required case, and any gate-level gap, is REVIEW. PASS needs every required case
   complete PASS. A FAIL result whose identity does not match the gate is not trusted as FAIL for
   this gate; it is REVIEW (`IDENTITY_MISMATCH:*`). Advisory corpus cases are reported but do not
   decide. `NOT_VISIBLE` appears only as `EVIDENCE_REASON:NOT_VISIBLE`.
7. **User-asserted builds.** v2 has no attester enrollment API. A gate definition with
   `--require-attested-build` makes a `USER_ASSERTED_LOCAL` build REVIEW (`BUILD_UNATTESTED`).
   The default policy allows a user-asserted build to reach PASS, with the finding
   `BUILD_USER_ASSERTED_LOCAL` and the label in every report; trusted-launch predicates inside
   invariants (INV-04 complete-effect coverage) stay REVIEW in the kernel regardless.
8. **Interruption.** A runner restart moves expired leases to RECOVERY_REQUIRED, records a
   `case_interruptions` row before recovery, recovers by compare-and-set with exactly one
   reconciliation-only token (never handed to a client by the CLI), closes input, and re-runs the
   kernel over the fenced snapshot. The kernel's case verdict stays authoritative for the case,
   but an interrupted case never contributes PASS to a gate (`CASE_INTERRUPTED`): the user reruns
   the gate. Case persistence and gate persistence are single transactions; a gate evaluation
   re-checks every case state inside its write and fails with `RS_REVISION_CONFLICT` (retried
   from a fresh snapshot) if anything moved.
9. **Exit codes and streams.** 0 PASS, 2 FAIL, 3 REVIEW/NOT_RUN/incomplete, 4 user/config/schema
   (`RS_CLI_USAGE`, not found, invalid scenario, identity mismatch, missing launcher), 5 internal
   or corrupted state (storage, migration, kernel input, bundle verification, write failure), 6
   safety policy denial (mode policy, export blocked/confirmation/overwrite, enforcement claims,
   lease held, token denials). Every error code is mapped explicitly. stdout carries exactly one
   JSON document; diagnostics and structured logs go to stderr.
10. **Reports.** JSON (`routespec.gate-report/1`), JUnit, and SARIF 2.1.0 are rendered from one
    persisted evaluation. JUnit: FAIL -> failure, REVIEW/UNSUPPORTED -> error, NOT_RUN ->
    skipped. SARIF results only for findings with a real URI; v2 journal findings are not source
    positions, so a gate's SARIF has zero results. Enforcement is reported `verified: false,
blocking: false`. `gate create`/`gate run`/`gate evaluate` reject `--branch-protection`,
    `--required-check-verified`, `--blocking`, and any enforcement mode outside the three allowed
    ones (`RS_ENFORCEMENT_CLAIM_REJECTED`, exit 6).
11. **Bundles.** A deterministic POSIX ustar archive (regular files only, sorted, mode 0644,
    mtime 0) holding reports, canonical case results, invariant results, normalized events,
    evidence manifest, run operations (addresses masked as digests unless explicitly included),
    optional operator attachments, `manifest.json`, and `checksums.sha256`. Run envelopes (host,
    paths, wall clock), tokens, request/response bodies, signed material, unreviewed traces, and
    browser state are declared exclusions. The bundle's own readiness is recorded outside it.
    No signature is claimed.
12. **Export confirmation.** `export plan` builds the bundle in memory, scans it (M05 export
    scan: credentials, authorization, cookies, private keys, signed payloads, sensitive
    addresses; plus author-machine paths), and records an immutable plan with category/path/count
    findings only; a blocked plan stores no content and exits 6. `export write` requires the plan
    digest as `--confirm`, an explicit `--out`, and a distinct `--overwrite` for an existing file;
    it rebuilds the bundle from the journal, requires the planned digest, writes atomically,
    re-reads, then records the write (idempotency key + expected revision). Any failed attempt
    sets `artifact_ready = 0`; the decision is never touched. `export verify` extracts into a new
    or empty directory and verifies with the bundle alone.
13. **Logs and metrics.** JSON lines on stderr with level, code, shortened IDs, epoch, and coded
    details; string details are checked for secret shapes before formatting. Metrics are local
    counters returned in the command output. No telemetry.

## Consequences

- A CI system uses `runWithLauncher` (or speaks the `routespec.launcher/1` IPC messages) to run
  its own client against the printed proxy origin; RouteSpec never needs to know how the client
  is built or started.
- A user-asserted build can PASS a default gate, honestly labelled; a team that needs attested
  builds opts into `--require-attested-build`, which stays REVIEW until M08/M11 deliver
  enrollment.
- Bundles verify on another machine without the journal, but checksums are not signatures.

## Not decided here

Attester enrollment, OIDC verification, and attestation challenge completion (M08/M11); the HTTP
control API surface (M08); retention and purge (M11); signing (needs its own ADR).
