/**
 * T-026 — Duplicate proxy request ID is idempotent. Covers FR-07, FR-08 (owned by M01).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CaseAuth, RouteSpecStore } from '../src/index.ts';
import {
  ManualClock,
  codeOf,
  createGate,
  openStore,
  quoteRequest,
  quoteResponse,
  startCase,
  tempDir,
} from './support/fixture.ts';

let tmp: ReturnType<typeof tempDir>;
let store: RouteSpecStore;
let auth: CaseAuth;
const clock = new ManualClock();
const body = { txHash: '0xaa', depositAddress: 'deposit.sim' };

beforeEach(() => {
  tmp = tempDir();
  store = openStore(tmp.dir, { clock });
});
afterEach(() => {
  store.close();
  tmp.cleanup();
});

function prepared(): { auth: CaseAuth; runOperationId: string; gate: ReturnType<typeof createGate> } {
  const gate = createGate(store, { label: 't026', cases: 2 });
  auth = startCase(store, gate.caseRunIds[0]!).auth;
  const request = quoteRequest();
  const ack = store.recordQuoteRequest(auth, {
    transportRequestId: 'q1',
    logicalJobKey: 'job',
    material: request,
  });
  store.finalizeQuote(auth, {
    transportRequestId: 'q1',
    runOperationId: ack.runOperationId,
    response: quoteResponse(request),
  });
  return { auth, runOperationId: ack.runOperationId, gate };
}

describe('T-026 — Duplicate proxy request ID is idempotent', () => {
  it('concurrent duplicates of one transport request ID yield one authoritative exchange', async () => {
    const { runOperationId } = prepared();
    const before = {
      ex: store.countRows('proxy_exchanges'),
      att: store.countRows('attempts'),
      ev: store.countRows('lifecycle_events'),
    };
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        store.journal
          .enqueue('dup', () => undefined)
          .then(() => store.commitMutation(auth, { transportRequestId: 'c1', runOperationId, body })),
      ),
    );
    const exchangeIds = new Set(results.map((r) => r.exchangeId));
    expect(exchangeIds.size).toBe(1);
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(new Set(results.map((r) => r.sequence)).size).toBe(1);
    expect(store.countRows('proxy_exchanges')).toBe(before.ex + 1);
    expect(store.countRows('attempts')).toBe(before.att + 1);
    expect(store.countRows('lifecycle_events')).toBe(before.ev + 1);
    expect(store.countRows('commit_bindings')).toBe(1);
  });

  it('a duplicate after restart returns the same journaled exchange and sequence', () => {
    const { runOperationId } = prepared();
    const first = store.commitMutation(auth, { transportRequestId: 'c1', runOperationId, body });
    const nextSequence = store.getSession(auth.sessionId)!['next_sequence'];
    store.close();
    store = openStore(tmp.dir, { clock });
    const again = store.commitMutation(auth, { transportRequestId: 'c1', runOperationId, body });
    expect(again.duplicate).toBe(true);
    expect(again.exchangeId).toBe(first.exchangeId);
    expect(again.sequence).toBe(first.sequence);
    expect(store.getSession(auth.sessionId)!['next_sequence']).toBe(nextSequence);
  });

  it('a different request ID with exact material adds an attempt to the same operation', () => {
    const { runOperationId } = prepared();
    const first = store.commitMutation(auth, { transportRequestId: 'c1', runOperationId, body });
    const second = store.commitMutation(auth, { transportRequestId: 'c2', runOperationId, body });
    expect(second.runOperationId).toBe(first.runOperationId);
    expect(second.attemptId).not.toBe(first.attemptId);
    expect(second.joined).toBe(true);
    const commits = store.listAttempts(runOperationId).filter((a) => a['phase'] === 'COMMIT_MUTATION');
    expect(commits.map((a) => a['attempt_ordinal'])).toEqual([2, 3]);
    expect(store.countRows('commit_bindings')).toBe(1);
  });

  it('the same logical job in another case creates a distinct run operation', () => {
    const { runOperationId, gate } = prepared();
    const other = startCase(store, gate.caseRunIds[1]!).auth;
    const ack = store.recordQuoteRequest(other, {
      transportRequestId: 'q1',
      logicalJobKey: 'job',
      material: quoteRequest(),
    });
    expect(ack.runOperationId).not.toBe(runOperationId);
    expect(ack.duplicate).toBe(false);
  });

  it('changed material, stale epoch, a copied token, or a second commit under a reused ID fails closed', () => {
    const { runOperationId, gate } = prepared();
    store.commitMutation(auth, { transportRequestId: 'c1', runOperationId, body });
    const snapshot = {
      ex: store.countRows('proxy_exchanges'),
      commit: store.getCommitBinding(runOperationId),
    };
    expect(
      codeOf(() =>
        store.commitMutation(auth, {
          transportRequestId: 'c1',
          runOperationId,
          body: { ...body, txHash: '0xbb' },
        }),
      ),
    ).toBe('RS_DUPLICATE');
    expect(
      codeOf(() =>
        store.commitMutation(auth, {
          transportRequestId: 'c9',
          runOperationId,
          body: { ...body, txHash: '0xbb' },
        }),
      ),
    ).toBe('RS_SECOND_COMMIT_REJECTED');
    expect(
      codeOf(() =>
        store.commitMutation(
          { ...auth, fencingEpoch: 0 },
          { transportRequestId: 'c1', runOperationId, body },
        ),
      ),
    ).toBe('RS_STALE_FENCING_EPOCH');
    const other = startCase(store, gate.caseRunIds[1]!).auth;
    expect(
      codeOf(() =>
        store.commitMutation(
          { ...other, token: auth.token },
          { transportRequestId: 'c1', runOperationId, body },
        ),
      ),
    ).toBe('RS_IDENTITY_MISMATCH');
    expect(
      codeOf(() => store.commitMutation(other, { transportRequestId: 'c1', runOperationId, body })),
    ).toBe('RS_IDENTITY_MISMATCH');
    expect(store.countRows('proxy_exchanges')).toBe(snapshot.ex);
    expect(store.getCommitBinding(runOperationId)).toEqual(snapshot.commit);
  });
});
