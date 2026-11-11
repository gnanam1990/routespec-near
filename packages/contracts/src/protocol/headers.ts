/**
 * Stable actual-client adapter correlation headers (API-SPEC.md section 1/5, FR-03).
 *
 * Every RouteSpec-local header plus any provider `Authorization` must be stripped before a
 * live upstream boundary. Header names are compared case-insensitively.
 */
export const ROUTESPEC_HEADERS = Object.freeze({
  session: 'x-routespec-session',
  caseRun: 'x-routespec-case-run',
  logicalJob: 'x-routespec-logical-job',
  requestId: 'x-routespec-request-id',
  adapter: 'x-routespec-adapter',
  fencingEpoch: 'x-routespec-fencing-epoch',
  caseToken: 'x-routespec-case-token',
  runOperation: 'x-routespec-run-operation',
} as const);

const LOCAL_PREFIX = 'x-routespec-';
const ALWAYS_STRIPPED = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie']);

export function isRouteSpecLocalHeader(name: string): boolean {
  return name.toLowerCase().startsWith(LOCAL_PREFIX);
}

/**
 * Return a copy of `headers` without RouteSpec-local headers or credential-bearing headers.
 * The input is not mutated. Used at every live-upstream boundary.
 */
export function stripForUpstream(headers: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower.startsWith(LOCAL_PREFIX) || ALWAYS_STRIPPED.has(lower)) continue;
    out[name] = value;
  }
  return out;
}
