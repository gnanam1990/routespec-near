/**
 * Memory-only provider credential container (SECURITY.md section 5, FR-16, NFR-08).
 *
 * The provider JWT is read from the adapter's own protected environment variable only after the
 * launch preflight passed, and the variable is deleted from `process.env` as it is read. The
 * value lives in one private field. It is never serializable: `toJSON`, `util.inspect` and
 * `String()` all expose only the token state. It is only released into an outbound header for a
 * request the policy module issued an allowance for, and only after the TLS connection to the
 * pinned address has been verified (see egress.ts). Releasing drops the reference; a managed
 * runtime gives no guarantee of physical erasure, and this module does not claim one.
 */
import { inspect } from 'node:util';
import { RouteSpecError, type ProviderTokenState } from '@routespec/contracts';
import { isIssuedAllowance, type AllowedDryQuote } from './policy.ts';

export const PROVIDER_JWT_ENV = 'ROUTESPEC_PROVIDER_JWT';

export type CredentialPolicy = 'NONE' | 'OPTIONAL';

function decodeExpiry(token: string): number | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) {
    throw new RouteSpecError('RS_TOKEN_INVALID', 'Provider credential is not a compact JWT.');
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
  } catch {
    throw new RouteSpecError('RS_TOKEN_INVALID', 'Provider credential payload is not JSON.');
  }
  if (payload === null || typeof payload !== 'object') {
    throw new RouteSpecError('RS_TOKEN_INVALID', 'Provider credential payload is not an object.');
  }
  const exp = (payload as Record<string, unknown>)['exp'];
  if (exp === undefined) return null;
  if (typeof exp !== 'number' || !Number.isFinite(exp)) {
    throw new RouteSpecError('RS_TOKEN_INVALID', 'Provider credential expiry is malformed.');
  }
  return exp * 1000;
}

export class ProviderCredentialVault {
  readonly #policy: CredentialPolicy;
  readonly #now: () => number;
  #token: string | null = null;
  #expiresAtMs: number | null = null;
  #attachments = 0;
  #released = false;

  constructor(policy: CredentialPolicy, now: () => number = Date.now) {
    this.#policy = policy;
    this.#now = now;
  }

  /**
   * Read and remove the protected environment variable. Called once, after preflight. With policy
   * NONE a supplied value is removed and ignored.
   */
  loadFromProtectedEnv(env: NodeJS.ProcessEnv = process.env): ProviderTokenState {
    const value = env[PROVIDER_JWT_ENV];
    delete env[PROVIDER_JWT_ENV];
    if (this.#policy === 'NONE' || value === undefined || value === '') return this.state();
    const expiresAtMs = decodeExpiry(value.trim());
    this.#token = value.trim();
    this.#expiresAtMs = expiresAtMs;
    return this.state();
  }

  state(): ProviderTokenState {
    if (this.#policy === 'NONE') return 'NOT_REQUIRED';
    if (this.#expiresAtMs !== null && this.#expiresAtMs <= this.#now()) {
      this.#token = null;
      return 'EXPIRED';
    }
    return this.#token === null ? 'OPTIONAL_ABSENT' : 'PRESENT_IN_MEMORY';
  }

  get attachments(): number {
    return this.#attachments;
  }

  /** Fail before DNS when the request would need a credential that has expired. */
  assertUsable(): void {
    if (this.state() === 'EXPIRED') {
      throw new RouteSpecError('RS_TOKEN_EXPIRED', 'Provider credential expired; nothing was sent.', {
        details: { credentialAttached: false, dnsAttempted: false, upstreamAttempted: false },
      });
    }
  }

  /**
   * Return the Authorization header value for an issued allowance, or null when no credential is
   * held. Anything other than a policy-issued allowance is refused.
   */
  authorizationFor(allowance: AllowedDryQuote): string | null {
    if (!isIssuedAllowance(allowance)) {
      throw new RouteSpecError('RS_MODE_POLICY_DENIED', 'Credential requested without a policy allowance.', {
        details: { credentialAttached: false },
      });
    }
    this.assertUsable();
    if (this.#token === null) return null;
    this.#attachments++;
    return `Bearer ${this.#token}`;
  }

  /** Stop using the value (stop, expiry, disconnect). */
  release(): void {
    this.#token = null;
    this.#expiresAtMs = null;
    this.#released = true;
  }

  get released(): boolean {
    return this.#released;
  }

  toJSON(): { tokenState: ProviderTokenState } {
    return { tokenState: this.state() };
  }

  toString(): string {
    return `[ProviderCredentialVault ${this.state()}]`;
  }

  [inspect.custom](): string {
    return this.toString();
  }
}
