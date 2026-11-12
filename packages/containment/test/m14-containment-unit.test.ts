/**
 * M14 containment launcher, runtime-free parts (T-004 live-coverage prerequisites, T-010
 * process-tree egress claim, RP-06): container command parsing, engine path mapping, runtime
 * detection that reports CONTAINER_RUNTIME_ABSENT instead of passing or failing, and the
 * fail-closed verification of an engine inspect record.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  SANDBOX_SCOPE_DOMAIN,
  detectContainerRuntime,
  enginePath,
  parseContainerCli,
  verifyInspect,
  type ContainmentExpectations,
  type SelfObservation,
} from '../src/index.ts';

const tmp = mkdtempSync(join(tmpdir(), 'routespec-m14-unit-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const IMAGE = `sha256:${'a'.repeat(64)}`;
const ROOT = '/mnt/c/work/routespec';
const expectations: ContainmentExpectations = {
  imageId: IMAGE,
  readOnlyMounts: [ROOT],
  maxPids: 128,
  maxMemoryBytes: 512 * 1024 * 1024,
  tunnelPorts: [41000, 47801],
};
const self: SelfObservation = {
  uid: 1000,
  capEff: '0000000000000000',
  capPrm: '0000000000000000',
  noNewPrivs: '1',
  interfaces: ['lo'],
};

/** The fields `docker inspect` reports for a launch made by `ContainedSubject`. */
function cleanInspect(): Record<string, unknown> {
  return {
    Id: 'f'.repeat(64),
    Image: IMAGE,
    State: { Running: true },
    Config: { User: '1000:1000' },
    HostConfig: {
      NetworkMode: 'none',
      PortBindings: {},
      ExtraHosts: null,
      Dns: [],
      ReadonlyRootfs: true,
      Privileged: false,
      CapDrop: ['ALL'],
      CapAdd: null,
      SecurityOpt: ['no-new-privileges:true'],
      PidMode: '',
      IpcMode: 'private',
      UTSMode: '',
      UsernsMode: '',
      CgroupnsMode: 'private',
      PidsLimit: 128,
      Memory: 512 * 1024 * 1024,
      Init: true,
      Devices: [],
      Tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev,size=16m' },
    },
    Mounts: [{ Type: 'bind', Destination: ROOT, RW: false }],
    NetworkSettings: { Networks: { none: {} } },
  };
}

function weaken(mutate: (r: Record<string, Record<string, unknown>>) => void): Record<string, unknown> {
  const r = cleanInspect() as Record<string, Record<string, unknown>>;
  mutate(r);
  return r;
}

describe('M14 container command configuration', () => {
  it('accepts a JSON array and a plain string, and maps engine paths per style', () => {
    const plain = parseContainerCli('docker');
    expect(plain).toMatchObject({ argv: ['docker'], pathStyle: 'native' });
    expect(parseContainerCli(undefined).argv).toEqual(['docker']);
    const wsl = parseContainerCli('["wsl.exe","-d","Ubuntu-24.04","-u","root","--exec","docker"]');
    expect(wsl.pathStyle).toBe('wsl');
    expect(enginePath(wsl, 'C:\\Users\\op\\work\\routespec')).toBe('/mnt/c/Users/op/work/routespec');
    expect(enginePath(wsl, 'D:/a/b/')).toBe('/mnt/d/a/b');
    expect(enginePath(plain, '/srv/routespec')).toBe('/srv/routespec');
    expect(parseContainerCli('["podman"]', 'native').pathStyle).toBe('native');
  });

  it('rewrites the WSL shell separator to --exec so arguments are never shell-expanded', () => {
    const cli = parseContainerCli('wsl.exe -d Ubuntu-24.04 -u root -- docker');
    expect(cli.argv).toEqual(['wsl.exe', '-d', 'Ubuntu-24.04', '-u', 'root', '--exec', 'docker']);
    expect(cli.notes).toContain('WSL_SEPARATOR_REWRITTEN_TO_EXEC');
    expect(() => parseContainerCli('["wsl.exe","docker"]')).toThrow(/--exec/);
    expect(() => parseContainerCli('[]')).toThrow();
    expect(() => parseContainerCli('[1]')).toThrow();
  });
});

describe('M14 runtime detection reports NOT_RUN reasons, never a verdict', () => {
  it('an unreachable engine command is CONTAINER_RUNTIME_ABSENT', async () => {
    const r = await detectContainerRuntime({
      cli: parseContainerCli('["routespec-no-such-container-engine"]'),
      timeoutMs: 10_000,
    });
    expect(r.status).toBe('ABSENT');
    if (r.status === 'ABSENT') expect(r.reason).toBe('CONTAINER_RUNTIME_ABSENT');
  });

  it('an engine without Linux containers is unsupported and a missing image is CONTAINER_IMAGE_ABSENT', async () => {
    const fake = join(tmp, 'fake-engine.mjs');
    writeFileSync(
      fake,
      [
        'const [a, b] = process.argv.slice(2);',
        "const os = process.env.FAKE_OS ?? 'linux';",
        "if (a === 'version') { process.stdout.write(JSON.stringify({ Os: os, Version: '0.0-test' })); process.exit(0); }",
        "if (a === 'image' && b === 'inspect') process.exit(1);",
        'process.exit(2);',
      ].join('\n'),
    );
    const cli = parseContainerCli(JSON.stringify([process.execPath, fake]));
    const missing = await detectContainerRuntime({ cli, image: 'routespec/absent:1' });
    expect(missing).toMatchObject({ status: 'ABSENT', reason: 'CONTAINER_IMAGE_ABSENT' });
    process.env['FAKE_OS'] = 'windows';
    try {
      const windows = await detectContainerRuntime({ cli });
      expect(windows).toMatchObject({ status: 'ABSENT', reason: 'CONTAINER_RUNTIME_UNSUPPORTED' });
    } finally {
      delete process.env['FAKE_OS'];
    }
  });
});

