/**
 * T-036 — Local listeners reject non-loopback exposure: the container-host part (M17).
 * Covers FR-02, NFR-02, RP-06.
 *
 * Every RouteSpec listener is started for real on this host on its loopback address: the control
 * service (IPv4, serving the console when it is built, and IPv6), the networkless scenario proxy,
 * the separately launched canary effect interceptor bound to a running case, and the separately
 * launched live-dry adapter. Then three kinds of container on the real engine try to reach them,
 * and the engine host, its network, and the engine itself:
 *
 * 1. the confined subject, started by the RouteSpec containment launcher exactly as a contained
 *    case is (`ContainedSubject`), with its two intended tunnels: the proxy and the effect sink;
 * 2. an ordinary container on the engine's default bridge network;
 * 3. a container on the engine host's own network (`--network host`; on Windows that is the WSL 2
 *    virtual machine).
 *
 * Each attempt is real: TCP connections to every listener port at every address of this host,
 * the engine host, the bridge gateway and the engine host's default gateway, loopback inside the
 * container, the engine's own host names; the engine API ports and sockets; WSL paths; and
 * running a Windows executable from the mounted checkout, which WSL's binfmt registration hands
 * to the Windows interop interpreter. A control listener on the engine host's network (bound to
 * its non-loopback addresses only, so WSL does not forward it to this host) is the positive
 * control: ordinary containers reach it, the confined subject must not.
 *
 * Skipped as `NOT_RUN: <reason>` when no engine or pinned image is present (never a pass).
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { request } from 'node:http';
import { connect } from 'node:net';
import { hostname, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, type TestContext } from 'vitest';
import {
  ContainedSubject,
  detectContainerRuntime,
  enginePath,
  runEngine,
  type RuntimeStatus,
} from '@routespec/containment';
import { ControlServer } from '@routespec/control-api';
import type { LaunchedAdapter } from '@routespec/live-dry-adapter';
import { CaseSupervisor, InterceptorHost, ScenarioProxy } from '@routespec/proxy';
import type { RouteSpecStore } from '@routespec/store';
import { launchTestAdapter } from '../../live-dry-adapter/test/support/harness.ts';
import { compileCore, createGate, openStore, tempDir } from '../../proxy/test/support/gate.ts';

type Available = Extract<RuntimeStatus, { status: 'AVAILABLE' }>;
type Target =
  | { id: string; kind: 'tcp'; host: string; port: number }
  | { id: string; kind: 'dns'; name: string }
  | { id: string; kind: 'unix'; path: string }
  | { id: string; kind: 'path'; path: string }
  | { id: string; kind: 'exec'; path: string; args: string[] };
interface ExecResult {
  result: string;
  stdout: string;
  stderr: string;
}
type Results = Record<string, string | ExecResult>;
interface Discovery {
  addresses: Array<{ iface: string; address: string; family: string }>;
  defaultGateways: Array<{ iface: string; gateway: string }>;
}

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const PROBE = fileURLToPath(new URL('./support/host-reach-probe.mjs', import.meta.url));
const CONSOLE_DIR = join(ROOT, 'apps', 'console', 'dist');
const CONSOLE_BUILT = existsSync(join(CONSOLE_DIR, 'index.html'));
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
const PORT_RANGE = Array.from({ length: 50 }, (_, i) => PORT_BASE + i);
/** Results that show there is no path at all (not a refusal by something that is reachable). */
const NO_ROUTE = new Set(['ENETUNREACH', 'EHOSTUNREACH', 'EADDRNOTAVAIL', 'EAI_AGAIN', 'ENOTFOUND']);

