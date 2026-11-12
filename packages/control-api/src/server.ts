/**
 * Loopback control service (M08): authenticated local control API plus the same-origin console.
 *
 * Request pipeline, in order (a refused request never reaches a handler and writes nothing):
 *   1. rate limit (fixed windows per request class, separate budget for failed authentication);
 *   2. Host / Origin / Fetch-Metadata boundary (DNS rebinding, cross-site, CSRF);
 *   3. static console assets (GET/HEAD only, strict CSP) for non-API paths;
 *   4. authentication: control bearer token, or the case token on the one subject route;
 *   5. route and method match (unknown routes are 404 only after authentication);
 *   6. bounded strict JSON body, strict schema, `Idempotency-Key` and `If-Match` preconditions;
 *   7. idempotent execution: PENDING marker, handler, COMPLETE with a redacted response.
 *
 * The service never sends `Access-Control-Allow-Origin` for a foreign origin, never accepts
 * credentials from a URL or cookie, and never binds a non-loopback address.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { RouteSpecError, canonicalJson } from '@routespec/contracts';
import type { LaunchCredentials } from '@routespec/proxy';
import { GateService, Logger } from '@routespec/runner';
import {
  ControlJournal,
  GateJournal,
  ImportJournal,
  persistedSecretRule,
  registerConfiguredSecrets,
  type RouteSpecStore,
} from '@routespec/store';
import { launcherArtifactDigest } from '@routespec/containment';
import { AttesterChannel } from './attestation.ts';
import { ContainmentHost, type ContainmentConfig } from './containment-host.ts';
import { CursorCodec } from './cursor.ts';
import { BASE_HEADERS, readJsonBody, safeError, writeError, writeJson, assertNoBody } from './http.ts';
import { buildRoutes, caseAuthFromHeaders, type LocalConfirmationNotice, type RouteDef } from './routes.ts';
import { parseBody } from './schemas.ts';
import {
  CONSOLE_CSP,
  CONTROL_PREFIX,
  ControlToken,
  assertLoopbackBind,
  assertNoQueryCredential,
  authenticate,
  checkBrowserBoundary,
  originPolicy,
  type LoopbackBindAddress,
  type OriginPolicy,
} from './security.ts';

export const CONTROL_API_REVISION = 'routespec-control-api@1.0.0' as const;

export interface RateLimits {
  readonly windowMs: number;
  readonly reads: number;
  readonly mutations: number;
  readonly authFailures: number;
}

export interface ControlServerOptions {
  readonly store: RouteSpecStore;
  readonly host?: string;
  readonly port?: number;
  readonly consoleDir?: string | null;
  readonly controlToken?: ControlToken;
  readonly onLocalConfirmation?: (notice: LocalConfirmationNotice) => void;
  readonly leaseTtlMs?: number;
  readonly tokenTtlMs?: number;
  readonly confirmationTtlMs?: number;
  readonly challengeTtlMs?: number;
  readonly rateLimits?: Partial<RateLimits>;
  readonly dataDirectory?: string;
  readonly maxBodyBytes?: number;
  /** Connection limits (M11, NFR-06): slow-client and flood bounds. */
  readonly limits?: Partial<ConnectionLimits>;
  /**
   * Local structured log sink (one JSON line per call; NFR-09). Lines carry codes and shortened
   * identifiers only; nothing leaves the machine. Default: no log.
   */
  readonly logSink?: (line: string) => void;
  /**
   * Configured secret values (memory only; M11, INV-11). The service refuses any request value
   * that contains one, the journal refuses to persist one, the proxy rejects one, imports record
   * it as a finding, exports block on it, and logs redact it. Each needs >= 8 characters.
   */
  readonly configuredSecrets?: readonly string[];
  /**
   * Container containment for subject cases (M14). Absent: `contained-start` answers
   * RS_CONTAINMENT_UNAVAILABLE with reason CONTAINER_RUNTIME_ABSENT.
   */
  readonly containment?: ContainmentConfig | null;
  /**
   * Reviewed launcher the host may fork for an enrolled LOCAL_LAUNCHER_KEY principal whose
   * enrolled launcher digest equals this script's measured digest (M14). The arguments name the
   * operator's key file and similar non-secret paths; the service never reads the key.
   */
  readonly launcher?: { readonly script: string; readonly args: readonly string[] } | null;
}

