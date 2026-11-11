/**
 * T-010 — Networkless scenario modes contain mutation-shaped requests locally.
 *
 * Covers FR-04, INV-10. In SIMULATE and REPLAY, a separately launched RouteSpec proxy process
 * (tripwire installed first) receives every mutation-shaped method/path/body the scenarios
 * need, including a provider `Authorization` header and cookies carrying a configured canary.
 * The requests change only local scenario/journal state: the process has no upstream client
 * (static import audit), never attaches a credential (journal constraint and stored flags),
 * makes zero DNS/socket attempts (tripwire, with a positive control proving it detects real
 * attempts), and no canary byte reaches the journal database or WAL.
 *
 * Scope: RouteSpec's own process. It does not claim the subject client process tree had no
 * egress; that would need an OS/container sandbox and process-tree instrumentation (NOT_RUN).
 */
import { createServer } from 'node:net';
import dns from 'node:dns';
import net from 'node:net';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ScenarioProxy, installNetworkTripwire, type CaseRuntimeRegistry } from '../src/index.ts';
import { adapterHeaders, openStore, quoteBody, send, tempDir } from './support/gate.ts';
import { launchProxyChild } from './support/launch.ts';

const CANARY_JWT = `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjYW5hcnktdDAxMCJ9.${'c4n4ry'.repeat(4)}`;
const CANARY_SECRET = 'canary-provider-secret-t010-7f3a9b';

async function exerciseMutations(mode: 'SIMULATE' | 'REPLAY'): Promise<void> {
  const proxy = await launchProxyChild({
    scenario: 'accepted-then-lost-response',
    mode,
    canaries: [CANARY_JWT, CANARY_SECRET],
  });
  try {
    const creds = proxy.credentials;
    const providerHeaders = { authorization: `Bearer ${CANARY_JWT}`, cookie: `session=${CANARY_SECRET}` };

    // 1. Mutation-shaped quote (non-dry) with a provider credential attached: stripped, local only.
    const quote = await send(proxy.port, {
      method: 'POST',
      path: '/v0/quote',
      headers: { ...adapterHeaders(creds, { requestId: `${mode}-q1`, logicalJob: 'job-1' }), ...providerHeaders },
      body: quoteBody(),
    });
    expect(quote.status).toBe(200);
    const runOperationId = String(quote.headers['x-routespec-run-operation']);
    const depositAddress = String((quote.body as { quote: { depositAddress: string } }).quote.depositAddress);
    expect(depositAddress).toMatch(/^sim-deposit-/);

    // 2. Mutation-shaped commit: accepted locally, response deterministically lost.
    const commit = await send(proxy.port, {
      method: 'POST',
      path: '/v0/deposit/submit',
      headers: { ...adapterHeaders(creds, { requestId: `${mode}-c1`, runOperationId }), ...providerHeaders },
      body: { txHash: 'sim-tx-1', depositAddress },
    });
    expect(commit.reset).toBe(true);

    // 3. A retry of the same mutation under the original token is contained: token revoked.
    const retry = await send(proxy.port, {
      method: 'POST',
      path: '/v0/deposit/submit',
      headers: adapterHeaders(creds, { requestId: `${mode}-c2`, runOperationId }),
      body: { txHash: 'sim-tx-1', depositAddress },
    });
    expect(retry.code).toBe('RS_TOKEN_REVOKED');

    // 4. Every other mutation-shaped SDK route is a local typed denial.
    for (const path of ['/v0/submit-intent', '/v0/orders', '/v0/generate-intent', '/v0/auth/authenticate']) {
      const r = await send(proxy.port, {
        method: 'POST',
        path,
        headers: { ...adapterHeaders(creds, { requestId: `${mode}-x${path}` }), ...providerHeaders },
        body: { signedData: { payload: 'sim' } },
      });
      expect(r.code).toBe('RS_UNSUPPORTED_ROUTE');
    }

    // 5. A configured secret value inside a body is rejected before persistence (category only).
    const leaked = await send(proxy.port, {
      method: 'POST',
      path: '/v0/quote',
      headers: adapterHeaders(creds, { requestId: `${mode}-q2`, logicalJob: 'job-2' }),
      body: quoteBody({ customRecipientMsg: `memo ${CANARY_SECRET}` }),
    });
    expect(leaked.code).toBe('RS_SECRET_FIELD_REJECTED');
    expect(JSON.stringify(leaked.body)).not.toContain(CANARY_SECRET);

    const report = await proxy.report();
    expect(report.tripwire.total, report.tripwire.detail.join(',')).toBe(0);
    expect(report.stats.upstreamAttempts).toBe(0);
    expect(report.stats.credentialHeadersStripped).toBeGreaterThanOrEqual(4);
    expect(report.exchanges.length).toBeGreaterThanOrEqual(2);
    for (const ex of report.exchanges) {
      expect(ex).toMatchObject({ credentialAttached: 0, dnsAttempted: 0, upstreamAttempted: 0 });
    }
    // The mutation affected only local scenario/journal state.
    expect(report.runOperations).toEqual([{ phase: 'COMMIT_MUTATION', committed: true }]);
    expect(report.caseLifecycle).toBe('RUNNING'); // fenced and resumed under a reconciliation token
    expect(report.canaryScan.hits).toEqual([]);
    const closed = await proxy.close();
    expect(closed.canaryScan.hits).toEqual([]);
    expect(closed.canaryScan.files).toBeGreaterThanOrEqual(1);
    expect(closed.tripwire.total).toBe(0);
  } finally {
    if (proxy.child.exitCode === null) proxy.child.kill();
  }
}