let runtime: RuntimeStatus = { status: 'ABSENT', reason: 'CONTAINER_RUNTIME_ABSENT', detail: '', cli: null };
let tmp: ReturnType<typeof tempDir> | null = null;
let store: RouteSpecStore | null = null;
let control4: ControlServer | null = null;
let control6: ControlServer | null = null;
let proxy: ScenarioProxy | null = null;
let interceptor: InterceptorHost | null = null;
let adapter: LaunchedAdapter | null = null;
let controlContainer: string | null = null;
let listeners: Array<{ label: string; port: number; loopback: '127.0.0.1' | '::1' }> = [];
let hostNet: Discovery = { addresses: [], defaultGateways: [] };
let bridgeNet: Discovery = { addresses: [], defaultGateways: [] };
let controlPort: number | null = null;
let controlHosts: string[] = [];
let windowsExe: string | null = null;
let windowsExeVersion: string | null = null;
const usedPorts = new Set<number>();

function needRuntime(ctx: TestContext): Available {
  if (runtime.status !== 'AVAILABLE') {
    ctx.skip(`NOT_RUN: ${runtime.reason}${runtime.detail ? ` (${runtime.detail})` : ''}`);
    throw new Error('unreachable');
  }
  return runtime;
}

/** Start a listener on the first free port of the assigned range (siblings may hold some). */
async function startInRange<T>(start: (port: number) => Promise<T>): Promise<T> {
  for (const port of PORT_RANGE) {
    if (usedPorts.has(port)) continue;
    try {
      const v = await start(port);
      usedPorts.add(port);
      return v;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error(`no free port in ${PORT_BASE}-${PORT_LAST}`);
}

function tryConnect(host: string, port: number): Promise<string> {
  return new Promise((resolve) => {
    const s = connect({ host, port, timeout: 3000 });
    s.once('connect', () => {
      s.destroy();
      resolve('CONNECTED');
    });
    s.once('timeout', () => {
      s.destroy();
      resolve('TIMEOUT');
    });
    s.once('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? 'ERROR'));
  });
}

function httpGet(port: number, path: string): Promise<{ status: number | null; body: string }> {
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, path, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? null, body: Buffer.concat(chunks).toString() }),
      );
    });
    req.once('error', () => resolve({ status: null, body: '' }));
    req.end();
  });
}

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64');

function lastJson<T>(stdout: string): T {
  const lines = stdout.split('\n').filter((l) => l.trim().startsWith('{'));
  if (lines.length === 0) throw new Error(`probe printed no result: ${stdout.slice(0, 400)}`);
  return JSON.parse(lines[lines.length - 1] as string) as T;
}

/** Hardened flags for the ordinary probe containers (their network is the variable under test). */
function probeArgs(rt: Available, network: string, extra: string[] = []): string[] {
  const root = enginePath(rt.cli, ROOT);
  return [
    'run',
    '--rm',
    '--network',
    network,
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--user',
    '1000:1000',
    '--pids-limit',
    '64',
    '--memory',
    '256m',
    '--label',
    'routespec.test=t036-container-host',
    '--volume',
    `${root}:${root}:ro`,
    ...extra,
    rt.imageId,
    'node',
    '--no-warnings',
    enginePath(rt.cli, PROBE),
  ];
}

async function runProbe<T>(rt: Available, network: string, mode: string, arg?: unknown): Promise<T> {
  const args = [...probeArgs(rt, network), mode, ...(arg === undefined ? [] : [b64(arg)])];
  const r = await runEngine(rt.cli, args, 180_000);
  if (r.exitCode !== 0) throw new Error(`probe container failed: ${String(r.exitCode)} ${r.stderr}`);
  return lastJson<T>(r.stdout);
}

const isLinkLocal6 = (a: string) => /^fe[89ab]/i.test(a);

/** Every address at which a container could try to reach this host or the engine host. */
function addressSet(): Array<{ label: string; host: string }> {
  const out = new Map<string, string>();
  for (const [iface, list] of Object.entries(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.internal || (a.family === 'IPv6' && isLinkLocal6(a.address))) continue;
      if (!out.has(a.address)) out.set(a.address, `this-host:${iface}`);
    }
  }
  for (const a of hostNet.addresses) {
    if (a.address === '127.0.0.1' || a.address === '::1' || isLinkLocal6(a.address)) continue;
    if (!out.has(a.address)) out.set(a.address, `engine-host:${a.iface}`);
  }
  for (const g of hostNet.defaultGateways)
    if (!out.has(g.gateway)) out.set(g.gateway, `engine-host-gateway:${g.iface}`);
  for (const g of bridgeNet.defaultGateways)
    if (!out.has(g.gateway)) out.set(g.gateway, `bridge-gateway:${g.iface}`);
  return [...out].map(([host, label]) => ({ label, host }));
}

