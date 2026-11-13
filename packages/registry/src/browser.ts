/**
 * `@routespec/registry/browser` — what the static verify page (M49) runs in a browser.
 *
 * It uses only WebCrypto, `fetch`, `TextEncoder` and zod, and reaches the same answer as
 * `routespec certificate verify --digest`: the bundle digest is the SHA-256 of the archive bytes,
 * every certificate signature is checked locally with Ed25519, and the release decision comes
 * from the same `aggregateReleaseWith` the CLI uses (digest only, REQUIRE_ONCHAIN_ATTESTER).
 *
 * What the RPC endpoint is trusted for is the same as for the CLI: it cannot invent a certificate
 * for a pinned key, but it can hide certificates and misreport enrolment and revocation.
 */
import { z } from 'zod';
import { badgeStatus, shieldsBadge, type BadgeStatus, type ShieldsEndpointBadge } from './badge.ts';
import { isPublicKeyText, publicKeyBytes } from './key-text.ts';
import {
  CERTIFICATE_PAYLOAD_DOMAIN,
  certificateFieldError,
  isBundleDigest,
  isProjectKey,
  isRegistryAccountId,
  payloadText,
  type CertificateFields,
} from './payload.ts';
import {
  aggregateReleaseWith,
  type AttesterState,
  type OnchainCertificate,
  type ReleaseDecision,
} from './release-core.ts';
import {
  attester,
  attesterView,
  certificate,
  certificateView,
  count,
  info,
  infoView,
  latestCertificate,
  MAX_CERTIFICATES_PER_BUNDLE,
  MAX_PAGE,
  type RegistryInfo,
} from './views.ts';

export { isPublicKeyText } from './key-text.ts';
export * from './badge.ts';
export { CERTIFICATE_PAYLOAD_DOMAIN, isBundleDigest, isProjectKey, isRegistryAccountId } from './payload.ts';
export type {
  AttesterState,
  CertificateAssessment,
  OnchainCertificate,
  ReleaseDecision,
} from './release-core.ts';
export type { RegistryInfo } from './views.ts';

export type BrowserVerifyErrorCode =
  | 'INPUT_INVALID'
  | 'RPC_UNAVAILABLE'
  | 'REGISTRY_REJECTED'
  | 'NOT_A_REGISTRY'
  | 'NETWORK_MISMATCH'
  | 'BROWSER_UNSUPPORTED';

export class BrowserVerifyError extends Error {
  readonly code: BrowserVerifyErrorCode;
  /** A short machine reason (for example `UNKNOWN_ACCOUNT`), when there is one. */
  readonly reason: string | null;
  constructor(code: BrowserVerifyErrorCode, message: string, reason: string | null = null) {
    super(message);
    this.name = 'BrowserVerifyError';
    this.code = code;
    this.reason = reason;
  }
}

