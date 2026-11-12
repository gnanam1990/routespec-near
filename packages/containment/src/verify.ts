/**
 * Containment verification (M14). Pure functions over what the container engine reports
 * (`docker inspect`) and what the in-container shim observed about itself.
 *
 * `PROCESS_TREE_ENFORCED` is returned only when every expectation holds; any missing or weaker
 * setting is a named finding and the result is `DECLARED_HOOKS_ONLY` (fail closed). The engine's
 * own record is the authority; the shim's self-observation can only add findings, never remove
 * them.
 */
import { digestValue, type Digest } from '@routespec/contracts';

export const SANDBOX_SCOPE_DOMAIN = 'routespec.container-sandbox-scope/1' as const;
export const CONTAINMENT_PROFILE_REVISION = 'routespec-container-containment@1.0.0' as const;

export type Containment = 'PROCESS_TREE_ENFORCED' | 'DECLARED_HOOKS_ONLY';

export interface ContainmentExpectations {
  readonly imageId: string;
  /** Engine paths of bind mounts, all of which must be read-only. */
  readonly readOnlyMounts: readonly string[];
  readonly maxPids: number;
  readonly maxMemoryBytes: number;
  /** Ports the shim listens on in the container's own loopback (tunnel endpoints). */
  readonly tunnelPorts: readonly number[];
}

export interface SelfObservation {
  readonly uid: number | null;
  readonly capEff: string | null;
  readonly capPrm: string | null;
  readonly noNewPrivs: string | null;
  readonly interfaces: readonly string[];
  readonly node?: string;
}

export interface ContainmentVerdict {
  readonly containment: Containment;
  readonly findings: readonly string[];
  /** Digest of the observed sandbox scope (null when the inspect record is unusable). */
  readonly sandboxScopeDigest: Digest | null;
  readonly scope: Record<string, unknown> | null;
}