const NAMES = ['host.docker.internal', 'gateway.docker.internal', hostname()];

/** Attempt id -> category for the evidence summary (categories carry no address or name). */
const categories = new Map<string, string>();

function targets(): Target[] {
  const t: Target[] = [];
  const add = (category: string, target: Target) => {
    categories.set(target.id, category);
    t.push(target);
  };
  const addrs = addressSet();
  const addrClass = (label: string) => label.slice(0, label.indexOf(':'));
  for (const l of listeners) {
    for (const a of addrs)
      add(`listener@${addrClass(a.label)}`, {
        id: `${l.label}@${a.host}`,
        kind: 'tcp',
        host: a.host,
        port: l.port,
      });
    for (const lo of ['127.0.0.1', '::1', 'localhost'])
      add('listener@container-loopback', { id: `${l.label}@${lo}`, kind: 'tcp', host: lo, port: l.port });
    for (const n of NAMES)
      add('listener@host-name', { id: `${l.label}@name:${n}`, kind: 'tcp', host: n, port: l.port });
  }
  for (const n of NAMES) add('dns-name', { id: `dns:${n}`, kind: 'dns', name: n });
  for (const a of addrs)
    for (const port of [2375, 2376])
      add('engine-api-port', { id: `engine-api:${port}@${a.host}`, kind: 'tcp', host: a.host, port });
  for (const path of ['/var/run/docker.sock', '/run/docker.sock', '/run/containerd/containerd.sock'])
    add('engine-socket', { id: `engine-socket:${path}`, kind: 'unix', path });
  for (const path of ['/run/WSL', '/mnt/wsl', '/init', '/mnt/c/Windows/System32'])
    add('wsl-path', { id: `wsl-path:${path}`, kind: 'path', path });
  if (controlPort !== null)
    for (const h of controlHosts)
      add('control-listener@engine-host-network', {
        id: `control@${h}`,
        kind: 'tcp',
        host: h,
        port: controlPort,
      });
  if (windowsExe !== null && runtime.status === 'AVAILABLE')
    add('windows-executable', {
      id: 'windows-exe',
      kind: 'exec',
      path: enginePath(runtime.cli, windowsExe),
      args: ['--version'],
    });
  return t;
}

const isListenerTarget = (id: string) => listeners.some((l) => id.startsWith(`${l.label}@`));

/** Result codes per attempt category; no address, host name, or path of this machine. */
function summary(results: Results): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const [id, v] of Object.entries(results)) {
    const category = categories.get(id) ?? 'other';
    const k =
      typeof v === 'string'
        ? v.replace(/^RESOLVED:.*/, 'RESOLVED')
        : `${v.result}${windowsExeVersion !== null && v.stdout.includes(windowsExeVersion) ? '+PROGRAM_OUTPUT' : ''}${/UtilBindVsockAnyPort/.test(v.stderr) ? '+VSOCK_DENIED' : ''}`;
    const bucket = (out[category] ??= {});
    bucket[k] = (bucket[k] ?? 0) + 1;
  }
  return out;
}

function findWindowsExe(): { path: string; version: string } | null {
  const pnpmDir = join(ROOT, 'node_modules', '.pnpm');
  if (!existsSync(pnpmDir)) return null;
  const dir = readdirSync(pnpmDir).find((d) => d.startsWith('@esbuild+win32-x64@'));
  if (!dir) return null;
  const path = join(pnpmDir, dir, 'node_modules', '@esbuild', 'win32-x64', 'esbuild.exe');
  return existsSync(path) ? { path, version: dir.slice('@esbuild+win32-x64@'.length) } : null;
}