/** The exact signing payload bytes (same as the CLI's `signingPayload`). */
export function payloadBytes(f: CertificateFields): Uint8Array {
  const reason = certificateFieldError(f);
  if (reason !== null)
    throw new BrowserVerifyError('INPUT_INVALID', 'A certificate field is not valid.', reason);
  return new TextEncoder().encode(payloadText(f));
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** `sha256:<hex>` of the given bytes: the digest of an evidence bundle archive. */
export async function sha256Digest(bytes: Uint8Array | ArrayBuffer): Promise<string> {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return `sha256:${hex(await crypto.subtle.digest('SHA-256', view as Uint8Array<ArrayBuffer>))}`;
}

const SIGNATURE_TEXT = /^[A-Za-z0-9+/]{86}==$/;

function base64Bytes(text: string): Uint8Array {
  const raw = atob(text);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Whether the certificate's attester signed exactly its fields for `registry`. Never throws for a
 * malformed certificate (it is simply not valid); throws `BROWSER_UNSUPPORTED` when this browser
 * has no WebCrypto Ed25519, so a missing capability is never shown as a bad signature.
 */
export async function verifyCertificateSignature(registry: string, c: OnchainCertificate): Promise<boolean> {
  const fields: CertificateFields = {
    registry,
    project: c.project,
    bundleDigest: c.bundleDigest,
    verdict: c.verdict,
    corpusDigest: c.corpusDigest,
    artifactDigest: c.artifactDigest,
    commit: c.commit,
    timestampMs: c.timestampMs,
  };
  if (certificateFieldError(fields) !== null) return false;
  const key = publicKeyBytes(c.attester);
  if (key === null) return false;
  if (typeof c.signature !== 'string' || !SIGNATURE_TEXT.test(c.signature)) return false;
  const signature = base64Bytes(c.signature);
  if (signature.length !== 64) return false;
  let cryptoKey: Awaited<ReturnType<typeof crypto.subtle.importKey>>;
  try {
    cryptoKey = await crypto.subtle.importKey(
      'raw',
      key as Uint8Array<ArrayBuffer>,
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
  } catch (error) {
    if (error instanceof Error && error.name === 'NotSupportedError') {
      throw new BrowserVerifyError(
        'BROWSER_UNSUPPORTED',
        'This browser cannot check Ed25519 signatures (WebCrypto Ed25519 is missing).',
      );
    }
    return false;
  }
  try {
    return await crypto.subtle.verify(
      { name: 'Ed25519' },
      cryptoKey,
      signature as Uint8Array<ArrayBuffer>,
      payloadBytes(fields) as Uint8Array<ArrayBuffer>,
    );
  } catch {
    return false;
  }
}

export interface DigestAssessmentInput {
  readonly registry: string;
  readonly bundleDigest: string;
  readonly certificates: readonly OnchainCertificate[];
  readonly attesters: Readonly<Record<string, AttesterState | null>>;
  readonly trustedAttesters: readonly string[];
}

/** The digest-only release decision (what `certificate verify --digest` computes). */
export async function assessDigest(input: DigestAssessmentInput): Promise<ReleaseDecision> {
  const valid = new Map<OnchainCertificate, boolean>();
  for (const c of input.certificates) valid.set(c, await verifyCertificateSignature(input.registry, c));
  return aggregateReleaseWith(
    { ...input, local: null, policy: 'REQUIRE_ONCHAIN_ATTESTER' },
    (c) => valid.get(c) === true,
  );
}

// ---------------------------------------------------------------------------------------------
// Read-only NEAR JSON-RPC
// ---------------------------------------------------------------------------------------------

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function isLoopbackRpc(url: URL): boolean {
  return LOOPBACK_HOSTS.has(url.hostname);
}

/** The endpoint rules of the CLI: https, or http on a loopback host only; no credentials. */
export function assertRpcUrl(text: string): URL {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new BrowserVerifyError('INPUT_INVALID', 'The RPC endpoint is not a URL.');
  }
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && isLoopbackRpc(url)))) {
    throw new BrowserVerifyError(
      'INPUT_INVALID',
      'The RPC endpoint must use https (http is accepted for a loopback node only).',
    );
  }
  if (url.username !== '' || url.password !== '' || url.hash !== '') {
    throw new BrowserVerifyError(
      'INPUT_INVALID',
      'The RPC endpoint must not carry credentials or a fragment.',
    );
  }
  return url;
}

function obj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function unavailable(message: string, reason: string | null = null): never {
  throw new BrowserVerifyError('RPC_UNAVAILABLE', message, reason);
}

function rejected(source: unknown, fallback: string): never {
  const text = typeof source === 'string' ? source : JSON.stringify(source ?? '');
  const reason =
    /RSREG_[A-Z0-9_]+(?::[a-z_]+)?/.exec(text)?.[0] ??
    /\b(MethodNotFound|CodeDoesNotExist|AccountDoesNotExist)\b/.exec(text)?.[1] ??
    /\b(UNKNOWN_ACCOUNT|NO_CONTRACT_CODE|CONTRACT_EXECUTION_ERROR)\b/.exec(text)?.[1] ??
    fallback;
  throw new BrowserVerifyError('REGISTRY_REJECTED', 'The registry refused the request.', reason.slice(0, 80));
}

