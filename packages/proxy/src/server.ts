/**
 * Networkless 1Click-compatible scenario proxy (FR-02, FR-03, FR-04, FR-07, FR-17; INV-10).
 *
 * - Binds 127.0.0.1 only and verifies the actual socket address; rejects foreign Host headers,
 *   any browser Origin, absolute-form/proxy-style request targets, and the control prefix.
 * - Serves only the enumerated routes of the pinned protocol profile; anything else is a typed
 *   local denial with `upstreamAttempted: false`, journaled as an audit event.
 * - Strips provider `Authorization`/cookies and every RouteSpec-local header before anything is
 *   recorded; configured secret values in a body reject the request before persistence.
 * - Authenticates each request with the one-time case token and bound identity, checks it
 *   before the scenario may consume a step, journals the exchange through M01's atomic
 *   bindings, and only then applies the scenario decision (respond, drop after acceptance,
 *   connection barrier, reset before acceptance).
 * - A commit whose response is not delivered (dropped, barrier abandoned, client gone) is an
 *   unknown outcome: the case supervisor is told synchronously, before the socket closes, so
 *   it can fence the case and issue the reconciliation-only token (INV-03).
 *
 * This process holds no upstream HTTP client, no DNS use, and no provider credential: there is
 * no code path that can contact a provider. LIVE_DRY_PROBE belongs to a separately launched
 * adapter (M07) and is refused here.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import {
  ADAPTER_HEADERS,
  CLIENT_INSTANCE_DIGEST_DOMAIN,
  RouteSpecError,
  digestValue,
  resolveProfileRoute,
  validateQuoteRequest,
  type ErrorCode,
  type OperationPhase,
} from '@routespec/contracts';
import type { Decision, ScenarioRequest, ScenarioRuntime } from '@routespec/scenario';
import type { CaseAuth, RouteSpecStore } from '@routespec/store';
import { assertNoBody, readJsonBody, toSafeError, writeError } from './http.ts';
import { Redactor } from './redact.ts';

export const PROXY_REVISION = 'routespec-proxy@1.0.0' as const;

export interface UncertainOutcomeEvent {
  readonly caseRunId: string;
  readonly runOperationId: string;
  readonly attemptId: string;
  readonly phase: OperationPhase;
  readonly cause: 'RESPONSE_DROPPED' | 'BARRIER_ABANDONED' | 'CLIENT_DISCONNECTED';
}

/** The case supervisor seen by the proxy: one scenario runtime per running case. */
export interface CaseRuntimeRegistry {
  runtimeFor(caseRunId: string): ScenarioRuntime | undefined;
  onUncertainOutcome(event: UncertainOutcomeEvent): void;
}

export interface ProxyLogEntry {
  readonly level: 'info' | 'warn';
  readonly code: string;
  readonly method: string;
  readonly route: string;
  readonly phase: OperationPhase | null;
  readonly session: string | null;
  readonly caseRun: string | null;
  readonly sequence: number | null;
}

export interface ScenarioProxyOptions {
  readonly store: RouteSpecStore;
  readonly mode: 'SIMULATE' | 'REPLAY';
  readonly cases: CaseRuntimeRegistry;
  readonly redactor?: Redactor;
  readonly maxBodyBytes?: number;
  readonly log?: (entry: ProxyLogEntry) => void;
  /**
   * Denial journaling budget (M11, NFR-06). Every denial is counted and answered, but at most
   * `maxPerWindow` denials per window are written as audit events; past that the journal gets
   * one `RS_RATE_LIMITED` marker per window, so a junk-request flood cannot grow the journal
   * without bound.
   */
  readonly denialJournal?: { readonly windowMs: number; readonly maxPerWindow: number };
  /** Connection limits; defaults are the reviewed production values. */
  readonly limits?: {
    readonly headersTimeoutMs?: number;
    readonly requestTimeoutMs?: number;
    readonly maxConnections?: number;
  };
}

