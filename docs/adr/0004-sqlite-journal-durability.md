# ADR-0004 — Single-writer SQLite journal: durability, fencing, and failure handling

- Date: 2026-11-11. Decision owner: implementing agent (M01 stage), pending user review.
- Status: ACCEPTED
- Related: FR-07, FR-08, NFR-05, NFR-08, INV-01, INV-02, INV-06, INV-07; module M01; tests T-001, T-002, T-006, T-007, T-022, T-023, T-024, T-026, T-028.

## Context

DATA-MODEL.md sections 5 and 8 and TDD.md section 15 require one writer queue/connection, WAL, foreign keys, a documented `busy_timeout`, explicit transaction mode, a declared synchronous setting, checkpoint/verified backup, fail-closed disk-full handling, fencing epochs, and read-only recovery for unknown schemas. ADR-0001 selected built-in `node:sqlite` (SQLite 3.51.3 in Node 22.23.1).

## Decision

- **Single writer.** `JournalDb.open` acquires `<db>.writer.lock` (exclusive create, holder PID + random token). A live holder → `RS_WRITER_LOCKED`; a lock whose PID is dead (crash) is removed and re-acquired. All mutations run on that one connection through `transact()`; `enqueue()` serializes async callers. Nested transactions are rejected.
- **Transaction mode:** `BEGIN IMMEDIATE` for every write (reserved lock up front; no lock-upgrade deadlocks).
- **Pragmas:** `journal_mode=WAL`, `synchronous=FULL`, `foreign_keys=ON`, `busy_timeout=5000` ms by default (configurable), `application_id=0x52535043` ("RSPC"). Optional `max_page_count` resource cap.
- **Durability claim:** with WAL + `synchronous=FULL`, a transaction whose `COMMIT` returned is durable across process crash and OS crash/power loss, provided the storage device honours flush requests. Process-crash durability is exercised by T-022/T-023 with a real killed child process; power-loss durability is not tested (NOT_RUN; requires hardware fault injection).
- **Acknowledgement rule:** repository methods return an acknowledgement only after `COMMIT`. A fault-injection hook (`beforeCommit`/`afterCommit`) exists for tests; production passes none.
- **Database-enforced invariants (defense in depth):** STRICT tables; insert-only tables abort UPDATE/DELETE with `RS_IMMUTABLE_RECORD`; the shared lifecycle transition table (generated from `@routespec/contracts`) guards `execution_lifecycle` and freezes terminal states; verdicts are set-once; fencing epochs and session sequences are monotonic; finalization/commit digests are set-once and a commit requires a finalization; accepted terminal provider status is set-once and the outcome can only move to `CONTRADICTORY`; single-use evidence consumption and allocation membership are trigger-checked; composite foreign keys bind session/run-operation/evidence/result rows to one consistent build/artifact/gate/case/session identity; `credential_attached`, `dns_attempted`, `upstream_attempted` are constrained to 0 in the networkless journal.
- **Fencing:** every client write presents the one-time case token (stored only as a SHA-256 digest) and bound identity; the transaction verifies revocation, identity, client instance, epoch, active-token, expiry, phase permission, lifecycle, and lease. Runner/evaluator writes present `(caseRunId, leaseOwnerDigest, fencingEpoch)`. Recovery (`recoverExpiredLeases`, `recoverCase` with compare-and-set on the expected epoch) revokes all tokens, increments the epoch, and issues exactly one `RECONCILIATION_ONLY` token whose phases are limited to `READ_ONLY_RECONCILIATION`.
- **Administrative writes:** idempotency keys (`idempotency_keys` table, request digest compared) and optimistic `revision` for project updates; immutable registrations are idempotent by identity digest. No case lease involved.
- **Storage faults:** `SQLITE_FULL`, `SQLITE_IOERR`, corrupt/not-a-database, a checkpoint error, or a failed verified backup put the journal in a fail-closed storage-fault state: the transaction is rolled back, nothing is acknowledged, every later transaction fails with `RS_STORAGE_UNAVAILABLE`, and a best-effort marker file `<db>.storage-fault` makes the state survive restart. `resumeAfterStorageFault()` runs `PRAGMA quick_check` and fences every executing case into `RECOVERY_REQUIRED` (tokens revoked, epoch + 1) before acknowledgements resume, so in-flight work can only continue through read-only reconciliation and can never become PASS.
- **Checkpoint:** `PRAGMA wal_checkpoint(TRUNCATE)`; an incomplete (busy) checkpoint is reported and recorded as `INCOMPLETE` (WAL remains durable); an error is a storage fault.
- **Verified backup:** `VACUUM INTO` a new file, then independently open it read-only and verify `integrity_check = ok`, schema version, and per-table row counts equal to the source snapshot; recorded in `maintenance_events`.
- **Migrations:** ordered, SHA-256 checksummed, each in its own `BEGIN IMMEDIATE` transaction; a failure rolls back completely (`RS_MIGRATION_FAILED`); checksum drift refuses to open; a newer unknown schema opens read-only (`READ_ONLY_RECOVERY`); a foreign SQLite file or non-database file is refused (`RS_STORAGE_CORRUPT`). Migration 002 is purely additive.

## Known limits

- `node:sqlite` is experimental in Node 22 (prints an ExperimentalWarning).
- Bounded checkpoint/backup _schedules_ (when they run) belong to the runner (M06); M01 provides the operations.
- The writer lock trusts PID liveness; PID reuse after a crash could cause a false `RS_WRITER_LOCKED` (fails closed, never open).
- Repository methods exist for the M01 core path. Tables for attester principals/challenges/subject attestations (M08), effect inventories/interceptors/boundary and subject observations (M04/M08), imports/mappings (M05), gate definitions/evaluations and artifact manifests (M06/M08), and audit events exist with constraints but have no repository methods yet.

## Invalidation

A move off `node:sqlite`, multi-process writers, or a remote store would require a new ADR.
