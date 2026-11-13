/**
 * LIVE_DRY_PROBE request classifier and mode policy (FR-04, FR-16, INV-10; owned test T-021).
 *
 * This is the first thing that runs on every inbound request, before the provider credential is
 * read, before DNS, before a socket exists and before the upstream client is invoked. It is a pure
 * function of the received method, request target, headers and body bytes: no scenario field, UI
 * flag or header can widen it.
 *
 * The only request that can pass is `POST /v0/quote` with a strict, unambiguous JSON object whose
 * `dry` is the boolean `true`, which contains no request-side deposit address, no commit or
 * reconciliation material and no field outside the pinned profile's quote-request schema. The
 * forwarded body is re-serialized from the validated material, so nothing outside the allowlist
 * can ride along.
 */
import {
  MATERIAL_FIELD_REGISTRY,
  ONECLICK_SDK_ROUTES,
  PROFILE_ROUTES,
  QuoteRequestMaterial,
  RouteSpecError,
  isRouteSpecError,
  validateQuoteRequest,
  type Digest,
  type ErrorCode,
  type QuoteRequestMaterial as QuoteRequestMaterialType,
} from '@routespec/contracts';
import { parseStrictJsonObject } from './strict-json.ts';

export const LIVE_DRY_MAX_REQUEST_BYTES = 64 * 1024;

/** Flags every denial reports. They are constants: a denial never reaches any of these steps. */
export const DENIAL_BOUNDARY = Object.freeze({
  credentialAttached: false,
  dnsAttempted: false,
  socketAttempted: false,
  upstreamAttempted: false,
  upstreamClientInvoked: false,
} as const);

export interface InboundRequest {
  readonly method: string;
  /** Request target exactly as received on the request line. */
  readonly target: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: Buffer;
}

export interface PolicyDenial {
  readonly allowed: false;
  readonly code: ErrorCode;
  readonly reason: string;
  /** A profile route label when the target matched one, otherwise `UNLISTED`. Never raw input. */
  readonly route: string;
  readonly method: string;
  readonly strippedInboundHeaders: readonly string[];
  readonly boundary: typeof DENIAL_BOUNDARY;
}

export interface AllowedDryQuote {
  readonly allowed: true;
  readonly method: 'POST';
  readonly path: '/v0/quote';
  readonly route: 'POST /v0/quote';
  readonly material: QuoteRequestMaterialType;
  readonly quoteRequestDigest: Digest;
  /** Exact bytes that may be forwarded: re-serialized from the validated material only. */
  readonly forwardBody: Buffer;
  readonly strippedInboundHeaders: readonly string[];
}

export type PolicyDecision = PolicyDenial | AllowedDryQuote;

/** Allowed decisions are only ever created here; the egress refuses anything else. */
const issued = new WeakSet<object>();

export function isIssuedAllowance(value: unknown): value is AllowedDryQuote {
  return typeof value === 'object' && value !== null && issued.has(value);
}

const STRIPPED_HEADER = /^(authorization|proxy-authorization|cookie|x-routespec-.*)$/;

function strippedNames(headers: InboundRequest['headers']): string[] {
  return Object.keys(headers)
    .map((h) => h.toLowerCase())
    .filter((h) => STRIPPED_HEADER.test(h))
    .sort();
}

/** Body keys that would make the request committed, fund-moving or reconciliation-scoped. */
const MUTATION_KEYS = new Set<string>([
  ...Object.entries(MATERIAL_FIELD_REGISTRY)
    .filter(([, cls]) => cls === 'COMMIT_MATERIAL' || cls === 'RECONCILIATION_ONLY')
    .map(([path]) => path.split('.').at(-1)!),
  'signedData',
  'signature',
  'signedIntent',
  'intent',
  'quoteHash',
  'transfer',
  'withdrawal',
  'withdraw',
  'orderId',
  'commit',
]);

const QUOTE_KEYS = new Set(Object.keys(QuoteRequestMaterial.shape));

interface RouteMatch {
  readonly label: string;
  readonly kind: 'ALLOWLISTED' | 'COMMITTED' | 'DISABLED' | 'PROHIBITED' | 'UNSUPPORTED';
  readonly method: string;
}

function sdkRoutePattern(path: string): RegExp {
  return new RegExp(`^${path.replace(/\{[A-Za-z]+\}/g, '[A-Za-z0-9_-]{1,128}').replace(/\//g, '\\/')}$`);
}

