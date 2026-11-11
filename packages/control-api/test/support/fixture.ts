/**
 * Test harness for the control API. Everything goes through real product surfaces: a real
 * `ControlServer` on a loopback socket, the M01 journal, the M02 proxy, the M03 runtime, the M04
 * kernel, the M06 gate service, and separately launched subject and launcher processes. Raw
 * `node:http` requests are used so the tests control every header a browser could send.
 */
import { fork, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADAPTER_HEADERS, digestValue } from '@routespec/contracts';
import { CORE_SCENARIO_SOURCES } from '@routespec/scenario';
import { RouteSpecStore } from '@routespec/store';
import {
  ControlServer,
  fileDigest,
  type ControlServerOptions,
  type LocalConfirmationNotice,
} from '../../src/index.ts';

export const PREFIX = '/__routespec/v1';

export function d(label: string): string {
  return digestValue('routespec.test.digest/1', label);
}

export function tempDir(prefix = 'routespec-m08-'): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  };
}

export class ManualClock {
  offsetMs = 0;
  nowMs(): number {
    return Date.now() + this.offsetMs;
  }
  advance(ms: number): void {
    this.offsetMs += ms;
  }
}

export interface Reply {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly text: string;
  readonly json: Record<string, unknown> | null;
}

export interface RawRequest {
  readonly method: string;
  readonly path: string;
  readonly headers?: Record<string, string>;
  readonly body?: string | Buffer;
  /** Omit the Host header entirely when null; default is the server's own origin host. */
  readonly host?: string | null;
}

export function raw(port: number, r: RawRequest): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...(r.headers ?? {}) };
    if (r.host !== null) headers['host'] = r.host ?? `127.0.0.1:${port}`;
    if (r.body !== undefined) headers['content-length'] = String(Buffer.byteLength(r.body));
    const req = httpRequest(
      { host: '127.0.0.1', port, method: r.method, path: r.path, headers, setHost: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: Record<string, unknown> | null = null;
          try {
            json = JSON.parse(text) as Record<string, unknown>;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
        });
      },
    );
    req.on('error', reject);
    if (r.body !== undefined) req.write(r.body);
    req.end();
  });
}

