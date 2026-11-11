/**
 * Browser-attack boundary of the loopback control API (FR-02, FR-17, SECURITY.md, AC-06).
 *
 * - Bind: only the literal loopback addresses 127.0.0.1 and ::1; anything else is refused before
 *   a socket is opened.
 * - Host: exact match against the generated local origin set for the bound port (DNS-rebinding
 *   defence). A rebinding page reaches the listener with its own host name and is refused.
 * - Origin and Fetch Metadata: a browser request must be same-origin. A present `Origin` must be
 *   exactly the service origin (`null` is refused); `Sec-Fetch-Site` other than `same-origin` or
 *   `none` is refused. No `Access-Control-Allow-Origin` is ever sent for a foreign origin.
 * - Authentication: an ephemeral control bearer token generated at start, held in memory, sent
 *   only in `Authorization: Bearer`. It is never accepted from a query string or cookie, and a
 *   case token (`X-RouteSpec-Case-Token` or an `rsct_` bearer) is never a control credential.
 * - CSRF: mutations additionally require `application/json` (not a CORS-simple content type), a
 *   bearer header a web page cannot attach cross-origin without a preflight that is refused.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { RouteSpecError } from '@routespec/contracts';

export const CONTROL_PREFIX = '/__routespec/v1';
export const LOOPBACK_BIND_ADDRESSES = Object.freeze(['127.0.0.1', '::1'] as const);
export type LoopbackBindAddress = (typeof LOOPBACK_BIND_ADDRESSES)[number];

export function assertLoopbackBind(host: string): asserts host is LoopbackBindAddress {
  if (!(LOOPBACK_BIND_ADDRESSES as readonly string[]).includes(host)) {
    throw new RouteSpecError('RS_MODE_POLICY_DENIED', 'The control API binds only to a loopback address.', {
      details: { host: host.slice(0, 64) },
    });
  }
}

export interface OriginPolicy {
  readonly hosts: ReadonlySet<string>;
  readonly origins: ReadonlySet<string>;
  readonly primaryOrigin: string;
}

export function originPolicy(bind: LoopbackBindAddress, port: number): OriginPolicy {
  const names = bind === '::1' ? ['[::1]', 'localhost'] : ['127.0.0.1', 'localhost'];
  const hosts = new Set(names.map((h) => `${h}:${port}`));
  const origins = new Set(names.map((h) => `http://${h}:${port}`));
  return { hosts, origins, primaryOrigin: `http://${names[0]}:${port}` };
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  if (Array.isArray(v)) throw new RouteSpecError('RS_HEADER_INVALID', `Header ${name} must appear once.`);
  return v;
}

/** Host, Origin, and Fetch Metadata checks shared by every route (static assets included). */
export function checkBrowserBoundary(req: IncomingMessage, policy: OriginPolicy): void {
  const host = header(req, 'host');
  if (host === undefined || !policy.hosts.has(host.toLowerCase())) {
    throw new RouteSpecError('RS_HOST_REJECTED', 'The Host header is not a local RouteSpec origin.');
  }
  const origin = header(req, 'origin');
  if (origin !== undefined && !policy.origins.has(origin.toLowerCase())) {
    throw new RouteSpecError('RS_ORIGIN_REJECTED', 'Cross-origin requests are not accepted.');
  }
  const site = header(req, 'sec-fetch-site');
  if (site !== undefined && site !== 'same-origin' && site !== 'none') {
    throw new RouteSpecError('RS_ORIGIN_REJECTED', 'Cross-site requests are not accepted.');
  }
}

function digest(value: string): Buffer {
  return createHash('sha256').update(`routespec.control-token/1\n${value}`, 'utf8').digest();
}

/** Ephemeral control credential. Only its digest is compared; the value is memory-only. */
export class ControlToken {
  readonly #value: string;
  readonly #digest: Buffer;

  constructor(value?: string) {
    this.#value = value ?? `rsctl_${randomBytes(32).toString('base64url')}`;
    this.#digest = digest(this.#value);
  }

  /** The clear value, for the one-time console handoff URL / launching process only. */
  reveal(): string {
    return this.#value;
  }

  matches(presented: string): boolean {
    const d = digest(presented);
    return d.length === this.#digest.length && timingSafeEqual(d, this.#digest);
  }
}

export function authenticate(req: IncomingMessage, token: ControlToken): void {
  if (req.headers['x-routespec-case-token'] !== undefined) {
    throw new RouteSpecError('RS_CONTROL_AUTH_INVALID', 'A case token is not a control credential.');
  }
  const auth = header(req, 'authorization');
  if (auth === undefined || auth.length === 0) {
    throw new RouteSpecError('RS_CONTROL_AUTH_REQUIRED', 'Control requests require the local bearer token.');
  }
  const m = /^Bearer ([A-Za-z0-9._~-]{16,256})$/.exec(auth);
  if (!m || (m[1] as string).startsWith('rsct_') || !token.matches(m[1] as string)) {
    throw new RouteSpecError('RS_CONTROL_AUTH_INVALID', 'The control token is not valid for this service.');
  }
}

/** Query-string credentials are refused outright (they leak through logs and history). */
export function assertNoQueryCredential(url: URL): void {
  for (const key of url.searchParams.keys()) {
    if (/^(token|access_token|auth|authorization|bearer|key)$/i.test(key)) {
      throw new RouteSpecError('RS_CONTROL_AUTH_INVALID', 'Credentials are not accepted in the URL.');
    }
  }
}

export const CONSOLE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');
