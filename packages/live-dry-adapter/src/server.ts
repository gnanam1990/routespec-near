/**
 * The LIVE_DRY_PROBE adapter service (ARCHITECTURE.md DF-02). It runs in its own process
 * (main.ts) and listens on loopback only. The pinned official client points `OpenAPI.BASE` at it.
 *
 * Per inbound request, in this order:
 *   1. local checks: loopback Host, no browser Origin, origin-form target, the adapter's own
 *      probe-session token (a local credential, distinct from the provider JWT), bounded body;
 *   2. the pure mode policy (policy.ts); a denial is journaled (code/reason/route only) and
 *      answered with `credentialAttached/dnsAttempted/upstreamAttempted: false`;
 *   3. the probe budget (one forwarded dry quote per session by default; no retries);
 *   4. pinned egress (egress.ts), then shape classification and the compatibility ledger.
 * Inbound `Authorization` and every `x-routespec-*` header are dropped at step 1; the upstream
 * request is built from a fixed header set plus the vault credential only.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes, randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { RouteSpecError, type ErrorCode, type ProviderTokenState } from '@routespec/contracts';
import { compileUpstreamOrigin, type CompiledOrigin } from './address-policy.ts';
import { classifyOutcome, type CompatibilityResult } from './compatibility.ts';
import type { ProviderCredentialVault } from './credential.ts';
import {
  DEFAULT_EGRESS_LIMITS,
  isSystemTransport,
  sendDryQuote,
  sendTokenListRequest,
  type EgressCounters,
  type EgressLimits,
  type EgressTiming,
  type EgressTransport,
} from './egress.ts';
import type { CompatibilityLedger, DenialEntry, ProbeEntry } from './ledger.ts';
import {
  LIVE_DRY_MAX_REQUEST_BYTES,
  classifyLiveDryRequest,
  classifyTokenListRequest,
  denialEnvelope,
  type PolicyDenial,
} from './policy.ts';

export const PROBE_TOKEN_HEADER = 'x-routespec-probe-token';

/**
 * Hard upper bound on upstream requests one adapter session may make, dry quotes and token-list
 * reads together (ADR-0027). A session asking for more does not start.
 */
export const LIVE_DRY_HARD_REQUEST_CAP = 40;

const STATUS: Partial<Record<ErrorCode, number>> = {
  RS_MODE_POLICY_DENIED: 403,
  RS_UNSUPPORTED_ROUTE: 404,
  RS_UNKNOWN_MATERIAL_FIELD: 400,
  RS_MATERIAL_INVALID: 400,
  RS_DEPOSIT_ADDRESS_NOT_REQUEST_KNOWN: 400,
  RS_CONTENT_TYPE_UNSUPPORTED: 415,
  RS_BODY_TOO_LARGE: 413,
  RS_TOKEN_INVALID: 401,
  RS_TOKEN_EXPIRED: 401,
  RS_HOST_REJECTED: 403,
  RS_ORIGIN_REJECTED: 403,
};

export interface AdapterCounters extends EgressCounters {
  requests: number;
  localRejections: number;
  policyDenials: number;
  forwarded: number;
  /** Token-list reads forwarded (fidelity matrix only; 0 unless a budget was requested). */
  tokenListForwarded: number;
}

export interface AdapterOptions {
  readonly vault: ProviderCredentialVault;
  readonly transport: EgressTransport;
  readonly ledger: CompatibilityLedger | null;
  readonly maxProbes?: number;
  /** Token-list reads allowed in this session. Default 0: the route stays denied. */
  readonly maxTokenListFetches?: number;
  readonly limits?: EgressLimits;
  /** Defaults to the pinned profile origin; any other value is refused by compileUpstreamOrigin. */
  readonly origin?: string;
}