async function boundedText(response: Response): Promise<string> {
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      unavailable('The RPC response exceeds the size limit.');
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  return new TextDecoder().decode(all);
}

export interface NearViewReaderOptions {
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
}

/** View calls only: this reader cannot sign or send anything. Finality is always `final`. */
export class NearViewReader {
  readonly url: URL;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private nextId = 1;

  constructor(url: string, options: NearViewReaderOptions = {}) {
    this.url = assertRpcUrl(url);
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.fetchImpl = options.fetch ?? ((...args) => fetch(...args));
  }

  async request(method: string, params: unknown): Promise<{ result?: unknown; error?: unknown }> {
    let response: Response;
    let text: string;
    try {
      response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params }),
        redirect: 'error',
        credentials: 'omit',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const length = Number(response.headers.get('content-length') ?? '0');
      if (length > MAX_RESPONSE_BYTES) unavailable('The RPC response exceeds the size limit.');
      text = await boundedText(response);
    } catch (error) {
      if (error instanceof BrowserVerifyError) throw error;
      unavailable(
        'The NEAR RPC endpoint could not be reached.',
        error instanceof Error ? error.name.slice(0, 40) : null,
      );
    }
    let body: Record<string, unknown> | null;
    try {
      body = obj(JSON.parse(text));
    } catch {
      body = null;
    }
    if (body === null || (!('result' in body) && !('error' in body))) {
      unavailable(
        'The NEAR RPC endpoint answered with something that is not JSON-RPC.',
        String(response.status),
      );
    }
    return body;
  }

  async chainId(): Promise<string> {
    const { result, error } = await this.request('status', []);
    const id = obj(result)?.['chain_id'];
    if (error !== undefined || typeof id !== 'string') unavailable('The node did not report its chain id.');
    return id.slice(0, 64);
  }

  async view(
    accountId: string,
    methodName: string,
    args: Record<string, unknown>,
  ): Promise<{ value: unknown; blockHeight: number }> {
    const argText = new TextEncoder().encode(JSON.stringify(args));
    let binary = '';
    for (const b of argText) binary += String.fromCharCode(b);
    const { result, error } = await this.request('query', {
      request_type: 'call_function',
      finality: 'final',
      account_id: accountId,
      method_name: methodName,
      args_base64: btoa(binary),
    });
    if (error !== undefined) rejected(error, 'VIEW_FAILED');
    const r = obj(result);
    if (r === null) unavailable('The view call returned no result.');
    if (typeof r['error'] === 'string') rejected(r['error'], 'VIEW_FAILED');
    const bytes = r['result'];
    const height = r['block_height'];
    if (
      !Array.isArray(bytes) ||
      typeof height !== 'number' ||
      !bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)
    ) {
      unavailable('The view call returned an unexpected shape.');
    }
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes as number[])));
    } catch {
      unavailable('The view call did not return JSON.');
    }
    return { value, blockHeight: height };
  }

  /** The code hash (base58 of the SHA-256 of the deployed wasm) of an account. */
  async codeHash(accountId: string): Promise<string> {
    const { result, error } = await this.request('query', {
      request_type: 'view_account',
      finality: 'final',
      account_id: accountId,
    });
    if (error !== undefined) rejected(error, 'UNKNOWN_ACCOUNT');
    const hash = obj(result)?.['code_hash'];
    if (typeof hash !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(hash)) {
      unavailable('The account query returned an unexpected shape.');
    }
    return hash;
  }
}

function shape<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) unavailable('The registry returned an unexpected shape.', what);
  return parsed.data;
}

/** The registry views the page needs, each answer checked against the closed view shapes. */
export class BrowserRegistryReader {
  readonly rpc: NearViewReader;
  readonly accountId: string;

