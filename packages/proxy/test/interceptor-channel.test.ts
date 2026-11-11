/**
 * Interceptor channel transport and containment (M02 deliverable 9). Supplementary module test:
 * it supports T-004, which M04 owns together with the coverage semantics; it does not claim
 * T-004 or any complete-effect coverage.
 *
 * A real separately launched interceptor process (the reviewed canary artifact) is bound to a
 * real running case in a real journal. The subject role is played by plain loopback HTTP
 * attempts at the interceptor's sink; no row is written directly.
 */
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CANARY_INTERCEPTOR_PROFILE,
  CaseSupervisor,
  InterceptorHost,
  artifactDigestOf,
  detectContainment,
  type InterceptorProfile,
} from '../src/index.ts';
import { compileCore, createGate, openStore, tempDir } from './support/gate.ts';

interface Ctx {
  dir: { dir: string; cleanup: () => void };
  store: ReturnType<typeof openStore>;
  supervisor: CaseSupervisor;
  caseRunId: string;
  caseToken: string;
}

let ctx: Ctx;
const hosts: InterceptorHost[] = [];

beforeEach(() => {
  const dir = tempDir('routespec-interceptor-');
  const store = openStore(dir.dir);
  const compiled = compileCore('happy-path');
  const gate = createGate(store, compiled, { label: 'interceptor' });
  const supervisor = new CaseSupervisor(store, { ownerLabel: 'interceptor-test' });
  const creds = supervisor.startCase({ caseRunId: gate.caseRunIds[0]!, compiled, mode: 'SIMULATE' });
  ctx = { dir, store, supervisor, caseRunId: gate.caseRunIds[0]!, caseToken: creds.token };
});

afterEach(async () => {
  for (const h of hosts.splice(0)) await h.teardown().catch(() => undefined);
  ctx.store.close();
  ctx.dir.cleanup();
});

async function launch(profile?: InterceptorProfile): Promise<InterceptorHost> {
  const host = await InterceptorHost.launch({
    store: ctx.store,
    fence: ctx.supervisor.fenceFor(ctx.caseRunId),
    ...(profile ? { profile } : {}),
  });
  hosts.push(host);
  return host;
}

async function attempt(
  host: InterceptorHost,
  sink: string,
  effectId: string,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${host.sinkOrigin}/sink/${sink}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ effectId }),
  });
  return { status: res.status, body: await res.json() };
}

