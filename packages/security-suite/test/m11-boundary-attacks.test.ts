/**
 * M11 fail-closed attacks on credential separation and the effect boundary (deliverable 7).
 * Supplementary module test; it claims no canonical test ID. T-016, T-044, T-059, T-004 and the
 * M02 interceptor-channel test keep owning their own cases and are rerun as regressions.
 *
 * A real case runs against the real control service with the official-SDK subject. The subject
 * then holds exactly what a malicious subject would hold: its case token and identity headers.
 * With them it tries to act as an operator on control routes, to claim the independent boundary
 * source on the subject observation route, and to replay its token as a second client or after
 * fenced recovery. Every attempt must fail closed and leave the boundary-observation records
 * empty. On this host no OS/container sandbox exists, so any interceptor runs with
 * DECLARED_HOOKS_ONLY containment and the tracked coverage gap keeps complete-effect coverage
 * REVIEW.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADAPTER_HEADERS } from '@routespec/contracts';
import { detectContainment } from '@routespec/proxy';
import {
  Subject,
  caseHeaders,
  errorCode,
  expectOk,
  quoteBody,
  raw,
  setupProject,
  startHarness,
  startedGateRun,
  type Harness,
} from '../../control-api/test/support/fixture.ts';
import { send } from '../../proxy/test/support/gate.ts';

let h: Harness;
let start: Record<string, unknown>;
let caseRunId = '';
let subject: Subject | null = null;
let manifestDigest = '';
let policyDigest = '';

beforeAll(async () => {
  h = await startHarness();
  const p = await setupProject(h, 'm11-attacks');
  manifestDigest = p.manifestDigest;
  policyDigest = p.policyDigest;
  const run = await startedGateRun(h, p);
  caseRunId = run.caseRunId;
  start = expectOk(await h.api('POST', `/case-runs/${caseRunId}/start`, {}), 201);
  subject = await Subject.launch();
  await subject.attach(String(start['proxyBaseUrl']), start);
  await subject.send({ type: 'logicalJob', key: 'order-m11-attacks' });
  expect((await subject.call('getQuote', quoteBody()))['ok']).toBe(true);
}, 120_000);

afterAll(async () => {
  await subject?.close().catch(() => undefined);
  await h?.close();
});

const caseToken = () => (start['token'] as { value: string }).value;

/** The identity headers the subject itself sends, including its logical job and run operation. */
async function subjectHeaders(): Promise<Record<string, string>> {
  const events = expectOk(await h.api('GET', `/sessions/${String(start['sessionId'])}/events?limit=50`), 200);
  const runOperationId = (events['items'] as Array<Record<string, unknown>>)
    .map((e) => e['runOperationId'])
    .find((v): v is string => typeof v === 'string') as string;
  return {
    ...caseHeaders(start),
    [ADAPTER_HEADERS.logicalJob]: 'order-m11-attacks',
    [ADAPTER_HEADERS.runOperation]: runOperationId,
  };
}
const boundaryRows = () => h.store.countRows('effect_boundary_observations');