  constructor(rpc: NearViewReader, accountId: string) {
    if (!isRegistryAccountId(accountId)) {
      throw new BrowserVerifyError('INPUT_INVALID', 'The registry must be a NEAR account id.');
    }
    this.rpc = rpc;
    this.accountId = accountId;
  }

  async info(): Promise<RegistryInfo & { readonly blockHeight: number }> {
    const { value, blockHeight } = await this.rpc.view(this.accountId, 'get_info', {});
    return { ...info(shape(infoView, value, 'get_info')), blockHeight };
  }

  async getAttester(publicKey: string): Promise<AttesterState | null> {
    const { value } = await this.rpc.view(this.accountId, 'get_attester', { public_key: publicKey });
    return value === null ? null : attester(shape(attesterView, value, 'get_attester'));
  }

  async certificatesByBundle(
    bundleDigest: string,
  ): Promise<{ certificates: OnchainCertificate[]; blockHeight: number }> {
    const { value, blockHeight } = await this.rpc.view(this.accountId, 'get_certificates_by_bundle', {
      bundle_digest: bundleDigest,
    });
    const list = shape(z.array(certificateView).max(MAX_CERTIFICATES_PER_BUNDLE), value, 'by_bundle');
    return { certificates: list.map(certificate), blockHeight };
  }

  async projectCertificateCount(project: string): Promise<number> {
    const { value } = await this.rpc.view(this.accountId, 'get_project_certificate_count', { project });
    return shape(count, value, 'project_count');
  }

  async certificatesByProject(
    project: string,
    fromIndex: number,
    limit: number,
  ): Promise<OnchainCertificate[]> {
    const { value } = await this.rpc.view(this.accountId, 'get_certificates_by_project', {
      project,
      from_index: fromIndex,
      limit,
    });
    return shape(z.array(certificateView).max(MAX_PAGE), value, 'by_project').map(certificate);
  }
}

export interface PageVerificationRequest {
  readonly rpcUrl: string;
  readonly registry: string;
  readonly bundleDigest: string;
  /** Pinned attester keys; empty: any attester the registry reports enrolled and not revoked. */
  readonly trustedAttesters: readonly string[];
  /** The chain id the endpoint must report (`testnet`, `mainnet`); null: not checked. */
  readonly expectedChainId: string | null;
  /** Code hashes of known reproducible registry builds; empty: not checked. */
  readonly knownCodeHashes: readonly string[];
  readonly fetch?: typeof fetch;
}

export interface PageVerification {
  readonly bundleDigest: string;
  readonly chainId: string;
  readonly registry: {
    readonly accountId: string;
    readonly ownerId: string;
    readonly version: string;
    readonly codeHash: string;
    readonly codeHashKnown: boolean | null;
    readonly readAtBlockHeight: number;
  };
  readonly release: ReleaseDecision;
  readonly certificates: ReadonlyArray<
    OnchainCertificate & { readonly accepted: boolean; findings: readonly string[] }
  >;
  readonly attesters: Readonly<Record<string, AttesterState | null>>;
  readonly trustedAttesters: readonly string[];
  readonly status: BadgeStatus;
  readonly badge: ShieldsEndpointBadge;
}

function checkKeys(keys: readonly string[]): string[] {
  for (const k of keys) {
    if (!isPublicKeyText(k))
      throw new BrowserVerifyError('INPUT_INVALID', 'Attester keys are written ed25519:<base58>.');
  }
  return [...new Set(keys)];
}

async function connect(
  request: Pick<PageVerificationRequest, 'rpcUrl' | 'registry' | 'expectedChainId' | 'fetch'>,
): Promise<{ reader: BrowserRegistryReader; chainId: string }> {
  const rpc = new NearViewReader(request.rpcUrl, request.fetch === undefined ? {} : { fetch: request.fetch });
  const reader = new BrowserRegistryReader(rpc, request.registry);
  const chainId = await rpc.chainId();
  if (request.expectedChainId !== null && chainId !== request.expectedChainId) {
    throw new BrowserVerifyError('NETWORK_MISMATCH', 'The RPC endpoint serves a different network.', chainId);
  }
  return { reader, chainId };
}

