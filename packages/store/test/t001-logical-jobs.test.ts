/**
 * T-001 — Logical jobs never merge run-scoped operations. Covers FR-08, INV-01 (owned by M01).
 *
 * Boundary note: header stripping at a live upstream boundary is a contracts-level function
 * (`stripForUpstream`, M00 tests) and is exercised end-to-end by the proxy (M02); this suite
 * covers the persistence boundary.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RouteSpecStore } from '../src/index.ts';
import {
  ManualClock,
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
let store: RouteSpecStore;
const clock = new ManualClock();

beforeEach(() => {
  tmp = tempDir();
  store = openStore(tmp.dir, { clock });
});
afterEach(() => {
  store.close();
  tmp.cleanup();
});

describe('T-001 — Logical jobs never merge run-scoped operations', () => {
  it('creates a distinct run operation per build/gate/case scope, linked only by typed lineage', () => {
    const roles = ['BASELINE', 'CORRECTED', 'REPLAY', 'PROMOTED_REGRESSION'] as const;
    const gate = createGate(store, { label: 'g1', cases: 4, roles: [...roles] });
    const otherGate = createGate(store, {
      label: 'g1',
      cases: 1,
      integrationRevisionId: gate.integrationRevisionId,
      projectId: gate.projectId,
    });
    const otherBuild = createGate(store, {
      label: 'g1',
      cases: 1,
      artifact: 'artifact-other-build',
      integrationRevisionId: gate.integrationRevisionId,
      projectId: gate.projectId,
    });
    const caseIds = [...gate.caseRunIds, ...otherGate.caseRunIds, ...otherBuild.caseRunIds];
    const ops = caseIds.map((caseRunId) => {
      const { auth } = startCase(store, caseRunId);
      return { caseRunId, runOperationId: quoteAndFinalize(store, auth, { job: 'shared-logical-job' }) };
    });
    const runOpIds = new Set(ops.map((o) => o.runOperationId));
    expect(runOpIds.size).toBe(caseIds.length);
    const logicalJobs = new Set(ops.map((o) => store.getRunOperation(o.runOperationId)!['logical_job_id']));
    expect(logicalJobs.size).toBe(1); // same correlation key, never shared state

    for (const o of ops) {
      const attempts = store.listAttempts(o.runOperationId);
      expect(attempts).toHaveLength(1);
      expect(attempts.every((a) => a['run_operation_id'] === o.runOperationId)).toBe(true);
    }
    const [baseline, corrected, replay, promoted] = ops;
    store.linkLineage({
      fromRunOperationId: baseline!.runOperationId,
      toRunOperationId: corrected!.runOperationId,
      relation: 'CORRECTION_OF',
    });
    store.linkLineage({
      fromRunOperationId: baseline!.runOperationId,
      toRunOperationId: replay!.runOperationId,
      relation: 'REPLAY_OF',
    });
    store.linkLineage({
      fromRunOperationId: baseline!.runOperationId,
      toRunOperationId: promoted!.runOperationId,
      relation: 'PROMOTED_FROM',
    });
    expect(store.countRows('run_operation_lineage')).toBe(3);
    // Lineage never merges: each operation keeps its own finalization and attempts.
    for (const o of ops) expect(store.getQuoteFinalization(o.runOperationId)).toBeDefined();
    expect(
      codeOf(() =>
        store.linkLineage({
          fromRunOperationId: baseline!.runOperationId,
          toRunOperationId: baseline!.runOperationId,
          relation: 'REPLAY_OF',
        }),
      ),
    ).toBe('RS_SCHEMA_INVALID');
  });

  it('joins SDK-internal retries (new transport request IDs) into the same run operation as attempts', () => {
    const gate = createGate(store, { label: 'retry' });
    const { auth } = startCase(store, gate.caseRunIds[0]!);
    const first = store.recordQuoteRequest(auth, {
      transportRequestId: 'tx-1',
      logicalJobKey: 'job',
      material: quoteRequest(),
    });
    const retry = store.recordQuoteRequest(auth, {
      transportRequestId: 'tx-2',
      logicalJobKey: 'job',
      material: quoteRequest(),
    });
    expect(retry.runOperationId).toBe(first.runOperationId);
    expect(retry.joined).toBe(true);
    expect(retry.attemptId).not.toBe(first.attemptId);
    const attempts = store.listAttempts(first.runOperationId);
    expect(attempts.map((a) => a['attempt_ordinal'])).toEqual([1, 2]);
    expect(attempts.map((a) => a['transport_request_id'])).toEqual(['tx-1', 'tx-2']);
  });

  it('fails closed on copied tokens, other clients, changed build/case/epoch, changed material, and unknown fields', () => {
    const gate = createGate(store, { label: 'fail-closed', cases: 2 });
    const a = startCase(store, gate.caseRunIds[0]!);
    const b = startCase(store, gate.caseRunIds[1]!);
    const opId = store.recordQuoteRequest(a.auth, {
      transportRequestId: 'tx-a',
      logicalJobKey: 'job',
      material: quoteRequest(),
    }).runOperationId;
    const before = {
      exchanges: store.countRows('proxy_exchanges'),
      ops: store.countRows('run_operations'),
      attempts: store.countRows('attempts'),
    };
    const send = (auth: typeof a.auth, material: unknown = quoteRequest(), tx = `tx-${Math.random()}`) =>
      codeOf(() =>
        store.recordQuoteRequest(auth, { transportRequestId: tx, logicalJobKey: 'job', material }),
      );

    expect(send({ ...a.auth, caseRunId: b.auth.caseRunId, sessionId: b.auth.sessionId })).toBe(
      'RS_IDENTITY_MISMATCH',
    ); // copied token
    expect(send({ ...a.auth, clientInstanceDigest: d('other-client') })).toBe('RS_CLIENT_CONFLICT');
    expect(send({ ...a.auth, buildRevisionId: '00000000-0000-4000-8000-000000000000' })).toBe(
      'RS_IDENTITY_MISMATCH',
    );
    expect(send({ ...a.auth, artifactDigest: d('swapped-artifact') })).toBe('RS_IDENTITY_MISMATCH');
    expect(send({ ...a.auth, fencingEpoch: a.auth.fencingEpoch + 1 })).toBe('RS_STALE_FENCING_EPOCH');
    expect(send({ ...a.auth, token: 'rsct_forged' })).toBe('RS_TOKEN_INVALID');
    expect(send(a.auth, quoteRequest({ surprise: true }))).toBe('RS_UNKNOWN_MATERIAL_FIELD');
    expect(send(a.auth, quoteRequest({ depositAddress: 'pre-known' }))).toBe(
      'RS_DEPOSIT_ADDRESS_NOT_REQUEST_KNOWN',
    );
    expect(send(a.auth, quoteRequest({ amount: '2000000' }))).toBe('RS_MATERIAL_CHANGED');

    expect(store.countRows('proxy_exchanges')).toBe(before.exchanges);
    expect(store.countRows('run_operations')).toBe(before.ops);
    expect(store.countRows('attempts')).toBe(before.attempts);
    expect(store.getRunOperation(opId)!['quote_request_digest']).toBeDefined();
    // The changed-material rejection leaves only a safe conflict code, never the material.
    const conflicts = store.listConflicts(a.auth.sessionId);
    expect(conflicts.map((c) => c['error_code'])).toEqual(['RS_MATERIAL_CHANGED']);
    expect(JSON.stringify(conflicts)).not.toContain('2000000');
  });

  it('never lets a transport request ID substitute for logical or run identity', () => {
    const gate = createGate(store, { label: 'transport', cases: 2 });
    const a = startCase(store, gate.caseRunIds[0]!);
    const b = startCase(store, gate.caseRunIds[1]!);
    const ackA = store.recordQuoteRequest(a.auth, {
      transportRequestId: 'same-tx',
      logicalJobKey: 'job-1',
      material: quoteRequest(),
    });
    const ackB = store.recordQuoteRequest(b.auth, {
      transportRequestId: 'same-tx',
      logicalJobKey: 'job-1',
      material: quoteRequest(),
    });
    expect(ackB.runOperationId).not.toBe(ackA.runOperationId);
    // Same transport ID in the same session with a different logical job is a conflict, not a new identity.
    expect(
      codeOf(() =>
        store.recordQuoteRequest(a.auth, {
          transportRequestId: 'same-tx',
          logicalJobKey: 'job-2',
          material: quoteRequest({ amount: '5' }),
        }),
      ),
    ).toBe('RS_DUPLICATE');
  });
});
