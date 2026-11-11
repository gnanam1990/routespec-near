---
project: RouteSpec
version: 2.0.0
artifact_status: SPECIFICATION_ONLY
product_runtime_status: NOT_RUN
updated_at: 2026-11-11
---

# Architecture

## 1. Context

RouteSpec sits beside an integrator's application during development and CI. For simulation/replay the application targets a networkless scenario proxy; an explicit live dry probe instead targets a separately launched egress-capable adapter. RouteSpec records subject effect reports separately from independently intercepted sandbox-boundary observations and evaluates the result against deterministic economic invariants.

```text
Integrator application / official SDK
        | versioned adapter + case token + stable logical-job correlation
        +-------------------------------+
        v                               v
networkless scenario proxy       separately launched LIVE_DRY adapter
        |                               | policy before JWT/DNS/socket
        |                               +----> pinned 1Click HTTPS origin
        +---------------+---------------+
                        v
 subject effect SDK ------> Durable journal -> Normalizer -> Invariant kernel
 independent interceptor -^                                   |
                              local project/revision/build matrix + release check
                                                               |
                                            console / CLI / checksummed export
```

## 2. Architectural qualities

- **Fail-closed:** unknown route, mode, schema, evidence, or revision cannot silently pass.
- **Replayable:** proxy schedules, barriers, response drops, and clients with injected clock/transport are deterministic; uncontrolled client wall timers are noncanonical REVIEW evidence.
- **Inspectable:** raw observation, normalized fact, evidence classification, and verdict remain distinct.
- **Local-first:** credentials and unreviewed traces remain on the user's machine.
- **Crash-safe:** acknowledged journal writes survive and partial work cannot pass.
- **Version-bound:** every result names exact project/build/artifact/attestation, gate/case/session, adapter/effect-manifest/epoch, corpus, evaluator, and configuration identity.
- **Non-custodial:** RouteSpec does not sign, hold, or move assets.

## 3. Bounded contexts

### Project registry

Owns projects, integration revisions, subject build/artifact registration, launcher/CI attestations, effect manifests, protocol profiles/adapters, GateRuns/CaseRuns, capped enforcement, separate compatibility, and settings. It does not own repositories, verify/configure branch protection, or run arbitrary build commands.

### Protocol simulation

Owns networkless routes, versioned SDK adapter correlation, quote request/finalization, one-time commit binding, read-only reconciliation, deterministic response drops/barriers, and virtual time. Deposit address is response-assigned. It rejects partial/changed/concurrent/second commits and contains no upstream client/provider credential.

### Evidence ledger

Owns logical jobs, build/gate/case-scoped run operations and lineage, attempts, phases, exchanges, effect policies/manifests, attested call-site inventories, independent boundary observations, subject reports, normalized events, evidence identity/class/scope/reason, and digests. It never merges cases/builds or collapses self-report/live compatibility into proof.

### Evaluation

Owns invariant applicability, predicate resolution, exact CaseRun results, GateRun aggregation, artifact readiness, and advisory/CI/unverified enforcement. It is pure and deterministic; incomplete cases/effect coverage yield REVIEW and artifacts/compatibility never change verdicts.

### Regression knowledge

Owns installed-artifact capture, no-network quarantine, sanitization, mapping, deterministic replay, explicit review, immutable scenario promotion, and new corpus revisions. It rejects secrets/nondeterminism/unresolved identity and requires corrected-client normal-path rerun.

### Experience and automation

Owns the console, CLI, event stream, JUnit/JSON/SARIF rendering, and redacted exports. It consumes persisted decisions rather than recomputing them.

## 4. Process and network topology

### Local service

- Binds control and proxy listeners to loopback.
- Issues separate control, per-case execution, and reconciliation-only tokens. Case tokens bind build/artifact/gate/case/session/client/adapter/phase/epoch and are revoked on recovery/teardown.
- Owns the sole SQLite writer queue/connection, explicit transaction policy, checkpoints, backups, and disk-full fail-closed path. Session/execution writes check lease fencing epochs; administrative, project, import, and export writes use idempotency plus optimistic revision.
- Serves the console with a restrictive content security policy.

