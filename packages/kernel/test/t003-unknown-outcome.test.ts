/**
 * T-003 — Unknown outcome blocks a second mutation. Covers FR-07, INV-03.
 *
 * Journal-backed: the real networkless proxy accepts a commit, the accepted-then-lost-response
 * scenario deterministically drops its response, and the supervisor revokes the execution token,
 * increments the fencing epoch, and issues exactly one reconciliation-only token. Every forbidden
 * write is denied before any state change; read-only status calls on the bound run operation are
 * permitted; the kernel then evaluates INV-03 from the journal snapshot.
 *
 * Restart/concurrency: a journal with an uncertain commit is closed and reopened past its lease;
 * recovery issues only reconciliation authority and a concurrent recovery loses on the epoch.
 *
 * Counterexamples the journal itself refuses to produce (an accepted second mutation, a reissued
 * execution token, a missing fence) are applied to the real journal snapshot to prove the kernel
 * fails or reviews them rather than passing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLIENT_INSTANCE_DIGEST_DOMAIN, digestValue } from '@routespec/contracts';
import { RouteSpecStore } from '@routespec/store';
import { evaluateCase, evaluateInv03, snapshotFromJournal } from '../src/index.ts';
import { mutate } from './support/pure.ts';
import {
  Harness,
  adapterHeaders,
  compileCore,
  createGate,
  evaluateFromJournal,
  openStore,
  persistEvaluation,
  pollStatus,
  quoteAndCommit,
  quoteBody,
  send,
  tempDir,
} from './support/journal.ts';

const REQUIRED = ['INV-01', 'INV-02', 'INV-03', 'INV-05', 'INV-06', 'INV-07', 'INV-08'];

let tmp: ReturnType<typeof tempDir>;
afterEach(() => tmp?.cleanup());

describe('T-003 — Unknown outcome blocks a second mutation', () => {
  let store: RouteSpecStore;
  let h: Harness;
  beforeEach(async () => {
    tmp = tempDir();
    store = openStore(tmp.dir);
    h = await Harness.start(store);
  });
  afterEach(async () => {
    await h.close();
    store.close();
  });

  it('fences on response loss, denies every mutation before state change, permits read-only reconciliation, and INV-03 passes', async () => {
    const compiled = compileCore('accepted-then-lost-response');
    const gate = createGate(store, compiled, { label: 't003', requiredInvariants: REQUIRED });
    const caseRunId = gate.caseRunIds[0] as string;
    const original = h.startCase(caseRunId, compiled);
    const op = await quoteAndCommit(h, caseRunId, 't003');
    expect(op.commit.reset).toBe(true); // accepted locally, response deterministically lost

    const recon = h.creds(caseRunId);
    expect(recon.purpose).toBe('RECONCILIATION_ONLY');
    expect(recon.fencingEpoch).toBe(original.fencingEpoch + 1);
    expect(recon.token).not.toBe(original.token);
    const before = {
      bindings: store.countRows('commit_bindings'),
      finalizations: store.countRows('quote_finalizations'),
      operations: store.countRows('run_operations'),
      exchanges: store.countRows('proxy_exchanges'),
    };

    const commit = (creds: typeof original, requestId: string, txHash: string) =>
      send(h.proxy.port, {
        method: 'POST',
        path: '/v0/deposit/submit',
        headers: adapterHeaders(creds, { requestId, runOperationId: op.runOperationId }),
        body: { txHash, depositAddress: op.depositAddress },
      });
    // Original token: exact retry and changed commit are both refused.
    expect((await commit(original, 't003-c-retry', 't003-tx')).code).toBe('RS_TOKEN_REVOKED');
    expect((await commit(original, 't003-c-changed', 't003-tx-2')).code).toBe('RS_TOKEN_REVOKED');
    // Stale epoch with the reconciliation token.
    expect(
      (await commit({ ...recon, fencingEpoch: original.fencingEpoch }, 't003-c-stale', 't003-tx')).code,
    ).toBe('RS_STALE_FENCING_EPOCH');
    // Reconciliation token: no commit (exact or changed), no new quote/finalization.
    expect((await commit(recon, 't003-c-recon', 't003-tx')).code).toBe('RS_TOKEN_PHASE_DENIED');
    expect((await commit(recon, 't003-c-recon2', 't003-tx-2')).code).toBe('RS_TOKEN_PHASE_DENIED');
    const requote = await send(h.proxy.port, {
      method: 'POST',
      path: '/v0/quote',
      headers: adapterHeaders(recon, { requestId: 't003-q2', logicalJob: 't003-job-2' }),
      body: quoteBody(),
    });
    expect(requote.code).toBe('RS_TOKEN_PHASE_DENIED');
    expect({
      bindings: store.countRows('commit_bindings'),
      finalizations: store.countRows('quote_finalizations'),
      operations: store.countRows('run_operations'),
      exchanges: store.countRows('proxy_exchanges'),
    }).toEqual(before);

    // Read-only status calls on the bound run operation are permitted under the reconciliation token.
    const seen: string[] = [];
    for (let i = 1; i <= 3 && seen.at(-1) !== 'SUCCESS'; i++) {
      const s = await pollStatus(h, caseRunId, op, `t003-s${i}`);
      expect(s.status, JSON.stringify(s.body)).toBe(200);
      seen.push((s.body as { status: string }).status);
    }
    expect(seen.at(-1)).toBe('SUCCESS');
    expect(store.countRows('commit_bindings')).toBe(1);

    h.supervisor.teardown(caseRunId);
    const { input, evaluation } = evaluateFromJournal(store, caseRunId);
    const inv03 = evaluation.invariantResults.filter((r) => r.invariantId === 'INV-03');
    expect(inv03).toHaveLength(1);
    expect(inv03[0]).toMatchObject({
      verdict: 'PASS',
      explanationCode: 'INV03_RECONCILED_WITHOUT_SECOND_MUTATION',
      runOperationId: op.runOperationId,
    });
    expect(input.tokens.map((t) => [t.purpose, t.fencingEpoch, t.revoked])).toEqual([
      ['EXECUTION', original.fencingEpoch, true],
      ['RECONCILIATION_ONLY', recon.fencingEpoch, true],
    ]);
    expect(evaluation.verdict).toBe('PASS');
    persistEvaluation(store, h.supervisor.fenceFor(caseRunId), input, evaluation);
    expect(store.getCaseRun(caseRunId)).toMatchObject({ execution_lifecycle: 'COMPLETED', verdict: 'PASS' });

    // Counterexamples on top of the real snapshot: the kernel never passes them.
    const commitSeq = input.commitBindings[0]!.sequence;
    const secondCommit = mutate(input, (dr) => {
      dr.runOperations.push({
        ...dr.runOperations[0]!,
        runOperationId: '00000000-0000-4000-8000-0000000000ff',
        logicalJobId: '00000000-0000-4000-8000-0000000000fe',
      });
      dr.commitBindings.push({
        runOperationId: '00000000-0000-4000-8000-0000000000ff',
        bindingDigest: digestValue('routespec.test/1', 'second'),
        firstAttemptId: '00000000-0000-4000-8000-0000000000fd',
        sequence: commitSeq + 1,
        fencingEpoch: recon.fencingEpoch,
      });
    });
    expect(evaluateInv03(secondCommit)[0]).toMatchObject({
      verdict: 'FAIL',
      explanationCode: 'INV03_SECOND_MUTATION_UNDER_UNCERTAINTY',
    });
    expect(evaluateCase(secondCommit).verdict).toBe('FAIL');
    const finalizedAgain = mutate(input, (dr) => {
      dr.quoteFinalizations.push({
        ...dr.quoteFinalizations[0]!,
        runOperationId: '00000000-0000-4000-8000-0000000000ff',
        sequence: commitSeq + 1,
      });
    });
    expect(evaluateInv03(finalizedAgain)[0]!.verdict).toBe('FAIL');
    const reissued = mutate(input, (dr) => {
      dr.tokens.push({
        purpose: 'EXECUTION',
        fencingEpoch: recon.fencingEpoch,
        revoked: false,
        revocationReason: null,
        revokedAtEpoch: null,
      });
    });
    expect(evaluateInv03(reissued)[0]).toMatchObject({
      verdict: 'FAIL',
      explanationCode: 'INV03_MUTATION_AUTHORITY_REISSUED',
    });
    const unfenced = mutate(input, (dr) => {
      dr.tokens = dr.tokens
        .filter((t) => t.purpose === 'EXECUTION')
        .map((t) => ({ ...t, revoked: false, revocationReason: null, revokedAtEpoch: null }));
    });
    expect(evaluateInv03(unfenced)[0]).toMatchObject({
      verdict: 'REVIEW',
      explanationCode: 'INV03_RECOVERY_FENCE_MISSING',
    });
    const unreconciled = mutate(input, (dr) => {
      dr.events = dr.events.filter((e) => e.rawStatus !== 'SUCCESS');
      dr.runOperations[0]!.acceptedTerminalStatus = null;
      dr.runOperations[0]!.normalizedOutcome = 'PROCESSING';
    });
    expect(evaluateInv03(unreconciled)[0]).toMatchObject({
      verdict: 'REVIEW',
      explanationCode: 'INV03_RECONCILIATION_INCOMPLETE',
    });
    // Cancellation or a user assertion is not a terminal: an aborted lifecycle still cannot pass.
    expect(
      evaluateCase(mutate(unreconciled, (dr) => void (dr.caseState.lifecycle = 'ABORTED'))).verdict,
    ).toBe('REVIEW');
  });
});

describe('T-003 — restart and concurrent recovery cannot issue competing mutation authority', () => {
  it('reopens a journal with an uncertain commit; recovery issues only reconciliation authority and one recovery wins', () => {
    tmp = tempDir();
    let now = 1_800_000_000_000;
    const clock = { nowMs: () => now };
    const compiled = compileCore('accepted-then-lost-response');
    let store = openStore(tmp.dir, { clock });
    let caseRunId = '';
    let client = '';
    let started: ReturnType<RouteSpecStore['startCase']>;
    let q: ReturnType<RouteSpecStore['recordQuoteRequest']>;
    try {
      const gate = createGate(store, compiled, { label: 't003-restart', requiredInvariants: REQUIRED });
      caseRunId = gate.caseRunIds[0] as string;
      client = digestValue(CLIENT_INSTANCE_DIGEST_DOMAIN, 'client-restart');
      started = store.startCase({
        caseRunId,
        leaseOwnerDigest: digestValue('routespec.runner-owner/1', 'runner-a'),
        clientInstanceDigest: client,
        mode: 'SIMULATE',
        seed: compiled.plan.seed,
        leaseTtlMs: 60_000,
        tokenTtlMs: 600_000,
      });
      q = store.recordQuoteRequest(started.auth, {
        transportRequestId: 'r-q',
        logicalJobKey: 'job-r',
        material: quoteBody(),
      });
      const fin = store.finalizeQuote(started.auth, {
        transportRequestId: 'r-q',
        runOperationId: q.runOperationId,
        response: {
          correlationId: 'corr-r',
          timestamp: '2026-11-11T11:00:00Z',
          signature: 'sig-r',
          quoteRequest: quoteBody(),
          quote: {
            depositAddress: 'deposit-r.sim',
            amountIn: '1000000',
            amountInFormatted: '1.0',
            amountInUsd: '1.00',
            minAmountIn: '1000000',
            amountOut: '999000',
            amountOutFormatted: '0.999',
            amountOutUsd: '0.99',
            minAmountOut: '989010',
            deadline: '2026-11-11T12:00:00Z',
            timeEstimate: 30,
          },
        },
      });
      expect(fin.depositAddress).toBe('deposit-r.sim');
      store.markResponseDelivered(started.auth, q.exchangeId);
      // Commit accepted and journaled; the response is never delivered (process "crashes").
      store.commitMutation(started.auth, {
        transportRequestId: 'r-c',
        runOperationId: q.runOperationId,
        body: { txHash: 'tx-r', depositAddress: 'deposit-r.sim' },
      });
    } finally {
      store.close();
    }

    now += 120_000; // past the lease
    store = RouteSpecStore.open({ path: `${tmp.dir}/journal.db`, clock });
    try {
      expect(store.recoverExpiredLeases()).toEqual([caseRunId]);
      const fenced = Number(store.getCaseRun(caseRunId)?.['fencing_epoch']);
      const recover = (owner: string) =>
        store.recoverCase({
          caseRunId,
          recoveryOwnerDigest: digestValue('routespec.runner-owner/1', owner),
          clientInstanceDigest: client,
          expectedFencingEpoch: fenced,
          leaseTtlMs: 60_000,
          tokenTtlMs: 600_000,
        });
      const winner = recover('runner-b');
      expect(() => recover('runner-c')).toThrow(expect.objectContaining({ code: 'RS_LEASE_HELD' }));
      expect(() =>
        store.recoverCase({
          caseRunId,
          recoveryOwnerDigest: digestValue('routespec.runner-owner/1', 'runner-d'),
          clientInstanceDigest: client,
          expectedFencingEpoch: fenced - 1,
          leaseTtlMs: 60_000,
          tokenTtlMs: 600_000,
        }),
      ).toThrow(expect.objectContaining({ code: 'RS_STALE_FENCING_EPOCH' }));
      // The original token and the recovery token can never commit again.
      const again = {
        transportRequestId: 'r-c2',
        runOperationId: q.runOperationId,
        body: { txHash: 'tx-r', depositAddress: 'deposit-r.sim' },
      };
      expect(() => store.commitMutation(started.auth, again)).toThrow(
        expect.objectContaining({ code: 'RS_TOKEN_REVOKED' }),
      );
      expect(() => store.commitMutation(winner.auth, again)).toThrow(
        expect.objectContaining({ code: 'RS_TOKEN_PHASE_DENIED' }),
      );
      expect(store.countRows('commit_bindings')).toBe(1);

      const snap1 = snapshotFromJournal(store.readEvaluationSnapshot(caseRunId));
      expect(snap1.tokens.filter((t) => !t.revoked).map((t) => t.purpose)).toEqual(['RECONCILIATION_ONLY']);
      expect(evaluateInv03(snap1)[0]).toMatchObject({
        verdict: 'REVIEW',
        explanationCode: 'INV03_RECONCILIATION_INCOMPLETE',
      });

      // Read-only reconciliation reaches an accepted terminal; INV-03 then passes.
      for (const [i, raw] of ['PROCESSING', 'SUCCESS'].entries()) {
        const s = store.recordStatusObservation(winner.auth, {
          transportRequestId: `r-s${i}`,
          runOperationId: q.runOperationId,
          query: { depositAddress: 'deposit-r.sim' },
          rawStatus: raw,
        });
        expect(s.ack).toBe(true);
      }
      const snap2 = snapshotFromJournal(store.readEvaluationSnapshot(caseRunId));
      expect(evaluateInv03(snap2)[0]).toMatchObject({
        verdict: 'PASS',
        explanationCode: 'INV03_RECONCILED_WITHOUT_SECOND_MUTATION',
      });
    } finally {
      store.close();
    }
  });
});
