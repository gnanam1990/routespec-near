/**
 * Domain-separated digests over the canonical encoding.
 *
 *   digest = SHA-256( "rs-canon/1" 0x00 domain 0x00 canonicalEncode(value) )
 *   rendered as "sha256:" + lowercase hex
 *
 * The algorithm is pinned (sha256). The `Digester` interface lets later modules supply a
 * different implementation (e.g. WebCrypto in a browser-free worker) without changing callers;
 * any alternative must reproduce the committed test vectors byte-for-byte.
 */
import { createHash } from 'node:crypto';
import { RouteSpecError } from '../errors.ts';
import { CANONICAL_ENCODING_VERSION, canonicalEncode, type CanonicalEncodeOptions } from './encoding.ts';

export const DIGEST_ALGORITHM = 'sha256' as const;
export const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

export type Digest = `sha256:${string}`;

export interface Digester {
  readonly algorithm: typeof DIGEST_ALGORITHM;
  digestBytes(bytes: Uint8Array): Digest;
  digestValue(domain: string, value: unknown, options?: CanonicalEncodeOptions): Digest;
}

const DOMAIN_PATTERN = /^[a-z0-9][a-z0-9._/-]{0,95}$/;

function assertDomain(domain: string): void {
  if (!DOMAIN_PATTERN.test(domain)) {
    throw new RouteSpecError('RS_SCHEMA_INVALID', 'Digest domain tag is not a valid identifier.', {
      details: { domain },
    });
  }
}

export const sha256Digester: Digester = Object.freeze({
  algorithm: DIGEST_ALGORITHM,
  digestBytes(bytes: Uint8Array): Digest {
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  },
  digestValue(domain: string, value: unknown, options?: CanonicalEncodeOptions): Digest {
    assertDomain(domain);
    const hash = createHash('sha256');
    hash.update(`${CANONICAL_ENCODING_VERSION}\u0000${domain}\u0000`, 'utf8');
    hash.update(canonicalEncode(value, options));
    return `sha256:${hash.digest('hex')}`;
  },
});

export function digestValue(domain: string, value: unknown, options?: CanonicalEncodeOptions): Digest {
  return sha256Digester.digestValue(domain, value, options);
}

export function isDigest(value: unknown): value is Digest {
  return typeof value === 'string' && DIGEST_PATTERN.test(value);
}

/** Digest of an opaque secret-like value (tokens). Only the digest is ever persisted. */
export function digestOpaque(domain: string, value: string): Digest {
  return digestValue(domain, value);
}