### Isolated compiler/evaluator

- Receives canonical bounded data over an internal message channel.
- Has no provider credentials.
- Has network disabled where the host permits.
- Has CPU, memory, input-size, and runtime limits.
- Returns structured result objects only.

### Integrator application

- Is launched by a reviewed launcher/CI adapter or user; only the former can attest the launched artifact.
- Receives proxy URL and one-time case handoff through supported SDK middleware; concurrent/swapped clients fail.
- Retains responsibility for its own keys and secrets.

### Independent effect interceptor

- Is launched and attested independently from the subject, with a reviewed artifact/profile and private process-local IPC inaccessible to case tokens.
- Binds one build/case/session/epoch and an explicit OS/container process-tree boundary plus supported sink classes.
- Observes or denies test effects at the boundary and redirects only to a local canary; it never invokes the real downstream target.
- Cannot establish complete coverage when the selected platform cannot prevent bypass, the sink class is unsupported, or dynamic/native call sites escape the declared analyzer model; those cases are `DECLARED_HOOKS_ONLY` and REVIEW.

### Networkless scenario proxy

- Runs as a separate process with no upstream client and no provider credential input.
- May accept mutation-shaped requests only to advance local scenario state.
- Uses deterministic response-drop/connection barriers for accepted-then-lost-response cases.

### Live-dry upstream adapter

- Exists only in the `LIVE_DRY_PROBE` adapter.
- Uses a fixed origin and explicit path/method/body allowlist.
- Receives a memory-only provider JWT only after policy passes; token state is explicit.
- Cannot be invoked by scenario source or browser input directly.

## 5. Data flows

### DF-01 — Deterministic test

1. CLI creates one immutable GateRun and isolated ordered CaseRuns for exact subject/corpus/manifest identities.
2. Scheduler issues one case/client/token/epoch handoff; the adapter correlates logical job and RouteSpec-assigned run operation.
3. Proxy validates quote request/finalization and first commit, journals before acknowledgement, then deterministically loses the response.
4. On crash/uncertainty it revokes stale authority, increments epoch, and permits only read-only reconciliation.
5. Normalizer and effect-coverage checker reconcile subject reports with independently authenticated boundary observations, attested inventory when selected, and interceptor teardown from a fenced snapshot.
6. Kernel evaluates one case; gate aggregates only after all required cases are terminal/incomplete under fail-closed precedence.

### DF-02 — Live dry probe

1. User explicitly starts a dry-probe session.
2. Control service starts the separate adapter and verifies mode, exact pinned SDK/schema profile, allowlist, pinned origin, and token state.
3. The official client submits `dry: true` through the local proxy.
4. Adapter rejects any non-dry or mutation request before provider JWT attachment, DNS, or socket creation.
5. Allowed request is forwarded, response shape is validated and redacted, and compatibility is recorded.
6. Result explicitly states that no real settlement was exercised.

### DF-03 — Installed trace capture and promotion

1. Product captures authoritative exchanges from the installed failing subject under exact build/gate/case/session/run identity; a user file remains separately labelled.
2. Capture enters no-network quarantine, secret/nondeterminism/resource checks, and sanitization without ordinary raw-byte persistence.
3. Mapper resolves phases, material, expected behavior, and effect coverage; unresolved items cannot promote.
4. Repeated deterministic replay and explicit immutable review are required.
5. Promotion creates a new immutable scenario and new corpus identity.
6. Corrected installed subject runs the promoted corpus through the normal product path; replay alone is insufficient.

### DF-04 — Evidence export

1. User chooses session/gate and export policy.
2. Exporter reads a consistent snapshot.
3. Secret/privacy scan blocks on findings.
4. Manifest, canonical JSON, JUnit/SARIF where applicable, and digests are assembled.
5. User sees exact included/excluded items and explicitly writes the local bundle.

### DF-05 — Protected-effect coverage