export interface AdapterReport {
  readonly tokenState: ProviderTokenState;
  readonly counters: Readonly<AdapterCounters>;
  readonly credentialAttachments: number;
  readonly transportKind: 'SYSTEM' | 'INJECTED';
  readonly denials: readonly DenialEntry[];
  readonly probes: readonly ProbeEntry[];
  readonly inMemoryDenials: readonly Pick<PolicyDenial, 'code' | 'reason' | 'route' | 'method'>[];
  readonly lastResult: CompatibilityResult | null;
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export class LiveDryAdapter {
  readonly #vault: ProviderCredentialVault;
  readonly #transport: EgressTransport;
  readonly #ledger: CompatibilityLedger | null;
  readonly #origin: CompiledOrigin;
  readonly #limits: EgressLimits;
  readonly #maxProbes: number;
  readonly #maxTokenListFetches: number;
  readonly #probeTokenDigest: Buffer;
  readonly probeToken: string;
  readonly counters: AdapterCounters = {
    requests: 0,
    localRejections: 0,
    policyDenials: 0,
    forwarded: 0,
    tokenListForwarded: 0,
    resolverCalls: 0,
    connectorCalls: 0,
    upstreamRequests: 0,
  };
  readonly #denials: Array<Pick<PolicyDenial, 'code' | 'reason' | 'route' | 'method'>> = [];
  #lastResult: CompatibilityResult | null = null;
  #server: Server | null = null;
  #port = 0;
  #inFlight = false;

  constructor(options: AdapterOptions) {
    this.#vault = options.vault;
    this.#transport = options.transport;
    this.#ledger = options.ledger;
    this.#origin = compileUpstreamOrigin(options.origin ?? 'https://1click.chaindefuser.com');
    this.#limits = options.limits ?? DEFAULT_EGRESS_LIMITS;
    this.#maxProbes = options.maxProbes ?? 1;
    this.#maxTokenListFetches = options.maxTokenListFetches ?? 0;
    const budgets = [this.#maxProbes, this.#maxTokenListFetches];
    if (
      budgets.some((n) => !Number.isInteger(n) || n < 0) ||
      this.#maxProbes + this.#maxTokenListFetches > LIVE_DRY_HARD_REQUEST_CAP
    ) {
      throw new RouteSpecError('RS_MODE_POLICY_DENIED', 'Session request budget exceeds the hard cap.', {
        details: { reason: 'REQUEST_CAP_EXCEEDED' },
      });
    }
    this.probeToken = `rslp_${randomBytes(32).toString('base64url')}`;
    this.#probeTokenDigest = digest(this.probeToken);
  }

  get port(): number {
    return this.#port;
  }

  async listen(): Promise<AddressInfo> {
    const server = createServer({ maxHeaderSize: 16 * 1024 }, (req, res) => void this.#handle(req, res));
    server.headersTimeout = 10_000;
    server.requestTimeout = 30_000;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => resolve());
    });
    this.#server = server;
    const address = server.address() as AddressInfo;
    if (address.address !== '127.0.0.1') {
      server.close();
      throw new RouteSpecError('RS_HOST_REJECTED', 'Adapter must bind loopback only.');
    }
    this.#port = address.port;
    return address;
  }

