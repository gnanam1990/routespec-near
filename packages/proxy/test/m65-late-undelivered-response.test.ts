/**
 * M65 — an undelivered response noticed after the case closed is not a case event.
 *
 * The proxy learns that a held (connection-barrier) commit response was never delivered only
 * when its socket closes. That close can arrive late: the subject process exits after the
 * launcher reported its input closed, or the proxy shuts down after every case was torn down.
 * On a loaded runner the late close used to reach the journal after teardown (moving the fence
 * of a finished case) or after the journal was closed, crashing `routespec gate run` with exit 1
 * after it had printed its decision.
 *
 * Real store, real supervisor, real proxy. Waits are on observable state (supervisor reports,
 * `proxy.close()` resolution), never on fixed sleeps.
 */
import { request, type ClientRequest } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { compileScenario } from '@routespec/scenario';
import type { RouteSpecStore } from '@routespec/store';
import {
  CaseSupervisor,
  ScenarioProxy,
  type CaseRuntimeRegistry,
  type LaunchCredentials,
  type UncertainOutcomeEvent,
} from '../src/index.ts';
import { adapterHeaders, createGate, openStore, quoteBody, send, tempDir } from './support/gate.ts';

const SOURCE = `schemaVersion: "1.0"
scenarioId: m65-held-commit
revisionLabel: r1
title: Commit answer held until status
protocolProfile: oneclick-v0@1.0.0
seed: m65-held-commit
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

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function until(predicate: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

interface Held {
  readonly req: ClientRequest;
  /** Resolves once the proxy has the request (its socket is connected and the body sent). */
  readonly sent: Promise<void>;
  readonly settled: Promise<void>;
}

/** A commit the scenario holds at its connection barrier. */
function holdCommit(
  port: number,
  creds: LaunchCredentials,
  runOperationId: string,
  depositAddress: string,
): Held {
  const body = JSON.stringify({ txHash: 'sim-tx-1', depositAddress });
  const req = request({
    host: '127.0.0.1',
    port,
    method: 'POST',
    path: '/v0/deposit/submit',
    setHost: false,
    headers: {
      host: `127.0.0.1:${port}`,
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
      ...adapterHeaders(creds, { requestId: 'c1', runOperationId }),
    },
  });
  const sent = new Promise<void>((resolve) => req.once('finish', () => resolve()));
  const settled = new Promise<void>((resolve) => {
    req.once('response', (res) => {
      res.resume();
      res.once('close', () => resolve());
    });
    req.once('error', () => resolve());
    req.once('close', () => resolve());
  });
  req.end(body);
  return { req, sent, settled };
}

async function startCase(registry?: (s: CaseSupervisor) => CaseRuntimeRegistry) {
  const dir = tempDir('routespec-m65-');
  const store: RouteSpecStore = openStore(dir.dir);
  let storeOpen = true;
  const closeStore = () => {
    if (storeOpen) store.close();
    storeOpen = false;
  };
  cleanups.push(() => dir.cleanup());
  cleanups.push(closeStore);
  const compiled = compileScenario(SOURCE);
  const gate = createGate(store, compiled, { label: 'm65' });
  const caseRunId = gate.caseRunIds[0] as string;
  const supervisor = new CaseSupervisor(store, { ownerLabel: 'm65' });
  const creds = supervisor.startCase({ caseRunId, compiled, mode: 'SIMULATE' });
  const proxy = await ScenarioProxy.start({
    store,
    mode: 'SIMULATE',
    cases: registry ? registry(supervisor) : supervisor,
  });
  let proxyOpen = true;
  const closeProxy = async () => {
    if (proxyOpen) await proxy.close();
    proxyOpen = false;
  };
  cleanups.push(closeProxy);

  const quote = await send(proxy.port, {
    method: 'POST',
    path: '/v0/quote',
    headers: adapterHeaders(creds, { requestId: 'q1', logicalJob: 'job-1' }),
    body: quoteBody(),
  });
  expect(quote.status).toBe(200);
  const runOperationId = String(quote.headers['x-routespec-run-operation']);
  const depositAddress = String((quote.body as { quote: { depositAddress: string } }).quote.depositAddress);
  const held = holdCommit(proxy.port, creds, runOperationId, depositAddress);
  await held.sent;
  // The commit is journaled (and held) once the case has a committed run operation.
  await until(
    () => store.listRunOperations(caseRunId).some((o) => o['current_phase'] === 'COMMIT_MUTATION'),
    'the commit to be journaled',
  );
  return { store, supervisor, proxy, caseRunId, held, closeProxy, closeStore };
}

describe('M65 — a late undelivered-response report after the case closed', () => {
  it('control: a held commit abandoned while the case runs fences the case (INV-03)', async () => {
    const c = await startCase();
    const epoch = c.supervisor.fenceFor(c.caseRunId).fencingEpoch;
    c.held.req.destroy();
    await until(() => c.supervisor.uncertainOutcomes(c.caseRunId).length > 0, 'the uncertain outcome');
    expect(c.supervisor.uncertainOutcomes(c.caseRunId).map((e) => e.cause)).toEqual(['BARRIER_ABANDONED']);
    expect(c.supervisor.fenceFor(c.caseRunId).fencingEpoch).toBe(epoch + 1);
  });

  it('after teardown, the held commit closing changes neither the fence nor the journal', async () => {
    const c = await startCase();
    const epoch = c.supervisor.fenceFor(c.caseRunId).fencingEpoch;
    c.supervisor.teardown(c.caseRunId);
    c.held.req.destroy();
    await c.held.settled;
    // proxy.close() resolves only after every response close handler has run.
    await c.closeProxy();
    expect(c.supervisor.uncertainOutcomes(c.caseRunId)).toEqual([]);
    expect(c.supervisor.fenceFor(c.caseRunId).fencingEpoch).toBe(epoch);
    expect(c.store.getCaseRun(c.caseRunId)?.['execution_lifecycle']).toBe('RUNNING');
    c.closeStore();
  });

  it('proxy.close() delivers every undelivered-response report before it resolves', async () => {
    const reports: Array<{ event: UncertainOutcomeEvent; afterClose: boolean }> = [];
    let closed = false;
    const c = await startCase((s) => ({
      runtimeFor: (id) => s.runtimeFor(id),
      onUncertainOutcome: (event) => reports.push({ event, afterClose: closed }),
    }));
    // The client still holds the commit open: the proxy shutdown is what abandons it.
    await c.closeProxy();
    closed = true;
    c.closeStore();
    await c.held.settled;
    expect(reports.map((r) => [r.event.cause, r.afterClose])).toEqual([['BARRIER_ABANDONED', false]]);
  });
});
