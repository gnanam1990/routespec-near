/**
 * T-059 — Protected-effect observation is operation-bound and idempotent.
 * Covers FR-07, FR-08, FR-09, INV-04.
 *
 * Subject path: reports authenticate with the case token through the journal and bind
 * build/artifact/gate/case/session/run operation, policy/manifest/hook, effect ID/type/action,
 * fencing epoch, idempotency key, and time. Exact retries return the original report; changed
 * identities/actions, stale epoch, a copied token, a concurrent client, an undeclared or forged
 * hook, and a mismatched manifest fail closed. Every row is SUBJECT_REPORTED.
 *
 * Boundary path: the separately launched interceptor authenticates over its private channel;
 * subject, control, and case tokens cannot write boundary observations. Exact duplicate frames
 * are idempotent; forged/stale bindings fail closed. Kernel: incomplete independent coverage is
 * REVIEW, an observed forbidden release is FAIL. No real downstream effect executes.
 */
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { digestValue } from '@routespec/contracts';
import {
  CANARY_INTERCEPTOR_PROFILE,
  INTERCEPTOR_CHANNEL_KEY_DOMAIN,
  InterceptorHost,
} from '@routespec/proxy';
import { codeOfThrow } from './support/codes.ts';
import {
  Harness,
  compileCore,
  createGate,
  evaluateFromJournal,
  openStore,
  tempDir,
} from './support/journal.ts';
import {
  CANARY_PROFILE_DIGEST,
  SINK,
  attemptEffect,
  caseAuthFor,
  report,
  runLiveEffectCase,
} from './support/effects.ts';

let tmp: ReturnType<typeof tempDir>;
let store: ReturnType<typeof openStore>;
let h: Harness;

beforeAll(async () => {
  tmp = tempDir();
  store = openStore(tmp.dir);
  h = await Harness.start(store);
});
afterAll(async () => {
  await h.close();
  store.close();
  tmp.cleanup();
});