function assertNoWindowsProgramRan(r: string | ExecResult | undefined): void {
  if (windowsExeVersion === null) return;
  const exec = r as ExecResult;
  expect(exec, 'exec attempt reported').toBeTypeOf('object');
  // The Windows program prints its version when it runs; nothing of it may appear.
  expect(exec.stdout).not.toContain(windowsExeVersion);
}

beforeAll(async () => {
  runtime = await detectContainerRuntime();
  if (runtime.status !== 'AVAILABLE') return;
  const rt = runtime;
  tmp = tempDir('routespec-t036-host-');
  store = openStore(tmp.dir);
  const s = store;
  control4 = await startInRange((port) =>
    ControlServer.start({
      store: s,
      host: '127.0.0.1',
      port,
      consoleDir: CONSOLE_BUILT ? CONSOLE_DIR : null,
      onLocalConfirmation: () => undefined,
    }),
  );
  control6 = await startInRange((port) =>
    ControlServer.start({ store: s, host: '::1', port, onLocalConfirmation: () => undefined }),
  );
  const compiled = compileCore('happy-path');
  const gate = createGate(s, compiled, { label: 't036-host' });
  const supervisor = new CaseSupervisor(s, { ownerLabel: 't036-host' });
  supervisor.startCase({ caseRunId: gate.caseRunIds[0] as string, compiled, mode: 'SIMULATE' });
  proxy = await startInRange((port) =>
    ScenarioProxy.start({ store: s, mode: 'SIMULATE', cases: supervisor, port }),
  );
  interceptor = await InterceptorHost.launch({
    store: s,
    fence: supervisor.fenceFor(gate.caseRunIds[0] as string),
  });
  adapter = await launchTestAdapter({ test: { kind: 'deny-all' } });
  listeners = [
    {
      label: CONSOLE_BUILT ? 'control-api+console' : 'control-api',
      port: control4.port,
      loopback: '127.0.0.1',
    },
    { label: 'control-api-ipv6', port: control6.port, loopback: '::1' },
    { label: 'scenario-proxy', port: proxy.port, loopback: '127.0.0.1' },
    { label: 'interceptor-sink', port: interceptor.sinkPort, loopback: '127.0.0.1' },
    { label: 'live-dry-adapter', port: adapter.port, loopback: '127.0.0.1' },
  ];
  for (const l of listeners) usedPorts.add(l.port);

  hostNet = await runProbe<Discovery>(rt, 'host', 'discover');
  bridgeNet = await runProbe<Discovery>(rt, 'bridge', 'discover');

  // Positive control on the engine host's network, bound to its non-loopback IPv4 addresses.
  controlHosts = hostNet.addresses
    .filter((a) => a.family === 'IPv4' && a.iface !== 'lo' && !a.address.startsWith('127.'))
    .map((a) => a.address);
  if (controlHosts.length > 0) {
    controlContainer = `routespec-t036-control-${randomBytes(6).toString('hex')}`;
    const ports = PORT_RANGE.filter((p) => !usedPorts.has(p));
    const args = probeArgs(rt, 'host', ['-d', '--name', controlContainer]);
    const started = await runEngine(
      rt.cli,
      [...args, 'listen', b64({ hosts: controlHosts, ports })],
      120_000,
    );
    if (started.exitCode === 0) {
      for (let i = 0; i < 100 && controlPort === null; i++) {
        const logs = await runEngine(rt.cli, ['logs', controlContainer], 30_000);
        const line = logs.stdout.split('\n').find((l) => l.includes('"listening"'));
        if (line) controlPort = (JSON.parse(line) as { listening: number | null }).listening;
        else await new Promise((r) => setTimeout(r, 200));
      }
    }
  }
  const exe = findWindowsExe();
  if (exe !== null && rt.cli.pathStyle === 'wsl') {
    windowsExe = exe.path;
    windowsExeVersion = exe.version;
  }
}, 600_000);