  async close(): Promise<void> {
    this.#vault.release();
    const server = this.#server;
    this.#server = null;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  report(): AdapterReport {
    return {
      tokenState: this.#vault.state(),
      counters: { ...this.counters },
      credentialAttachments: this.#vault.attachments,
      transportKind: isSystemTransport(this.#transport) ? 'SYSTEM' : 'INJECTED',
      denials: this.#ledger?.denials() ?? [],
      probes: this.#ledger?.probes() ?? [],
      inMemoryDenials: [...this.#denials],
      lastResult: this.#lastResult,
    };
  }

  #reply(res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(text),
    });
    res.end(text);
  }

  #local(res: ServerResponse, code: ErrorCode, reason: string, requestId: string): void {
    this.counters.localRejections++;
    const error = new RouteSpecError(code, 'Request rejected by the live-dry adapter.', {
      details: { reason, credentialAttached: false, dnsAttempted: false, upstreamAttempted: false },
    });
    this.#reply(res, STATUS[code] ?? 400, error.toEnvelope(requestId));
  }

  #deny(res: ServerResponse, denial: PolicyDenial, requestId: string): void {
    this.counters.policyDenials++;
    this.#denials.push({
      code: denial.code,
      reason: denial.reason,
      route: denial.route,
      method: denial.method,
    });
    this.#ledger?.recordDenial(denial);
    this.#reply(res, STATUS[denial.code] ?? 403, denialEnvelope(denial, requestId));
  }

  #authorized(req: IncomingMessage): boolean {
    const presented = req.headers[PROBE_TOKEN_HEADER];
    if (typeof presented !== 'string' || presented.length < 16 || presented.length > 128) return false;
    return timingSafeEqual(digest(presented), this.#probeTokenDigest);
  }

  async #readBody(req: IncomingMessage): Promise<Buffer | null> {
    const declared = Number(req.headers['content-length'] ?? '0');
    if (Number.isFinite(declared) && declared > LIVE_DRY_MAX_REQUEST_BYTES) return null;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > LIVE_DRY_MAX_REQUEST_BYTES) return null;
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  #capReached(): boolean {
    return this.counters.forwarded + this.counters.tokenListForwarded >= LIVE_DRY_HARD_REQUEST_CAP;
  }

  /** Fidelity matrix only: one bare token-list read, no credential, nothing written to the ledger. */
  async #readTokenList(
    req: IncomingMessage,
    res: ServerResponse,
    body: Buffer,
    requestId: string,
  ): Promise<void> {
    const decision = classifyTokenListRequest({
      method: req.method ?? '',
      target: req.url ?? '',
      headers: req.headers,
      body,
    });
    if (!decision.allowed) return this.#deny(res, decision, requestId);
    if (
      this.counters.tokenListForwarded >= this.#maxTokenListFetches ||
      this.#inFlight ||
      this.#capReached()
    ) {
      return this.#deny(
        res,
        {
          allowed: false,
          code: 'RS_MODE_POLICY_DENIED',
          reason: 'TOKEN_LIST_BUDGET_EXHAUSTED',
          route: decision.route,
          method: decision.method,
          strippedInboundHeaders: decision.strippedInboundHeaders,
          boundary: {
            credentialAttached: false,
            dnsAttempted: false,
            socketAttempted: false,
            upstreamAttempted: false,
            upstreamClientInvoked: false,
          },
        },
        requestId,
      );
    }
    this.#inFlight = true;
    this.counters.tokenListForwarded++;
    const outcome = await sendTokenListRequest({
      allowance: decision,
      origin: this.#origin,
      transport: this.#transport,
      counters: this.counters,
      limits: this.#limits,
    });
    this.#inFlight = false;
    if (
      outcome.kind === 'RESPONSE' &&
      outcome.status === 200 &&
      (outcome.contentType ?? '').toLowerCase().startsWith('application/json')
    ) {
      res.writeHead(200, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'content-length': outcome.body.length,
      });
      res.end(outcome.body);
      return;
    }
    const error = new RouteSpecError('RS_MODE_POLICY_DENIED', 'Token list read did not produce a list.', {
      details: {
        reason: outcome.kind === 'FAILED' ? outcome.reason : `PROVIDER_HTTP_${outcome.status}`,
        credentialAttached: false,
        dnsAttempted: outcome.boundary.dnsAttempted,
        upstreamAttempted: outcome.boundary.upstreamAttempted,
      },
    });
    this.#reply(res, 502, error.toEnvelope(requestId));
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = randomUUID();
    this.counters.requests++;
    try {
      const host = String(req.headers.host ?? '').toLowerCase();
      if (host !== `127.0.0.1:${this.#port}` && host !== `localhost:${this.#port}`) {
        return this.#local(res, 'RS_HOST_REJECTED', 'HOST_NOT_LOOPBACK', requestId);
      }
      if (req.headers.origin !== undefined) {
        return this.#local(res, 'RS_ORIGIN_REJECTED', 'BROWSER_ORIGIN', requestId);
      }
      if (!this.#authorized(req)) {
        return this.#local(res, 'RS_TOKEN_INVALID', 'PROBE_SESSION_TOKEN', requestId);
      }
      const body = await this.#readBody(req);
      if (body === null) {
        req.resume();
        return this.#local(res, 'RS_BODY_TOO_LARGE', 'BODY_TOO_LARGE', requestId);
      }
      if (this.#maxTokenListFetches > 0 && (req.url ?? '').split('?')[0] === '/v0/tokens') {
        return await this.#readTokenList(req, res, body, requestId);
      }
      const decision = classifyLiveDryRequest({
        method: req.method ?? '',
        target: req.url ?? '',
        headers: req.headers,
        body,
      });
      if (!decision.allowed) return this.#deny(res, decision, requestId);

      if (this.counters.forwarded >= this.#maxProbes || this.#inFlight || this.#capReached()) {
        return this.#deny(
          res,
          {
            allowed: false,
            code: 'RS_MODE_POLICY_DENIED',
            reason: 'PROBE_BUDGET_EXHAUSTED',
            route: decision.route,
            method: decision.method,
            strippedInboundHeaders: decision.strippedInboundHeaders,
            boundary: {
              credentialAttached: false,
              dnsAttempted: false,
              socketAttempted: false,
              upstreamAttempted: false,
              upstreamClientInvoked: false,
            },
          },
          requestId,
        );
      }
      if (this.#vault.state() === 'EXPIRED') {
        return this.#local(res, 'RS_TOKEN_EXPIRED', 'PROVIDER_CREDENTIAL_EXPIRED', requestId);
      }
      this.#inFlight = true;
      this.counters.forwarded++;
      const outcome = await sendDryQuote({
        allowance: decision,
        vault: this.#vault,
        origin: this.#origin,
        transport: this.#transport,
        counters: this.counters,
        limits: this.#limits,
      });
      this.#inFlight = false;
      const official = isSystemTransport(this.#transport);
      const result = classifyOutcome({ allowance: decision, outcome, officialTransport: official });
      this.#lastResult = result;
      const timing: EgressTiming | null = outcome.timing;
      this.#ledger?.recordProbe({
        result,
        transportKind: official ? 'SYSTEM' : 'INJECTED',
        quoteRequestDigest: decision.quoteRequestDigest,
        credentialAttached: outcome.boundary.credentialAttached,
        tokenState: this.#vault.state(),
        timing,
      });
      if (
        outcome.kind === 'RESPONSE' &&
        (outcome.contentType ?? '').toLowerCase().startsWith('application/json')
      ) {
        // The subject client gets the provider's answer to its own dry request; nothing is stored.
        res.writeHead(outcome.status, {
          'content-type': 'application/json',
          'cache-control': 'no-store',
          'content-length': outcome.body.length,
          'x-routespec-compatibility': result.compatibility,
        });
        res.end(outcome.body);
        return;
      }
      const error = new RouteSpecError(
        'RS_MODE_POLICY_DENIED',
        'Dry probe did not produce a usable response.',
        {
          details: {
            reason: result.reasonCode,
            compatibility: result.compatibility,
            credentialAttached: outcome.boundary.credentialAttached,
            dnsAttempted: outcome.boundary.dnsAttempted,
            upstreamAttempted: outcome.boundary.upstreamAttempted,
          },
        },
      );
      this.#reply(res, 502, error.toEnvelope(requestId));
    } catch {
      this.#inFlight = false;
      if (!res.headersSent) {
        this.#reply(
          res,
          500,
          new RouteSpecError('RS_INTERNAL', 'Internal adapter error.').toEnvelope(requestId),
        );
      } else {
        res.destroy();
      }
    }
  }
}
