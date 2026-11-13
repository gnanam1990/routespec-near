/**
 * Fidelity matrix (M51): one run. Reads the official token list once, then sends one dry quote
 * per candidate route through the live-dry adapter until the target number of routes has been
 * answered with a judgeable (2xx) response or the quote ceiling is reached, and builds the
 * redacted matrix. A route the endpoint cannot quote (for example no liquidity) stays in the
 * matrix as UNKNOWN and the next candidate is probed; no request is ever repeated.
 *
 * Request budget: at most `LIVE_DRY_HARD_REQUEST_CAP` (40) upstream requests per run, counted
 * here before every call and enforced again by the adapter session, which is started with exactly
 * this run's budget: one token-list read plus at most 39 dry quotes.
 */
import type { ProviderTokenState } from '@routespec/contracts';
import { profileIdentity, type CompatibilityResult } from './compatibility.ts';
import type { LaunchedAdapter } from './launch.ts';
import {
  baselineStatus,
  evaluateMatrix,
  type FidelityBaseline,
  type FidelityMatrix,
  type MatrixRow,
} from './matrix-report.ts';
import { MATRIX_DEFAULT_ROUTES, buildDryQuoteRequest, selectRoutes } from './matrix-routes.ts';
import { TOKEN_LIST_MAX_ENTRIES } from './matrix-tokens.ts';
import { parseTokenList, type ParsedTokenList } from './matrix-tokens.ts';
import { LIVE_DRY_HARD_REQUEST_CAP, PROBE_TOKEN_HEADER, type AdapterReport } from './server.ts';

/** Most dry quotes one run can send: the cap minus the token-list read. */
export const MATRIX_MAX_ROUTES = LIVE_DRY_HARD_REQUEST_CAP - 1;

/** Ceiling on dry quotes for a run: never below the target, never above 39. */
export function clampQuoteCeiling(requested: number | undefined, target: number): number {
  const n = requested === undefined || !Number.isInteger(requested) ? MATRIX_MAX_ROUTES : requested;
  return Math.min(MATRIX_MAX_ROUTES, Math.max(target, n));
}

/**
 * Coarse class of a provider 4xx message. The text itself is provider data and is never kept;
 * only one of these fixed labels reaches the matrix.
 */
export function providerRefusalClass(message: unknown): 'NO_LIQUIDITY' | 'AMOUNT_TOO_LOW' | 'OTHER' {
  if (typeof message !== 'string') return 'OTHER';
  if (/no liquidity/i.test(message)) return 'NO_LIQUIDITY';
  if (/amount is too low/i.test(message)) return 'AMOUNT_TOO_LOW';
  return 'OTHER';
}

export function clampRouteCount(requested: number | undefined): number {
  const n = requested === undefined || !Number.isInteger(requested) ? MATRIX_DEFAULT_ROUTES : requested;
  return Math.min(MATRIX_MAX_ROUTES, Math.max(1, n));
}

/** Counts upstream requests for one run; refuses the one that would exceed the cap. */
export class RequestBudget {
  readonly cap: number;
  #used = 0;
  constructor(cap: number = LIVE_DRY_HARD_REQUEST_CAP) {
    this.cap = Math.min(cap, LIVE_DRY_HARD_REQUEST_CAP);
  }
  get used(): number {
    return this.#used;
  }
  take(): void {
    if (this.#used >= this.cap) throw new Error('fidelity matrix request cap reached');
    this.#used++;
  }
}

export type TokenListObservation =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reasonCode: string };

export type QuoteObservation = Pick<
  MatrixRow,
  'forwarded' | 'httpStatus' | 'compatibility' | 'shapeResult' | 'reasonCode' | 'responseShapeDigest'
> & { readonly latencyMs: number | null };

export interface MatrixClient {
  readonly transportKind: () => Promise<'SYSTEM' | 'INJECTED'>;
  readonly tokenState: () => Promise<ProviderTokenState>;
  readonly tokens: () => Promise<TokenListObservation>;
  readonly quote: (request: Record<string, unknown>) => Promise<QuoteObservation>;
}

interface SdkLike {
  readonly OpenAPI: { BASE: string; TOKEN?: unknown; HEADERS?: unknown };
  readonly OneClickService: {
    getTokens(): Promise<unknown>;
    getQuote(request: never): Promise<unknown>;
  };
}

function httpReason(error: unknown): string {
  const status = (error as { status?: unknown } | null)?.status;
  return `CLIENT_HTTP_${typeof status === 'number' ? status : 'UNKNOWN'}`;
}

/**
 * The matrix client over a launched adapter: the pinned official SDK is pointed at the adapter's
 * loopback address and authenticates with the probe-session token only. Each quote row is read
 * from the adapter's own redacted result; the response body the SDK returns is discarded.
 */
