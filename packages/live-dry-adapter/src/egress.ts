/**
 * Pinned upstream egress for one allowed dry quote (SECURITY.md section 7; T-020, T-038).
 *
 * Order of operations, each step reached only if the previous one passed:
 *   1. the request carries a policy-issued allowance (policy.ts) and the credential is usable;
 *   2. the pinned host is resolved once; every answer must be global unicast (address-policy.ts);
 *   3. one TLS connection is opened to that exact validated address with SNI and certificate
 *      validation against the pinned host name; no DNS happens at connect time, so a second,
 *      rebound answer can never be used;
 *   4. only after the handshake is authorized is the credential released into the request;
 *   5. one HTTP/1.1 request is written with a fixed header set and the re-serialized body.
 * Redirects are never followed, encoded responses are refused (no decompression), and response
 * size and total time are bounded. No agent is used, so proxy environment variables cannot route
 * the connection. Nothing is retried.
 */
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { promises as dnsPromises } from 'node:dns';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { performance } from 'node:perf_hooks';
import { RouteSpecError, isRouteSpecError } from '@routespec/contracts';
import { pinResolvedAddresses, type CompiledOrigin } from './address-policy.ts';
import type { ProviderCredentialVault } from './credential.ts';
import {
  isIssuedAllowance,
  isIssuedTokenListAllowance,
  type AllowedDryQuote,
  type AllowedTokenList,
} from './policy.ts';

export interface ResolvedAnswer {
  readonly address: string;
  readonly family: number;
}

export interface ConnectTarget {
  readonly address: string;
  readonly family: 4 | 6;
  readonly port: 443;
  readonly servername: string;
}

export interface EgressTransport {
  readonly label: string;
  resolve(hostname: string): Promise<readonly ResolvedAnswer[]>;
  connect(target: ConnectTarget): TLSSocket;
}

const systemTransports = new WeakSet<EgressTransport>();

const SYSTEM_TRANSPORT: EgressTransport = Object.freeze({
  label: 'SYSTEM_DNS_SYSTEM_TLS',
  async resolve(hostname: string) {
    return dnsPromises.lookup(hostname, { all: true, order: 'verbatim' });
  },
  connect(target: ConnectTarget) {
    return tlsConnect({
      host: target.address,
      port: target.port,
      servername: target.servername,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
      ALPNProtocols: ['http/1.1'],
    });
  },
});
systemTransports.add(SYSTEM_TRANSPORT);

/** The production transport: operating-system DNS and the default trusted CA store. */
export function systemTransport(): EgressTransport {
  return SYSTEM_TRANSPORT;
}

/** Only the built-in transport can produce an official-endpoint claim; an injected one cannot. */
export function isSystemTransport(transport: EgressTransport): boolean {
  return systemTransports.has(transport);
}

export interface EgressLimits {
  readonly dnsTimeoutMs: number;
  readonly connectTimeoutMs: number;
  readonly totalTimeoutMs: number;
  readonly maxResponseBytes: number;
  readonly maxHeaderBytes: number;
}

export const DEFAULT_EGRESS_LIMITS: EgressLimits = Object.freeze({
  dnsTimeoutMs: 5_000,
  connectTimeoutMs: 5_000,
  totalTimeoutMs: 15_000,
  maxResponseBytes: 256 * 1024,
  maxHeaderBytes: 16 * 1024,
});

export interface EgressCounters {
  resolverCalls: number;
  connectorCalls: number;
  upstreamRequests: number;
}

export interface EgressTiming {
  readonly dnsMs: number | null;
  readonly connectMs: number | null;
  readonly ttfbMs: number | null;
  readonly totalMs: number;
}

export type EgressFailureReason =
  | 'TOKEN_EXPIRED'
  | 'DNS_FAILED'
  | 'ADDRESS_DENIED'
  | 'CONNECT_FAILED'
  | 'ADDRESS_MISMATCH'
  | 'TLS_VERIFY_FAILED'
  | 'TIMEOUT'
  | 'REDIRECT_REJECTED'
  | 'ENCODING_REFUSED'
  | 'RESPONSE_TOO_LARGE'
  | 'PROTOCOL_ERROR';

export interface EgressBoundary {
  readonly credentialAttached: boolean;
  readonly dnsAttempted: boolean;
  readonly socketAttempted: boolean;
  readonly upstreamAttempted: boolean;
}

export type EgressOutcome =
  | {
      readonly kind: 'RESPONSE';
      readonly status: number;
      readonly contentType: string | null;
      readonly body: Buffer;
      readonly timing: EgressTiming;
      readonly boundary: EgressBoundary;
      readonly pinnedFamily: 4 | 6;
    }
  | {
      readonly kind: 'FAILED';
      readonly reason: EgressFailureReason;
      readonly status: number | null;
      readonly addressClasses: readonly string[];
      readonly timing: EgressTiming;
      readonly boundary: EgressBoundary;
    };

