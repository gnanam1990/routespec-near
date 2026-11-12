/**
 * M14 containment against a real container engine (T-010 process-tree egress claim, RP-02 and
 * RP-06 containment, T-004 live complete-effect prerequisites).
 *
 * Every test here needs a reachable engine and the pinned image. When detection reports
 * anything else, each test is skipped with `NOT_RUN: <reason>` (for example
 * CONTAINER_RUNTIME_ABSENT): it neither passes nor fails. Run with `pnpm run test:containment`
 * and `ROUTESPEC_CONTAINER_CLI` naming the engine command (see docs/runbooks/container-containment.md).
 *
 * The hostile subject (`test/support/escape-probe.mjs`) tries to leave the container: direct
 * TCP/UDP egress over IPv4 and IPv6, DNS, the container gateway and the WSL host address, a host
 * listener on another loopback port, writes outside the ephemeral /tmp, execution from /tmp,
 * privilege changes, a detached daemon in a new session, and a process flood. No attempt can reach
 * a real downstream effect: there is no route, and the only reachable endpoints are the tunnels set
 * up here.
 */
import { createServer, type Server } from 'node:http';
import { randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, type TestContext } from 'vitest';
import {
  ContainedSubject,
  DEFAULT_MAX_MEMORY_BYTES,
  DEFAULT_MAX_PIDS,
  detectContainerRuntime,
  enginePath,
  runEngine,
  verifyInspect,
  type RuntimeStatus,
} from '../src/index.ts';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const PROBE = fileURLToPath(new URL('../test/support/escape-probe.mjs', import.meta.url));
const SINK_PORT = 47801;

let runtime: RuntimeStatus;
let server: Server;
let hostPort = 0;
let otherServer: Server;
let otherPort = 0;
const hits: string[] = [];

function listen(handler: (url: string) => string): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const s = createServer((req, res) => res.end(handler(req.url ?? '')));
    s.listen(0, '127.0.0.1', () => resolve({ server: s, port: (s.address() as { port: number }).port }));
  });
}

beforeAll(async () => {
  runtime = await detectContainerRuntime();
  const a = await listen((url) => {
    hits.push(url);
    return `tunnel-ok ${url}`;
  });
  server = a.server;
  hostPort = a.port;
  const b = await listen(() => 'must-not-be-reachable');
  otherServer = b.server;
  otherPort = b.port;
}, 120_000);

afterAll(() => {
  server?.close();
  otherServer?.close();
});

/** Skip as NOT_RUN with the detection reason when no usable engine is present. */
function needRuntime(ctx: TestContext): Extract<RuntimeStatus, { status: 'AVAILABLE' }> {
  if (runtime.status !== 'AVAILABLE') {
    ctx.skip(`NOT_RUN: ${runtime.reason}${runtime.detail ? ` (${runtime.detail})` : ''}`);
    throw new Error('unreachable');
  }
  return runtime;
}

async function launch(rt: Extract<RuntimeStatus, { status: 'AVAILABLE' }>): Promise<ContainedSubject> {
  const s = await ContainedSubject.launch({
    cli: rt.cli,
    imageId: rt.imageId,
    root: ROOT,
    entry: PROBE,
    tunnels: [
      { containerPort: 41000, hostPort, purpose: 'proxy' },
      { containerPort: SINK_PORT, hostPort: null, purpose: 'effect-sink' },
    ],
  });
  await s.waitFor('loaded', 60_000);
  return s;
}

/** Processes on the engine host (outside every container), when the command allows it. */
async function engineHostProcesses(
  rt: Extract<RuntimeStatus, { status: 'AVAILABLE' }>,
): Promise<string[] | null> {
  const argv = [...rt.cli.argv];
  if (argv[argv.length - 1] !== 'docker') return null;
  argv[argv.length - 1] = 'ps';
  const r = await runEngine({ ...rt.cli, argv }, ['-eo', 'args']);
  return r.exitCode === 0 ? r.stdout.split('\n') : null;
}