describe('M14 containment verification fails closed', () => {
  it('a launch with every expectation met is PROCESS_TREE_ENFORCED with a bound scope digest', () => {
    const v = verifyInspect([cleanInspect()], expectations, self);
    expect(v.findings).toEqual([]);
    expect(v.containment).toBe('PROCESS_TREE_ENFORCED');
    expect(v.sandboxScopeDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(SANDBOX_SCOPE_DOMAIN).toBe('routespec.container-sandbox-scope/1');
    const other = verifyInspect([weaken((r) => (r['Id'] = 'e'.repeat(64) as never))], expectations, self);
    expect(other.containment).toBe('PROCESS_TREE_ENFORCED');
    expect(other.sandboxScopeDigest).not.toBe(v.sandboxScopeDigest);
  });

  it.each([
    [
      'NETWORK_NOT_NONE',
      (r: Record<string, Record<string, unknown>>) => (r['HostConfig']!['NetworkMode'] = 'bridge'),
    ],
    [
      'NETWORK_ATTACHED',
      (r: Record<string, Record<string, unknown>>) => (r['NetworkSettings']!['Networks'] = { bridge: {} }),
    ],
    [
      'PORTS_PUBLISHED',
      (r: Record<string, Record<string, unknown>>) => (r['HostConfig']!['PortBindings'] = { '80/tcp': [] }),
    ],
    [
      'ROOTFS_WRITABLE',
      (r: Record<string, Record<string, unknown>>) => (r['HostConfig']!['ReadonlyRootfs'] = false),
    ],
    ['PRIVILEGED', (r: Record<string, Record<string, unknown>>) => (r['HostConfig']!['Privileged'] = true)],
    [
      'CAPABILITIES_NOT_DROPPED',
      (r: Record<string, Record<string, unknown>>) => (r['HostConfig']!['CapDrop'] = []),
    ],
    [
      'CAPABILITIES_ADDED',
      (r: Record<string, Record<string, unknown>>) => (r['HostConfig']!['CapAdd'] = ['NET_RAW']),
    ],
    [
      'NEW_PRIVILEGES_ALLOWED',
      (r: Record<string, Record<string, unknown>>) => (r['HostConfig']!['SecurityOpt'] = []),
    ],
    [
      'SECCOMP_UNCONFINED',
      (r: Record<string, Record<string, unknown>>) =>
        (r['HostConfig']!['SecurityOpt'] = ['no-new-privileges:true', 'seccomp=unconfined']),
    ],
    [
      'HOST_PID_NAMESPACE',
      (r: Record<string, Record<string, unknown>>) => (r['HostConfig']!['PidMode'] = 'host'),
    ],
    ['PIDS_UNLIMITED', (r: Record<string, Record<string, unknown>>) => (r['HostConfig']!['PidsLimit'] = 0)],
    ['MEMORY_UNLIMITED', (r: Record<string, Record<string, unknown>>) => (r['HostConfig']!['Memory'] = 0)],
    ['NO_INIT_REAPER', (r: Record<string, Record<string, unknown>>) => (r['HostConfig']!['Init'] = false)],
    ['RUNS_AS_ROOT', (r: Record<string, Record<string, unknown>>) => (r['Config']!['User'] = '')],
    [
      'IMAGE_MISMATCH',
      (r: Record<string, Record<string, unknown>>) => ((r as Record<string, unknown>)['Image'] = 'sha256:00'),
    ],
    [
      `MOUNT_WRITABLE:${ROOT}`,
      (r: Record<string, Record<string, unknown>>) =>
        ((r as Record<string, unknown>)['Mounts'] = [{ Type: 'bind', Destination: ROOT, RW: true }]),
    ],
    [
      'ENGINE_SOCKET_MOUNTED',
      (r: Record<string, Record<string, unknown>>) =>
        ((r as Record<string, unknown>)['Mounts'] = [
          { Type: 'bind', Destination: ROOT, RW: false },
          { Type: 'bind', Destination: '/var/run/docker.sock', RW: false },
        ]),
    ],
    [
      'TMPFS_UNEXPECTED:/home',
      (r: Record<string, Record<string, unknown>>) =>
        (r['HostConfig']!['Tmpfs'] = { '/tmp': 'rw', '/home': 'rw' }),
    ],
  ])('names %s and refuses PROCESS_TREE_ENFORCED', (finding, mutate) => {
    const v = verifyInspect([weaken(mutate)], expectations, self);
    expect(v.findings).toContain(finding);
    expect(v.containment).toBe('DECLARED_HOOKS_ONLY');
  });

  it('the self-observation can only add findings; a missing record is unusable', () => {
    const caps = verifyInspect([cleanInspect()], expectations, { ...self, capEff: '00000000a80425fb' });
    expect(caps.findings).toEqual(['SELF_CAPABILITIES_PRESENT']);
    const net = verifyInspect([cleanInspect()], expectations, { ...self, interfaces: ['eth0', 'lo'] });
    expect(net.findings).toEqual(['SELF_NETWORK_INTERFACES']);
    const root = verifyInspect([cleanInspect()], expectations, { ...self, uid: 0 });
    expect(root.findings).toEqual(['SELF_RUNS_AS_ROOT']);
    expect(verifyInspect([cleanInspect()], expectations, null).findings).toEqual([
      'SELF_OBSERVATION_MISSING',
    ]);
    const none = verifyInspect(null, expectations, self);
    expect(none).toMatchObject({ containment: 'DECLARED_HOOKS_ONLY', findings: ['INSPECT_UNAVAILABLE'] });
    expect(none.sandboxScopeDigest).toBeNull();
  });
});