const CERT_ERRORS = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_UNTRUSTED',
  'CERT_REVOKED',
  'CERT_SIGNATURE_FAILURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'HOSTNAME_MISMATCH',
]);

export const UPSTREAM_USER_AGENT = 'routespec-live-dry-adapter/1.0.0';

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new RouteSpecError('RS_INTERNAL', 'timeout')), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error('rejected'));
      },
    );
  });
}

function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) return String((error as { code: unknown }).code);
  return 'UNKNOWN';
}

/**
 * Send one allowed dry quote to the pinned origin. Returns a bounded outcome; never throws for an
 * upstream failure and never includes provider error text or credential material.
 */
export async function sendDryQuote(input: {
  readonly allowance: AllowedDryQuote;
  readonly vault: ProviderCredentialVault;
  readonly origin: CompiledOrigin;
  readonly transport: EgressTransport;
  readonly counters: EgressCounters;
  readonly limits?: EgressLimits;
}): Promise<EgressOutcome> {
  const { allowance, vault } = input;
  if (!isIssuedAllowance(allowance)) {
    throw new RouteSpecError('RS_MODE_POLICY_DENIED', 'Egress requires a policy-issued allowance.', {
      details: { credentialAttached: false, dnsAttempted: false, upstreamAttempted: false },
    });
  }
  return pinnedExchange({
    origin: input.origin,
    transport: input.transport,
    counters: input.counters,
    limits: input.limits ?? DEFAULT_EGRESS_LIMITS,
    method: 'POST',
    path: '/v0/quote',
    body: allowance.forwardBody,
    assertUsable: () => vault.assertUsable(),
    authorization: () => vault.authorizationFor(allowance),
  });
}

/** The token list is larger than a quote; it gets its own response bound (ADR-0027). */
export const TOKEN_LIST_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/**
 * Read the official token list from the pinned origin (fidelity matrix, ADR-0027): one bare GET
 * over the same resolved, validated and pinned connection. The provider credential is never
 * attached: the vault is not an input here.
 */
export async function sendTokenListRequest(input: {
  readonly allowance: AllowedTokenList;
  readonly origin: CompiledOrigin;
  readonly transport: EgressTransport;
  readonly counters: EgressCounters;
  readonly limits?: EgressLimits;
}): Promise<EgressOutcome> {
  if (!isIssuedTokenListAllowance(input.allowance)) {
    throw new RouteSpecError('RS_MODE_POLICY_DENIED', 'Egress requires a policy-issued allowance.', {
      details: { credentialAttached: false, dnsAttempted: false, upstreamAttempted: false },
    });
  }
  const limits = input.limits ?? DEFAULT_EGRESS_LIMITS;
  return pinnedExchange({
    origin: input.origin,
    transport: input.transport,
    counters: input.counters,
    limits: {
      ...limits,
      maxResponseBytes: Math.max(limits.maxResponseBytes, TOKEN_LIST_MAX_RESPONSE_BYTES),
    },
    method: 'GET',
    path: '/v0/tokens',
    body: null,
    assertUsable: () => undefined,
    authorization: () => null,
  });
}