export function adapterMatrixClient(adapter: LaunchedAdapter, sdk: SdkLike): MatrixClient {
  const point = () => {
    sdk.OpenAPI.BASE = adapter.baseUrl;
    sdk.OpenAPI.TOKEN = undefined;
    sdk.OpenAPI.HEADERS = { [PROBE_TOKEN_HEADER]: adapter.probeToken };
  };
  return {
    transportKind: async () => (await adapter.report<AdapterReport>()).transportKind,
    tokenState: async () => (await adapter.report<AdapterReport>()).tokenState,
    async tokens() {
      point();
      try {
        return { ok: true, value: await sdk.OneClickService.getTokens() };
      } catch (error) {
        return { ok: false, reasonCode: httpReason(error) };
      }
    },
    async quote(request) {
      point();
      const before = (await adapter.report<AdapterReport>()).counters.forwarded;
      const started = Date.now();
      let clientReason = 'RESOLVED';
      let refusal: string | null = null;
      try {
        await sdk.OneClickService.getQuote(request as never);
      } catch (error) {
        clientReason = httpReason(error);
        const body = (error as { body?: { message?: unknown } | null } | null)?.body;
        refusal = providerRefusalClass(body?.message);
      }
      const latencyMs = Date.now() - started;
      const report = await adapter.report<AdapterReport>();
      const result: CompatibilityResult | null = report.lastResult;
      if (report.counters.forwarded === before || result === null) {
        return {
          forwarded: false,
          httpStatus: null,
          compatibility: 'UNKNOWN',
          shapeResult: 'NOT_JUDGED',
          reasonCode: `NOT_FORWARDED_${report.inMemoryDenials.at(-1)?.reason ?? clientReason}`,
          responseShapeDigest: null,
          latencyMs: null,
        };
      }
      return {
        forwarded: true,
        httpStatus: result.httpStatus,
        compatibility: result.compatibility,
        shapeResult: result.shapeResult,
        reasonCode:
          refusal !== null &&
          result.httpStatus !== null &&
          result.httpStatus >= 400 &&
          result.httpStatus < 500
            ? `${result.reasonCode}_${refusal}`
            : result.reasonCode,
        responseShapeDigest: result.responseShapeDigest,
        latencyMs,
      };
    },
  };
}

export async function runFidelityMatrix(input: {
  readonly client: MatrixClient;
  readonly baseline: FidelityBaseline;
  /** Target number of routes with a judgeable (2xx) answer. Default 24, at most 39. */
  readonly routes?: number;
  /** Ceiling on dry quotes sent while reaching the target. Default and maximum 39. */
  readonly maxQuotes?: number;
  readonly now?: () => Date;
  /** Pause between dry quotes, in milliseconds. */
  readonly pauseMs?: number;
}): Promise<FidelityMatrix> {
  const now = input.now ?? (() => new Date());
  const target = clampRouteCount(input.routes);
  const ceiling = clampQuoteCeiling(input.maxQuotes, target);
  const budget = new RequestBudget();
  const identity = profileIdentity();

  budget.take();
  const listed = await input.client.tokens();
  let parsed: ParsedTokenList | null = null;
  let tokenListReason = listed.ok ? 'TOKEN_LIST_READ' : listed.reasonCode;
  if (listed.ok) {
    try {
      parsed = parseTokenList(listed.value);
    } catch {
      tokenListReason = 'TOKEN_LIST_SHAPE';
    }
  }

  const rows: MatrixRow[] = [];
  if (parsed !== null) {
    let judged = 0;
    for (const route of selectRoutes(parsed.tokens, TOKEN_LIST_MAX_ENTRIES)) {
      if (judged >= target || rows.length >= ceiling) break;
      if (rows.length > 0 && (input.pauseMs ?? 0) > 0) {
        await new Promise((resolve) => setTimeout(resolve, input.pauseMs));
      }
      budget.take();
      const seen = await input.client.quote(buildDryQuoteRequest(route, now()));
      if (seen.shapeResult !== 'NOT_JUDGED') judged++;
      const { assetId: oId, blockchain: oChain, symbol: oSymbol } = route.origin;
      const { assetId: dId, blockchain: dChain, symbol: dSymbol } = route.destination;
      rows.push(
        Object.freeze({
          index: route.index,
          origin: { symbol: oSymbol, blockchain: oChain, assetId: oId },
          destination: { symbol: dSymbol, blockchain: dChain, assetId: dId },
          ...seen,
          baseline: baselineStatus(seen, input.baseline),
        }),
      );
    }
  }

  const transportKind = await input.client.transportKind();
  const matrix: FidelityMatrix = {
    schema: 'routespec.fidelity-matrix/1',
    generatedAt: now().toISOString(),
    origin: identity.origin,
    profile: {
      protocolProfileId: identity.protocolProfileId,
      profileIntegrityDigest: identity.profileIntegrityDigest,
      sdkPackage: identity.sdkPackage,
      sdkVersion: identity.sdkVersion,
    },
    transportKind,
    tokenState: await input.client.tokenState(),
    tokenList: {
      status: parsed === null ? 'UNAVAILABLE' : 'READ',
      reasonCode: tokenListReason,
      listed: parsed?.listed ?? 0,
      usable: parsed?.usable ?? 0,
      shapeDigest: parsed?.shapeDigest ?? null,
    },
    requests: {
      hardCap: LIVE_DRY_HARD_REQUEST_CAP,
      targetRoutes: target,
      quoteCeiling: ceiling,
      tokenListReads: 1,
      dryQuotes: rows.length,
      total: budget.used,
    },
    rows: Object.freeze(rows),
    ...evaluateMatrix({ rows, transportKind, tokenListRead: parsed !== null }),
    settlementExercised: false,
  };
  return Object.freeze(matrix);
}