type J = Record<string, unknown>;
const obj = (v: unknown): J => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as J) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Verify one `docker inspect` record against the expectations. */
export function verifyInspect(
  inspect: unknown,
  expect: ContainmentExpectations,
  self: SelfObservation | null,
): ContainmentVerdict {
  const record = Array.isArray(inspect) ? inspect[0] : inspect;
  if (record === null || typeof record !== 'object') {
    return {
      containment: 'DECLARED_HOOKS_ONLY',
      findings: ['INSPECT_UNAVAILABLE'],
      sandboxScopeDigest: null,
      scope: null,
    };
  }
  const r = record as J;
  const host = obj(r['HostConfig']);
  const config = obj(r['Config']);
  const state = obj(r['State']);
  const net = obj(obj(r['NetworkSettings'])['Networks']);
  const f: string[] = [];

  if (state['Running'] !== true) f.push('CONTAINER_NOT_RUNNING');
  if (r['Image'] !== expect.imageId) f.push('IMAGE_MISMATCH');
  if (host['NetworkMode'] !== 'none') f.push('NETWORK_NOT_NONE');
  const networks = Object.keys(net).sort();
  if (networks.length !== 1 || networks[0] !== 'none') f.push('NETWORK_ATTACHED');
  if (Object.keys(obj(host['PortBindings'])).length > 0) f.push('PORTS_PUBLISHED');
  if (arr(host['ExtraHosts']).length > 0) f.push('EXTRA_HOSTS');
  if (arr(host['Dns']).length > 0) f.push('DNS_CONFIGURED');
  if (host['ReadonlyRootfs'] !== true) f.push('ROOTFS_WRITABLE');
  if (host['Privileged'] !== false) f.push('PRIVILEGED');
  const capDrop = arr(host['CapDrop']).map(String);
  if (!capDrop.includes('ALL')) f.push('CAPABILITIES_NOT_DROPPED');
  if (arr(host['CapAdd']).length > 0) f.push('CAPABILITIES_ADDED');
  const secOpt = arr(host['SecurityOpt']).map(String);
  if (!secOpt.some((s) => s === 'no-new-privileges' || s === 'no-new-privileges:true'))
    f.push('NEW_PRIVILEGES_ALLOWED');
  if (secOpt.some((s) => /^seccomp[=:]unconfined$/.test(s))) f.push('SECCOMP_UNCONFINED');
  if (secOpt.some((s) => /^apparmor[=:]unconfined$/.test(s))) f.push('APPARMOR_UNCONFINED');
  for (const [key, code] of [
    ['PidMode', 'HOST_PID_NAMESPACE'],
    ['IpcMode', 'HOST_IPC_NAMESPACE'],
    ['UTSMode', 'HOST_UTS_NAMESPACE'],
    ['UsernsMode', 'HOST_USER_NAMESPACE'],
  ] as const) {
    if (String(host[key] ?? '') === 'host') f.push(code);
  }
  if (String(host['CgroupnsMode'] ?? 'private') !== 'private') f.push('HOST_CGROUP_NAMESPACE');
  const pids = Number(host['PidsLimit'] ?? 0);
  if (!(pids > 0 && pids <= expect.maxPids)) f.push('PIDS_UNLIMITED');
  const mem = Number(host['Memory'] ?? 0);
  if (!(mem > 0 && mem <= expect.maxMemoryBytes)) f.push('MEMORY_UNLIMITED');
  if (host['Init'] !== true) f.push('NO_INIT_REAPER');
  if (arr(host['Devices']).length > 0) f.push('DEVICES_EXPOSED');
  const user = String(config['User'] ?? '');
  if (user === '' || user === '0' || user.startsWith('0:') || user === 'root') f.push('RUNS_AS_ROOT');

  const mounts = arr(r['Mounts']).map((m) => obj(m));
  const mountScope = mounts
    .map((m) => ({ type: String(m['Type']), destination: String(m['Destination']), rw: m['RW'] === true }))
    .sort((a, b) => (a.destination < b.destination ? -1 : a.destination > b.destination ? 1 : 0));
  for (const m of mountScope) {
    if (m.type === 'bind' && m.rw) f.push(`MOUNT_WRITABLE:${m.destination}`);
    if (m.type === 'volume') f.push(`VOLUME_MOUNTED:${m.destination}`);
    if (m.type === 'bind' && !expect.readOnlyMounts.includes(m.destination))
      f.push(`MOUNT_UNEXPECTED:${m.destination}`);
    if (/docker\.sock|containerd\.sock/.test(m.destination)) f.push('ENGINE_SOCKET_MOUNTED');
  }
  for (const want of expect.readOnlyMounts) {
    if (!mountScope.some((m) => m.type === 'bind' && m.destination === want)) f.push(`MOUNT_MISSING:${want}`);
  }
  const tmpfs = Object.keys(obj(host['Tmpfs'])).sort();
  for (const t of tmpfs) if (t !== '/tmp') f.push(`TMPFS_UNEXPECTED:${t}`);

  if (self === null) f.push('SELF_OBSERVATION_MISSING');
  else {
    if (self.capEff !== '0000000000000000') f.push('SELF_CAPABILITIES_PRESENT');
    if (self.capPrm !== null && self.capPrm !== '0000000000000000') f.push('SELF_CAPABILITIES_PRESENT');
    if (self.noNewPrivs !== '1') f.push('SELF_NEW_PRIVILEGES_ALLOWED');
    if (self.uid === null || self.uid === 0) f.push('SELF_RUNS_AS_ROOT');
    if (self.interfaces.length !== 1 || self.interfaces[0] !== 'lo') f.push('SELF_NETWORK_INTERFACES');
  }

  const scope = {
    profileRevision: CONTAINMENT_PROFILE_REVISION,
    engine: 'docker',
    containerId: String(r['Id'] ?? ''),
    imageId: String(r['Image'] ?? ''),
    networkMode: String(host['NetworkMode'] ?? ''),
    readonlyRootfs: host['ReadonlyRootfs'] === true,
    privileged: host['Privileged'] === true,
    capDrop: [...capDrop].sort(),
    capAdd: arr(host['CapAdd']).map(String).sort(),
    securityOpt: [...secOpt].sort(),
    pidsLimit: pids,
    memory: mem,
    init: host['Init'] === true,
    user,
    mounts: mountScope,
    tmpfs,
    tunnelPorts: [...expect.tunnelPorts].sort((a, b) => a - b),
  };
  const findings = [...new Set(f)].sort();
  return {
    containment: findings.length === 0 ? 'PROCESS_TREE_ENFORCED' : 'DECLARED_HOOKS_ONLY',
    findings,
    sandboxScopeDigest: digestValue(SANDBOX_SCOPE_DOMAIN, scope),
    scope,
  };
}