async function pinnedExchange(input: {
  readonly origin: CompiledOrigin;
  readonly transport: EgressTransport;
  readonly counters: EgressCounters;
  readonly limits: EgressLimits;
  readonly method: 'POST' | 'GET';
  readonly path: '/v0/quote' | '/v0/tokens';
  readonly body: Buffer | null;
  readonly assertUsable: () => void;
  readonly authorization: () => string | null;
}): Promise<EgressOutcome> {
  const { origin, transport, counters, limits, body } = input;
  const start = performance.now();
  const elapsed = () => Math.round(performance.now() - start);
  let dnsMs: number | null = null;
  let connectMs: number | null = null;
  let ttfbMs: number | null = null;
  const boundary = {
    credentialAttached: false,
    dnsAttempted: false,
    socketAttempted: false,
    upstreamAttempted: false,
  };
  const fail = (
    reason: EgressFailureReason,
    status: number | null = null,
    addressClasses: readonly string[] = [],
  ): EgressOutcome => ({
    kind: 'FAILED',
    reason,
    status,
    addressClasses,
    timing: { dnsMs, connectMs, ttfbMs, totalMs: elapsed() },
    boundary: { ...boundary },
  });

  try {
    input.assertUsable();
  } catch {
    return fail('TOKEN_EXPIRED');
  }

  // 2. Resolve once and pin.
  let answers: readonly ResolvedAnswer[];
  boundary.dnsAttempted = true;
  counters.resolverCalls++;
  try {
    answers = await withTimeout(Promise.resolve(transport.resolve(origin.hostname)), limits.dnsTimeoutMs);
  } catch {
    dnsMs = elapsed();
    return fail('DNS_FAILED');
  }
  dnsMs = elapsed();
  let pinned: { address: string; family: 4 | 6 };
  try {
    pinned = pinResolvedAddresses(answers);
  } catch (error) {
    const classes = isRouteSpecError(error) ? error.details['addressClasses'] : undefined;
    return fail('ADDRESS_DENIED', null, Array.isArray(classes) ? (classes as string[]) : []);
  }

  // 3. One TLS connection to the validated address.
  const connectStart = performance.now();
  boundary.socketAttempted = true;
  counters.connectorCalls++;
  let socket: TLSSocket;
  try {
    socket = transport.connect({
      address: pinned.address,
      family: pinned.family,
      port: origin.port,
      servername: origin.hostname,
    });
  } catch {
    return fail('CONNECT_FAILED');
  }
  const handshake = await new Promise<'ok' | EgressFailureReason>((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve('TIMEOUT');
    }, limits.connectTimeoutMs);
    const onSecure = () => {
      cleanup();
      resolve(socket.authorized ? 'ok' : 'TLS_VERIFY_FAILED');
    };
    const onError = (error: unknown) => {
      cleanup();
      resolve(CERT_ERRORS.has(errorCode(error)) ? 'TLS_VERIFY_FAILED' : 'CONNECT_FAILED');
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('secureConnect', onSecure);
      socket.off('error', onError);
    };
    socket.once('secureConnect', onSecure);
    socket.once('error', onError);
  });
  connectMs = Math.round(performance.now() - connectStart);
  if (handshake !== 'ok') {
    socket.destroy();
    return fail(handshake);
  }
  if (isSystemTransport(transport) && socket.remoteAddress !== pinned.address) {
    socket.destroy();
    return fail('ADDRESS_MISMATCH');
  }
  socket.on('error', () => undefined);

  // 4. Credential only now, for this issued allowance (never for the token-list read).
  let authorization: string | null;
  try {
    authorization = input.authorization();
  } catch {
    socket.destroy();
    return fail('TOKEN_EXPIRED');
  }
  const headers: Record<string, string> = {
    host: origin.hostname,
    accept: 'application/json',
    'accept-encoding': 'identity',
    'user-agent': UPSTREAM_USER_AGENT,
    connection: 'close',
  };
  if (body !== null) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(body.length);
  }
  if (authorization !== null) {
    headers['authorization'] = authorization;
    boundary.credentialAttached = true;
  }
  authorization = null;

  // 5. Exactly one request; bounded response.
  const sendStart = performance.now();
  boundary.upstreamAttempted = true;
  counters.upstreamRequests++;
  return new Promise<EgressOutcome>((resolve) => {
    let settled = false;
    const settle = (outcome: EgressOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(total);
      socket.destroy();
      resolve(outcome);
    };
    const total = setTimeout(
      () => {
        req.destroy();
        settle(fail('TIMEOUT'));
      },
      Math.max(1, limits.totalTimeoutMs - elapsed()),
    );
    const req = httpRequest({
      createConnection: () => socket,
      method: input.method,
      path: input.path,
      headers,
      setHost: false,
      maxHeaderSize: limits.maxHeaderBytes,
    });
    for (const key of Object.keys(headers)) delete headers[key];
    req.on('error', (error: unknown) => {
      settle(fail(CERT_ERRORS.has(errorCode(error)) ? 'TLS_VERIFY_FAILED' : 'PROTOCOL_ERROR'));
    });
    req.on('response', (res: IncomingMessage) => {
      ttfbMs = Math.round(performance.now() - sendStart);
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        res.destroy();
        settle(fail('REDIRECT_REJECTED', status));
        return;
      }
      const encoding = (res.headers['content-encoding'] ?? 'identity').toLowerCase().trim();
      if (encoding !== 'identity') {
        res.destroy();
        settle(fail('ENCODING_REFUSED', status));
        return;
      }
      const declared = Number(res.headers['content-length'] ?? '0');
      if (Number.isFinite(declared) && declared > limits.maxResponseBytes) {
        res.destroy();
        settle(fail('RESPONSE_TOO_LARGE', status));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > limits.maxResponseBytes) {
          res.destroy();
          settle(fail('RESPONSE_TOO_LARGE', status));
          return;
        }
        chunks.push(chunk);
      });
      res.on('error', () => settle(fail('PROTOCOL_ERROR', status)));
      res.on('end', () => {
        settle({
          kind: 'RESPONSE',
          status,
          contentType: typeof res.headers['content-type'] === 'string' ? res.headers['content-type'] : null,
          body: Buffer.concat(chunks),
          timing: { dnsMs, connectMs, ttfbMs, totalMs: elapsed() },
          boundary: { ...boundary },
          pinnedFamily: pinned.family,
        });
      });
    });
    if (body === null) req.end();
    else req.end(body);
  });
}
