/**
 * SEC RS-06 — connection barriers held by the shared scenario proxy are scoped to their case.
 *
 * One ScenarioProxy serves every case of a gate, and cases may run in parallel. Step ids are
 * unique only within one scenario, so two concurrent cases running the same scenario hold a
 * barrier under the same step id. A case's held response must be stored, released and delivered
 * only on that case's own runtime decisions: another case's traffic never releases, delivers or
 * replaces it.
 *
 * The store is a stub here (the proxy only needs its acknowledgements); the scenario runtimes
 * are real, compiled from one shared scenario with different seeds.
 */
import { randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { compileScenario, ScenarioRuntime } from '@routespec/scenario';
import type { RouteSpecStore } from '@routespec/store';
import { ScenarioProxy, type UncertainOutcomeEvent } from '../src/index.ts';

const scenarioSource = (seed: string) => `schemaVersion: "1.0"
scenarioId: barrier-case
revisionLabel: r1
title: Barrier
protocolProfile: oneclick-v0@1.0.0
seed: ${seed}
initialState: { clientClock: INJECTED, statusPollIntervalMs: 1000 }
operationTemplate:
  originAsset: nep141:origin.sim
  destinationAsset: nep141:destination.sim
  amountIn: "1000000"
  amountOut: "999000"
  minAmountOut: "989010"
steps:
  - { id: q, type: respond, match: { route: QUOTE } }
  - { id: c-barrier, type: connection_barrier, match: { route: COMMIT }, releaseOn: { route: STATUS } }
  - { id: poll, type: respond, match: { route: STATUS } }
  - { id: end, type: end }
groundTruthEvents: []
expectedOutcomes: {}
forbiddenBehaviors: []
requiredEvidence: []
resourceBudget: {}
sourceProvenance: { class: SYNTHETIC }
`;

interface Case {
  readonly name: string;
  readonly session: string;
  readonly caseRun: string;
  readonly op: string;
  readonly runtime: ScenarioRuntime;
}

interface Reply {
  readonly status: number | null;
  readonly body: string | null;
  readonly error: string | null;
}

const quoteMaterial = {
  dry: false,
  swapType: 'EXACT_INPUT',
  slippageTolerance: 100,
  originAsset: 'nep141:origin.sim',
  depositType: 'ORIGIN_CHAIN',
  destinationAsset: 'nep141:destination.sim',
  amount: '1000000',
  refundTo: 'refund.sim',
  refundType: 'ORIGIN_CHAIN',
  recipient: 'recipient.sim',
  recipientType: 'DESTINATION_CHAIN',
  deadline: '2026-11-11T12:00:00Z',
};

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function makeCase(name: string, seed: string): Case {
  return {
    name,
    session: randomUUID(),
    caseRun: randomUUID(),
    op: randomUUID(),
    runtime: new ScenarioRuntime(compileScenario(scenarioSource(seed)).plan),
  };
}

async function harness() {
  const a = makeCase('A', 'seed-a');
  const b = makeCase('B', 'seed-b');
  const byRun = new Map([
    [a.caseRun, a],
    [b.caseRun, b],
  ]);
  const bySession = new Map([
    [a.session, a],
    [b.session, b],
  ]);
  const delivered: string[] = [];
  const uncertain: Array<UncertainOutcomeEvent & { name: string }> = [];
  let seq = 0;
  const ack = (auth: { caseRunId: string }) => ({
    exchangeId: `ex-${++seq}`,
    attemptId: `at-${seq}`,
    runOperationId: (byRun.get(auth.caseRunId) as Case).op,
    sequence: seq,
  });
  const store = {
    getSession: (id: string) => {
      const c = bySession.get(id);
      return c
        ? {
            case_run_id: c.caseRun,
            mode: 'SIMULATE',
            gate_run_id: 'gate',
            build_revision_id: 'build',
            artifact_digest: 'digest',
          }
        : undefined;
    },
    verifyCaseAuth: () => ({}),
    recordQuoteRequest: (auth: { caseRunId: string }) => ({
      runOperationId: (byRun.get(auth.caseRunId) as Case).op,
    }),
    finalizeQuote: ack,
    commitMutation: ack,
    recordStatusObservation: ack,
    markResponseDelivered: (auth: { caseRunId: string }) => {
      delivered.push((byRun.get(auth.caseRunId) as Case).name);
    },
    recordProxyDenial: () => undefined,
  } as unknown as RouteSpecStore;
  const proxy = await ScenarioProxy.start({
    store,
    mode: 'SIMULATE',
    cases: {
      runtimeFor: (id) => byRun.get(id)?.runtime,
      onUncertainOutcome: (event) => {
        uncertain.push({ ...event, name: (byRun.get(event.caseRunId) as Case).name });
      },
    },
  });
  cleanups.push(() => proxy.close());

  let requestId = 0;
  const open: Array<ReturnType<typeof request>> = [];
  cleanups.push(() => {
    for (const r of open) r.destroy();
  });
  const send = (c: Case, method: 'GET' | 'POST', path: string, payload?: unknown) => {
    const body = payload === undefined ? null : JSON.stringify(payload);
    const headers: Record<string, string | number> = {
      host: `127.0.0.1:${proxy.port}`,
      'x-routespec-case-token': `dummy-token-${'x'.repeat(16)}`,
      'x-routespec-session': c.session,
      'x-routespec-case-run': c.caseRun,
      'x-routespec-adapter': 'adapter@1',
      'x-routespec-fencing-epoch': '1',
      'x-routespec-client-instance': 'client-instance-0001',
      'x-routespec-request-id': `req-${++requestId}`,
      'x-routespec-run-operation': c.op,
      'x-routespec-logical-job': 'job-1',
    };
    if (body !== null) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(body);
    }
    let settled = false;
    let latest: Reply = { status: null, body: null, error: null };
    const req = request({ host: '127.0.0.1', port: proxy.port, method, path, headers });
    open.push(req);
    const done = new Promise<Reply>((resolve) => {
      req.on('response', (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => (data += chunk.toString('utf8')));
        res.on('end', () => {
          settled = true;
          latest = { status: res.statusCode ?? null, body: data, error: null };
          resolve(latest);
        });
      });
      req.on('error', (error: NodeJS.ErrnoException) => {
        settled = true;
        latest = { status: null, body: null, error: error.code ?? error.message };
        resolve(latest);
      });
    });
    if (body !== null) req.end(body);
    else req.end();
    return { req, done, settled: () => settled, reply: () => latest };
  };
  const quote = async (c: Case) => {
    const r = await send(c, 'POST', '/v0/quote', quoteMaterial).done;
    expect(r.status).toBe(200);
    return (JSON.parse(r.body as string) as { quote: { depositAddress: string } }).quote.depositAddress;
  };
  return { a, b, send, quote, delivered, uncertain };
}

