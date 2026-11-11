/**
 * T-002 — Finalized operation binding is immutable. Covers FR-08, INV-02 (owned by M01).
 */
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
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

beforeEach(() => {
  tmp = tempDir();
  store = openStore(tmp.dir, { clock });
  const gate = createGate(store, { label: 't002' });
  auth = startCase(store, gate.caseRunIds[0]!).auth;
});
afterEach(() => {
  store.close();
  tmp.cleanup();
});

const QUOTE_FIELDS = [
  'amountIn',
  'minAmountIn',
  'amountOut',
  'minAmountOut',
  'timeEstimate',
  'amountInFormatted',
  'amountInUsd',
  'amountOutFormatted',
  'amountOutUsd',
];

function snapshot(runOperationId: string) {
  return {
    op: store.getRunOperation(runOperationId),
    fin: store.getQuoteFinalization(runOperationId) ?? null,
    commit: store.getCommitBinding(runOperationId) ?? null,
    exchanges: store.countRows('proxy_exchanges'),
    events: store.countRows('lifecycle_events'),
  };
}

describe('T-002 — Finalized operation binding is immutable', () => {
  it('quote request binds request-known material and rejects an assigned deposit address', () => {
    expect(
      codeOf(() =>
        store.recordQuoteRequest(auth, {
          transportRequestId: 'q0',
          logicalJobKey: 'job',
          material: quoteRequest({ depositAddress: 'x' }),
        }),
      ),
    ).toBe('RS_DEPOSIT_ADDRESS_NOT_REQUEST_KNOWN');
    expect(store.countRows('run_operations')).toBe(0);
    const ack = store.recordQuoteRequest(auth, {
      transportRequestId: 'q1',
      logicalJobKey: 'job',
      material: quoteRequest(),
    });
    const op = store.getRunOperation(ack.runOperationId)!;
    expect(op['current_phase']).toBe('QUOTE_REQUEST');
    expect(String(op['quote_request_json'])).not.toContain('depositAddress');
    expect(op['quote_finalization_digest']).toBeNull();
  });

  it('partial finalization writes nothing for every omitted required response field', () => {
    const request = quoteRequest();
    const ack = store.recordQuoteRequest(auth, {
      transportRequestId: 'q1',
      logicalJobKey: 'job',
      material: request,
    });
    const before = snapshot(ack.runOperationId);
    for (const field of [...QUOTE_FIELDS, 'depositAddress']) {
      const response = quoteResponse(request);
      delete (response['quote'] as Record<string, unknown>)[field];
      expect(
        codeOf(() =>
          store.finalizeQuote(auth, {
            transportRequestId: 'q1',
            runOperationId: ack.runOperationId,
            response,
          }),
        ),
      ).toBe('RS_PARTIAL_FINALIZATION');
    }
    for (const field of ['correlationId', 'timestamp', 'signature', 'quoteRequest']) {
      const response = quoteResponse(request);
      delete response[field];
      expect(
        codeOf(() =>
          store.finalizeQuote(auth, {
            transportRequestId: 'q1',
            runOperationId: ack.runOperationId,
            response,
          }),
        ),
      ).not.toBe('NO_ERROR');
    }
    expect(snapshot(ack.runOperationId)).toEqual(before);
  });

  it('finalizes once; exact repeats are read-idempotent; every changed field is rejected without rewriting', () => {
    const request = quoteRequest();
    const ack = store.recordQuoteRequest(auth, {
      transportRequestId: 'q1',
      logicalJobKey: 'job',
      material: request,
    });
    const fin = store.finalizeQuote(auth, {
      transportRequestId: 'q1',
      runOperationId: ack.runOperationId,
      response: quoteResponse(request),
    });
    expect(fin.depositAddress).toBe('deposit.sim');
    const bound = snapshot(ack.runOperationId);
    const repeat = store.finalizeQuote(auth, {
      transportRequestId: 'q1',
      runOperationId: ack.runOperationId,
      response: quoteResponse(request),
    });
    expect(repeat.finalizationDigest).toBe(fin.finalizationDigest);
    expect(repeat.duplicate).toBe(true);
    expect(snapshot(ack.runOperationId)).toEqual(bound);

    const changes: Array<Record<string, unknown>> = [
      quoteResponse(request, { depositAddress: 'attacker.sim' }),
      quoteResponse(request, { amountOut: '1' }),
      quoteResponse(request, { minAmountOut: '0' }),
      quoteResponse(request, { deadline: '2030-01-01T00:00:00Z' }),
      quoteResponse(request, { refundFee: '5' }),
      quoteResponse(request, { amountOutUsd: '9.99' }),
      quoteResponse(request, {}, { correlationId: 'corr-2' }),
      quoteResponse(request, {}, { signature: 'sig-2' }),
    ];
    for (const response of changes) {
      expect(
        codeOf(() =>
          store.finalizeQuote(auth, {
            transportRequestId: 'q1',
            runOperationId: ack.runOperationId,
            response,
          }),
        ),
      ).toBe('RS_FINALIZATION_CONFLICT');
    }
    expect(
      codeOf(() =>
        store.finalizeQuote(auth, {
          transportRequestId: 'q1',
          runOperationId: ack.runOperationId,
          response: quoteResponse(quoteRequest({ amount: '7' })),
        }),
      ),
    ).toBe('RS_FINALIZATION_REQUEST_MISMATCH');
    const after = snapshot(ack.runOperationId);
    expect(after.op).toEqual(bound.op);
    expect(after.fin).toEqual(bound.fin);
    expect(store.listConflicts(auth.sessionId).map((c) => c['error_code'])).toEqual(
      Array(changes.length).fill('RS_FINALIZATION_CONFLICT'),
    );
  });

  it('commit binds once to the finalized quote; exact retries join; changed, second, phase-invalid, and stale-epoch commits fail', () => {
    const request = quoteRequest();
    const ack = store.recordQuoteRequest(auth, {
      transportRequestId: 'q1',
      logicalJobKey: 'job',
      material: request,
    });
    const runOperationId = ack.runOperationId;
    expect(
      codeOf(() =>
        store.commitMutation(auth, {
          transportRequestId: 'c0',
          runOperationId,
          body: { txHash: '0xaa', depositAddress: 'deposit.sim' },
        }),
      ),
    ).toBe('RS_COMMIT_WITHOUT_FINALIZATION');
    store.finalizeQuote(auth, { transportRequestId: 'q1', runOperationId, response: quoteResponse(request) });
    const body = { txHash: '0xaa', depositAddress: 'deposit.sim' };
    const commit = store.commitMutation(auth, { transportRequestId: 'c1', runOperationId, body });
    expect(commit.ack).toBe(true);
    const bound = snapshot(runOperationId);
    expect(bound.commit!['binding_digest']).toBe(commit.bindingDigest);
    expect(bound.op!['current_phase']).toBe('COMMIT_MUTATION');

    const sameTx = store.commitMutation(auth, { transportRequestId: 'c1', runOperationId, body });
    expect(sameTx.duplicate).toBe(true);
    expect(sameTx.exchangeId).toBe(commit.exchangeId);
    const retry = store.commitMutation(auth, { transportRequestId: 'c2', runOperationId, body });
    expect(retry.joined).toBe(true);
    expect(retry.bindingDigest).toBe(commit.bindingDigest);
    expect(store.countRows('commit_bindings')).toBe(1);

    expect(
      codeOf(() =>
        store.commitMutation(auth, {
          transportRequestId: 'c3',
          runOperationId,
          body: { txHash: '0xbb', depositAddress: 'deposit.sim' },
        }),
      ),
    ).toBe('RS_SECOND_COMMIT_REJECTED');
    expect(
      codeOf(() =>
        store.commitMutation(auth, {
          transportRequestId: 'c4',
          runOperationId,
          body: { txHash: '0xaa', depositAddress: 'other.sim' },
        }),
      ),
    ).toBe('RS_COMMIT_MATERIAL_MISMATCH');
    expect(
      codeOf(() =>
        store.commitMutation(auth, { transportRequestId: 'c5', runOperationId, body: { ...body, extra: 1 } }),
      ),
    ).toBe('RS_UNKNOWN_MATERIAL_FIELD');
    expect(
      codeOf(() =>
        store.commitMutation(
          { ...auth, fencingEpoch: auth.fencingEpoch - 1 },
          { transportRequestId: 'c6', runOperationId, body },
        ),
      ),
    ).toBe('RS_STALE_FENCING_EPOCH');
    expect(
      codeOf(() =>
        store.recordQuoteRequest(auth, { transportRequestId: 'q9', logicalJobKey: 'job', material: request }),
      ),
    ).toBe('RS_PHASE_INVALID');
    expect(
      codeOf(() =>
        store.finalizeQuote(auth, {
          transportRequestId: 'q1',
          runOperationId,
          response: quoteResponse(request, { amountOut: '2' }),
        }),
      ),
    ).toBe('RS_FINALIZATION_CONFLICT');
    const after = snapshot(runOperationId);
    expect(after.commit).toEqual(bound.commit);
    expect(after.fin).toEqual(bound.fin);
    expect(after.op!['commit_binding_digest']).toBe(bound.op!['commit_binding_digest']);
  });

  it('racing finalization and commit callers through the writer queue bind exactly once', async () => {
    const request = quoteRequest();
    const ack = store.recordQuoteRequest(auth, {
      transportRequestId: 'q1',
      logicalJobKey: 'job',
      material: request,
    });
    const runOperationId = ack.runOperationId;
    const finals = await Promise.allSettled([
      store.journal
        .enqueue('race', () => undefined)
        .then(() =>
          store.finalizeQuote(auth, {
            transportRequestId: 'q1',
            runOperationId,
            response: quoteResponse(request),
          }),
        ),
      store.journal
        .enqueue('race', () => undefined)
        .then(() =>
          store.finalizeQuote(auth, {
            transportRequestId: 'q1',
            runOperationId,
            response: quoteResponse(request, { amountOut: '3' }),
          }),
        ),
    ]);
    expect(finals.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const bodies = ['0x01', '0x02', '0x03'].map((txHash) => ({ txHash, depositAddress: 'deposit.sim' }));
    const commits = await Promise.allSettled(
      bodies.map((body, i) =>
        Promise.resolve().then(() =>
          store.commitMutation(auth, { transportRequestId: `c${i}`, runOperationId, body }),
        ),
      ),
    );
    expect(commits.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(store.countRows('commit_bindings')).toBe(1);
    expect(store.countRows('quote_finalizations')).toBe(1);
  });

  it('the database itself refuses to rewrite a finalization or commit binding', () => {
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
    store.commitMutation(auth, {
      transportRequestId: 'c1',
      runOperationId: ack.runOperationId,
      body: { txHash: '0xaa', depositAddress: 'deposit.sim' },
    });
    store.close();
    // A raw connection (bypassing the repository) still cannot rewrite history: triggers abort.
    const raw = new DatabaseSync(join(tmp.dir, 'journal.db'));
    const attempts = [
      `UPDATE quote_finalizations SET deposit_address = 'x'`,
      `UPDATE commit_bindings SET transaction_digest = 'x'`,
      `DELETE FROM commit_bindings`,
      `UPDATE run_operations SET quote_finalization_digest = 'sha256:00'`,
      `UPDATE run_operations SET commit_binding_digest = NULL`,
      `UPDATE proxy_exchanges SET request_digest = 'x'`,
    ];
    for (const sql of attempts) expect(() => raw.exec(sql), sql).toThrow(/RS_IMMUTABLE_RECORD/);
    raw.close();
    store = openStore(tmp.dir, { clock });
  });
});