function matchRoute(path: string): RouteMatch[] {
  const out: RouteMatch[] = [];
  for (const r of PROFILE_ROUTES) {
    if (r.path !== path) continue;
    const kind =
      r.liveDryPolicy === 'ALLOW_IF_DRY_TRUE'
        ? 'ALLOWLISTED'
        : r.liveDryPolicy === 'DENY'
          ? 'COMMITTED'
          : 'DISABLED';
    out.push({ label: `${r.method} ${r.path}`, kind, method: r.method });
  }
  for (const r of ONECLICK_SDK_ROUTES) {
    if (r.profile === 'SUPPORTED') continue;
    if (!sdkRoutePattern(r.path).test(path)) continue;
    out.push({
      label: `${r.method} ${r.path}`,
      kind: r.profile === 'PROHIBITED' ? 'PROHIBITED' : 'UNSUPPORTED',
      method: r.method,
    });
  }
  return out;
}

function header(headers: InboundRequest['headers'], name: string): string | undefined {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === name) return Array.isArray(v) ? v.join(',') : v;
  }
  return undefined;
}

/** Classify one inbound request. Never throws; never touches the network or the credential. */
export function classifyLiveDryRequest(req: InboundRequest): PolicyDecision {
  const method = typeof req.method === 'string' ? req.method.toUpperCase().slice(0, 16) : '';
  const stripped = strippedNames(req.headers);
  const deny = (code: ErrorCode, reason: string, route = 'UNLISTED'): PolicyDenial =>
    Object.freeze({
      allowed: false,
      code,
      reason,
      route,
      method,
      strippedInboundHeaders: Object.freeze(stripped),
      boundary: DENIAL_BOUNDARY,
    });

  const target = typeof req.target === 'string' ? req.target : '';
  if (!target.startsWith('/') || target.startsWith('//')) {
    return deny('RS_MODE_POLICY_DENIED', 'TARGET_NOT_ORIGIN_FORM');
  }
  const q = target.indexOf('?');
  const path = q === -1 ? target : target.slice(0, q);
  const hasQuery = q !== -1;
  if (
    path.length > 256 ||
    /[%\\#\s;]/.test(path) ||
    /\/\.{1,2}(\/|$)/.test(path) ||
    path.includes('//') ||
    (path.length > 1 && path.endsWith('/'))
  ) {
    return deny('RS_MODE_POLICY_DENIED', 'PATH_NOT_CANONICAL');
  }

  const matches = matchRoute(path);
  if (matches.length === 0) return deny('RS_UNSUPPORTED_ROUTE', 'UNLISTED_ROUTE');
  const exact = matches.find((m) => m.method === method);
  if (!exact) return deny('RS_MODE_POLICY_DENIED', 'METHOD_NOT_ALLOWLISTED', matches[0]!.label);
  switch (exact.kind) {
    case 'COMMITTED':
      return deny('RS_MODE_POLICY_DENIED', 'COMMITTED_MUTATION_ROUTE', exact.label);
    case 'DISABLED':
      return deny('RS_MODE_POLICY_DENIED', 'STATUS_LOOKUP_DISABLED_BY_DEFAULT', exact.label);
    case 'PROHIBITED':
      return deny('RS_MODE_POLICY_DENIED', 'PROHIBITED_ROUTE', exact.label);
    case 'UNSUPPORTED':
      return deny('RS_MODE_POLICY_DENIED', 'ROUTE_NOT_ALLOWLISTED', exact.label);
    case 'ALLOWLISTED':
      break;
  }
  const route = exact.label;
  if (hasQuery) return deny('RS_MODE_POLICY_DENIED', 'QUERY_NOT_ALLOWED', route);

  const contentType = (header(req.headers, 'content-type') ?? '').toLowerCase().replace(/\s+/g, '');
  if (contentType !== 'application/json' && contentType !== 'application/json;charset=utf-8') {
    return deny('RS_CONTENT_TYPE_UNSUPPORTED', 'CONTENT_TYPE_NOT_JSON', route);
  }
  const encoding = (header(req.headers, 'content-encoding') ?? 'identity').toLowerCase().trim();
  if (encoding !== 'identity') return deny('RS_MODE_POLICY_DENIED', 'BODY_ENCODED', route);
  if (!Buffer.isBuffer(req.body) || req.body.length > LIVE_DRY_MAX_REQUEST_BYTES) {
    return deny('RS_BODY_TOO_LARGE', 'BODY_TOO_LARGE', route);
  }

  const parsed = parseStrictJsonObject(req.body);
  if (!parsed.ok) return deny('RS_MODE_POLICY_DENIED', parsed.reason, route);
  const body = parsed.value;

  if (!Object.prototype.hasOwnProperty.call(body, 'dry')) {
    return deny('RS_MODE_POLICY_DENIED', 'DRY_MISSING', route);
  }
  if (typeof body['dry'] !== 'boolean') return deny('RS_MODE_POLICY_DENIED', 'DRY_NOT_BOOLEAN', route);
  if (body['dry'] !== true) return deny('RS_MODE_POLICY_DENIED', 'DRY_FALSE_COMMITTED_QUOTE', route);

  if ('depositAddress' in body || 'depositMemo' in body) {
    return deny('RS_DEPOSIT_ADDRESS_NOT_REQUEST_KNOWN', 'DEPOSIT_ADDRESS_IN_REQUEST', route);
  }
  const keys = Object.keys(body);
  if (keys.some((k) => MUTATION_KEYS.has(k))) {
    return deny('RS_MODE_POLICY_DENIED', 'MUTATION_MATERIAL_PRESENT', route);
  }
  if (keys.some((k) => !QUOTE_KEYS.has(k))) {
    return deny('RS_UNKNOWN_MATERIAL_FIELD', 'FIELD_OUTSIDE_PROFILE', route);
  }

  let validated: ReturnType<typeof validateQuoteRequest>;
  try {
    validated = validateQuoteRequest(body);
  } catch (error) {
    const code: ErrorCode = isRouteSpecError(error) ? error.code : 'RS_MATERIAL_INVALID';
    return deny(code, 'MATERIAL_INVALID', route);
  }
  if (validated.material.dry !== true) {
    // Unreachable after the checks above; kept so a schema change cannot silently relax it.
    return deny('RS_MODE_POLICY_DENIED', 'DRY_FALSE_COMMITTED_QUOTE', route);
  }

  const allowed: AllowedDryQuote = Object.freeze({
    allowed: true,
    method: 'POST',
    path: '/v0/quote',
    route: 'POST /v0/quote',
    material: validated.material,
    quoteRequestDigest: validated.quoteRequestDigest,
    forwardBody: Buffer.from(JSON.stringify(validated.material), 'utf8'),
    strippedInboundHeaders: Object.freeze(stripped),
  });
  issued.add(allowed);
  return allowed;
}

/** Envelope for a denial, with the boundary flags API-SPEC.md section 5 requires. */
export function denialEnvelope(denial: PolicyDenial, requestId: string) {
  return new RouteSpecError(denial.code, 'The request is not permitted in LIVE_DRY_PROBE.', {
    details: { reason: denial.reason, route: denial.route, ...denial.boundary },
  }).toEnvelope(requestId);
}

// ---------------------------------------------------------------------------------------------
// Fidelity matrix (M51, ADR-0027): the official token list.
//
// A second, separately classified read: a bare `GET /v0/tokens` (no query, no body). It is only
// consulted by an adapter that was started with an explicit token-list budget; the default
// classifier above still denies the route. The read is public, so the egress never attaches the
// provider credential to it (the vault only releases the credential for a dry-quote allowance).

export interface AllowedTokenList {
  readonly allowed: true;
  readonly method: 'GET';
  readonly path: '/v0/tokens';
  readonly route: 'GET /v0/tokens';
  readonly strippedInboundHeaders: readonly string[];
}

const issuedTokenList = new WeakSet<object>();

export function isIssuedTokenListAllowance(value: unknown): value is AllowedTokenList {
  return typeof value === 'object' && value !== null && issuedTokenList.has(value);
}

/** Classify a token-list read. Never throws; never touches the network or the credential. */
export function classifyTokenListRequest(req: InboundRequest): AllowedTokenList | PolicyDenial {
  const method = typeof req.method === 'string' ? req.method.toUpperCase().slice(0, 16) : '';
  const stripped = strippedNames(req.headers);
  const route = 'GET /v0/tokens';
  const deny = (reason: string, label = route): PolicyDenial =>
    Object.freeze({
      allowed: false,
      code: 'RS_MODE_POLICY_DENIED',
      reason,
      route: label,
      method,
      strippedInboundHeaders: Object.freeze(stripped),
      boundary: DENIAL_BOUNDARY,
    });
  const target = typeof req.target === 'string' ? req.target : '';
  const q = target.indexOf('?');
  const path = q === -1 ? target : target.slice(0, q);
  if (path !== '/v0/tokens') return deny('NOT_TOKEN_LIST_ROUTE', 'UNLISTED');
  if (method !== 'GET') return deny('METHOD_NOT_ALLOWLISTED');
  if (q !== -1) return deny('QUERY_NOT_ALLOWED');
  const encoding = (header(req.headers, 'content-encoding') ?? 'identity').toLowerCase().trim();
  if (encoding !== 'identity') return deny('BODY_ENCODED');
  if (!Buffer.isBuffer(req.body) || req.body.length !== 0) return deny('BODY_NOT_ALLOWED');
  const allowed: AllowedTokenList = Object.freeze({
    allowed: true,
    method: 'GET',
    path: '/v0/tokens',
    route,
    strippedInboundHeaders: Object.freeze(stripped),
  });
  issuedTokenList.add(allowed);
  return allowed;
}