afterAll(async () => {
  const step = async (label: string, fn: () => Promise<unknown> | unknown) => {
    const t0 = Date.now();
    await Promise.resolve()
      .then(fn)
      .catch(() => undefined);
    console.info(`[T-036 teardown] ${label} ${Date.now() - t0} ms`);
  };
  if (controlContainer !== null && runtime.status === 'AVAILABLE') {
    const rt = runtime;
    const name = controlContainer;
    await step('control container', () => runEngine(rt.cli, ['rm', '-f', name]));
  }
  await step('adapter', () => adapter?.close());
  await step('interceptor', () => interceptor?.teardown());
  await step('proxy', () => proxy?.close());
  await step('control4', () => control4?.close());
  await step('control6', () => control6?.close());
  store?.close();
  tmp?.cleanup();
}, 120_000);

describe('T-036 — container-host access to RouteSpec listeners (real engine)', () => {
  it('every listener is up on its loopback address on this host (sanity)', async (ctx) => {
    needRuntime(ctx);
    for (const l of listeners) expect(await tryConnect(l.loopback, l.port), l.label).toBe('CONNECTED');
    for (const p of usedPorts) if (p >= PORT_BASE && p <= PORT_LAST) expect(PORT_RANGE).toContain(p);
    expect(PORT_RANGE).toContain(control4?.port);
    expect(PORT_RANGE).toContain(control6?.port);
    expect(PORT_RANGE).toContain(proxy?.port);
  });

  it('the console is served on loopback only (it shares the control listener)', async (ctx) => {
    needRuntime(ctx);
    if (!CONSOLE_BUILT) {
      ctx.skip('NOT_RUN: CONSOLE_NOT_BUILT (run pnpm run build:console)');
      return;
    }
    const r = await httpGet(control4?.port as number, '/');
    expect(r.status).toBe(200);
    expect(r.body.toLowerCase()).toContain('<!doctype html>');
  });

  it('an ordinary bridge-network container reaches the engine host network but no RouteSpec listener', async (ctx) => {
    const rt = needRuntime(ctx);
    const t = targets();
    const { results } = await runProbe<{ results: Results }>(rt, 'bridge', 'reach', t);
    console.info('[T-036 bridge container]', JSON.stringify(summary(results)));
    for (const [id, v] of Object.entries(results))
      if (isListenerTarget(id)) expect(v, id).not.toBe('CONNECTED');
    for (const [id, v] of Object.entries(results))
      if (id.startsWith('engine-api:') || id.startsWith('engine-socket:'))
        expect(v, id).not.toBe('CONNECTED');
    for (const path of ['/run/WSL', '/mnt/wsl', '/init', '/mnt/c/Windows/System32'])
      expect(results[`wsl-path:${path}`], path).toBe('ABSENT');
    assertNoWindowsProgramRan(results['windows-exe']);
    // Positive control: this container does have a path to the engine host's network.
    expect(controlPort, 'control listener started').not.toBeNull();
    const control = Object.entries(results).filter(([id]) => id.startsWith('control@'));
    expect(
      control.some(([, v]) => v === 'CONNECTED'),
      JSON.stringify(control),
    ).toBe(true);
  });

  it("a container on the engine host's own network reaches no RouteSpec listener, not even on its loopback", async (ctx) => {
    const rt = needRuntime(ctx);
    const { results } = await runProbe<{ results: Results }>(rt, 'host', 'reach', targets());
    console.info('[T-036 host-network container]', JSON.stringify(summary(results)));
    for (const [id, v] of Object.entries(results))
      if (isListenerTarget(id)) expect(v, id).not.toBe('CONNECTED');
    for (const [id, v] of Object.entries(results))
      if (id.startsWith('engine-socket:')) expect(v, id).not.toBe('CONNECTED');
    assertNoWindowsProgramRan(results['windows-exe']);
    const control = Object.entries(results).filter(([id]) => id.startsWith('control@'));
    expect(control.length).toBeGreaterThan(0);
    for (const [id, v] of control) expect(v, id).toBe('CONNECTED');
  });

  it('the confined subject reaches only its two tunnels: no host service, engine, WSL host network, service, or console', async (ctx) => {
    const rt = needRuntime(ctx);
    const p = proxy as ScenarioProxy;
    const sink = interceptor as InterceptorHost;
    const subject = await ContainedSubject.launch({
      cli: rt.cli,
      imageId: rt.imageId,
      root: ROOT,
      entry: PROBE,
      tunnels: [
        { containerPort: p.port, hostPort: p.port, purpose: 'proxy' },
        { containerPort: sink.sinkPort, hostPort: sink.sinkPort, purpose: 'effect-sink' },
      ],
    });
    let teardown;
    let results: Results = {};
    let viaTunnel: Record<string, unknown> = {};
    try {
      await subject.waitFor('loaded', 60_000);
      expect(subject.verdict.findings).toEqual([]);
      expect(subject.verdict.containment).toBe('PROCESS_TREE_ENFORCED');
      expect(subject.self).toMatchObject({ seccomp: '2', interfaces: ['lo'], uid: 1000 });
      results = (await subject.request({ type: 'reach', targets: targets() }, 180_000))['results'] as Results;
      // The intended path: the real proxy answers through the launcher-owned tunnel.
      viaTunnel = await subject.request({ type: 'http', port: p.port, path: '/v0/quote', body: {} });
    } finally {
      teardown = await subject.stop();
    }
    console.info('[T-036 confined subject]', JSON.stringify(summary(results)));
    expect(typeof viaTunnel['status']).toBe('number');
    expect(String(viaTunnel['body'])).toMatch(/"code":"RS_[A-Z_]+"/);

    const tunnelIds = new Set(
      ['scenario-proxy', 'interceptor-sink'].flatMap((l) => [`${l}@127.0.0.1`, `${l}@localhost`]),
    );
    const connected = Object.entries(results)
      .filter(([, v]) => v === 'CONNECTED')
      .map(([id]) => id);
    // Only the container's own loopback tunnel endpoints connect, and each of those connections
    // was carried by the launcher (counted by the tunnel, which forwards to one fixed target).
    for (const id of connected) expect(tunnelIds.has(id), id).toBe(true);
    expect(connected).toContain('scenario-proxy@127.0.0.1');
    expect(connected).toContain('interceptor-sink@127.0.0.1');
    const carried =
      (teardown.tunnels['proxy']?.connections ?? 0) + (teardown.tunnels['effect-sink']?.connections ?? 0);
    expect(carried).toBe(connected.length + 1); // + the HTTP request through the proxy tunnel
    expect(teardown.removed).toBe(true);

    for (const [id, v] of Object.entries(results)) {
      if (connected.includes(id) || typeof v !== 'string') continue;
      const loopback = /@(127\.0\.0\.1|::1|localhost)$/.test(id);
      if (id.startsWith('engine-socket:')) expect(v, id).toBe('ENOENT');
      else if (id.startsWith('wsl-path:')) expect(v, id).toBe('ABSENT');
      else if (id.startsWith('dns:')) expect(NO_ROUTE.has(v), `${id} ${v}`).toBe(true);
      else if (loopback) expect(['ECONNREFUSED', ...NO_ROUTE], `${id} ${v}`).toContain(v);
      // Any other address: no route at all. A TIMEOUT or a refusal would mean packets left.
      else expect(NO_ROUTE.has(v), `${id} ${v}`).toBe(true);
    }
    // The WSL host network is reachable from ordinary containers (positive control), not here.
    const control = Object.entries(results).filter(([id]) => id.startsWith('control@'));
    expect(control.length).toBeGreaterThan(0);
    for (const [id, v] of control) expect(v, id).toBe('ENETUNREACH');
    assertNoWindowsProgramRan(results['windows-exe']);
  });
});
