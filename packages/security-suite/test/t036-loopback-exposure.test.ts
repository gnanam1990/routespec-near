/**
 * T-036 — Local listeners reject non-loopback exposure. Covers FR-02, NFR-02.
 *
 * Every listener RouteSpec opens is started for real: the control service (IPv4 and IPv6
 * loopback), the networkless scenario proxy, the separately launched canary effect interceptor
 * bound to a running case, and the separately launched live-dry adapter. The bound addresses
 * are then read from the operating system (`Get-NetTCPConnection` on Windows, `lsof`
 * elsewhere), not from RouteSpec's own bookkeeping, and connections are attempted through
 * every non-loopback interface address this host has. Wildcard, LAN, and look-alike bind
 * requests must be refused before any socket opens, including through the service entry point.
 *
 * The container-host part (attempts from containers on a real engine, including the confined
 * subject) is `runtime-test/t036-container-host-access.runtime.test.ts` (M17,
 * `pnpm run test:containment`); it reports NOT_RUN when no engine is configured.
 */
import { fork } from 'node:child_process';
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ControlServer } from '@routespec/control-api';
import { listeningSockets, type ListeningSocket } from '@routespec/hardening';
import type { LaunchedAdapter } from '@routespec/live-dry-adapter';
import { CaseSupervisor, InterceptorHost, ScenarioProxy } from '@routespec/proxy';
import { RouteSpecStore } from '@routespec/store';
import { launchTestAdapter } from '../../live-dry-adapter/test/support/harness.ts';
import { compileCore, createGate, openStore, send, tempDir } from '../../proxy/test/support/gate.ts';

const LOOPBACK = new Set(['127.0.0.1', '::1']);
const MAIN = fileURLToPath(new URL('../../control-api/src/main.ts', import.meta.url));

interface Listener {
  readonly label: string;
  readonly pid: number;
  readonly port: number;
}

let tmp: ReturnType<typeof tempDir>;
let store: RouteSpecStore;
let control4: ControlServer;
let control6: ControlServer;
let proxy: ScenarioProxy;
let interceptor: InterceptorHost;
let adapter: LaunchedAdapter;
let supervisor: CaseSupervisor;
let listeners: Listener[] = [];

function externalAddresses(): Array<{ address: string; family: 'IPv4' | 'IPv6'; scopeid?: number }> {
  return Object.values(networkInterfaces())
    .flatMap((list) => list ?? [])
    .filter((a) => !a.internal)
    .map((a) => ({
      address: a.address,
      family: a.family,
      ...(a.family === 'IPv6' && a.scopeid !== undefined ? { scopeid: a.scopeid } : {}),
    }));
}

function tryConnect(host: string, port: number): Promise<'CONNECTED' | string> {
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: 1_500 });
    socket.once('connect', () => {
      socket.destroy();
      resolve('CONNECTED');
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve('TIMEOUT');
    });
    socket.once('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? 'ERROR'));
  });
}

beforeAll(async () => {
  tmp = tempDir('routespec-t036-');
  store = openStore(tmp.dir);
  control4 = await ControlServer.start({ store, host: '127.0.0.1', onLocalConfirmation: () => undefined });
  control6 = await ControlServer.start({ store, host: '::1', onLocalConfirmation: () => undefined });
  const compiled = compileCore('happy-path');
  const gate = createGate(store, compiled, { label: 't036' });
  supervisor = new CaseSupervisor(store, { ownerLabel: 't036' });
  supervisor.startCase({ caseRunId: gate.caseRunIds[0] as string, compiled, mode: 'SIMULATE' });
  proxy = await ScenarioProxy.start({ store, mode: 'SIMULATE', cases: supervisor });
  interceptor = await InterceptorHost.launch({
    store,
    fence: supervisor.fenceFor(gate.caseRunIds[0] as string),
  });
  adapter = await launchTestAdapter({ test: { kind: 'deny-all' } });
  listeners = [
    { label: 'control-api (127.0.0.1)', pid: process.pid, port: control4.port },
    { label: 'control-api (::1)', pid: process.pid, port: control6.port },
    { label: 'scenario proxy', pid: process.pid, port: proxy.port },
    { label: 'canary interceptor sink', pid: interceptor.peerPid, port: interceptor.sinkPort },
    { label: 'live-dry adapter', pid: adapter.child.pid as number, port: adapter.port },
  ];
}, 120_000);

