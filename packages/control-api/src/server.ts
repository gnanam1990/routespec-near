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
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { RouteSpecError, canonicalJson } from '@routespec/contracts';
import type { LaunchCredentials } from '@routespec/proxy';
import { GateService } from '@routespec/runner';
import { ControlJournal, GateJournal, ImportJournal, type RouteSpecStore } from '@routespec/store';
import { AttesterChannel } from './attestation.ts';
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
}

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
  readonly metrics = { refused: {} as Record<string, number>, handled: 0, replays: 0 };
  readonly #server: Server;
  readonly #routes: CompiledRoute[];
  readonly #launchers = new Map<string, AttesterChannel>();
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
    this.service = new GateService(this.store, {
      ...(options.leaseTtlMs !== undefined ? { leaseTtlMs: options.leaseTtlMs } : {}),
      ...(options.tokenTtlMs !== undefined ? { tokenTtlMs: options.tokenTtlMs } : {}),
      ...(options.dataDirectory !== undefined ? { dataDirectory: options.dataDirectory } : {}),
      onCredentials: (caseRunId, credentials) => {
        if (credentials.purpose === 'RECONCILIATION_ONLY') this.#pending.set(caseRunId, credentials);
      },
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
      pendingCredentials: this.#pending,
      onLocalConfirmation: notify,
      confirmationTtlMs: options.confirmationTtlMs ?? 120_000,
      challengeTtlMs: options.challengeTtlMs ?? 300_000,
    }).map(compile);
    this.#server = createServer({ maxHeaderSize: 16_384 }, (req, res) => {
      void this.#handle(req, res);
    });
    this.#server.headersTimeout = 10_000;
    this.#server.requestTimeout = 60_000;
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

  async close(): Promise<void> {
    for (const l of this.#launchers.values()) await l.close().catch(() => undefined);
    this.#launchers.clear();
    await this.service.close();
    await new Promise<void>((r) => {
      this.#server.close(() => r());
      this.#server.closeAllConnections();
    });
  }

  #refuse(res: ServerResponse, error: RouteSpecError, requestId: string): void {
    this.metrics.refused[error.code] = (this.metrics.refused[error.code] ?? 0) + 1;
    writeError(res, error, requestId);
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
      if (!res.headersSent && req.readableEnded === false) req.resume();
      this.#refuse(res, safe, requestId);
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