describe('SEC RS-06 — scenario proxy connection barriers are case-scoped', () => {
  it("one case's barrier release never delivers or orphans another case's held response", async () => {
    const h = await harness();
    const depA = await h.quote(h.a);
    const depB = await h.quote(h.b);

    const commitA = h.send(h.a, 'POST', '/v0/deposit/submit', { txHash: 'sim-tx-a', depositAddress: depA });
    await wait(150);
    const commitB = h.send(h.b, 'POST', '/v0/deposit/submit', { txHash: 'sim-tx-b', depositAddress: depB });
    await wait(150);
    expect(commitA.settled()).toBe(false);
    expect(commitB.settled()).toBe(false);

    // Case A's STATUS releases case A's barrier only.
    const statusA = await h.send(h.a, 'GET', `/v0/status?depositAddress=${encodeURIComponent(depA)}`).done;
    expect(statusA.status).toBe(200);
    const replyA = await Promise.race([commitA.done, wait(1_000).then(() => null)]);
    await wait(100);

    expect(replyA, "case A's held commit is delivered by case A's own release").not.toBeNull();
    expect(replyA?.status).toBe(200);
    expect(commitB.settled(), "case B's held commit stays held").toBe(false);
    expect(h.uncertain).toEqual([]);

    // Case B's STATUS then releases case B's barrier.
    const statusB = await h.send(h.b, 'GET', `/v0/status?depositAddress=${encodeURIComponent(depB)}`).done;
    expect(statusB.status).toBe(200);
    const replyB = await Promise.race([commitB.done, wait(1_000).then(() => null)]);
    expect(replyB?.status).toBe(200);
    expect(replyA?.body).not.toBe(replyB?.body);
    await wait(50);
    expect(h.uncertain).toEqual([]);
    expect(h.delivered.filter((n) => n === 'A').length).toBe(3);
    expect(h.delivered.filter((n) => n === 'B').length).toBe(3);
  });

  it("an abandoned held response is reported for its own case and is not delivered by another's release", async () => {
    const h = await harness();
    const depA = await h.quote(h.a);
    const depB = await h.quote(h.b);
    const commitA = h.send(h.a, 'POST', '/v0/deposit/submit', { txHash: 'sim-tx-a', depositAddress: depA });
    await wait(150);
    const commitB = h.send(h.b, 'POST', '/v0/deposit/submit', { txHash: 'sim-tx-b', depositAddress: depB });
    await wait(150);

    // Client B gives up on its held commit before anything is released.
    commitB.req.destroy();
    await wait(150);
    expect(h.uncertain.map((e) => [e.name, e.cause])).toEqual([['B', 'BARRIER_ABANDONED']]);

    // Case A's release still delivers case A's own held response.
    await h.send(h.a, 'GET', `/v0/status?depositAddress=${encodeURIComponent(depA)}`).done;
    const replyA = await Promise.race([commitA.done, wait(1_000).then(() => null)]);
    expect(replyA?.status).toBe(200);
    await wait(50);
    expect(h.uncertain.map((e) => [e.name, e.cause])).toEqual([['B', 'BARRIER_ABANDONED']]);
  });
});