1. The subject may call the observer with case token plus exact build/gate/case/session/run/manifest/hook/epoch/effect identity; this produces only `SUBJECT_REPORTED` correlation evidence.
2. The separately attested interceptor observes or denies declared sink classes at the sandbox/process-tree boundary and writes over private authenticated IPC; exact duplicates are idempotent.
3. When selected, the trust-root-attested build-time inventory binds analyzed call sites to the exact artifact, but runtime interception remains mandatory for complete-effect PASS.
4. Changed/stale/forged/missing inventory or interceptor identity, unsupported dynamic call sites, an incomplete boundary, declared hooks only, or an unobserved required sink yields REVIEW. A proven forbidden release at the independent boundary yields FAIL. No test path performs the real effect.

## 6. Failure containment

| Failure | Containment |
|---|---|
| Client sends unknown endpoint | Local typed rejection; no upstream fallback |
| Scenario client sends mutation-shaped request | Networkless proxy may model it locally; no provider credential or upstream capability exists |
| Live-dry client sends `dry: false` | Reject before credential attachment/DNS/socket; journal policy code only |
| Scenario parser crashes | Session ERROR; no partial promotion or gate PASS |
| Evaluator crashes | Session REVIEW/ERROR; immutable input snapshot retained |
| Process terminates after commit journal | Revoke stale case token, increment epoch, issue reconciliation-only authority, deny a second mutation, and evaluate from the durable fenced snapshot |
| SQLite busy/corrupt/disk full | Single writer, busy timeout, explicit transaction/synchronous policy; no acknowledged response without commit, then RECOVERY_REQUIRED/REVIEW |
| Upstream dry probe times out | Compatibility UNKNOWN; no retry mutation |
| Private evidence unavailable | Evidence scope/reason is `PRIVATE_NOT_VISIBLE`/`NOT_VISIBLE`; verdict is REVIEW if proof is required |
| UI disconnects | Runner continues; reconnect by `after_sequence`; UI never owns state |
| Secret detector finds a value | Import/export blocked; only finding class and location metadata shown |

## 7. Deployment profiles

### Developer workstation

Local control API with project/revision/build matrix, networkless scenario proxy, SQLite, console, and CLI. The live-dry adapter is absent unless explicitly launched. Default retention is local and explicit; no cloud account is required.

### CI runner

Ephemeral local control service, networkless scenario proxy, and data directory. Required corpus is checked into the project or fetched from an integrity-pinned internal source by the CI workflow, not by scenario code. Outputs are redacted artifacts. No provider JWT is required for simulation/replay. RouteSpec's no-egress instrumentation covers its processes; covering the complete client process tree requires an explicit OS/container sandbox and process-tree network instrumentation.

### Team collaboration expansion

Hosted collaboration is future/excluded and not part of the critical DAG. Any later design may accept reviewed redacted bundles only and requires a new data-protection, authorization, and isolation specification.

## 8. Dependency direction

```text
domain types
  <- scenario compiler
  <- journal repositories
  <- normalizer
  <- invariant kernel
  <- release gate

protocol adapter -> domain types
control API -> application services -> domain/repositories
CLI and console -> control API
exporter -> read-only repositories + redaction
```

The domain and invariant packages must not import Fastify, SQLite, React, upstream SDKs, or AI clients.

## 9. Scale strategy

- Stream imports; never load unbounded traces into memory.
- Store large payloads content-addressed and redacted, separate from indexed metadata.
- Page event/evidence queries and virtualize console rows.
- Parallelize cases only within the GateRun bound, with separate tokens, client instances, reset state, sessions, epochs, and deterministic result ordering.
- Bound concurrency to protect the workstation.
- Cache compiled scenarios by immutable digest.
- Re-evaluate from normalized facts rather than rereading large raw bodies when evaluator version is compatible.

## 10. Architectural exclusions

An onchain oracle, TEE, token, marketplace, solver network, insurance reserve, or autonomous recovery agent is not required for RouteSpec's job. Adding one would introduce a second trust or economic system without improving the integrator's core release decision. Optional provenance anchoring stays outside the critical path.