describe('M02 interceptor channel transport (supports T-004; coverage semantics are M04)', () => {
  it('refuses a modified interceptor artifact before spawning or registering anything', async () => {
    const copy = join(ctx.dir.dir, 'canary-interceptor.ts');
    copyFileSync(CANARY_INTERCEPTOR_PROFILE.artifactPath, copy);
    writeFileSync(copy, `${readFileSync(copy, 'utf8')}\n// unreviewed change\n`);
    const tampered: InterceptorProfile = { ...CANARY_INTERCEPTOR_PROFILE, artifactPath: copy };
    await expect(launch(tampered)).rejects.toMatchObject({ code: 'RS_IDENTITY_MISMATCH' });
    expect(ctx.store.countRows('effect_interceptor_instances')).toBe(0);
  });

  it('the pinned profile digest equals the reviewed artifact on disk', () => {
    expect(artifactDigestOf(CANARY_INTERCEPTOR_PROFILE.artifactPath)).toBe(
      CANARY_INTERCEPTOR_PROFILE.artifactDigest,
    );
  });

  it('launches a separate peer-bound process, registers exact binding, and labels containment honestly', async () => {
    const host = await launch();
    expect(host.peerPid).not.toBe(process.pid);
    expect(host.containment).toBe('DECLARED_HOOKS_ONLY');
    expect(detectContainment().reason).toBe('NO_PROCESS_TREE_SANDBOX');
    const inst = ctx.store.getInterceptorInstance(host.interceptorInstanceId)!;
    const session = ctx.store.getSession(String(ctx.store.getCaseRun(ctx.caseRunId)?.['session_id']))!;
    expect(inst).toMatchObject({
      case_run_id: ctx.caseRunId,
      session_id: session['session_id'],
      build_revision_id: session['build_revision_id'],
      gate_run_id: session['gate_run_id'],
      policy_digest: session['effect_coverage_policy_digest'],
      manifest_digest: session['effect_manifest_digest'],
      fencing_epoch: ctx.supervisor.fenceFor(ctx.caseRunId).fencingEpoch,
      containment: 'DECLARED_HOOKS_ONLY',
      peer_pid: host.peerPid,
      interceptor_profile_digest: host.profileDigest,
      teardown_at_ms: null,
    });
  });

  it('denies an effect attempt before release and journals ATTEMPTED then BLOCKED before answering', async () => {
    const host = await launch();
    const r = await attempt(host, 'fulfilment-webhook', 'order-1');
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ denied: true, reason: 'EFFECT_NOT_RELEASED' });
    const obs = ctx.store.listBoundaryObservations(ctx.caseRunId);
    expect(obs.map((o) => [o['action'], o['sink_class'], o['effect_id']])).toEqual([
      ['ATTEMPTED', 'fulfilment-webhook', 'order-1'],
      ['BLOCKED', 'fulfilment-webhook', 'order-1'],
    ]);
    expect(host.acks.every((a) => a.ok)).toBe(true);
  });

  it('after release, routes to the no-effect canary and journals RELEASED', async () => {
    const host = await launch();
    await host.release();
    const r = await attempt(host, 'fulfilment-webhook', 'order-2');
    expect(r.status).toBe(202);
    expect(r.body).toEqual({ denied: false, canary: true });
    expect(ctx.store.listBoundaryObservations(ctx.caseRunId).map((o) => o['action'])).toEqual([
      'ATTEMPTED',
      'RELEASED',
    ]);
  });

  it('an undeclared sink is rejected by the journal and the subject is denied (fail closed)', async () => {
    const host = await launch();
    const r = await attempt(host, 'payment-capture', 'pay-1');
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ denied: true, reason: 'RS_SINK_UNSUPPORTED' });
    expect(ctx.store.listBoundaryObservations(ctx.caseRunId)).toEqual([]);
  });

  it('a subject case token or a forged key cannot journal an observation', async () => {
    const host = await launch();
    await attempt(host, 'fulfilment-webhook', 'order-3');
    const [first] = ctx.store.listBoundaryObservations(ctx.caseRunId);
    const forged = {
      sequence: 99,
      frameDigest: `sha256:${'a'.repeat(64)}`,
      buildRevisionId: String(first?.['build_revision_id']),
      gateRunId: String(first?.['gate_run_id']),
      caseRunId: ctx.caseRunId,
      sessionId: String(first?.['session_id']),
      fencingEpoch: Number(first?.['fencing_epoch']),
      policyDigest: String(first?.['policy_digest']),
      manifestDigest: String(first?.['manifest_digest']),
      interceptorProfileDigest: host.profileDigest,
      runOperationId: null,
      sinkClass: 'fulfilment-webhook',
      effectId: 'order-forged',
      effectType: 'DELIVER_GOODS',
      action: 'RELEASED' as const,
      virtualMs: null,
    };
    for (const channelKey of [ctx.caseToken, 'x'.repeat(43)]) {
      expect(() =>
        ctx.store.recordBoundaryObservation(
          { interceptorInstanceId: host.interceptorInstanceId, channelKey },
          forged,
        ),
      ).toThrow(expect.objectContaining({ code: 'RS_CHANNEL_AUTH_FAILED' }));
    }
    expect(ctx.store.listBoundaryObservations(ctx.caseRunId)).toHaveLength(2);
  });

  it('a stale fencing epoch invalidates the instance; attempts then fail closed', async () => {
    const host = await launch();
    ctx.store.requireRecovery(ctx.supervisor.fenceFor(ctx.caseRunId), 'OUTCOME_UNKNOWN');
    const r = await attempt(host, 'fulfilment-webhook', 'order-4');
    expect(r.status).toBe(503);
    expect(['RS_STALE_FENCING_EPOCH', 'RS_CHANNEL_BINDING_MISMATCH']).toContain(
      (r.body as { reason: string }).reason,
    );
    expect(ctx.store.listBoundaryObservations(ctx.caseRunId)).toEqual([]);
  });

  it('orderly teardown closes the sink and records TEARDOWN; no further journaling is possible', async () => {
    const host = await launch();
    await host.teardown();
    expect(ctx.store.getInterceptorInstance(host.interceptorInstanceId)).toMatchObject({
      teardown_reason: 'TEARDOWN',
    });
    await expect(attempt(host, 'fulfilment-webhook', 'order-5')).rejects.toThrow();
  });

  it('a lost channel (interceptor killed) is recorded as CHANNEL_LOST', async () => {
    const host = await launch();
    process.kill(host.peerPid);
    for (let i = 0; i < 50 && !host.closed; i++) await new Promise((r) => setTimeout(r, 20));
    expect(host.closed).toBe(true);
    expect(ctx.store.getInterceptorInstance(host.interceptorInstanceId)).toMatchObject({
      teardown_reason: 'CHANNEL_LOST',
    });
  });
});