export interface ProxyStats {
  requests: number;
  accepted: number;
  denied: number;
  credentialHeadersStripped: number;
  /** Denials answered and counted but not written to the journal (budget exhausted). */
  denialsNotJournaled: number;
  upstreamAttempts: 0;
}

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface Parsed {
  readonly auth: CaseAuth;
  readonly transportRequestId: string;
  readonly logicalJob: string | null;
  readonly runOperationId: string | null;
}

interface Planned {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Record<string, string>;
}

function short(id: string | null): string | null {
  return id === null ? null : id.slice(0, 8);
}

function headerError(name: string): never {
  throw new RouteSpecError(
    'RS_HEADER_INVALID',
    'A required RouteSpec adapter header is missing or malformed.',
    {
      details: { header: name },
    },
  );
}

export class ScenarioProxy {
  readonly store: RouteSpecStore;
  readonly mode: 'SIMULATE' | 'REPLAY';
  readonly stats: ProxyStats = {
    requests: 0,
    accepted: 0,
    denied: 0,
    credentialHeadersStripped: 0,
    denialsNotJournaled: 0,
    upstreamAttempts: 0,
  };
  readonly #denialBudget: { readonly windowMs: number; readonly maxPerWindow: number };
  #denialWindowStart = 0;
  #denialsInWindow = 0;
  private readonly cases: CaseRuntimeRegistry;
  private readonly redactor: Redactor;
  private readonly maxBodyBytes: number;
  private readonly log: (entry: ProxyLogEntry) => void;
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private readonly barriers = new Map<string, () => void>();
  private allowedHosts: ReadonlySet<string> = new Set();
  #port = 0;