describe('M11 — credential separation and effect-boundary attacks fail closed', () => {
  it('a case token is never a control credential, in any header form, on any control route', async () => {
    const routes: Array<[string, string, unknown]> = [
      ['GET', '/settings', undefined],
      ['GET', '/metrics', undefined],
      ['POST', '/projects', { name: 'takeover' }],
      ['POST', '/attester-principals', { projectId: randomUUID(), label: 'self', policy: {} }],
      ['POST', `/case-runs/${caseRunId}/finish-input`, {}],
      ['POST', `/case-runs/${caseRunId}/recover`, {}],
      ['POST', '/imports', { projectId: randomUUID(), fileName: 'x.json', content: '{}' }],
    ];
    const forms: Array<Record<string, string>> = [
      { authorization: `Bearer ${caseToken()}` },
      { [ADAPTER_HEADERS.caseToken]: caseToken() },
      { ...caseHeaders(start) },
    ];
    const before = h.tableCounts();
    for (const [method, path, body] of routes) {
      for (const headers of forms) {
        const r = await h.api(method, path, body, { token: null, headers });
        expect(r.status, `${method} ${path} with ${Object.keys(headers)[0]}`).toBe(401);
      }
    }
    const { control_idempotency: _a, ...after } = h.tableCounts();
    const { control_idempotency: _b, ...was } = before;
    expect(after).toEqual(was);
  });

  it('the subject observation route cannot claim the independent boundary source or extra fields', async () => {
    const base = {
      runOperationId: null,
      effectManifestDigest: manifestDigest,
      effectCoveragePolicyDigest: policyDigest,
      hookId: 'fulfilment',
      hookRevision: '1',
      effectId: 'effect-1',
      effectType: 'DELIVER_GOODS',
      action: 'RELEASED',
      idempotencyKey: 'obs-m11-attack-1',
      fencingEpoch: Number(start['fencingEpoch']),
    };
    for (const forged of [
      { ...base, sourceKind: 'INDEPENDENT_BOUNDARY_INTERCEPT' },
      { ...base, interceptorInstanceId: randomUUID() },
      { ...base, containment: 'PROCESS_TREE_ENFORCED' },
    ]) {
      const r = await raw(h.port, {
        method: 'POST',
        path: '/__routespec/v1/effects/observe',
        headers: { ...caseHeaders(start), 'content-type': 'application/json' },
        body: JSON.stringify(forged),
      });
      expect(r.status).toBe(400);
      expect(errorCode(r)).toBe('RS_SCHEMA_INVALID');
    }
    // A control token on the subject route is refused too (no cross-use in either direction).
    const r = await raw(h.port, {
      method: 'POST',
      path: '/__routespec/v1/effects/observe',
      headers: { authorization: `Bearer ${h.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(base),
    });
    expect(r.status).toBe(401);
    expect(boundaryRows()).toBe(0);
  });

  it('a copied case token used by a second client instance is refused by the proxy', async () => {
    const proxyPort = Number(new URL(String(start['proxyBaseUrl'])).port);
    const headers = { ...(await subjectHeaders()), [ADAPTER_HEADERS.clientInstance]: `copy-${randomUUID()}` };
    const r = await send(proxyPort, { method: 'POST', path: '/v0/quote', headers, body: quoteBody() });
    expect(r.status).toBe(403);
    expect((r.body as { error: { code: string } }).error.code).toBe('RS_CLIENT_CONFLICT');
  });

  it('after fenced recovery the old token and epoch cannot mutate', async () => {
    h.clock.advance(10 * 60_000);
    const rec = await h.api('POST', `/case-runs/${caseRunId}/recover`, {});
    expect([200, 201, 409]).toContain(rec.status);
    const proxyPort = Number(new URL(String(start['proxyBaseUrl'])).port);
    const headers = await subjectHeaders();
    const r = await send(proxyPort, {
      method: 'POST',
      path: '/v0/deposit/submit',
      headers,
      body: { txHash: 'sim-tx-stale', depositAddress: 'sim-deposit-stale' },
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect([
      'RS_TOKEN_REVOKED',
      'RS_STALE_FENCING_EPOCH',
      'RS_TOKEN_EXPIRED',
      'RS_LEASE_EXPIRED',
      'RS_TOKEN_PHASE_DENIED',
    ]).toContain((r.body as { error: { code: string } }).error.code);
    expect(boundaryRows()).toBe(0);
  });

  it('without a process-tree sandbox the interceptor is DECLARED_HOOKS_ONLY and the gap is tracked', async () => {
    expect(detectContainment().containment).toBe('DECLARED_HOOKS_ONLY');
    const m = expectOk(await h.api('GET', '/metrics'), 200);
    const gaps = m['effectCoverageGaps'] as Record<string, number>;
    expect(gaps['policies_declared_hooks_only']).toBeGreaterThanOrEqual(1);
  });
});
