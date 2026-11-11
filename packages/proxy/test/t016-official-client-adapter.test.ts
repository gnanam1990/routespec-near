/**
 * T-016 — Versioned adapter drives the pinned official client.
 *
 * Covers FR-03. Two separately launched processes:
 * - the RouteSpec networkless proxy (network tripwire installed first; test/support/proxy-child.ts);
 * - the subject client running the exact pinned official SDK
 *   `@defuse-protocol/one-click-sdk-typescript@0.1.26` with the versioned RouteSpec adapter
 *   attached to the SDK's own `OpenAPI` config and axios instance (test/support/subject-client.ts).
 *
 * The documented base URL (`OpenAPI.BASE`) is set to RouteSpec by the adapter. The official
 * client then runs quote request/finalization, the first commit, a deterministic response
 * loss, a transport retry inside the same run operation, status reconciliation under the
 * reconciliation-only token, teardown, next-case reset, and token expiry. Every positive step
 * is an official SDK service call; raw HTTP is used only for negative probes (copied token,
 * other client, stale epoch, other adapter revision), which are not the client under test.
 *
 * The pinned SDK has no retry of its own (its `request` sends once); the retry exercised here
 * is the adapter's transport retry, installed on the SDK's own axios instance, so it goes
 * through the SDK's real request pipeline and produces a new transport ID under the same run
 * operation. It is labelled as an adapter transport retry, not an SDK feature.
 */
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADAPTER_HEADERS, ADAPTER_REVISION, ONECLICK_SDK_PIN } from '@routespec/contracts';
import type { LaunchCredentials } from '../src/index.ts';
import { adapterHeaders, quoteBody, send } from './support/gate.ts';
import { launchProxyChild, type ProxyChild } from './support/launch.ts';

interface LogRecord {
  transportRequestId: string;
  attempt: number;
  method: string;
  route: string;
  target: 'PROXY' | 'OTHER';
  sessionId: string | null;
  caseRunId: string | null;
  logicalJob: string | null;
  runOperationId: string | null;
  fencingEpoch: number | null;
  purpose: string | null;
  outcome: 'RESPONSE' | 'NETWORK_ERROR';
  httpStatus: number | null;
  errorCode: string | null;
}

interface CallResult {
  ok: boolean;
  value?: unknown;
  error?: { name: string; status: number | null; code: string | null };
}

class Subject {
  readonly child: ChildProcess;
  private constructor(child: ChildProcess) {
    this.child = child;
  }
  static async launch(): Promise<Subject> {
    const script = fileURLToPath(new URL('./support/subject-client.ts', import.meta.url));
    const child = fork(script, [], {
      execArgv: ['--no-warnings'],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    const subject = new Subject(child);
    await subject.wait('loaded');
    return subject;
  }
  private wait(type: string): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const onExit = (code: number | null) => reject(new Error(`subject exited ${code}`));
      const onMessage = (m: unknown) => {
        const msg = m as Record<string, unknown>;
        if (msg['type'] === 'error' || msg['type'] === type) {
          this.child.off('message', onMessage);
          this.child.off('exit', onExit);
          if (msg['type'] === 'error')
            reject(new Error(`subject error ${String(msg['code'])}: ${String(msg['message'])}`));
          else resolve(msg);
        }
      };
      this.child.on('message', onMessage);
      this.child.once('exit', onExit);
    });
  }
  async send(msg: Record<string, unknown>): Promise<Record<string, unknown>> {
    const p = this.wait(`${String(msg['type'])}-done`);
    this.child.send(msg);
    return p;
  }
  async call(op: string, ...args: unknown[]): Promise<CallResult> {
    return (await this.send({ type: 'call', op, args })) as unknown as CallResult;
  }
  async log(): Promise<LogRecord[]> {
    return (await this.send({ type: 'log' }))['log'] as LogRecord[];
  }
}

let proxy: ProxyChild;
let subject: Subject;
let case1: LaunchCredentials;
let case2: LaunchCredentials;
let recovery: LaunchCredentials;
let depositAddress = '';
let runOperationId = '';

beforeAll(async () => {
  proxy = await launchProxyChild({ scenario: 'accepted-then-lost-response', mode: 'SIMULATE', cases: 2 });
  subject = await Subject.launch();
  case1 = proxy.credentials;
});

afterAll(async () => {
  if (subject && subject.child.exitCode === null) subject.child.kill();
  await proxy?.close();
});

