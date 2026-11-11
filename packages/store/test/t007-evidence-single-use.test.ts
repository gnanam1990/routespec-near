/**
 * T-007 — Single-use evidence cannot close two operations. Covers INV-07 (owned by M01).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExecutionFence, RouteSpecStore } from '../src/index.ts';
import {
  ManualClock,
  codeOf,
  createGate,
  openStore,
  quoteAndFinalize,
  startCase,
  tempDir,
} from './support/fixture.ts';

let tmp: ReturnType<typeof tempDir>;
let store: RouteSpecStore;
let fence: ExecutionFence;
let opA: string;
let opB: string;
let opC: string;

function proof(amount: string | null, singleUse = true): string {
  return store.recordEvidence(fence, {
    runOperationId: null,
    evidenceClass: 'PROVEN',
    evidenceScope: 'SIMULATED_GROUND_TRUTH',
    reasons: [],
    subject: 'deposit_tx',
    sourceKind: 'SCENARIO_GROUND_TRUTH',
    assetId: amount === null ? null : 'nep141:origin.test',
    amount,
    singleUse,
    payload: { txHashDigest: 'sha256:test-only', amount },
  }).evidenceId;
}

beforeEach(() => {
  tmp = tempDir();
  store = openStore(tmp.dir, { clock: new ManualClock() });
  const gate = createGate(store, { label: 't007' });
  const started = startCase(store, gate.caseRunIds[0]!);
  fence = started.fence;
  opA = quoteAndFinalize(store, started.auth, { job: 'a', tx: 'qa' });
  opB = quoteAndFinalize(store, started.auth, { job: 'b', tx: 'qb' });
  opC = quoteAndFinalize(store, started.auth, { job: 'c', tx: 'qc' });
});
afterEach(() => {
  store.close();
  tmp.cleanup();
});

describe('T-007 — Single-use evidence cannot close two operations', () => {
  it('rejects a second operation consuming the same single-use proof', () => {
    const evidenceId = proof('1000000');
    store.consumeEvidence(fence, { evidenceId, runOperationId: opA, predicate: 'INV-05.deposit' });
    // Same operation, another predicate: allowed (still one operation binding).
    store.consumeEvidence(fence, { evidenceId, runOperationId: opA, predicate: 'INV-07.deposit' });
    // Exact repeat: idempotent.
    store.consumeEvidence(fence, { evidenceId, runOperationId: opA, predicate: 'INV-05.deposit' });
    expect(
      codeOf(() =>
        store.consumeEvidence(fence, { evidenceId, runOperationId: opB, predicate: 'INV-05.deposit' }),
      ),
    ).toBe('RS_EVIDENCE_ALREADY_CONSUMED');
    expect(store.countRows('evidence_consumptions')).toBe(2);
  });

  it('allows an explicit aggregate allocation only when parts exactly partition the value', () => {
    const evidenceId = proof('1000');
    expect(
      codeOf(() =>
        store.allocateEvidence(fence, {
          evidenceId,
          parts: [
            { runOperationId: opA, amount: '600' },
            { runOperationId: opB, amount: '399' },
          ],
        }),
      ),
    ).toBe('RS_ALLOCATION_INVALID'); // one-unit drift
    expect(
      codeOf(() =>
        store.allocateEvidence(fence, {
          evidenceId,
          parts: [
            { runOperationId: opA, amount: '600' },
            { runOperationId: opB, amount: '401' },
          ],
        }),
      ),
    ).toBe('RS_ALLOCATION_INVALID');
    expect(
      codeOf(() =>
        store.allocateEvidence(fence, {
          evidenceId,
          parts: [
            { runOperationId: opA, amount: '500' },
            { runOperationId: opA, amount: '500' },
          ],
        }),
      ),
    ).toBe('RS_ALLOCATION_INVALID');
    expect(
      codeOf(() =>
        store.allocateEvidence(fence, { evidenceId, parts: [{ runOperationId: opA, amount: '1000' }] }),
      ),
    ).toBe('RS_ALLOCATION_INVALID');
    expect(store.countRows('evidence_allocations')).toBe(0);

    const allocationId = store.allocateEvidence(fence, {
      evidenceId,
      parts: [
        { runOperationId: opA, amount: '600' },
        { runOperationId: opB, amount: '400' },
      ],
    });
    store.consumeEvidence(fence, {
      evidenceId,
      runOperationId: opA,
      predicate: 'INV-05.deposit',
      allocationId,
    });
    store.consumeEvidence(fence, {
      evidenceId,
      runOperationId: opB,
      predicate: 'INV-05.deposit',
      allocationId,
    });
    // An operation outside the partition, or a plain consumption bypassing the allocation, is rejected.
    expect(
      codeOf(() =>
        store.consumeEvidence(fence, {
          evidenceId,
          runOperationId: opC,
          predicate: 'INV-05.deposit',
          allocationId,
        }),
      ),
    ).toBe('RS_ALLOCATION_INVALID');
    expect(
      codeOf(() =>
        store.consumeEvidence(fence, { evidenceId, runOperationId: opC, predicate: 'INV-05.deposit' }),
      ),
    ).toBe('RS_EVIDENCE_ALREADY_CONSUMED');
    // A second allocation of the same evidence is impossible (already consumed through the first).
    expect(
      codeOf(() =>
        store.allocateEvidence(fence, {
          evidenceId,
          parts: [
            { runOperationId: opB, amount: '1' },
            { runOperationId: opC, amount: '999' },
          ],
        }),
      ),
    ).toBe('RS_EVIDENCE_ALREADY_CONSUMED');
    expect(store.countRows('evidence_allocations')).toBe(1);
  });

  it('rejects a second allocation of unconsumed evidence by unique identity', () => {
    const evidenceId = proof('10');
    store.allocateEvidence(fence, {
      evidenceId,
      parts: [
        { runOperationId: opA, amount: '4' },
        { runOperationId: opB, amount: '6' },
      ],
    });
    expect(
      codeOf(() =>
        store.allocateEvidence(fence, {
          evidenceId,
          parts: [
            { runOperationId: opB, amount: '5' },
            { runOperationId: opC, amount: '5' },
          ],
        }),
      ),
    ).toBe('RS_DUPLICATE');
    expect(store.countRows('evidence_allocation_parts')).toBe(2);
  });

  it('cannot allocate evidence that was already consumed plainly, nor evidence without an amount', () => {
    const consumed = proof('1000');
    store.consumeEvidence(fence, { evidenceId: consumed, runOperationId: opA, predicate: 'INV-05.deposit' });
    expect(
      codeOf(() =>
        store.allocateEvidence(fence, {
          evidenceId: consumed,
          parts: [
            { runOperationId: opA, amount: '500' },
            { runOperationId: opB, amount: '500' },
          ],
        }),
      ),
    ).toBe('RS_EVIDENCE_ALREADY_CONSUMED');
    const noAmount = proof(null);
    expect(
      codeOf(() =>
        store.allocateEvidence(fence, {
          evidenceId: noAmount,
          parts: [
            { runOperationId: opA, amount: '1' },
            { runOperationId: opB, amount: '1' },
          ],
        }),
      ),
    ).toBe('RS_ALLOCATION_INVALID');
  });

  it('rejects consumption across case identities and under a stale fence', () => {
    const evidenceId = proof('10');
    const other = createGate(store, { label: 't007', cases: 1 });
    const otherCase = startCase(store, other.caseRunIds[0]!);
    const foreignOp = quoteAndFinalize(store, otherCase.auth, { job: 'a', tx: 'qa' });
    expect(
      codeOf(() =>
        store.consumeEvidence(fence, { evidenceId, runOperationId: foreignOp, predicate: 'INV-05.deposit' }),
      ),
    ).toBe('RS_IDENTITY_MISMATCH');
    expect(
      codeOf(() =>
        store.consumeEvidence(
          { ...fence, fencingEpoch: fence.fencingEpoch + 1 },
          { evidenceId, runOperationId: opA, predicate: 'p' },
        ),
      ),
    ).toBe('RS_STALE_FENCING_EPOCH');
  });
});