/** Read the registry for one bundle digest and assess it exactly as the CLI does. */
export async function verifyDigestOnChain(request: PageVerificationRequest): Promise<PageVerification> {
  if (!isBundleDigest(request.bundleDigest)) {
    throw new BrowserVerifyError('INPUT_INVALID', 'A bundle digest is written sha256:<64 lowercase hex>.');
  }
  const trustedAttesters = checkKeys(request.trustedAttesters);
  const { reader, chainId } = await connect(request);
  const registryInfo = await reader.info();
  if (
    registryInfo.contract !== 'routespec-registry' ||
    registryInfo.payloadDomain !== CERTIFICATE_PAYLOAD_DOMAIN
  ) {
    throw new BrowserVerifyError(
      'NOT_A_REGISTRY',
      'The account is not a RouteSpec registry of this version.',
      'NOT_A_ROUTESPEC_REGISTRY',
    );
  }
  const codeHash = await reader.rpc.codeHash(reader.accountId);
  const codeHashKnown =
    request.knownCodeHashes.length === 0 ? null : request.knownCodeHashes.includes(codeHash);
  const { certificates, blockHeight } = await reader.certificatesByBundle(request.bundleDigest);
  const attesters: Record<string, AttesterState | null> = {};
  for (const key of new Set([...certificates.map((c) => c.attester), ...trustedAttesters])) {
    attesters[key] = await reader.getAttester(key);
  }
  const release = await assessDigest({
    registry: reader.accountId,
    bundleDigest: request.bundleDigest,
    certificates,
    attesters,
    trustedAttesters,
  });
  const status = badgeStatus(release, codeHashKnown);
  const byId = new Map(release.certificates.map((a) => [a.id, a]));
  return {
    bundleDigest: request.bundleDigest,
    chainId,
    registry: {
      accountId: reader.accountId,
      ownerId: registryInfo.ownerId,
      version: registryInfo.version,
      codeHash,
      codeHashKnown,
      readAtBlockHeight: blockHeight,
    },
    release,
    certificates: certificates.map((c) => ({
      ...c,
      accepted: byId.get(c.id)?.accepted ?? false,
      findings: byId.get(c.id)?.findings ?? [],
    })),
    attesters,
    trustedAttesters,
    status,
    badge: shieldsBadge(status),
  };
}

/** How far back from the newest certificate a project lookup searches. */
export const PROJECT_LOOKBACK = 200;

/**
 * The bundle digest of a project's newest certificate (from a pinned attester, when keys are
 * pinned), or null when there is none in the newest `PROJECT_LOOKBACK` certificates.
 */
export async function latestProjectDigest(
  request: Pick<
    PageVerificationRequest,
    'rpcUrl' | 'registry' | 'expectedChainId' | 'fetch' | 'trustedAttesters'
  > & {
    readonly project: string;
  },
): Promise<{ bundleDigest: string; certificateId: number; projectCertificates: number } | null> {
  if (!isProjectKey(request.project))
    throw new BrowserVerifyError('INPUT_INVALID', 'The project key is not valid.');
  const trusted = checkKeys(request.trustedAttesters);
  const { reader } = await connect(request);
  const total = await reader.projectCertificateCount(request.project);
  for (let end = total; end > 0 && total - end < PROJECT_LOOKBACK; end -= MAX_PAGE) {
    const from = Math.max(0, end - MAX_PAGE);
    const page = await reader.certificatesByProject(request.project, from, end - from);
    const found = latestCertificate(page, request.project, trusted);
    if (found !== null) {
      return { bundleDigest: found.bundleDigest, certificateId: found.id, projectCertificates: total };
    }
  }
  return null;
}