describe('T-016 — Versioned adapter drives the pinned official client', () => {
  it('attaches the versioned adapter to the exact pinned SDK and points its documented base URL at RouteSpec', async () => {
    const attached = await subject.send({
      type: 'attach',
      origin: `http://127.0.0.1:${proxy.port}`,
      credentials: case1,
    });
    expect(attached['sdk']).toEqual({
      name: ONECLICK_SDK_PIN.packageName,
      version: ONECLICK_SDK_PIN.version,
    });
    expect(attached['base']).toBe(`http://127.0.0.1:${proxy.port}`);
    expect(attached['revision']).toBe(ADAPTER_REVISION);
  });

  it('runs quote request and finalization through the official client; the deposit address is response-assigned', async () => {
    await subject.send({ type: 'logicalJob', key: 'job-1' });
    const quote = await subject.call('getQuote', quoteBody());
    expect(quote.ok, JSON.stringify(quote.error)).toBe(true);
    const value = quote.value as { quote: { depositAddress: string; amountIn: string } };
    depositAddress = value.quote.depositAddress;
    expect(depositAddress).toMatch(/^sim-deposit-/);
    const [record] = await subject.log();
    expect(record).toMatchObject({
      route: '/v0/quote',
      method: 'POST',
      target: 'PROXY',
      attempt: 1,
      sessionId: case1.sessionId,
      caseRunId: case1.caseRunId,
      logicalJob: 'job-1',
      fencingEpoch: case1.fencingEpoch,
      purpose: 'EXECUTION',
      outcome: 'RESPONSE',
      httpStatus: 200,
    });
    // RouteSpec assigned the run operation; the adapter learned it from the response header.
    expect(record?.runOperationId).toMatch(/^[0-9a-f-]{36}$/);
    runOperationId = String(record?.runOperationId);
  });

  it('first commit is accepted locally and its response is lost; the transport retry is denied under the revoked token', async () => {
    const commit = await subject.call('submitDepositTx', { txHash: 'sim-tx-1', depositAddress });
    expect(commit.ok).toBe(false);
    expect(commit.error).toMatchObject({ name: 'ApiError', status: 401, code: 'RS_TOKEN_REVOKED' });
    const log = (await subject.log()).filter((r) => r.route === '/v0/deposit/submit');
    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({
      attempt: 1,
      outcome: 'NETWORK_ERROR',
      runOperationId,
      purpose: 'EXECUTION',
    });
    expect(log[1]).toMatchObject({
      attempt: 2,
      outcome: 'RESPONSE',
      httpStatus: 401,
      errorCode: 'RS_TOKEN_REVOKED',
      runOperationId,
    });
    expect(log[0]?.transportRequestId).not.toBe(log[1]?.transportRequestId);
    // The supervisor fenced the case and pushed exactly one reconciliation-only token.
    expect(proxy.pushed).toHaveLength(1);
    recovery = proxy.pushed[0]!.credentials;
    expect(recovery).toMatchObject({
      purpose: 'RECONCILIATION_ONLY',
      sessionId: case1.sessionId,
      caseRunId: case1.caseRunId,
      clientInstanceId: case1.clientInstanceId,
      fencingEpoch: case1.fencingEpoch + 1,
    });
    expect(recovery.token).not.toBe(case1.token);
  });

  it('reconciles status read-only under the reconciliation token; a second mutation is denied', async () => {
    await subject.send({ type: 'credentials', credentials: recovery });
    const status = await subject.call('getExecutionStatus', depositAddress);
    expect(status.ok, JSON.stringify(status.error)).toBe(true);
    // The first queued provider status of the scenario (PROCESSING, then SUCCESS) is reported.
    expect((status.value as { status: string }).status).toBe('PROCESSING');
    const second = await subject.call('submitDepositTx', { txHash: 'sim-tx-2', depositAddress });
    expect(second.error).toMatchObject({ status: 403, code: 'RS_TOKEN_PHASE_DENIED' });
    const original = await subject.send({ type: 'credentials', credentials: case1 }).catch((e: Error) => e);
    expect(String(original)).toContain('RS_STALE_FENCING_EPOCH');
    const log = await subject.log();
    const statusRecord = log.find((r) => r.route === '/v0/status');
    expect(statusRecord).toMatchObject({
      runOperationId,
      purpose: 'RECONCILIATION_ONLY',
      fencingEpoch: recovery.fencingEpoch,
      httpStatus: 200,
    });
  });

  it('journals one stable run operation with unique transport IDs across quote, commit, retry, and status', async () => {
    const log = await subject.log();
    const ids = log.map((r) => r.transportRequestId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of log) {
      expect(r).toMatchObject({ sessionId: case1.sessionId, caseRunId: case1.caseRunId, target: 'PROXY' });
      expect(r.runOperationId).toBe(runOperationId);
    }
    const report = await proxy.report(0);
    expect(report.runOperations).toHaveLength(1);
    expect(report.runOperations[0]).toMatchObject({
      runOperationId,
      phase: 'READ_ONLY_RECONCILIATION',
      committed: true,
    });
    // Journaled exchanges are exactly the accepted ones (quote, commit, status), bound to the
    // same run operation, under the transport IDs the official client sent.
    expect(report.exchanges.map((e) => e.phase)).toEqual([
      'QUOTE_REQUEST',
      'COMMIT_MUTATION',
      'READ_ONLY_RECONCILIATION',
    ]);
    for (const e of report.exchanges) {
      expect(e.runOperationId).toBe(runOperationId);
      expect(ids).toContain(e.transportRequestId);
      expect(e).toMatchObject({ credentialAttached: 0, dnsAttempted: 0, upstreamAttempted: 0 });
    }
    const commitAttempt = report.attempts.find((a) => a.phase === 'COMMIT_MUTATION');
    expect(commitAttempt?.outcome).toBe('SENT_OUTCOME_UNKNOWN');
    expect(report.uncertain).toBe(1);
    expect(report.tripwire.total, report.tripwire.detail.join(',')).toBe(0);
  });

  it('strips every RouteSpec header before any non-RouteSpec (live) boundary', async () => {
    const probe = (await subject.send({ type: 'liveBoundaryProbe' })) as unknown as {
      headers: Record<string, string>;
      routeSpecHeaders: string[];
    };
    expect(probe.routeSpecHeaders).toEqual([]);
    expect(JSON.stringify(probe.headers)).not.toContain(recovery.token);
    expect(probe.headers['authorization']).toBeUndefined();
    const other = (await subject.log()).at(-1);
    expect(other).toMatchObject({ target: 'OTHER', sessionId: null, runOperationId: null });
  });

  it('teardown revokes the case token; the official client is then refused', async () => {
    const torn = await proxy.teardownCase(0);
    expect(torn.revokedTokens).toBe(1);
    expect(torn.evidence).toBeGreaterThanOrEqual(1);
    const after = await subject.call('getExecutionStatus', depositAddress);
    expect(after.error).toMatchObject({ status: 401, code: 'RS_TOKEN_REVOKED' });
  });

  it('next-case reset: fresh session/client/token; prior-case tokens and correlation never carry over', async () => {
    case2 = await proxy.startCase(1);
    expect(case2.sessionId).not.toBe(case1.sessionId);
    expect(case2.clientInstanceId).not.toBe(case1.clientInstanceId);
    expect(case2.token).not.toBe(case1.token);
    await subject.send({ type: 'reset', credentials: case2 });
    // The prior case's deposit address has no run operation in the reset adapter.
    const stale = await subject.call('getExecutionStatus', depositAddress);
    expect(stale.error).toMatchObject({ status: 400, code: 'RS_HEADER_INVALID' });
    await subject.send({ type: 'logicalJob', key: 'job-1' });
    const quote = await subject.call('getQuote', quoteBody());
    expect(quote.ok, JSON.stringify(quote.error)).toBe(true);
    const case2Log = (await subject.log()).filter(
      (r) => r.caseRunId === case2.caseRunId && r.route === '/v0/quote',
    );
    expect(case2Log.at(-1)?.runOperationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(case2Log.at(-1)?.runOperationId).not.toBe(runOperationId);
    const report = await proxy.report(1);
    expect(report.sessionId).toBe(case2.sessionId);
    expect(report.runOperations).toHaveLength(1);
  });

  it('rejects copied tokens, other clients, other cases, stale epochs, and other adapter revisions', async () => {
    const at = (creds: LaunchCredentials, over: Partial<LaunchCredentials>, id: string) =>
      adapterHeaders({ ...creds, ...over }, { requestId: id, logicalJob: 'job-x' });
    const probes: Array<[Record<string, string>, string]> = [
      // case-1 token copied into case 2's session
      [at(case2, { token: case1.token }, 'neg-1'), 'RS_TOKEN_REVOKED'],
      // case-2 token presented by a different client instance
      [at(case2, { clientInstanceId: `client-${'f'.repeat(32)}` }, 'neg-2'), 'RS_CLIENT_CONFLICT'],
      // case-2 token presented against case 1's session
      [
        at(case2, { sessionId: case1.sessionId, caseRunId: case1.caseRunId }, 'neg-3'),
        'RS_IDENTITY_MISMATCH',
      ],
      [at(case2, { fencingEpoch: case2.fencingEpoch + 1 }, 'neg-4'), 'RS_STALE_FENCING_EPOCH'],
      [at(case2, { adapterRevision: 'routespec-adapter@0.9.0' }, 'neg-5'), 'RS_IDENTITY_MISMATCH'],
    ];
    for (const [headers, code] of probes) {
      const r = await send(proxy.port, { method: 'POST', path: '/v0/quote', headers, body: quoteBody() });
      expect(r.code, JSON.stringify(headers[ADAPTER_HEADERS.requestId])).toBe(code);
    }
    const report = await proxy.report(1);
    expect(report.runOperations).toHaveLength(1);
  });

  it('expired case token is refused before any state change', async () => {
    await proxy.advanceClock(120_001);
    const expired = await subject.call('getQuote', quoteBody({ amount: '2000000' }));
    expect(expired.error).toMatchObject({ status: 401, code: 'RS_TOKEN_EXPIRED' });
    const report = await proxy.report(1);
    expect(report.runOperations).toHaveLength(1);
    expect(report.exchanges).toHaveLength(1);
  });

  it('detach restores the SDK configuration; the proxy made zero DNS/socket attempts throughout', async () => {
    const detached = await subject.send({ type: 'detach' });
    expect(detached['base']).toBe(ONECLICK_SDK_PIN.defaultBaseUrl);
    expect(detached['headers']).toBe('undefined');
    const report = await proxy.report(1);
    expect(report.tripwire.total, report.tripwire.detail.join(',')).toBe(0);
    expect(report.stats.upstreamAttempts).toBe(0);
  });
});