describe('M14 subject containment on a real container engine', () => {
  it('detection names the engine and the pinned image by its immutable id', (ctx) => {
    const rt = needRuntime(ctx);
    expect(rt.serverOs).toBe('linux');
    expect(rt.imageId).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('the engine record and the in-container self-observation are PROCESS_TREE_ENFORCED', async (ctx) => {
    const rt = needRuntime(ctx);
    const s = await launch(rt);
    try {
      expect(s.verdict.findings).toEqual([]);
      expect(s.verdict.containment).toBe('PROCESS_TREE_ENFORCED');
      expect(s.self).toMatchObject({
        uid: 1000,
        capEff: '0000000000000000',
        capPrm: '0000000000000000',
        noNewPrivs: '1',
        seccomp: '2',
        interfaces: ['lo'],
      });
      expect(s.verdict.scope).toMatchObject({
        networkMode: 'none',
        readonlyRootfs: true,
        capDrop: ['ALL'],
        capAdd: [],
        init: true,
        pidsLimit: DEFAULT_MAX_PIDS,
        memory: DEFAULT_MAX_MEMORY_BYTES,
        user: '1000:1000',
      });
      expect(s.containerId).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await s.stop();
    }
  });

  it('direct egress, DNS, the gateway, IPv6, and other host listeners have no route', async (ctx) => {
    const rt = needRuntime(ctx);
    const s = await launch(rt);
    try {
      const r = (await s.request({ type: 'escape', hostPort: otherPort }))['results'] as Record<
        string,
        string
      >;
      for (const key of [
        'tcpPublicV4',
        'tcpDnsV4',
        'tcpPublicV6',
        'tcpDockerGateway',
        'tcpWslHost',
        'tcpLoopbackUnconfigured',
        'tcpHostListenerPort',
      ]) {
        expect(r[key], key).not.toBe('CONNECTED');
        expect(r[key], key).not.toBe('TIMEOUT');
      }
      expect(r['tcpPublicV4']).toBe('ENETUNREACH');
      expect(r['tcpPublicV6']).toBe('ENETUNREACH');
      expect(r['tcpDockerGateway']).toBe('ENETUNREACH');
      expect(r['tcpHostListenerPort']).toBe('ECONNREFUSED');
      expect(r['udpDnsV4']).toBe('ENETUNREACH');
      expect(['EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED']).toContain(r['dnsLookup']);
      expect(['EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED']).toContain(r['dnsResolve']);
      expect(['EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED']).toContain(r['dnsHostGateway']);
    } finally {
      await s.stop();
    }
  });

  it('no persistent write, no execution from /tmp, no privilege gain, no engine socket', async (ctx) => {
    const rt = needRuntime(ctx);
    const s = await launch(rt);
    try {
      const r = (await s.request({ type: 'escape' }))['results'] as Record<string, string>;
      expect(r['writeRootfs']).toBe('EROFS');
      expect(r['writeCheckout']).toBe('EROFS');
      expect(r['writeTmp']).toBe('OK');
      expect(r['execFromTmp']).toBe('EACCES');
      expect(r['setuidRoot']).toBe('EPERM');
      expect(r['engineSocket']).toBe('ABSENT');
    } finally {
      await s.stop();
    }
  });

  it('only the configured tunnels reach the host, and a port without a target is refused', async (ctx) => {
    const rt = needRuntime(ctx);
    const s = await launch(rt);
    try {
      const ok = await s.request({ type: 'http', port: 41000, path: '/through-tunnel' });
      expect(ok).toMatchObject({ status: 200, body: 'tunnel-ok /through-tunnel' });
      expect(hits).toContain('/through-tunnel');
      const refused = await s.request({
        type: 'http',
        port: SINK_PORT,
        path: '/sink/x',
        body: { effectId: 'e' },
      });
      expect(refused['status']).toBeNull();
      expect(s.stats['effect-sink']?.refused).toBe(1);
      s.setTunnelTarget(SINK_PORT, hostPort);
      const bound = await s.request({ type: 'http', port: SINK_PORT, path: '/now-bound' });
      expect(bound).toMatchObject({ status: 200, body: 'tunnel-ok /now-bound' });
    } finally {
      const t = await s.stop();
      expect(t.tunnels['proxy']?.connections).toBe(1);
      expect(t.tunnels['effect-sink']?.connections).toBe(1);
    }
  });

  it('a detached daemon in a new session stays in the tree and does not outlive the container', async (ctx) => {
    const rt = needRuntime(ctx);
    const s = await launch(rt);
    const seconds = 900 + randomInt(0, 9000);
    const marker = `sleep ${seconds}`;
    let teardown;
    try {
      const d = await s.request({ type: 'daemon', seconds });
      expect(typeof d['pid']).toBe('number');
      await new Promise((r) => setTimeout(r, 300));
      const inside = await s.processes();
      expect(inside.some((l) => l.includes(marker))).toBe(true);
    } finally {
      teardown = await s.stop();
    }
    expect(teardown.removed).toBe(true);
    expect(teardown.survivors).toEqual([]);
    const gone = await runEngine(rt.cli, ['inspect', s.name]);
    expect(gone.exitCode).not.toBe(0);
    const host = await engineHostProcesses(rt);
    if (host !== null) expect(host.filter((l) => l.includes(marker))).toEqual([]);
  });

  it('a process flood is capped by the pids limit', async (ctx) => {
    const rt = needRuntime(ctx);
    const s = await launch(rt);
    try {
      const r = await s.request({ type: 'flood', count: 400 }, 120_000);
      expect(Number(r['started'])).toBeLessThan(DEFAULT_MAX_PIDS);
      expect(r['refused']).toBe('EAGAIN');
    } finally {
      await s.stop();
    }
  });

  it('a container launched without the confinement flags is never reported as enforced', async (ctx) => {
    const rt = needRuntime(ctx);
    const name = `routespec-weak-${randomInt(0, 1e9)}`;
    const engineRoot = enginePath(rt.cli, ROOT);
    const run = await runEngine(rt.cli, [
      'run',
      '-d',
      '--rm',
      '--name',
      name,
      '--volume',
      `${engineRoot}:${engineRoot}`,
      rt.imageId,
      'sleep',
      '60',
    ]);
    expect(run.exitCode).toBe(0);
    try {
      const inspect = await runEngine(rt.cli, ['inspect', name]);
      const v = verifyInspect(
        JSON.parse(inspect.stdout) as unknown,
        {
          imageId: rt.imageId,
          readOnlyMounts: [engineRoot],
          maxPids: DEFAULT_MAX_PIDS,
          maxMemoryBytes: DEFAULT_MAX_MEMORY_BYTES,
          tunnelPorts: [],
        },
        null,
      );
      expect(v.containment).toBe('DECLARED_HOOKS_ONLY');
      for (const f of [
        'NETWORK_NOT_NONE',
        'ROOTFS_WRITABLE',
        'CAPABILITIES_NOT_DROPPED',
        'NEW_PRIVILEGES_ALLOWED',
        'PIDS_UNLIMITED',
        'MEMORY_UNLIMITED',
        'NO_INIT_REAPER',
        'RUNS_AS_ROOT',
        `MOUNT_WRITABLE:${engineRoot}`,
      ]) {
        expect(v.findings, f).toContain(f);
      }
    } finally {
      await runEngine(rt.cli, ['rm', '-f', name]);
    }
  });
});