describe('T-059 — Protected-effect observation is operation-bound and idempotent', () => {
  it('subject reports: exact retry is idempotent; every changed or foreign binding fails closed', async () => {
    const compiled = compileCore('happy-path');
    const gate = createGate(store, compiled, { label: 't059-subject', cases: 2 });
    const [caseA, caseB] = gate.caseRunIds as [string, string];
    h.startCase(caseA, compiled);
    h.startCase(caseB, compiled);
    const auth = caseAuthFor(h, gate, caseA);
    const first = report(store, auth, gate, {
      effectId: 'order-1',
      action: 'ATTEMPTED',
      idempotencyKey: 'k-1',
    });
    expect(first).toMatchObject({ duplicate: false, coverageClassification: 'SUBJECT_REPORTED' });
    const retry = report(store, auth, gate, {
      effectId: 'order-1',
      action: 'ATTEMPTED',
      idempotencyKey: 'k-1',
    });
    expect(retry).toEqual({ ...first, duplicate: true });
    expect(store.listSubjectEffectReports(caseA)).toHaveLength(1);

    const fails: Array<[string, () => unknown, string]> = [
      [
        'changed action',
        () => report(store, auth, gate, { effectId: 'order-1', action: 'RELEASED', idempotencyKey: 'k-1' }),
        'RS_IDEMPOTENCY_KEY_REUSED',
      ],
      [
        'changed effect',
        () => report(store, auth, gate, { effectId: 'order-2', action: 'ATTEMPTED', idempotencyKey: 'k-1' }),
        'RS_IDEMPOTENCY_KEY_REUSED',
      ],
      [
        'changed effect type',
        () =>
          report(store, auth, gate, {
            effectId: 'order-1',
            action: 'ATTEMPTED',
            idempotencyKey: 'k-1',
            effectType: 'SEND_EMAIL',
          }),
        'RS_IDEMPOTENCY_KEY_REUSED',
      ],
      [
        'undeclared hook',
        () => report(store, auth, gate, { effectId: 'o-3', action: 'ATTEMPTED', hookId: 'refund-mailer' }),
        'RS_EFFECT_HOOK_UNDECLARED',
      ],
      [
        'forged hook revision',
        () => report(store, auth, gate, { effectId: 'o-4', action: 'ATTEMPTED', hookRevision: '2' }),
        'RS_EFFECT_HOOK_UNDECLARED',
      ],
      [
        'forged hook effect type',
        () => report(store, auth, gate, { effectId: 'o-5', action: 'ATTEMPTED', effectType: 'SEND_EMAIL' }),
        'RS_EFFECT_HOOK_UNDECLARED',
      ],
      [
        'mismatched manifest',
        () =>
          report(store, auth, gate, {
            effectId: 'o-6',
            action: 'ATTEMPTED',
            manifestDigest: 'sha256:' + '5'.repeat(64),
          }),
        'RS_IDENTITY_MISMATCH',
      ],
      [
        'mismatched policy',
        () =>
          report(store, auth, gate, {
            effectId: 'o-7',
            action: 'ATTEMPTED',
            policyDigest: 'sha256:' + '6'.repeat(64),
          }),
        'RS_IDENTITY_MISMATCH',
      ],
      [
        'foreign run operation',
        () =>
          report(store, auth, gate, {
            effectId: 'o-8',
            action: 'ATTEMPTED',
            runOperationId: '00000000-0000-4000-8000-0000000000cc',
          }),
        'RS_IDENTITY_MISMATCH',
      ],
      [
        'copied token on another case',
        () =>
          report(store, { ...caseAuthFor(h, gate, caseB), token: auth.token }, gate, {
            effectId: 'o-9',
            action: 'ATTEMPTED',
          }),
        'RS_IDENTITY_MISMATCH',
      ],
      [
        'concurrent client',
        () =>
          report(
            store,
            { ...auth, clientInstanceDigest: digestValue('routespec.client-instance/1', 'other') },
            gate,
            { effectId: 'o-10', action: 'ATTEMPTED' },
          ),
        'RS_CLIENT_CONFLICT',
      ],
      [
        'forged token',
        () =>
          report(store, { ...auth, token: `rsct_${randomBytes(32).toString('base64url')}` }, gate, {
            effectId: 'o-11',
            action: 'ATTEMPTED',
          }),
        'RS_TOKEN_INVALID',
      ],
    ];
    for (const [label, fn, code] of fails) expect(codeOfThrow(fn), label).toBe(code);
    expect(store.listSubjectEffectReports(caseA)).toHaveLength(1);

    // Stale epoch: after the case is fenced, the old token and its epoch are refused.
    store.requireRecovery(h.supervisor.fenceFor(caseA), 'RUNNER_CANCELLED');
    expect(
      codeOfThrow(() =>
        report(store, auth, gate, { effectId: 'order-1', action: 'ATTEMPTED', idempotencyKey: 'k-1' }),
      ),
    ).toBe('RS_TOKEN_REVOKED');
    const row = store.listSubjectEffectReports(caseA)[0]!;
    expect(row).toMatchObject({
      coverage_classification: 'SUBJECT_REPORTED',
      fencing_epoch: auth.fencingEpoch,
      hook_id: 'fulfilment',
      action: 'ATTEMPTED',
    });
    expect(String(row['idempotency_key_digest'])).toMatch(/^sha256:/); // the key itself is not stored
  });

  it('boundary observations: only the private channel writes; duplicates are idempotent; forged/stale bindings fail', async () => {
    const compiled = compileCore('happy-path');
    const gate = createGate(store, compiled, {
      label: 't059-boundary',
      basis: 'INDEPENDENT_BOUNDARY_INTERCEPT',
      interceptorProfileDigest: CANARY_PROFILE_DIGEST,
    });
    const caseRunId = gate.caseRunIds[0] as string;
    const creds = h.startCase(caseRunId, compiled);
    const host = await InterceptorHost.launch({ store, fence: h.supervisor.fenceFor(caseRunId) });
    try {
      const denied = await attemptEffect(host, 'order-b1');
      expect(denied.status).toBe(409);
      const [first] = store.listBoundaryObservations(caseRunId);
      const frame = {
        sequence: 50,
        frameDigest: digestValue('routespec.test/1', 'frame-50'),
        buildRevisionId: gate.buildRevisionId,
        gateRunId: gate.gateRunId,
        caseRunId,
        sessionId: creds.sessionId,
        fencingEpoch: creds.fencingEpoch,
        policyDigest: gate.policyDigest,
        manifestDigest: gate.manifestDigest,
        interceptorProfileDigest: CANARY_PROFILE_DIGEST,
        runOperationId: null,
        sinkClass: SINK,
        effectId: 'order-forged',
        effectType: 'DELIVER_GOODS',
        action: 'RELEASED' as const,
        virtualMs: null,
      };
      // Subject case token, a control-style token, and a forged key cannot write.
      for (const channelKey of [
        creds.token,
        'rsctl_control-token-shaped-value',
        randomBytes(32).toString('base64url'),
      ]) {
        expect(
          codeOfThrow(() =>
            store.recordBoundaryObservation(
              { interceptorInstanceId: host.interceptorInstanceId, channelKey },
              frame,
            ),
          ),
        ).toBe('RS_CHANNEL_AUTH_FAILED');
      }
      expect(first?.['action']).toBe('ATTEMPTED');

      // A second authenticated channel (store API, test-chosen key) to exercise exact duplicates and binding checks.
      const key = randomBytes(32).toString('base64url');
      const { interceptorInstanceId } = store.registerInterceptorInstance(h.supervisor.fenceFor(caseRunId), {
        interceptorProfileDigest: CANARY_PROFILE_DIGEST,
        interceptorArtifactDigest: CANARY_INTERCEPTOR_PROFILE.artifactDigest,
        sandboxScopeDigest: digestValue('routespec.sandbox-scope/1', 't059'),
        supportedSinks: [SINK],
        containment: 'DECLARED_HOOKS_ONLY',
        channelKeyDigest: digestValue(INTERCEPTOR_CHANNEL_KEY_DOMAIN, key),
        peerPid: process.pid,
        attestationId: null,
      });
      const ch = { interceptorInstanceId, channelKey: key };
      const blocked = { ...frame, action: 'BLOCKED' as const, effectId: 'order-dup' };
      const a = store.recordBoundaryObservation(ch, blocked);
      expect(store.recordBoundaryObservation(ch, blocked)).toEqual({
        observationId: a.observationId,
        duplicate: true,
      });
      expect(
        codeOfThrow(() =>
          store.recordBoundaryObservation(ch, {
            ...blocked,
            frameDigest: digestValue('routespec.test/1', 'changed'),
          }),
        ),
      ).toBe('RS_DUPLICATE');
      expect(
        codeOfThrow(() =>
          store.recordBoundaryObservation(ch, {
            ...blocked,
            sequence: 51,
            interceptorProfileDigest: 'sha256:' + '7'.repeat(64),
          }),
        ),
      ).toBe('RS_CHANNEL_BINDING_MISMATCH');
      expect(
        codeOfThrow(() =>
          store.recordBoundaryObservation(ch, { ...blocked, sequence: 52, sinkClass: 'payment-capture' }),
        ),
      ).toBe('RS_SINK_UNSUPPORTED');
      expect(
        codeOfThrow(() =>
          store.recordBoundaryObservation(ch, {
            ...blocked,
            sequence: 53,
            caseRunId: gate.caseRunIds[0]!,
            sessionId: '00000000-0000-4000-8000-0000000000dd',
          }),
        ),
      ).toBe('RS_CHANNEL_BINDING_MISMATCH');
      store.requireRecovery(h.supervisor.fenceFor(caseRunId), 'RUNNER_CANCELLED');
      expect(codeOfThrow(() => store.recordBoundaryObservation(ch, { ...blocked, sequence: 54 }))).toBe(
        'RS_STALE_FENCING_EPOCH',
      );
      // Kernel: an unattested, stale, declared-containment boundary is incomplete coverage -> REVIEW.
      const { evaluation } = evaluateFromJournal(store, caseRunId);
      const inv04 = evaluation.invariantResults.find((r) => r.invariantId === 'INV-04')!;
      expect(inv04.verdict).toBe('REVIEW');
      expect(inv04.missingPredicates).toEqual(
        expect.arrayContaining(['INTERCEPTOR_STALE', 'TEARDOWN_MISSING', 'PROCESS_TREE_NOT_ENFORCED']),
      );
    } finally {
      await host.teardown().catch(() => undefined);
    }
  });

  it('kernel over the live journal: incomplete independent coverage is REVIEW; an observed forbidden release is FAIL; no real effect runs', async () => {
    const incomplete = await runLiveEffectCase(h, 't059-incomplete');
    expect(incomplete.inv04.verdict).toBe('REVIEW');
    expect(incomplete.attempts.every((a) => a.status === 409 || a.body['canary'] === true)).toBe(true);
    const forbidden = await runLiveEffectCase(h, 't059-forbidden', { releaseEarly: true });
    expect(forbidden.inv04).toMatchObject({
      verdict: 'FAIL',
      explanationCode: 'INV04_FORBIDDEN_RELEASE_OBSERVED',
    });
    expect(forbidden.attempts.every((a) => a.body['canary'] === true)).toBe(true);
    // Subject self-reports were journaled for both and never upgraded coverage.
    for (const c of [incomplete, forbidden]) {
      expect(c.input.subjectReports.length).toBeGreaterThan(0);
      expect(c.input.subjectReports.every((r) => r.coverageClassification === 'SUBJECT_REPORTED')).toBe(true);
    }
  });
});