export interface ConnectionLimits {
  /** Time allowed to receive the complete request head. */
  readonly headersTimeoutMs: number;
  /** Time allowed to receive the complete request, body included. */
  readonly requestTimeoutMs: number;
  /** Idle time before a kept-alive connection is closed. */
  readonly keepAliveTimeoutMs: number;
  /** Concurrent TCP connections; further connections are closed on accept. */
  readonly maxConnections: number;
}

export const DEFAULT_CONNECTION_LIMITS: ConnectionLimits = Object.freeze({
  headersTimeoutMs: 10_000,
  requestTimeoutMs: 30_000,
  keepAliveTimeoutMs: 5_000,
  maxConnections: 128,
});

export interface ControlMetrics {
  readonly refused: Record<string, number>;
  readonly handled: number;
  readonly replays: number;
}

interface CompiledRoute {
  readonly def: RouteDef;
  readonly regex: RegExp;
  readonly names: readonly string[];
}

const PARAM_PATTERN: Record<string, string> = {
  profileId: '[A-Za-z0-9@._-]{1,64}',
};
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

function compile(def: RouteDef): CompiledRoute {
  const names: string[] = [];
  const source = def.path.replace(/:([A-Za-z]+)/g, (_m, name: string) => {
    names.push(name);
    return `(${PARAM_PATTERN[name] ?? UUID})`;
  });
  return { def, regex: new RegExp(`^${source}$`), names };
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

class Windows {
  #start = 0;
  #counts = new Map<string, number>();
  readonly limits: RateLimits;
  readonly now: () => number;
  constructor(limits: RateLimits, now: () => number) {
    this.limits = limits;
    this.now = now;
  }
  take(bucket: 'reads' | 'mutations' | 'authFailures'): boolean {
    const t = this.now();
    if (t - this.#start >= this.limits.windowMs) {
      this.#start = t;
      this.#counts.clear();
    }
    const n = (this.#counts.get(bucket) ?? 0) + 1;
    this.#counts.set(bucket, n);
    return n <= this.limits[bucket];
  }
  exhausted(bucket: 'authFailures'): boolean {
    const t = this.now();
    if (t - this.#start >= this.limits.windowMs) return false;
    return (this.#counts.get(bucket) ?? 0) >= this.limits[bucket];
  }
}

function methodLabel(method: string | undefined): string {
  return method !== undefined && /^[A-Z]{1,10}$/.test(method) ? method : 'OTHER';
}

/**
 * Effect-coverage gaps currently recorded in the journal (tracked, never hidden): interceptor
 * findings by kind, interceptor instances without process-tree containment, and coverage
 * policies that rely on declared hooks only. Each of these keeps complete-effect coverage REVIEW.
 */
export function effectCoverageGaps(store: RouteSpecStore): Record<string, number> {
  return store.journal.read((db) => {
    const out: Record<string, number> = {};
    for (const r of db
      .prepare('SELECT kind, count(*) AS n FROM effect_coverage_findings GROUP BY kind ORDER BY kind')
      .all() as Array<{ kind: string; n: number }>)
      out[`finding_${r.kind.toLowerCase()}`] = r.n;
    out['interceptors_declared_hooks_only'] = (
      db
        .prepare("SELECT count(*) AS n FROM interceptor_channels WHERE containment = 'DECLARED_HOOKS_ONLY'")
        .get() as { n: number }
    ).n;
    out['policies_declared_hooks_only'] = (
      db
        .prepare("SELECT count(*) AS n FROM effect_coverage_policies WHERE basis = 'DECLARED_HOOKS_ONLY'")
        .get() as { n: number }
    ).n;
    return out;
  });
}

function parseIfMatch(value: string | undefined): number | null {
  if (value === undefined) return null;
  const m = /^(?:W\/)?"(\d{1,9})"$|^(\d{1,9})$/.exec(value.trim());
  if (!m)
    throw new RouteSpecError('RS_PRECONDITION_REQUIRED', 'If-Match must carry the expected record revision.');
  return Number(m[1] ?? m[2]);
}

export class ControlServer {
  readonly store: RouteSpecStore;
  readonly control: ControlJournal;
  readonly service: GateService;
  readonly token: ControlToken;
  readonly host: LoopbackBindAddress;
  readonly metrics = { refused: {} as Record<string, number>, handled: 0, replays: 0, connectionsDropped: 0 };
  readonly connectionLimits: ConnectionLimits;
  readonly logger: Logger;
  readonly #secrets: readonly string[];
  readonly #unregisterSecrets: () => void;
  #open = 0;
  readonly #server: Server;
  readonly #routes: CompiledRoute[];
  readonly #launchers = new Map<string, AttesterChannel>();
  readonly #launcherConfig: { readonly script: string; readonly args: readonly string[] } | null;
  readonly containment: ContainmentHost;
  readonly #pending = new Map<string, LaunchCredentials>();
  readonly #limits: Windows;
  readonly #consoleDir: string | null;
  readonly #maxBody: number;
  #policy: OriginPolicy | null = null;

  private constructor(options: ControlServerOptions, host: LoopbackBindAddress) {
    this.store = options.store;
    this.host = host;
    this.control = new ControlJournal(this.store);
    this.token = options.controlToken ?? new ControlToken();
    this.#consoleDir = options.consoleDir ? resolve(options.consoleDir) : null;
    this.#maxBody = options.maxBodyBytes ?? 262_144;
    const secrets = Object.freeze([...(options.configuredSecrets ?? [])]);
    this.#secrets = secrets;
    this.#unregisterSecrets = registerConfiguredSecrets(secrets);
    this.logger = new Logger({
      configuredSecrets: secrets,
      ...(options.logSink ? { sink: options.logSink } : {}),
    });
    this.service = new GateService(this.store, {
      logger: this.logger,
      configuredSecrets: secrets,
      ...(options.leaseTtlMs !== undefined ? { leaseTtlMs: options.leaseTtlMs } : {}),
      ...(options.tokenTtlMs !== undefined ? { tokenTtlMs: options.tokenTtlMs } : {}),
      ...(options.dataDirectory !== undefined ? { dataDirectory: options.dataDirectory } : {}),
      onCredentials: (caseRunId, credentials) => {
        // A contained subject receives re-issued authority over its private channel only.
        if (this.containment?.deliverCredentials(caseRunId, credentials)) return;
        if (credentials.purpose === 'RECONCILIATION_ONLY') this.#pending.set(caseRunId, credentials);
      },
    });
    this.#launcherConfig = options.launcher ?? null;
    this.containment = new ContainmentHost({
      store: this.store,
      control: this.control,
      service: this.service,
      config: options.containment ?? null,
      launcherFor: (principalId) => this.launcherFor(principalId),
      challengeTtlMs: options.challengeTtlMs ?? 300_000,
    });
    this.#limits = new Windows(
      {
        windowMs: options.rateLimits?.windowMs ?? 10_000,
        reads: options.rateLimits?.reads ?? 2_000,
        mutations: options.rateLimits?.mutations ?? 500,
        authFailures: options.rateLimits?.authFailures ?? 50,
      },
      () => Date.now(),
    );
    const notify =
      options.onLocalConfirmation ??
      ((n: LocalConfirmationNotice) => {
        process.stderr.write(
          `routespec: local confirmation for ${n.actionCode} (${n.summary}): id=${n.confirmationId} code=${n.code} expires=${n.expiresAt}\n`,
        );
      });
    this.#routes = buildRoutes({
      store: this.store,
      control: this.control,
      gates: new GateJournal(this.store),
      imports: new ImportJournal(this.store),
      service: this.service,
      cursors: new CursorCodec(),
      appRevision: CONTROL_API_REVISION,
      nowMs: () => this.store.clock.nowMs(),
      bind: { host, port: () => this.port },
      launchers: this.#launchers,
      launcherFor: (principalId: string) => this.launcherFor(principalId),
      containment: this.containment,
      pendingCredentials: this.#pending,
      onLocalConfirmation: notify,
      confirmationTtlMs: options.confirmationTtlMs ?? 120_000,
      challengeTtlMs: options.challengeTtlMs ?? 300_000,
      metrics: () => this.metricsSnapshot(),
      configuredSecrets: secrets,
    }).map(compile);
    const limits = { ...DEFAULT_CONNECTION_LIMITS, ...(options.limits ?? {}) };
    this.connectionLimits = Object.freeze(limits);
    this.#server = createServer(
      {
        maxHeaderSize: 16_384,
        headersTimeout: limits.headersTimeoutMs,
        requestTimeout: limits.requestTimeoutMs,
        keepAliveTimeout: limits.keepAliveTimeoutMs,
        // Node checks the two timeouts on this interval (default 30 s), so a slow client would
        // otherwise outlive its timeout by up to 30 s.
        connectionsCheckingInterval: Math.max(100, Math.min(1_000, Math.floor(limits.headersTimeoutMs / 2))),
      },
      (req, res) => {
        void this.#handle(req, res);
      },
    );
    this.#server.maxConnections = limits.maxConnections;
    this.#server.maxRequestsPerSocket = 1_000;
    this.#server.on('drop', () => {
      this.metrics.connectionsDropped++;
    });
    this.#server.on('timeout', (socket: Socket) => socket.destroy());
    this.#server.on('connection', (socket: Socket) => {
      this.#open++;
      socket.once('close', () => this.#open--);
    });
  }

  /** Bounded, coded, local-only metrics (NFR-09). Never contains a request value or credential. */
  metricsSnapshot(): Record<string, unknown> {
    const mem = process.memoryUsage();
    return {
      telemetry: 'OFF',
      revision: CONTROL_API_REVISION,
      refused: { ...this.metrics.refused },
      handled: this.metrics.handled,
      replays: this.metrics.replays,
      connections: { open: this.#open, dropped: this.metrics.connectionsDropped },
      limits: { ...this.connectionLimits, maxBodyBytes: this.#maxBody },
      process: {
        rssBytes: mem.rss,
        heapUsedBytes: mem.heapUsed,
        uptimeSeconds: Math.round(process.uptime()),
      },
      runner: this.service.logger.metrics.snapshot(),
      proxy: this.service.proxyStats(),
      effectCoverageGaps: effectCoverageGaps(this.store),
    };
  }

  static async start(options: ControlServerOptions): Promise<ControlServer> {
    const host = options.host ?? '127.0.0.1';
    assertLoopbackBind(host);
    const s = new ControlServer(options, host);
    await new Promise<void>((resolveListen, reject) => {
      s.#server.once('error', reject);
      s.#server.listen({ host, port: options.port ?? 0, exclusive: true }, () => resolveListen());
    });
    const addr = s.#server.address() as AddressInfo;
    if (addr.address !== host) {
      await s.close();
      throw new RouteSpecError('RS_MODE_POLICY_DENIED', 'The listener is not bound to the loopback address.');
    }
    s.#policy = originPolicy(host, addr.port);
    return s;
  }

  get port(): number {
    return (this.#server.address() as AddressInfo).port;
  }

  get origin(): string {
    return (this.#policy as OriginPolicy).primaryOrigin;
  }

  /** One-time console hand-off URL; the token travels only in the fragment (never sent to a server). */
  consoleUrl(): string {
    return `${this.origin}/#token=${encodeURIComponent(this.token.reveal())}`;
  }

  /** Attach a reviewed launcher process for a LOCAL_LAUNCHER_KEY principal (host-side only). */
  attachLauncher(principalId: string, scriptPath: string, args: readonly string[] = []): AttesterChannel {
    const channel = AttesterChannel.launch(this.control, scriptPath, args);
    this.#launchers
      .get(principalId)
      ?.close()
      .catch(() => undefined);
    this.#launchers.set(principalId, channel);
    return channel;
  }

  /**
   * The launcher channel of a principal: an attached one, or the configured reviewed launcher
   * forked on demand when its measured digest equals the principal's enrolled launcher digest.
   */
  launcherFor(principalId: string): AttesterChannel | undefined {
    const existing = this.#launchers.get(principalId);
    if (existing && existing.child.exitCode === null && existing.child.connected) return existing;
    const cfg = this.#launcherConfig;
    if (cfg === null) return existing;
    const p = this.control.getPrincipal(principalId);
    if (!p || p.principal['kind'] !== 'LOCAL_LAUNCHER_KEY' || p.principal['enabled'] !== 1) return undefined;
    if (p.policy['launcherArtifactDigest'] !== launcherArtifactDigest(cfg.script)) return undefined;
    const channel = AttesterChannel.launch(this.control, cfg.script, cfg.args, launcherArtifactDigest);
    this.#launchers.set(principalId, channel);
    return channel;
  }

  async close(): Promise<void> {
    await this.containment.closeAll().catch(() => undefined);
    this.#unregisterSecrets();
    for (const l of this.#launchers.values()) await l.close().catch(() => undefined);
    this.#launchers.clear();
    await this.service.close();
    await new Promise<void>((r) => {
      this.#server.close(() => r());
      this.#server.closeAllConnections();
    });
  }

  #refuse(req: IncomingMessage, res: ServerResponse, error: RouteSpecError, requestId: string): void {
    this.metrics.refused[error.code] = (this.metrics.refused[error.code] ?? 0) + 1;
    const socket = req.socket;
    if (!req.complete && socket) {
      // Never drain an unread or over-limit body (an endless chunked upload would otherwise be
      // read until the request timeout). Answer, half-close so the client can read the answer,
      // and destroy the connection shortly after (bounded lingering close).
      res.shouldKeepAlive = false;
      res.once('finish', () => {
        socket.end();
        setTimeout(() => socket.destroy(), 1_000).unref();
      });
    }
    writeError(res, error, requestId);
    this.logger.warn('control.refused', { details: { code: error.code, method: methodLabel(req.method) } });
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = randomUUID();
    const policy = this.#policy;
    try {
      if (policy === null) throw new RouteSpecError('RS_STORAGE_UNAVAILABLE', 'The service is starting.');
      const method = req.method ?? 'GET';
      const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(method);
      if (!this.#limits.take(mutating ? 'mutations' : 'reads') || this.#limits.exhausted('authFailures')) {
        req.resume();
        throw new RouteSpecError('RS_RATE_LIMITED', 'Too many requests; retry later.', { recoverable: true });
      }
      checkBrowserBoundary(req, policy);
      const url = new URL(req.url ?? '/', policy.primaryOrigin);
      if (method === 'OPTIONS') {
        // Same-origin pages never need a preflight; foreign origins were already refused.
        req.resume();
        throw new RouteSpecError('RS_METHOD_NOT_ALLOWED', 'Preflight requests are not served.');
      }
      if (url.pathname !== CONTROL_PREFIX && !url.pathname.startsWith(`${CONTROL_PREFIX}/`)) {
        this.#static(req, res, url, method);
        return;
      }
      assertNoQueryCredential(url);
      const sub = url.pathname.slice(CONTROL_PREFIX.length) || '/';
      const matches = this.#routes
        .map((r) => ({ r, m: r.regex.exec(sub) }))
        .filter((x): x is { r: CompiledRoute; m: RegExpExecArray } => x.m !== null);
      const match = matches.find((x) => x.r.def.method === method) ?? null;
      if (match?.r.def.auth === 'case') {
        // The single subject route: a case token, never a control bearer token.
      } else {
        try {
          authenticate(req, this.token);
        } catch (error) {
          this.#limits.take('authFailures');
          req.resume();
          throw error;
        }
      }
      if (match === null) {
        req.resume();
        if (matches.length > 0)
          throw new RouteSpecError('RS_METHOD_NOT_ALLOWED', 'Method not allowed for this route.');
        throw new RouteSpecError('RS_NOT_FOUND', 'Route not found.');
      }
      const def = match.r.def;
      const params = Object.fromEntries(match.r.names.map((n, i) => [n, match.m[i + 1] as string]));
      const caseAuth = def.auth === 'case' ? caseAuthFromHeaders(req.headers, this.store) : null;
      let rawBody: unknown = undefined;
      if (def.schema !== undefined) rawBody = await readJsonBody(req, def.maxBody ?? this.#maxBody);
      else assertNoBody(req);
      const idempotencyKey = def.mutation ? this.#idempotencyKey(req) : null;
      this.#refuseSecrets(def, url, rawBody, idempotencyKey);
      const ifMatch = def.ifMatch === true ? parseIfMatch(this.#single(req, 'if-match')) : null;
      if (def.ifMatch === true && ifMatch === null) {
        throw new RouteSpecError(
          'RS_PRECONDITION_REQUIRED',
          'This update requires If-Match with the expected revision.',
        );
      }
      const body = def.schema !== undefined ? parseBody(def.schema, rawBody) : undefined;
      const ctx = { params, body, query: url.searchParams, ifMatch, idempotencyKey, caseAuth };
      if (!def.mutation) {
        const r = await def.handle(ctx);
        this.metrics.handled++;
        writeJson(res, r.status, r.body, { 'x-request-id': requestId });
        return;
      }
      const scope = `${def.method} ${def.path} ${canonicalJson(params)}`;
      const start = this.control.beginIdempotent(scope, idempotencyKey as string, { body: rawBody, ifMatch });
      if (start.state === 'REPLAY') {
        this.metrics.replays++;
        writeJson(res, start.status, start.body, { 'x-request-id': requestId, 'idempotent-replay': 'true' });
        return;
      }
      let result;
      try {
        result = await def.handle(ctx);
      } catch (error) {
        this.control.abandonIdempotent(scope, idempotencyKey as string);
        throw error;
      }
      let recorded = 'true';
      try {
        this.control.completeIdempotent(
          scope,
          idempotencyKey as string,
          result.status,
          result.record ?? result.body,
        );
      } catch {
        // The mutation has happened; the caller must still learn its outcome. The key stays
        // PENDING, so a retry reports the outcome as unknown instead of re-executing it.
        recorded = 'false';
      }
      this.metrics.handled++;
      writeJson(res, result.status, result.body, {
        'x-request-id': requestId,
        'idempotency-recorded': recorded,
      });
    } catch (error) {
      const safe = safeError(error);
      this.#refuse(req, res, safe, requestId);
    }
  }

  /**
   * Request-boundary secret check (M11, T-011): a configured secret value, the control token, or
   * a RouteSpec credential shape anywhere in the body (keys and values), the query string, or
   * the idempotency key is refused before any handler, idempotency record, or log line sees it.
   * The error names only where it was found.
   */
  #refuseSecrets(def: RouteDef, url: URL, rawBody: unknown, idempotencyKey: string | null): void {
    const control = this.token.reveal();
    const hit = (v: string) =>
      v.includes(control) || persistedSecretRule(v) !== null || this.#secrets.some((x) => v.includes(x));
    const walk = (v: unknown, depth: number): boolean => {
      if (typeof v === 'string') return hit(v);
      if (depth > 64 || v === null || typeof v !== 'object') return false;
      if (Array.isArray(v)) return v.some((x) => walk(x, depth + 1));
      return Object.entries(v as Record<string, unknown>).some(([k, x]) => hit(k) || walk(x, depth + 1));
    };
    const where: string[] = [];
    if (idempotencyKey !== null && hit(idempotencyKey)) where.push('idempotency-key');
    for (const [k, v] of url.searchParams) if (hit(k) || hit(v)) where.push('query');
    if (def.secretScan !== 'pipeline' && rawBody !== undefined && walk(rawBody, 0)) where.push('body');
    if (where.length > 0) {
      throw new RouteSpecError(
        'RS_SECRET_FIELD_REJECTED',
        'A secret value was refused before it was stored.',
        {
          details: { locations: [...new Set(where)].join(',') },
        },
      );
    }
  }

  #single(req: IncomingMessage, name: string): string | undefined {
    const v = req.headers[name];
    if (Array.isArray(v)) throw new RouteSpecError('RS_HEADER_INVALID', `Header ${name} must appear once.`);
    return v;
  }

  #idempotencyKey(req: IncomingMessage): string {
    const v = this.#single(req, 'idempotency-key');
    if (v === undefined || v.length === 0) {
      throw new RouteSpecError(
        'RS_IDEMPOTENCY_KEY_REQUIRED',
        'Control mutations require an Idempotency-Key header.',
      );
    }
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(v)) {
      throw new RouteSpecError('RS_SCHEMA_INVALID', 'Idempotency-Key must be 8-128 safe characters.');
    }
    return v;
  }

  #static(req: IncomingMessage, res: ServerResponse, url: URL, method: string): void {
    req.resume();
    if (method !== 'GET' && method !== 'HEAD') {
      throw new RouteSpecError('RS_METHOD_NOT_ALLOWED', 'Static console assets are read-only.');
    }
    const dir = this.#consoleDir;
    if (dir === null || !existsSync(join(dir, 'index.html')))
      throw new RouteSpecError('RS_NOT_FOUND', 'The console is not installed.');
    let rel: string;
    try {
      rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
    } catch {
      throw new RouteSpecError('RS_NOT_FOUND', 'Not found.');
    }
    let file = resolve(dir, rel);
    if (!(file === dir || file.startsWith(dir + sep)) || rel.includes('\0'))
      throw new RouteSpecError('RS_NOT_FOUND', 'Not found.');
    if (!existsSync(file) || !statSync(file).isFile()) file = join(dir, 'index.html');
    const bytes = readFileSync(file);
    res.writeHead(200, {
      ...BASE_HEADERS,
      'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'content-length': String(bytes.length),
      'content-security-policy': CONSOLE_CSP,
      'cache-control': file.endsWith('index.html') ? 'no-store' : 'public, max-age=3600, immutable',
    });
    res.end(method === 'HEAD' ? undefined : bytes);
  }
}