  private constructor(options: ScenarioProxyOptions) {
    if ((options.mode as string) === 'LIVE_DRY_PROBE' || !['SIMULATE', 'REPLAY'].includes(options.mode)) {
      throw new RouteSpecError(
        'RS_MODE_POLICY_DENIED',
        'The networkless proxy serves only SIMULATE and REPLAY; LIVE_DRY_PROBE is a separate adapter.',
      );
    }
    this.store = options.store;
    this.mode = options.mode;
    this.cases = options.cases;
    this.redactor = options.redactor ?? new Redactor();
    this.maxBodyBytes = options.maxBodyBytes ?? 16_384;
    this.log = options.log ?? (() => undefined);
    this.#denialBudget = options.denialJournal ?? { windowMs: 60_000, maxPerWindow: 600 };
    const headersTimeout = options.limits?.headersTimeoutMs ?? 10_000;
    this.server = createServer(
      {
        requestTimeout: options.limits?.requestTimeoutMs ?? 30_000,
        headersTimeout,
        maxHeaderSize: 16_384,
        connectionsCheckingInterval: Math.max(100, Math.min(1_000, Math.floor(headersTimeout / 2))),
      },
      (req, res) => {
        void this.handle(req, res);
      },
    );
    this.server.maxConnections = options.limits?.maxConnections ?? 64;
    this.server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });
  }

  static async start(options: ScenarioProxyOptions): Promise<ScenarioProxy> {
    const proxy = new ScenarioProxy(options);
    await new Promise<void>((resolve, reject) => {
      proxy.server.once('error', reject);
      proxy.server.listen({ port: 0, host: '127.0.0.1', exclusive: true }, () => resolve());
    });
    const address = proxy.server.address() as AddressInfo;
    if (address.address !== '127.0.0.1' || address.family !== 'IPv4') {
      await proxy.close();
      throw new RouteSpecError('RS_HOST_REJECTED', 'Proxy did not bind the IPv4 loopback address.');
    }
    proxy.#port = address.port;
    proxy.allowedHosts = new Set([`127.0.0.1:${address.port}`, `localhost:${address.port}`]);
    return proxy;
  }

  get port(): number {
    return this.#port;
  }

  get origin(): string {
    return `http://127.0.0.1:${this.#port}`;
  }

  get boundAddress(): AddressInfo {
    return this.server.address() as AddressInfo;
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  // -------------------------------------------------------------------------------------------

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.stats.requests++;
    const requestId = randomUUID();
    const method = req.method ?? 'OTHER';
    const target = req.url ?? '';
    let sessionHint: string | null = null;
    // What logs and the journal may keep about the target: the matched profile route, never the
    // raw path (a pasted secret in an unknown path must not be persisted; M11, T-011).
    let routeLabel = 'UNROUTED';
    try {
      const host = String(req.headers.host ?? '').toLowerCase();
      if (!this.allowedHosts.has(host)) {
        throw new RouteSpecError('RS_HOST_REJECTED', 'Host header is outside the local origin set.');
      }
      if (req.headers.origin !== undefined || req.headers['sec-fetch-site'] !== undefined) {
        throw new RouteSpecError(
          'RS_ORIGIN_REJECTED',
          'Browser-originated requests are not accepted by the proxy.',
        );
      }
      if (!target.startsWith('/') || target.startsWith('//')) {
        throw new RouteSpecError('RS_UNSUPPORTED_ROUTE', 'Only origin-form request targets are accepted.', {
          details: { method, upstreamAttempted: false },
        });
      }
      const url = new URL(target, 'http://127.0.0.1');
      if (url.pathname !== (target.split('?')[0] ?? '')) {
        // Dot segments, encoded separators, or other normalization never select a route.
        throw new RouteSpecError('RS_UNSUPPORTED_ROUTE', 'Request target is not in normal form.', {
          details: { method, upstreamAttempted: false },
        });
      }
      const route = resolveProfileRoute(method, url.pathname);
      routeLabel = route.path;
      const headers = this.redactor.partitionHeaders(req.headers);
      // RouteSpec-local headers are persisted (logical job, request ids): refuse a secret in any
      // of them except the case token itself, before authentication can consume anything.
      const { [ADAPTER_HEADERS.caseToken]: _caseToken, ...persistedLocal } = headers.local;
      this.rejectSecrets(persistedLocal);
      this.stats.credentialHeadersStripped += headers.stripped.filter(
        (f) => f.category === 'provider-authorization' || f.category === 'cookie',
      ).length;
      const sessionHeader = headers.local[ADAPTER_HEADERS.session];
      if (sessionHeader !== undefined && UUID.test(sessionHeader)) sessionHint = sessionHeader;
      const parsed = this.authenticate(headers.local);
      // Looked up here, checked only after token/identity authorization inside `exchange`, so
      // a torn-down or foreign case is refused for its credentials first.
      const runtime = this.cases.runtimeFor(parsed.auth.caseRunId);

      if (route.path === '/v0/quote') {
        const body = await readJsonBody(req, this.maxBodyBytes);
        this.rejectSecrets(body);
        await this.quote(res, parsed, runtime, body);
      } else if (route.path === '/v0/deposit/submit') {
        const body = await readJsonBody(req, this.maxBodyBytes);
        this.rejectSecrets(body);
        await this.commit(res, parsed, runtime, body);
      } else {
        assertNoBody(req);
        const query: Record<string, string> = {};
        for (const [k, v] of url.searchParams) {
          if (k in query) throw new RouteSpecError('RS_SCHEMA_INVALID', 'Duplicate query parameter.');
          query[k] = v;
        }
        this.rejectSecrets(query);
        await this.status(res, parsed, runtime, query);
      }
    } catch (error) {
      const safe = toSafeError(error);
      this.stats.denied++;
      this.log({
        level: 'warn',
        code: safe.code,
        method,
        route: routeLabel,
        phase: null,
        session: short(sessionHint),
        caseRun: null,
        sequence: null,
      });
      try {
        const journal = this.#denialJournalSlot();
        if (journal === 'RECORD') {
          this.store.recordProxyDenial({ method, path: routeLabel, code: safe.code, sessionId: sessionHint });
        } else if (journal === 'MARK') {
          this.store.recordProxyDenial({ method, path: '/', code: 'RS_RATE_LIMITED', sessionId: null });
        }
      } catch {
        // A storage fault must not turn a denial into an acceptance; the response still fails closed.
      }
      writeError(res, safe, requestId);
    }
  }

  /** Whether this denial is journaled, replaced by the one per-window marker, or only counted. */
  #denialJournalSlot(): 'RECORD' | 'MARK' | 'COUNT_ONLY' {
    const now = Date.now();
    if (now - this.#denialWindowStart >= this.#denialBudget.windowMs) {
      this.#denialWindowStart = now;
      this.#denialsInWindow = 0;
    }
    this.#denialsInWindow++;
    if (this.#denialsInWindow <= this.#denialBudget.maxPerWindow) return 'RECORD';
    this.stats.denialsNotJournaled++;
    return this.#denialsInWindow === this.#denialBudget.maxPerWindow + 1 ? 'MARK' : 'COUNT_ONLY';
  }

  private rejectSecrets(value: unknown): void {
    const findings = this.redactor.findIn(value);
    if (findings.length > 0) {
      throw new RouteSpecError(
        'RS_SECRET_FIELD_REJECTED',
        'A secret-bearing value was rejected before persistence.',
        {
          details: {
            categories: [...new Set(findings.map((f) => f.category))].sort(),
            paths: findings.map((f) => f.path).slice(0, 8),
          },
        },
      );
    }
  }

  private authenticate(local: Readonly<Record<string, string>>): Parsed {
    const h = ADAPTER_HEADERS;
    const token = local[h.caseToken];
    if (token === undefined || token.length < 16 || token.length > 256) {
      throw new RouteSpecError('RS_TOKEN_INVALID', 'Case token is missing.');
    }
    const sessionId = local[h.session] ?? headerError(h.session);
    const caseRunId = local[h.caseRun] ?? headerError(h.caseRun);
    if (!UUID.test(sessionId)) headerError(h.session);
    if (!UUID.test(caseRunId)) headerError(h.caseRun);
    const adapterRevision = local[h.adapter] ?? headerError(h.adapter);
    const epochText = local[h.fencingEpoch] ?? headerError(h.fencingEpoch);
    if (!/^(0|[1-9][0-9]{0,8})$/.test(epochText)) headerError(h.fencingEpoch);
    const clientInstance = local[h.clientInstance] ?? headerError(h.clientInstance);
    if (!/^[A-Za-z0-9._:-]{16,128}$/.test(clientInstance)) headerError(h.clientInstance);
    const transportRequestId = local[h.requestId] ?? headerError(h.requestId);
    if (!ID_PATTERN.test(transportRequestId)) headerError(h.requestId);
    const logicalJob = local[h.logicalJob] ?? null;
    if (logicalJob !== null && !ID_PATTERN.test(logicalJob)) headerError(h.logicalJob);
    const runOperationId = local[h.runOperation] ?? null;
    if (runOperationId !== null && !UUID.test(runOperationId)) headerError(h.runOperation);
    const session = this.store.getSession(sessionId);
    if (!session || session['case_run_id'] !== caseRunId) {
      throw new RouteSpecError('RS_TOKEN_INVALID', 'Case token is not recognized for this session.');
    }
    if (session['mode'] !== this.mode) {
      throw new RouteSpecError('RS_MODE_POLICY_DENIED', 'Session mode differs from this proxy mode.');
    }
    return {
      auth: {
        token,
        sessionId,
        caseRunId,
        gateRunId: String(session['gate_run_id']),
        buildRevisionId: String(session['build_revision_id']),
        artifactDigest: String(session['artifact_digest']),
        clientInstanceDigest: digestValue(CLIENT_INSTANCE_DIGEST_DOMAIN, clientInstance),
        adapterRevision,
        fencingEpoch: Number(epochText),
      },
      transportRequestId,
      logicalJob,
      runOperationId,
    };
  }

  /**
   * Shared exchange pipeline: authorize (read-only) -> plan -> journal -> commit plan -> release
   * barriers -> apply the decision. A refused request never consumes a scenario step.
   */
  private async exchange(args: {
    res: ServerResponse;
    parsed: Parsed;
    runtime: ScenarioRuntime | undefined;
    phase: OperationPhase;
    request: ScenarioRequest;
    journal: (decision: Decision) => {
      exchangeId: string;
      attemptId: string;
      runOperationId: string;
      sequence: number;
    };
    build: (decision: Decision, runOperationId: string, runtime: ScenarioRuntime) => Planned;
    commitPhase: boolean;
  }): Promise<void> {
    const { res, parsed, request } = args;
    try {
      this.store.verifyCaseAuth(parsed.auth, args.phase);
    } catch (error) {
      args.runtime?.deny(request, toSafeError(error).code);
      throw error;
    }
    const runtime = args.runtime;
    if (!runtime)
      throw new RouteSpecError('RS_PHASE_INVALID', 'No scenario runtime is active for this case.');
    const plan = runtime.planRequest(request);
    const decision = plan.decision;
    if (decision.kind === 'REJECT_UNEXPECTED') {
      runtime.commit(plan);
      throw new RouteSpecError(
        (decision.rejectCode ?? 'RS_SCENARIO_UNEXPECTED_REQUEST') as ErrorCode,
        'The request is not part of the scenario schedule.',
      );
    }
    if (decision.kind === 'RESET_BEFORE_ACCEPT') {
      runtime.commit(plan);
      this.releaseBarriers(decision);
      res.socket?.destroy();
      return;
    }
    let ack: { exchangeId: string; attemptId: string; runOperationId: string; sequence: number };
    try {
      ack = args.journal(decision);
    } catch (error) {
      runtime.deny(request, toSafeError(error).code);
      throw error;
    }
    runtime.commit(plan);
    this.stats.accepted++;
    this.log({
      level: 'info',
      code: 'EXCHANGE_JOURNALED',
      method: request.route === 'STATUS' ? 'GET' : 'POST',
      route: request.route,
      phase: args.phase,
      session: short(parsed.auth.sessionId),
      caseRun: short(parsed.auth.caseRunId),
      sequence: ack.sequence,
    });
    this.releaseBarriers(decision);
    const planned = args.build(decision, ack.runOperationId, runtime);
    let delivered = false;
    let lostReported = false;
    const lost = (cause: UncertainOutcomeEvent['cause']) => {
      if (delivered || lostReported || !args.commitPhase) return;
      lostReported = true;
      this.cases.onUncertainOutcome({
        caseRunId: parsed.auth.caseRunId,
        runOperationId: ack.runOperationId,
        attemptId: ack.attemptId,
        phase: args.phase,
        cause,
      });
    };
    const write = () => {
      if (res.destroyed || res.writableEnded) {
        lost('CLIENT_DISCONNECTED');
        return;
      }
      const body = JSON.stringify(planned.body);
      res.writeHead(planned.status, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body),
        ...(planned.headers ?? {}),
      });
      res.end(body);
    };
    res.on('finish', () => {
      delivered = true;
      try {
        this.store.markResponseDelivered(parsed.auth, ack.exchangeId);
      } catch {
        // The case may have been fenced meanwhile; the attempt then honestly stays unknown.
      }
    });
    res.on('close', () => {
      if (!delivered) lost(decision.kind === 'HOLD_BARRIER' ? 'BARRIER_ABANDONED' : 'CLIENT_DISCONNECTED');
    });
    if (decision.kind === 'DROP_AFTER_ACCEPT') {
      lost('RESPONSE_DROPPED');
      res.socket?.destroy();
      return;
    }
    if (decision.kind === 'HOLD_BARRIER') {
      this.barriers.set(decision.stepId as string, write);
      return;
    }
    write();
  }

  private releaseBarriers(decision: Decision): void {
    for (const stepId of decision.releasedBarriers) {
      const deliver = this.barriers.get(stepId);
      this.barriers.delete(stepId);
      deliver?.();
    }
  }

  private async quote(
    res: ServerResponse,
    parsed: Parsed,
    runtime: ScenarioRuntime | undefined,
    body: unknown,
  ): Promise<void> {
    if (parsed.logicalJob === null) headerError(ADAPTER_HEADERS.logicalJob);
    const material = validateQuoteRequest(body).material;
    await this.exchange({
      res,
      parsed,
      runtime,
      phase: 'QUOTE_REQUEST',
      request: { route: 'QUOTE', material, logicalJobKey: parsed.logicalJob as string },
      commitPhase: false,
      journal: (decision) => {
        const ack = this.store.recordQuoteRequest(parsed.auth, {
          transportRequestId: parsed.transportRequestId,
          logicalJobKey: parsed.logicalJob as string,
          material,
          virtualMs: decision.virtualMs,
        });
        const fin = this.store.finalizeQuote(parsed.auth, {
          transportRequestId: parsed.transportRequestId,
          runOperationId: ack.runOperationId,
          response: decision.quoteResponse,
          virtualMs: decision.virtualMs,
          deliveryPending: true,
        });
        return {
          exchangeId: fin.exchangeId,
          attemptId: fin.attemptId,
          runOperationId: ack.runOperationId,
          sequence: fin.sequence,
        };
      },
      build: (decision, runOperationId) => ({
        status: 200,
        body: decision.quoteResponse,
        headers: { [ADAPTER_HEADERS.runOperation]: runOperationId },
      }),
    });
  }

  private requireOperation(parsed: Parsed): string {
    if (parsed.runOperationId === null) headerError(ADAPTER_HEADERS.runOperation);
    return parsed.runOperationId as string;
  }

  private async commit(
    res: ServerResponse,
    parsed: Parsed,
    runtime: ScenarioRuntime | undefined,
    body: unknown,
  ): Promise<void> {
    const runOperationId = this.requireOperation(parsed);
    await this.exchange({
      res,
      parsed,
      runtime,
      phase: 'COMMIT_MUTATION',
      request: { route: 'COMMIT', material: body },
      commitPhase: true,
      journal: (decision) =>
        this.store.commitMutation(parsed.auth, {
          transportRequestId: parsed.transportRequestId,
          runOperationId,
          body,
          virtualMs: decision.virtualMs,
        }),
      build: (decision, _op, rt) => this.executionBody(rt, body, decision),
    });
  }

  private async status(
    res: ServerResponse,
    parsed: Parsed,
    runtime: ScenarioRuntime | undefined,
    query: Record<string, string>,
  ): Promise<void> {
    const runOperationId = this.requireOperation(parsed);
    await this.exchange({
      res,
      parsed,
      runtime,
      phase: 'READ_ONLY_RECONCILIATION',
      request: { route: 'STATUS', material: query },
      commitPhase: false,
      journal: (decision) =>
        this.store.recordStatusObservation(parsed.auth, {
          transportRequestId: parsed.transportRequestId,
          runOperationId,
          query,
          rawStatus: decision.rawStatus ?? 'PENDING_DEPOSIT',
          virtualMs: decision.virtualMs,
          deliveryPending: true,
        }),
      build: (decision, _op, rt) => this.executionBody(rt, query, decision),
    });
  }

  private executionBody(runtime: ScenarioRuntime, material: unknown, decision: Decision): Planned {
    const depositAddress = String((material as Record<string, unknown>)['depositAddress'] ?? '');
    const quoteResponse = runtime.quoteForDepositAddress(depositAddress);
    if (quoteResponse === null) {
      throw new RouteSpecError('RS_INTERNAL', 'Scenario runtime has no quote for the bound deposit address.');
    }
    return {
      status: 200,
      body: runtime.executionBody(quoteResponse, decision.rawStatus ?? 'PENDING_DEPOSIT', decision.virtualMs),
    };
  }
}
