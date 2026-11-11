/**
 * T-024 — Expired execution lease cannot create two runners. Covers FR-07, NFR-05 (owned by M01).
 *
 * Exercises: lease expiry vs a second runner, stale worker after recovery, racing recovery
 * workers, bounded parallelism with fresh per-case token/client/session, copied tokens and
 * concurrent clients, busy-timeout, checkpoint, sequence allocation, second writer process,
 * administrative idempotency/optimistic revision without a case lease, and disk-full/backup
 * failures that cannot acknowledge or PASS work.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RouteSpecStore, type CaseAuth } from '../src/index.ts';
import { spawnChild } from './support/child.ts';
import {
  LEASE_TTL_MS,
  ManualClock,
  TOKEN_TTL_MS,
  canonicalFor,
  codeOf,
  createGate,
  d,
  openStore,
  quoteAndFinalize,
  quoteRequest,
  startCase,
  tempDir,
} from './support/fixture.ts';

let tmp: ReturnType<typeof tempDir>;
let clock: ManualClock;
let store: RouteSpecStore;

beforeEach(() => {
  tmp = tempDir();
  clock = new ManualClock(Date.now());
  store = openStore(tmp.dir, { clock });
});
afterEach(() => {
  store.close();
  tmp.cleanup();
});

const recoverInput = (caseRunId: string, auth: CaseAuth, expectedFencingEpoch: number) => ({
  caseRunId,
  recoveryOwnerDigest: d('recovery-runner'),
  clientInstanceDigest: auth.clientInstanceDigest,
  expectedFencingEpoch,
  leaseTtlMs: LEASE_TTL_MS,
  tokenTtlMs: TOKEN_TTL_MS,
});

describe('T-024 — Expired execution lease cannot create two runners', () => {
  it('a second runner can neither start nor write; recovery fences the stale worker', () => {
    const gate = createGate(store, { label: 'lease' });
    const caseRunId = gate.caseRunIds[0]!;
    const a = startCase(store, caseRunId, { owner: 'runner-a' });
    const start = () =>
      store.startCase({
        caseRunId,
        leaseOwnerDigest: d('runner-b'),
        clientInstanceDigest: d('client-b'),
        mode: 'SIMULATE',
        seed: 's',
        leaseTtlMs: LEASE_TTL_MS,
        tokenTtlMs: TOKEN_TTL_MS,
      });
    expect(codeOf(start)).toBe('RS_LEASE_HELD');
    clock.advance(LEASE_TTL_MS + 1);
    expect(codeOf(start)).toBe('RS_LEASE_EXPIRED'); // only recovery may resume an expired case
    expect(
      codeOf(() =>
        store.recordQuoteRequest(a.auth, {
          transportRequestId: 'late',
          logicalJobKey: 'j',
          material: quoteRequest(),
        }),
      ),
    ).toBe('RS_LEASE_EXPIRED');
    expect(codeOf(() => store.renewLease(a.fence, LEASE_TTL_MS))).toBe('RS_LEASE_EXPIRED');

    const recovered = store.recoverCase(recoverInput(caseRunId, a.auth, a.fence.fencingEpoch));
    expect(recovered.fencingEpoch).toBe(a.fence.fencingEpoch + 1);
    // Stale worker A: old token revoked, old fence epoch stale.
    expect(
      codeOf(() =>
        store.recordQuoteRequest(a.auth, {
          transportRequestId: 'stale',
          logicalJobKey: 'j',
          material: quoteRequest(),
        }),
      ),
    ).toBe('RS_TOKEN_REVOKED');
    expect(codeOf(() => store.renewLease(a.fence, LEASE_TTL_MS))).toBe('RS_STALE_FENCING_EPOCH');
    expect(
      codeOf(() =>
        store.recordEvidence(a.fence, {
          runOperationId: null,
          evidenceClass: 'PROVEN',
          evidenceScope: 'SIMULATED_GROUND_TRUTH',
          reasons: [],
          subject: 'x',
          sourceKind: 's',
          assetId: null,
          amount: null,
          singleUse: false,
          payload: {},
        }),
      ),
    ).toBe('RS_STALE_FENCING_EPOCH');
    const { canonical, envelope } = canonicalFor(store, caseRunId, 'REVIEW');
    expect(
      codeOf(() =>
        store.persistCaseEvaluation(a.fence, {
          verdict: 'REVIEW',
          evaluatorRevision: 'kernel@0.0.0',
          invariantResults: [],
          canonical: { ...canonical, fencingEpoch: a.fence.fencingEpoch },
          envelope,
        }),
      ),
    ).toBe('RS_STALE_FENCING_EPOCH');
    expect(store.getCaseRun(caseRunId)!['lease_owner_digest']).toBe(d('recovery-runner'));
  });

  it('racing recovery workers produce exactly one reconciliation token', async () => {
    const gate = createGate(store, { label: 'race' });
    const caseRunId = gate.caseRunIds[0]!;
    const a = startCase(store, caseRunId);
    clock.advance(LEASE_TTL_MS + 1);
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        store.journal
          .enqueue('race', () => undefined)
          .then(() => store.recoverCase(recoverInput(caseRunId, a.auth, a.fence.fencingEpoch))),
      ),
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok).toHaveLength(1);
    for (const r of results.filter((x) => x.status === 'rejected')) {
      expect((r as PromiseRejectedResult).reason.code).toBe('RS_STALE_FENCING_EPOCH');
    }
    const tokens = store.journal.read((db) =>
      db
        .prepare(
          `SELECT purpose, count(*) AS n FROM case_tokens WHERE case_run_id = ? GROUP BY purpose ORDER BY purpose`,
        )
        .all(caseRunId),
    );
    expect(tokens).toEqual([
      { purpose: 'EXECUTION', n: 1 },
      { purpose: 'RECONCILIATION_ONLY', n: 1 },
    ]);
    // Re-running recovery with the new epoch while the recovery lease is live is refused.
    expect(codeOf(() => store.recoverCase(recoverInput(caseRunId, a.auth, a.fence.fencingEpoch + 1)))).toBe(
      'RS_LEASE_HELD',
    );
  });

  it('bounded parallelism gives every case a fresh token/client/session and rejects copies', () => {
    const gate = createGate(store, { label: 'parallel', cases: 3, maxParallelCases: 2 });
    const [c1, c2, c3] = gate.caseRunIds as [string, string, string];
    const s1 = startCase(store, c1);
    const s2 = startCase(store, c2);
    expect(codeOf(() => startCase(store, c3))).toBe('RS_PARALLELISM_EXCEEDED');
    expect(new Set([s1.auth.token, s2.auth.token]).size).toBe(2);
    expect(s1.sessionId).not.toBe(s2.sessionId);
    expect(s1.auth.clientInstanceDigest).not.toBe(s2.auth.clientInstanceDigest);
    // Copied token into another case, and a concurrent second client on the same case, are refused.
    expect(
      codeOf(() =>
        store.recordQuoteRequest(
          { ...s2.auth, token: s1.auth.token },
          { transportRequestId: 't', logicalJobKey: 'j', material: quoteRequest() },
        ),
      ),
    ).toBe('RS_IDENTITY_MISMATCH');
    expect(
      codeOf(() =>
        store.recordQuoteRequest(
          { ...s1.auth, clientInstanceDigest: d('intruder') },
          { transportRequestId: 't', logicalJobKey: 'j', material: quoteRequest() },
        ),
      ),
    ).toBe('RS_CLIENT_CONFLICT');
    const { canonical, envelope } = canonicalFor(store, c1, 'REVIEW');
    store.persistCaseEvaluation(s1.fence, {
      verdict: 'REVIEW',
      evaluatorRevision: 'kernel@0.0.0',
      invariantResults: [],
      canonical,
      envelope,
    });
    expect(store.getCaseRun(c1)!['execution_lifecycle']).toBe('COMPLETED');
    expect(
      codeOf(() =>
        store.recordQuoteRequest(s1.auth, {
          transportRequestId: 't2',
          logicalJobKey: 'j',
          material: quoteRequest(),
        }),
      ),
    ).toBe('RS_TOKEN_REVOKED');
    const s3 = startCase(store, c3); // capacity freed by the terminal case
    expect(s3.sessionId).not.toBe(s1.sessionId);
  });

  it('sequence allocation stays unique and contiguous under queued concurrent writers and checkpoints', async () => {
    const gate = createGate(store, { label: 'seq' });
    const { auth } = startCase(store, gate.caseRunIds[0]!);
    const acks = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        store.journal
          .enqueue('seq', () => undefined)
          .then(() => {
            if (i % 10 === 0) store.checkpoint();
            return store.recordQuoteRequest(auth, {
              transportRequestId: `t-${i}`,
              logicalJobKey: `job-${i % 7}`,
              material: quoteRequest(),
            });
          }),
      ),
    );
    const sequences = acks.map((a) => a.sequence).sort((x, y) => x - y);
    expect(sequences).toEqual(Array.from({ length: 40 }, (_, i) => i));
    expect(store.getSession(auth.sessionId)!['next_sequence']).toBe(40);
    expect(store.checkpoint().complete).toBe(true);
  });

  it('busy-timeout contention never acknowledges a write', () => {
    store.close();
    store = openStore(tmp.dir, { clock, busyTimeoutMs: 50 });
    const gate = createGate(store, { label: 'busy' });
    const { auth } = startCase(store, gate.caseRunIds[0]!);
    const other = new DatabaseSync(join(tmp.dir, 'journal.db'));
    other.exec('PRAGMA busy_timeout = 0');
    other.exec('BEGIN IMMEDIATE');
    try {
      expect(
        codeOf(() =>
          store.recordQuoteRequest(auth, {
            transportRequestId: 'b1',
            logicalJobKey: 'j',
            material: quoteRequest(),
          }),
        ),
      ).toBe('RS_STORAGE_BUSY');
    } finally {
      other.exec('ROLLBACK');
      other.close();
    }
    expect(store.countRows('proxy_exchanges')).toBe(0);
    expect(
      store.recordQuoteRequest(auth, {
        transportRequestId: 'b1',
        logicalJobKey: 'j',
        material: quoteRequest(),
      }).sequence,
    ).toBe(0);
  });

  it('a second writer process is refused while the first holds the journal', async () => {
    const run = spawnChild({ mode: 'try-open', dbPath: join(tmp.dir, 'journal.db') });
    const line = await run.waitFor('OPEN_FAILED');
    expect(line['code']).toBe('RS_WRITER_LOCKED');
    await run.exited();
    expect(codeOf(() => RouteSpecStore.open({ path: join(tmp.dir, 'journal.db') }))).toBe('RS_WRITER_LOCKED');
  });

  it('administrative writes serialize by idempotency key and optimistic revision without a case lease', async () => {
    const { projectId } = store.createProject({ name: 'admin', idempotencyKey: 'create-admin-1' });
    expect(store.createProject({ name: 'admin', idempotencyKey: 'create-admin-1' }).projectId).toBe(
      projectId,
    );
    expect(codeOf(() => store.createProject({ name: 'different', idempotencyKey: 'create-admin-1' }))).toBe(
      'RS_IDEMPOTENCY_KEY_REUSED',
    );
    const results = await Promise.allSettled([
      store.journal
        .enqueue('a', () => undefined)
        .then(() =>
          store.updateProject({
            projectId,
            expectedRevision: 1,
            patch: { name: 'one' },
            idempotencyKey: 'update-one-1',
          }),
        ),
      store.journal
        .enqueue('b', () => undefined)
        .then(() =>
          store.updateProject({
            projectId,
            expectedRevision: 1,
            patch: { name: 'two' },
            idempotencyKey: 'update-two-1',
          }),
        ),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(
      ((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason as { code: string })
        .code,
    ).toBe('RS_REVISION_CONFLICT');
    expect(
      store.updateProject({
        projectId,
        expectedRevision: 1,
        patch: { name: 'one' },
        idempotencyKey: 'update-one-1',
      }).revision,
    ).toBe(2); // replay
    expect(
      codeOf(() =>
        store.updateProject({
          projectId,
          expectedRevision: 2,
          patch: { name: 'x', token: 'leak' } as never,
          idempotencyKey: 'update-secret',
        }),
      ),
    ).toBe('RS_SECRET_FIELD_REJECTED');
  });

  it('disk-full fails closed: nothing is acknowledged, the fault survives restart, and resume fences active work', () => {
    store.close();
    store = openStore(tmp.dir, { clock });
    const gate = createGate(store, { label: 'full' });
    const { auth, fence } = startCase(store, gate.caseRunIds[0]!);
    const runOperationId = quoteAndFinalize(store, auth);
    const pages = Number(
      store.journal.read(
        (db) => (db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count,
      ),
    );
    store.close();
    store = openStore(tmp.dir, { clock, maxPageCount: pages });
    const big = { txHash: `0x${'ab'.repeat(120)}`, depositAddress: 'deposit.sim' };
    let code = 'NO_ERROR';
    for (let i = 0; i < 200 && code === 'NO_ERROR'; i++) {
      code = codeOf(() =>
        store.recordQuoteRequest(auth, {
          transportRequestId: `fill-${i}`,
          logicalJobKey: `fill-${i}`,
          material: quoteRequest({ customRecipientMsg: 'x'.repeat(3000) }),
        }),
      );
    }
    expect(code).toBe('RS_STORAGE_FULL');
    const committed = store.countRows('commit_bindings');
    expect(
      codeOf(() => store.commitMutation(auth, { transportRequestId: 'c1', runOperationId, body: big })),
    ).toBe('RS_STORAGE_UNAVAILABLE');
    const { canonical, envelope } = canonicalFor(store, gate.caseRunIds[0]!, 'PASS');
    expect(
      codeOf(() =>
        store.persistCaseEvaluation(fence, {
          verdict: 'PASS',
          evaluatorRevision: 'kernel@0.0.0',
          invariantResults: [],
          canonical,
          envelope,
        }),
      ),
    ).toBe('RS_STORAGE_UNAVAILABLE');
    expect(store.countRows('commit_bindings')).toBe(committed);
    store.close();

    // Operator frees space (no page cap). The fault marker survives restart: still fail-closed.
    expect(existsSync(join(tmp.dir, 'journal.db.storage-fault'))).toBe(true);
    store = openStore(tmp.dir, { clock });
    expect(
      codeOf(() => store.commitMutation(auth, { transportRequestId: 'c1', runOperationId, body: big })),
    ).toBe('RS_STORAGE_UNAVAILABLE');
    const resumed = store.resumeAfterStorageFault();
    expect(resumed.fencedCases).toEqual([gate.caseRunIds[0]]);
    expect(store.getCaseRun(gate.caseRunIds[0]!)!['execution_lifecycle']).toBe('RECOVERY_REQUIRED');
    expect(store.getCaseRun(gate.caseRunIds[0]!)!['verdict']).toBeNull(); // never PASS from partial work
    expect(
      codeOf(() => store.commitMutation(auth, { transportRequestId: 'c1', runOperationId, body: big })),
    ).toBe('RS_TOKEN_REVOKED');
    expect(
      codeOf(() =>
        store.persistCaseEvaluation(fence, {
          verdict: 'PASS',
          evaluatorRevision: 'kernel@0.0.0',
          invariantResults: [],
          canonical,
          envelope,
        }),
      ),
    ).toBe('RS_STALE_FENCING_EPOCH');
  });

  it('a failed verified backup suspends acknowledgements; a verified backup is independently readable', () => {
    const gate = createGate(store, { label: 'backup' });
    const { auth, fence } = startCase(store, gate.caseRunIds[0]!);
    quoteAndFinalize(store, auth);
    const ok = store.backupVerified(join(tmp.dir, 'backup-1.db'));
    expect(ok.verified).toBe(true);
    const copy = new DatabaseSync(join(tmp.dir, 'backup-1.db'), { readOnly: true });
    expect((copy.prepare('SELECT count(*) AS n FROM quote_finalizations').get() as { n: number }).n).toBe(1);
    copy.close();

    expect(codeOf(() => store.backupVerified(join(tmp.dir, 'missing-dir', 'backup-2.db')))).toBe(
      'RS_BACKUP_FAILED',
    );
    expect(
      codeOf(() =>
        store.recordQuoteRequest(auth, {
          transportRequestId: 'after',
          logicalJobKey: 'j2',
          material: quoteRequest(),
        }),
      ),
    ).toBe('RS_STORAGE_UNAVAILABLE');
    const { canonical, envelope } = canonicalFor(store, gate.caseRunIds[0]!, 'PASS');
    expect(
      codeOf(() =>
        store.persistCaseEvaluation(fence, {
          verdict: 'PASS',
          evaluatorRevision: 'kernel@0.0.0',
          invariantResults: [],
          canonical,
          envelope,
        }),
      ),
    ).toBe('RS_STORAGE_UNAVAILABLE');
    store.resumeAfterStorageFault();
    expect(store.getCaseRun(gate.caseRunIds[0]!)!['execution_lifecycle']).toBe('RECOVERY_REQUIRED');
    expect(store.listMaintenance().map((m) => `${m['kind']}:${m['outcome']}`)).toEqual([
      'BACKUP:VERIFIED',
      'STORAGE_RESUME:COMPLETE',
    ]);
  });
});
