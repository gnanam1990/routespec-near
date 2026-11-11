/**
 * T-022 — Acknowledged proxy exchange survives restart. Covers FR-07, NFR-05 (owned by M01).
 * T-023 — Crash before journal commit does not acknowledge acceptance. Covers FR-07, NFR-05 (owned by M01).
 *
 * Real process termination: a separate Node.js process performs the commit and is killed with
 * SIGKILL (TerminateProcess on Windows). No mocks are on this path.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RouteSpecStore, type CaseAuth } from '../src/index.ts';
import { spawnChild } from './support/child.ts';
import {
  LEASE_TTL_MS,
  ManualClock,
  codeOf,
  createGate,
  quoteAndFinalize,
  quoteRequest,
  startCase,
  tempDir,
} from './support/fixture.ts';

let tmp: ReturnType<typeof tempDir>;
let dbPath: string;
const body = { txHash: '0xfeed', depositAddress: 'deposit.sim' };

beforeEach(() => {
  tmp = tempDir();
  dbPath = join(tmp.dir, 'journal.db');
});
afterEach(() => tmp.cleanup());

function prepare(): { auth: CaseAuth; runOperationId: string; caseRunId: string; fencingEpoch: number } {
  const store = RouteSpecStore.open({ path: dbPath, clock: new ManualClock(Date.now()) });
  try {
    const gate = createGate(store, { label: 'crash' });
    const started = startCase(store, gate.caseRunIds[0]!);
    const runOperationId = quoteAndFinalize(store, started.auth);
    return {
      auth: started.auth,
      runOperationId,
      caseRunId: gate.caseRunIds[0]!,
      fencingEpoch: started.fence.fencingEpoch,
    };
  } finally {
    store.close();
  }
}

describe('T-022 — Acknowledged proxy exchange survives restart', () => {
  it('kills the process after an acknowledged commit; restart recovers exactly one commit, read-only', async () => {
    const { auth, runOperationId, caseRunId, fencingEpoch } = prepare();
    const run = spawnChild({
      mode: 'ack-then-wait',
      dbPath,
      auth,
      runOperationId,
      transportRequestId: 'commit-1',
      body,
    });
    const ackLine = await run.waitFor('ACK');
    const ack = ackLine['ack'] as {
      exchangeId: string;
      sequence: number;
      bindingDigest: string;
      attemptId: string;
    };
    run.child.kill('SIGKILL');
    const exit = await run.exited();
    expect(exit.code === 0 && exit.signal === null).toBe(false);
    expect(existsSync(`${dbPath}.writer.lock`)).toBe(true); // crash left the lock behind

    const later = new ManualClock(Date.now() + 2 * LEASE_TTL_MS);
    const store = RouteSpecStore.open({ path: dbPath, clock: later }); // stale lock is taken over
    try {
      expect(store.countRows('commit_bindings')).toBe(1);
      expect(store.getCommitBinding(runOperationId)!['binding_digest']).toBe(ack.bindingDigest);
      const commits = store.listExchanges(auth.sessionId).filter((e) => e['phase'] === 'COMMIT_MUTATION');
      expect(commits).toHaveLength(1);
      expect(commits[0]!['exchange_id']).toBe(ack.exchangeId);
      expect(commits[0]!['sequence']).toBe(ack.sequence);
      expect(
        store.listEvents(auth.sessionId).filter((e) => e['event_kind'] === 'COMMIT_ACCEPTED'),
      ).toHaveLength(1);
      expect(store.getSession(auth.sessionId)!['next_sequence']).toBe(ack.sequence + 1);
      // The proxy never recorded delivery, so the accepted commit's outcome is unknown to the client.
      expect(
        store.listAttempts(runOperationId).find((a) => a['attempt_id'] === ack.attemptId)!['outcome'],
      ).toBe('SENT_OUTCOME_UNKNOWN');

      // Restart: the expired lease forces recovery; stale authority is revoked and the epoch increments.
      expect(store.recoverExpiredLeases()).toEqual([caseRunId]);
      expect(store.getCaseRun(caseRunId)!['execution_lifecycle']).toBe('RECOVERY_REQUIRED');
      expect(store.getCaseRun(caseRunId)!['fencing_epoch']).toBe(fencingEpoch + 1);
      const recovery = store.recoverCase({
        caseRunId,
        recoveryOwnerDigest: auth.clientInstanceDigest,
        clientInstanceDigest: auth.clientInstanceDigest,
        expectedFencingEpoch: fencingEpoch + 1,
        leaseTtlMs: LEASE_TTL_MS,
        tokenTtlMs: LEASE_TTL_MS,
      });
      expect(
        codeOf(() => store.commitMutation(auth, { transportRequestId: 'commit-2', runOperationId, body })),
      ).toBe('RS_TOKEN_REVOKED');
      expect(
        codeOf(() =>
          store.commitMutation(recovery.auth, { transportRequestId: 'commit-3', runOperationId, body }),
        ),
      ).toBe('RS_TOKEN_PHASE_DENIED');
      expect(
        codeOf(() =>
          store.recordQuoteRequest(recovery.auth, {
            transportRequestId: 'q-2',
            logicalJobKey: 'job-2',
            material: quoteRequest(),
          }),
        ),
      ).toBe('RS_TOKEN_PHASE_DENIED');
      const status = store.recordStatusObservation(recovery.auth, {
        transportRequestId: 'status-1',
        runOperationId,
        query: { depositAddress: 'deposit.sim' },
        rawStatus: 'PROCESSING',
      });
      expect(status.ack).toBe(true);
      expect(store.countRows('commit_bindings')).toBe(1);
      expect(
        store.listExchanges(auth.sessionId).filter((e) => e['phase'] === 'COMMIT_MUTATION'),
      ).toHaveLength(1);
    } finally {
      store.close();
    }
  });
});

describe('T-023 — Crash before journal commit does not acknowledge acceptance', () => {
  it('terminates at beforeCommit: no ACK reaches the client and the journal holds no acceptance', async () => {
    const { auth, runOperationId } = prepare();
    const before = RouteSpecStore.open({ path: dbPath });
    const seqBefore = before.getSession(auth.sessionId)!['next_sequence'];
    const exchangesBefore = before.countRows('proxy_exchanges');
    before.close();

    const run = spawnChild({
      mode: 'kill-before-commit',
      dbPath,
      auth,
      runOperationId,
      transportRequestId: 'commit-1',
      body,
    });
    await run.waitFor('ABOUT_TO_COMMIT');
    const exit = await run.exited();
    expect(exit.code === 0 && exit.signal === null).toBe(false);
    expect(run.lines.some((l) => l['event'] === 'ACK')).toBe(false);

    const store = RouteSpecStore.open({ path: dbPath, clock: new ManualClock(Date.now()) });
    try {
      expect(store.countRows('commit_bindings')).toBe(0);
      expect(store.countRows('proxy_exchanges')).toBe(exchangesBefore);
      expect(
        store.listEvents(auth.sessionId).filter((e) => e['event_kind'] === 'COMMIT_ACCEPTED'),
      ).toHaveLength(0);
      expect(store.getSession(auth.sessionId)!['next_sequence']).toBe(seqBefore);
      expect(store.getRunOperation(runOperationId)!['commit_binding_digest']).toBeNull();
      expect(store.journal.read((db) => db.prepare('PRAGMA integrity_check').get())).toEqual({
        integrity_check: 'ok',
      });
    } finally {
      store.close();
    }
  });

  it('in-process: a failure at beforeCommit rolls back and returns no acknowledgement', () => {
    const { auth, runOperationId } = prepare();
    let armed = true;
    const store = RouteSpecStore.open({
      path: dbPath,
      clock: new ManualClock(Date.now()),
      faultInjector: (point, label) => {
        if (armed && point === 'beforeCommit' && label === 'proxy.commit-mutation')
          throw new Error('injected crash');
      },
    });
    try {
      let ack: unknown;
      expect(
        () => (ack = store.commitMutation(auth, { transportRequestId: 'c1', runOperationId, body })),
      ).toThrow();
      expect(ack).toBeUndefined();
      expect(store.countRows('commit_bindings')).toBe(0);
      armed = false;
      // The same request can then be journaled for real; it is the first acceptance.
      const real = store.commitMutation(auth, { transportRequestId: 'c1', runOperationId, body });
      expect(real.duplicate).toBe(false);
      expect(store.countRows('commit_bindings')).toBe(1);
    } finally {
      store.close();
    }
  });
});