describe('T-010 — Networkless scenario modes contain mutation-shaped requests locally', () => {
  it('SIMULATE: mutation-shaped requests stay local with zero DNS/socket attempts', async () => {
    await exerciseMutations('SIMULATE');
  });

  it('REPLAY: mutation-shaped requests stay local with zero DNS/socket attempts', async () => {
    await exerciseMutations('REPLAY');
  });

  it('positive control: the tripwire detects real DNS and socket attempts', async () => {
    const tripwire = installNetworkTripwire();
    try {
      await new Promise<void>((resolve) => dns.lookup('localhost', () => resolve()));
      const server = createServer();
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const port = (server.address() as { port: number }).port;
      await new Promise<void>((resolve) => {
        const socket = net.connect(port, '127.0.0.1', () => {
          socket.destroy();
          resolve();
        });
        socket.on('error', () => resolve());
      });
      await new Promise<void>((resolve) => server.close(() => resolve()));
      const report = tripwire.report();
      expect(report.dnsLookups).toBeGreaterThanOrEqual(1);
      expect(report.socketConnects + report.clientSockets).toBeGreaterThanOrEqual(1);
    } finally {
      tripwire.uninstall();
    }
  });

  it('refuses LIVE_DRY_PROBE: the proxy will not start and the journal will not start such a case', async () => {
    const { dir, cleanup } = tempDir();
    const store = openStore(dir);
    try {
      const cases: CaseRuntimeRegistry = { runtimeFor: () => undefined, onUncertainOutcome: () => undefined };
      await expect(
        ScenarioProxy.start({ store, mode: 'LIVE_DRY_PROBE' as unknown as 'SIMULATE', cases }),
      ).rejects.toMatchObject({ code: 'RS_MODE_POLICY_DENIED' });
    } finally {
      store.close();
      cleanup();
    }
  });

  it('static audit: proxy, scenario, store, and contracts contain no upstream client or credential path', () => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const forbiddenImports = /from\s+'(node:)?(https|tls|http2|dgram|undici|axios|@defuse-protocol\/[^']*)'/;
    const forbiddenCalls = [/\bfetch\s*\(/, /\bnew\s+WebSocket\b/, /\bhttp\.request\s*\(/, /\bnet\.connect\s*\(/];
    let files = 0;
    for (const pkg of ['proxy', 'scenario', 'store', 'contracts']) {
      const src = join(root, pkg, 'src');
      const walk = (dir: string): string[] =>
        readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
          e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : [],
        );
      for (const file of walk(src)) {
        files++;
        const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
        expect(forbiddenImports.test(text), file).toBe(false);
        for (const call of forbiddenCalls) expect(call.test(text), `${file} ${call}`).toBe(false);
        const valueImports = [...text.matchAll(/^import\s+(?!type\b)[^;]*?from\s+'(node:(?:dns|net|http))'/gm)].map((m) => m[1]);
        for (const spec of valueImports) {
          const allowed =
            (spec === 'node:http' && file.endsWith(join('proxy', 'src', 'server.ts'))) ||
            ((spec === 'node:dns' || spec === 'node:net') && file.endsWith(join('proxy', 'src', 'tripwire.ts')));
          expect(allowed, `${file} imports ${spec}`).toBe(true);
        }
      }
    }
    expect(files).toBeGreaterThan(20);
  });
});