afterAll(async () => {
  await adapter?.close().catch(() => undefined);
  await interceptor?.teardown().catch(() => undefined);
  await proxy?.close();
  await control4?.close();
  await control6?.close();
  store?.close();
  tmp?.cleanup();
});

describe('T-036 — Local listeners reject non-loopback exposure', () => {
  // The two OS-level checks below ask the OS for its socket table and probe every interface
  // address (1.5 s each); on a host with many virtual adapters that alone takes tens of seconds.
  it('the OS reports every RouteSpec listening socket on a loopback address only', () => {
    const byPid = new Map<number, ListeningSocket[]>();
    for (const pid of new Set(listeners.map((l) => l.pid))) byPid.set(pid, listeningSockets(pid));
    for (const l of listeners) {
      const sockets = (byPid.get(l.pid) ?? []).filter((s) => s.port === l.port);
      expect(sockets.length, `${l.label} is listening`).toBeGreaterThan(0);
      for (const s of sockets) expect(LOOPBACK.has(s.address), `${l.label} bound ${s.address}`).toBe(true);
    }
    // No other listener exists in any of these processes (no hidden wildcard socket).
    for (const [pid, sockets] of byPid) {
      for (const s of sockets)
        expect(LOOPBACK.has(s.address), `pid ${pid} port ${s.port} on ${s.address}`).toBe(true);
    }
  }, 180_000);

  it('connections through every non-loopback interface address are refused', async (ctx) => {
    const external = externalAddresses();
    if (external.length === 0) {
      ctx.skip(); // NOT_RUN: this host has no non-loopback interface.
      return;
    }
    for (const l of listeners) {
      const family = l.label.includes('::1') ? 'IPv6' : 'IPv4';
      expect(await tryConnect(family === 'IPv6' ? '::1' : '127.0.0.1', l.port), `${l.label} loopback`).toBe(
        'CONNECTED',
      );
      for (const a of external) {
        const host = a.family === 'IPv6' && a.scopeid ? `${a.address}%${a.scopeid}` : a.address;
        const result = await tryConnect(host, l.port);
        expect(result, `${l.label} via ${a.family} ${a.address}`).not.toBe('CONNECTED');
      }
    }
  }, 180_000);

  it('wildcard, LAN, and look-alike bind addresses are refused before any socket opens', async () => {
    const before = listeningSockets(process.pid).length;
    const lan = externalAddresses().find((a) => a.family === 'IPv4')?.address ?? '192.0.2.10';
    for (const host of [
      '0.0.0.0',
      '::',
      lan,
      'localhost',
      '127.0.0.2',
      '::ffff:127.0.0.1',
      '',
      ' 127.0.0.1',
    ]) {
      await expect(
        ControlServer.start({ store, host, onLocalConfirmation: () => undefined }),
        `bind ${JSON.stringify(host)}`,
      ).rejects.toMatchObject({ code: 'RS_MODE_POLICY_DENIED' });
    }
    expect(listeningSockets(process.pid).length).toBe(before);
  });

  it('the service entry point exits without listening when asked to bind a wildcard address', async () => {
    const dataDir = join(tmp.dir, 'entry');
    const child = fork(MAIN, ['--data', dataDir, '--host', '0.0.0.0'], {
      execArgv: ['--no-warnings'],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    let stdout = '';
    child.stdout?.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr?.resume();
    const sockets: ListeningSocket[] = [];
    const exitCode = await new Promise<number | null>((resolve) => {
      const poll = setInterval(() => {
        try {
          if (child.pid) sockets.push(...listeningSockets(child.pid));
        } catch {
          // process gone
        }
      }, 250);
      child.once('exit', (code) => {
        clearInterval(poll);
        resolve(code);
      });
    });
    expect(exitCode).not.toBe(0);
    expect(stdout).not.toContain('origin');
    expect(sockets).toEqual([]);
  });

  it('a request that reaches a listener under a foreign Host name is refused (rebinding)', async () => {
    const lan = externalAddresses().find((a) => a.family === 'IPv4')?.address ?? '192.0.2.10';
    for (const host of [
      `${lan}:${proxy.port}`,
      `attacker.example:${proxy.port}`,
      `127.0.0.1.nip.io:${proxy.port}`,
    ]) {
      const r = await send(proxy.port, { method: 'POST', path: '/v0/quote', host, body: {} });
      expect(r.status, host).toBe(403);
      expect((r.body as { error: { code: string } }).error.code).toBe('RS_HOST_REJECTED');
    }
  });
});
