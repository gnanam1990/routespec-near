/**
 * M17 — explicit loopback port for the networkless scenario proxy (FR-02, NFR-02; supports the
 * T-036 container-host run, which must use a fixed, configured port range).
 *
 * The proxy keeps binding the IPv4 loopback address only; an operator may now name the port.
 * An invalid port is refused before any socket opens, and a port already in use fails without
 * leaving a listener behind.
 */
import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { ScenarioProxy, type CaseRuntimeRegistry } from '../src/index.ts';
import { openStore, send, tempDir } from './support/gate.ts';

const NO_CASES: CaseRuntimeRegistry = { resolve: () => null } as unknown as CaseRuntimeRegistry;
/**
 * Host ports for this suite: a 50-port window starting at ROUTESPEC_TEST_PORT_BASE (default 9350),
 * so parallel runs on one machine can be given disjoint ranges.
 */
function portBase(): number {
  const raw = process.env['ROUTESPEC_TEST_PORT_BASE'];
  if (raw === undefined || raw === '') return 9350;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1024 || n > 65535 - 50) {
    throw new Error(`ROUTESPEC_TEST_PORT_BASE must be an integer in 1024-65485, got ${raw}`);
  }
  return n;
}
const PORT_BASE = portBase();
const PORT_LAST = PORT_BASE + 49;
const RANGE = Array.from({ length: 50 }, (_, i) => PORT_BASE + i);

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function store() {
  const tmp = tempDir('routespec-m17-proxy-');
  const s = openStore(tmp.dir);
  cleanups.push(() => tmp.cleanup());
  cleanups.push(() => s.close());
  return s;
}

let cursor = 0;

/**
 * Start a proxy on the next free port of the range (other suites may hold some of them). Each
 * call moves on, so no test reuses a port whose kept-alive client socket another test left behind.
 */
async function startInRange(s: ReturnType<typeof store>): Promise<ScenarioProxy> {
  while (cursor < RANGE.length) {
    const port = RANGE[cursor++] as number;
    try {
      return await ScenarioProxy.start({ store: s, mode: 'SIMULATE', cases: NO_CASES, port });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error(`no free port in ${PORT_BASE}-${PORT_LAST}`);
}

function hold(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen({ host: '127.0.0.1', port, exclusive: true }, () => resolve(srv));
  });
}

describe('M17 — scenario proxy on an explicit loopback port', () => {
  it('binds exactly the configured port on 127.0.0.1 and serves there', async () => {
    const s = store();
    const proxy = await startInRange(s);
    cleanups.push(() => proxy.close());
    expect(RANGE).toContain(proxy.port);
    expect(proxy.boundAddress).toMatchObject({ address: '127.0.0.1', family: 'IPv4', port: proxy.port });
    expect(proxy.origin).toBe(`http://127.0.0.1:${proxy.port}`);
    const r = await send(proxy.port, { method: 'POST', path: '/v0/quote', body: {} });
    expect(typeof r.status).toBe('number');
    expect((r.body as { error?: { code?: string } }).error?.code).toMatch(/^RS_/);
  });

  it('the Host allowlist follows the configured port', async () => {
    const s = store();
    const proxy = await startInRange(s);
    cleanups.push(() => proxy.close());
    const other = proxy.port === PORT_LAST ? PORT_LAST - 1 : proxy.port + 1;
    const r = await send(proxy.port, {
      method: 'POST',
      path: '/v0/quote',
      host: `127.0.0.1:${other}`,
      body: {},
    });
    expect(r.status).toBe(403);
    expect((r.body as { error: { code: string } }).error.code).toBe('RS_HOST_REJECTED');
  });

  it('invalid ports are refused before any socket opens', async () => {
    const s = store();
    for (const port of [-1, 65_536, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        ScenarioProxy.start({ store: s, mode: 'SIMULATE', cases: NO_CASES, port }),
        `port ${String(port)}`,
      ).rejects.toMatchObject({ code: 'RS_MODE_POLICY_DENIED' });
    }
  });

  it('a port already in use fails with EADDRINUSE and leaves nothing listening', async () => {
    const s = store();
    const proxy = await startInRange(s);
    const port = proxy.port;
    await proxy.close();
    const holder = await hold(port);
    cleanups.push(() => new Promise<void>((r) => holder.close(() => r())));
    await expect(
      ScenarioProxy.start({ store: s, mode: 'SIMULATE', cases: NO_CASES, port }),
    ).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });
});
