/**
 * The closed shapes of the `routespec-registry` view results and their mapping to the package
 * types (M47). No Node dependency: the Node client and the static verify page (M49) validate
 * every RPC answer against these same schemas before using it.
 */
import { z } from 'zod';
import { isPublicKeyText } from './key-text.ts';
import type { AttesterState, OnchainCertificate } from './release-core.ts';

/** Most certificates the registry keeps for one bundle, and the largest page of any listing. */
export const MAX_CERTIFICATES_PER_BUNDLE = 8;
export const MAX_PAGE = 50;

export const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const optionalCount = count.nullable();

export const certificateView = z
  .object({
    id: count,
    registry: z.string().max(64),
    project: z.string().max(96),
    bundle_digest: z.string().max(80),
    verdict: z.string().max(16),
    corpus_digest: z.string().max(80),
    artifact_digest: z.string().max(80),
    commit: z.string().max(64),
    timestamp_ms: count,
    attester: z.string().max(64).refine(isPublicKeyText),
    signature: z.string().max(100),
    published_at_ms: count,
    published_block_height: count,
    attester_revoked: z.boolean(),
    attester_revoked_at_ms: optionalCount,
  })
  .strict();

export const attesterView = z
  .object({
    public_key: z.string().max(64).refine(isPublicKeyText),
    label: z.string().max(64),
    enrolled_at_ms: count,
    enrolled_block_height: count,
    revoked: z.boolean(),
    revoked_at_ms: optionalCount,
    revoked_block_height: optionalCount,
    revocation_reason: z.string().max(120).nullable(),
    certificates: count,
  })
  .strict();

export const infoView = z
  .object({
    contract: z.string().max(64),
    version: z.string().max(32),
    payload_domain: z.string().max(64),
    owner_id: z.string().max(64),
    attesters: count,
    certificates: count,
    max_future_skew_ms: count,
    max_age_ms: count,
  })
  .strict();

export interface RegistryInfo {
  readonly contract: string;
  readonly version: string;
  readonly payloadDomain: string;
  readonly ownerId: string;
  readonly attesters: number;
  readonly certificates: number;
  readonly maxFutureSkewMs: number;
  readonly maxAgeMs: number;
}

export function info(v: z.infer<typeof infoView>): RegistryInfo {
  return {
    contract: v.contract,
    version: v.version,
    payloadDomain: v.payload_domain,
    ownerId: v.owner_id,
    attesters: v.attesters,
    certificates: v.certificates,
    maxFutureSkewMs: v.max_future_skew_ms,
    maxAgeMs: v.max_age_ms,
  };
}

export function certificate(v: z.infer<typeof certificateView>): OnchainCertificate {
  return {
    id: v.id,
    registry: v.registry,
    project: v.project,
    bundleDigest: v.bundle_digest,
    verdict: v.verdict,
    corpusDigest: v.corpus_digest,
    artifactDigest: v.artifact_digest,
    commit: v.commit,
    timestampMs: v.timestamp_ms,
    attester: v.attester,
    signature: v.signature,
    publishedAtMs: v.published_at_ms,
    publishedBlockHeight: v.published_block_height,
    attesterRevoked: v.attester_revoked,
    attesterRevokedAtMs: v.attester_revoked_at_ms,
  };
}

export function attester(v: z.infer<typeof attesterView>): AttesterState {
  return {
    publicKey: v.public_key,
    label: v.label,
    enrolledAtMs: v.enrolled_at_ms,
    enrolledBlockHeight: v.enrolled_block_height,
    revoked: v.revoked,
    revokedAtMs: v.revoked_at_ms,
    revokedBlockHeight: v.revoked_block_height,
    revocationReason: v.revocation_reason,
    certificates: v.certificates,
  };
}

/**
 * The newest certificate of `project` in a page of project certificates (publication order),
 * from one of the `trusted` attester keys when any are given.
 */
export function latestCertificate(
  page: readonly OnchainCertificate[],
  project: string,
  trusted: readonly string[],
): OnchainCertificate | null {
  let best: OnchainCertificate | null = null;
  for (const c of page) {
    if (c.project !== project) continue;
    if (trusted.length > 0 && !trusted.includes(c.attester)) continue;
    if (best === null || c.id > best.id) best = c;
  }
  return best;
}