let keyCounter = 0;
export function key(label = 'k'): string {
  keyCounter++;
  return `${label}-${process.pid}-${keyCounter}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface Harness {
  readonly server: ControlServer;
  readonly store: RouteSpecStore;
  readonly port: number;
  readonly token: string;
  readonly clock: ManualClock;
  readonly dir: string;
  readonly confirmations: LocalConfirmationNotice[];
  api(
    method: string,
    path: string,
    body?: unknown,
    opts?: {
      idem?: string | null;
      ifMatch?: number;
      headers?: Record<string, string>;
      token?: string | null;
    },
  ): Promise<Reply>;
  tableCounts(): Record<string, number>;
  close(): Promise<void>;
}

export async function startHarness(
  options: Partial<ControlServerOptions> & { label?: string } = {},
): Promise<Harness> {
  const tmp = tempDir();
  const clock = new ManualClock();
  const store = RouteSpecStore.open({ path: join(tmp.dir, 'journal.db'), clock });
  const confirmations: LocalConfirmationNotice[] = [];
  const server = await ControlServer.start({
    store,
    onLocalConfirmation: (n) => confirmations.push(n),
    dataDirectory: tmp.dir,
    ...options,
  });
  const port = server.port;
  const token = server.token.reveal();
  const api: Harness['api'] = (method, path, body, opts = {}) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.token !== null) headers['authorization'] = `Bearer ${opts.token ?? token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (method !== 'GET' && opts.idem !== null) headers['idempotency-key'] = opts.idem ?? key();
    if (opts.ifMatch !== undefined) headers['if-match'] = `"${opts.ifMatch}"`;
    return raw(port, {
      method,
      path: `${PREFIX}${path}`,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  };
  const tableCounts = () =>
    Object.fromEntries(
      (
        store.journal.read((db) =>
          db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all(),
        ) as Array<{ name: string }>
      )
        .filter((t) => !t.name.startsWith('sqlite_'))
        .map((t) => [t.name, store.countRows(t.name)]),
    );
  return {
    server,
    store,
    port,
    token,
    clock,
    dir: tmp.dir,
    confirmations,
    api,
    tableCounts,
    close: async () => {
      await server.close();
      store.close();
      tmp.cleanup();
    },
  };
}

export function expectOk(r: Reply, status: number | number[] = [200, 201]): Record<string, unknown> {
  const allowed = Array.isArray(status) ? status : [status];
  if (!allowed.includes(r.status)) throw new Error(`unexpected ${r.status}: ${r.text.slice(0, 600)}`);
  return r.json as Record<string, unknown>;
}

export function errorCode(r: Reply): string | null {
  const e = (r.json?.['error'] as { code?: string } | undefined)?.code;
  return e ?? null;
}

// ---------------------------------------------------------------------------------------------
// A complete project assembled through the API.

export const SUBJECT_SCRIPT = fileURLToPath(
  new URL('../../../proxy/test/support/subject-client.ts', import.meta.url),
);

export interface ProjectSetup {
  readonly projectId: string;
  readonly integrationRevisionId: string;
  readonly buildRevisionId: string;
  readonly artifactDigest: string;
  readonly manifestDigest: string;
  readonly policyDigest: string;
  readonly scenarioRevisionId: string;
  readonly corpusRevisionId: string;
  readonly gateId: string;
}

export async function setupProject(
  h: Pick<Harness, 'api'>,
  label: string,
  scenario = 'happy-path',
): Promise<ProjectSetup> {
  const p = expectOk(await h.api('POST', '/projects', { name: `project ${label}` }), 201);
  const projectId = String(p['projectId']);
  const rev = expectOk(
    await h.api('POST', `/projects/${projectId}/revisions`, {
      revisionLabel: `${label}-r1`,
      commitSha: null,
      configurationDigest: d(`config-${label}`),
      protocolProfileId: 'oneclick-v0@1.0.0',
      metadata: {},
    }),
    201,
  );
  const integrationRevisionId = String(rev['integrationRevisionId']);
  const artifactDigest = fileDigest(SUBJECT_SCRIPT);
  const build = expectOk(
    await h.api('POST', `/projects/${projectId}/builds`, {
      integrationRevisionId,
      repositoryLocator: `git+file:subject/${label}`,
      commitSha: 'a'.repeat(40),
      dirtyTreeDigest: null,
      artifactDigest,
      toolchainDigest: d('toolchain'),
      lockDigest: d('lock'),
      effectManifestDigest: d(`manifest-${label}`),
      launchRecipeDigest: d('recipe'),
      ciWorkflowRunId: null,
    }),
    201,
  );
  const buildRevisionId = String(build['buildRevisionId']);
  const manifest = expectOk(
    await h.api('POST', '/effect-manifests', {
      projectId,
      buildRevisionId,
      artifactDigest,
      adapterRevision: 'routespec-adapter@1.0.0',
      hooks: [
        {
          hookId: 'fulfilment',
          hookRevision: '1',
          effectType: 'DELIVER_GOODS',
          sinkClass: 'fulfilment-webhook',
          sourceLocatorDigest: null,
          mechanism: 'subject-hook',
          scenarioSelectors: ['*'],
          coverageExpectation: 'REQUIRED',
        },
      ],
    }),
    201,
  );
  const manifestDigest = String(manifest['manifestDigest']);
  const sc = expectOk(
    await h.api('POST', '/scenarios', { projectId, source: CORE_SCENARIO_SOURCES[scenario] }),
    201,
  );
  const scenarioRevisionId = String(sc['scenarioRevisionId']);
  const corpus = expectOk(
    await h.api('POST', '/corpora', {
      projectId,
      label: `corpus-${label}`,
      cases: [
        {
          scenarioRevisionId,
          requiredInvariants: ['INV-01', 'INV-02', 'INV-03', 'INV-05'],
          severity: 'HIGH',
          gatePolicy: 'REQUIRED',
        },
      ],
    }),
    201,
  );
  const corpusRevisionId = String(corpus['corpusRevisionId']);
  const policy = expectOk(
    await h.api('POST', '/effect-coverage-policies', {
      projectId,
      buildRevisionId,
      artifactDigest,
      selectedAttestationId: null,
      scenarioRevisionId,
      manifestDigest,
      requiredSinkClasses: ['fulfilment-webhook'],
      interceptorProfileDigest: null,
      callsiteInventoryDigest: null,
      basis: 'DECLARED_HOOKS_ONLY',
    }),
    201,
  );
  const gate = expectOk(
    await h.api('POST', '/gates', {
      projectId,
      name: `gate ${label}`,
      corpusRevisionId,
      enforcementMode: 'LOCAL_ADVISORY',
      buildAttestationPolicy: 'ALLOW_USER_ASSERTED',
    }),
    201,
  );
  return {
    projectId,
    integrationRevisionId,
    buildRevisionId,
    artifactDigest,
    manifestDigest,
    policyDigest: String(policy['policyDigest']),
    scenarioRevisionId,
    corpusRevisionId,
    gateId: String(gate['gateId']),
  };
}

export function gateRunBody(p: ProjectSetup, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    projectId: p.projectId,
    gateId: p.gateId,
    buildRevisionId: p.buildRevisionId,
    artifactDigest: p.artifactDigest,
    corpusRevisionId: p.corpusRevisionId,
    effectManifestDigest: p.manifestDigest,
    effectCoveragePolicyDigest: p.policyDigest,
    callsiteInventoryDigest: null,
    interceptorProfileDigest: null,
    buildAttestation: { class: 'USER_ASSERTED_LOCAL' },
    mode: 'SIMULATE',
    maxParallelCases: 2,
    ...extra,
  };
}

/** Create, validate, and start a gate run; return its first case run id. */
export async function startedGateRun(
  h: Pick<Harness, 'api'>,
  p: ProjectSetup,
  extra: Record<string, unknown> = {},
): Promise<{ gateRunId: string; caseRunId: string; proxyBaseUrl: string }> {
  const g = expectOk(await h.api('POST', '/gate-runs', gateRunBody(p, extra)), 201);
  const gateRunId = String(g['gateRunId']);
  const v = expectOk(
    await h.api('POST', `/gate-runs/${gateRunId}/validate`, {}, { ifMatch: Number(g['revision']) }),
    200,
  );
  const vr = v['gateRun'] as Record<string, unknown>;
  const s = expectOk(
    await h.api('POST', `/gate-runs/${gateRunId}/start`, {}, { ifMatch: Number(vr['revision']) }),
    200,
  );
  const cases = expectOk(await h.api('GET', `/gate-runs/${gateRunId}/cases`), 200);
  const first = (cases['items'] as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
  return { gateRunId, caseRunId: String(first['caseRunId']), proxyBaseUrl: String(s['proxyBaseUrl']) };
}

// ---------------------------------------------------------------------------------------------
// Separately launched subject: the pinned official SDK with the RouteSpec adapter (M02 harness).

export class Subject {
  readonly child: ChildProcess;
  private constructor(child: ChildProcess) {
    this.child = child;
  }
  static async launch(): Promise<Subject> {
    const child = fork(SUBJECT_SCRIPT, [], {
      execArgv: ['--no-warnings'],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    const s = new Subject(child);
    await s.wait('loaded');
    return s;
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
            reject(new Error(`subject error ${String(msg['code'])} ${String(msg['message'])}`));
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
  attach(origin: string, start: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.send({ type: 'attach', origin, credentials: credentialsOf(start, 'EXECUTION') });
  }
  call(
    op: 'getQuote' | 'submitDepositTx' | 'getExecutionStatus',
    ...args: unknown[]
  ): Promise<Record<string, unknown>> {
    return this.send({ type: 'call', op, args });
  }
  async close(): Promise<void> {
    if (this.child.exitCode !== null) return;
    await this.send({ type: 'detach' }).catch(() => undefined);
    await new Promise<void>((r) => (this.child.exitCode !== null ? r() : this.child.once('exit', () => r())));
  }
}

export function credentialsOf(
  start: Record<string, unknown>,
  purpose: 'EXECUTION' | 'RECONCILIATION_ONLY',
  clientInstanceId?: string,
): Record<string, unknown> {
  const token = start['token'] as { value: string };
  return {
    purpose,
    token: token.value,
    sessionId: start['sessionId'] ?? (start as { sessionId?: string }).sessionId,
    caseRunId: start['caseRunId'],
    adapterRevision: 'routespec-adapter@1.0.0',
    fencingEpoch: start['fencingEpoch'],
    clientInstanceId: clientInstanceId ?? start['clientInstanceId'],
  };
}

export function quoteBody(): Record<string, unknown> {
  return {
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
}

/** Headers a subject would send for a direct (non-SDK) call to the subject observer route. */
export function caseHeaders(start: Record<string, unknown>, token?: string): Record<string, string> {
  const h = ADAPTER_HEADERS;
  return {
    [h.caseToken]: token ?? (start['token'] as { value: string }).value,
    [h.session]: String(start['sessionId']),
    [h.caseRun]: String(start['caseRunId']),
    [h.adapter]: 'routespec-adapter@1.0.0',
    [h.fencingEpoch]: String(start['fencingEpoch']),
    [h.clientInstance]: String(start['clientInstanceId']),
    [h.requestId]: `tr-${Math.random().toString(36).slice(2, 14)}`,
  };
}

// ---------------------------------------------------------------------------------------------
// Launcher keys and scripts.

export const LAUNCHER_SCRIPT = fileURLToPath(new URL('./launcher.ts', import.meta.url));

export function launcherKeyFile(
  dir: string,
  name: string,
): { path: string; publicJwk: Record<string, unknown>; privateKey: KeyObject } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const path = join(dir, `${name}.pem`);
  writeFileSync(path, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  return { path, publicJwk: { kty: jwk['kty'], crv: jwk['crv'], x: jwk['x'] }, privateKey };
}

/** Enroll a principal through the two-step local confirmation flow. */
export async function enroll(
  h: Harness,
  projectId: string,
  label: string,
  policy: Record<string, unknown>,
): Promise<string> {
  const first = expectOk(await h.api('POST', '/attester-principals', { projectId, label, policy }), 202);
  const notice = h.confirmations.find((n) => n.confirmationId === first['confirmationId']);
  if (!notice) throw new Error('no local confirmation delivered');
  const done = expectOk(
    await h.api('POST', '/attester-principals', {
      projectId,
      label,
      policy,
      confirmation: { confirmationId: notice.confirmationId, code: notice.code },
    }),
    201,
  );
  return String(done['principalId']);
}

// ---------------------------------------------------------------------------------------------
// The control service in its own process.

export interface RemoteHarness {
  readonly port: number;
  readonly token: string;
  readonly child: ChildProcess;
  api: Harness['api'];
  stop(): Promise<void>;
}

const CONTROL_CHILD = fileURLToPath(new URL('./control-child.ts', import.meta.url));

export async function startChildServer(dataDir: string): Promise<RemoteHarness> {
  const child = fork(CONTROL_CHILD, [dataDir], {
    execArgv: ['--no-warnings'],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const ready = await new Promise<{ port: number; token: string }>((resolve, reject) => {
    child.once('exit', (code) => reject(new Error(`control child exited ${code}`)));
    child.once('message', (m) => resolve(m as { port: number; token: string }));
  });
  const api: Harness['api'] = (method, path, body, opts = {}) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.token !== null) headers['authorization'] = `Bearer ${opts.token ?? ready.token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (method !== 'GET' && opts.idem !== null) headers['idempotency-key'] = opts.idem ?? key();
    if (opts.ifMatch !== undefined) headers['if-match'] = `"${opts.ifMatch}"`;
    return raw(ready.port, {
      method,
      path: `${PREFIX}${path}`,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  };
  return {
    port: ready.port,
    token: ready.token,
    child,
    api,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once('exit', () => resolve());
        child.send({ type: 'stop' });
      }),
  };
}
