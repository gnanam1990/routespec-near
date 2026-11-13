/**
 * Release aggregation over on-chain certificates (M47, ADR-0029): `release-core.ts` with the
 * Ed25519 signatures checked by `node:crypto`.
 */
import { certificateFieldError, signingPayload } from './certificate.ts';
import { parsePublicKey, verifyEd25519 } from './keys.ts';
import {
  aggregateReleaseWith,
  type OnchainCertificate,
  type ReleaseDecision,
  type ReleaseInput,
} from './release-core.ts';

export * from './release-core.ts';

function signatureValid(registry: string, c: OnchainCertificate): boolean {
  const fields = {
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
  let key: Uint8Array;
  try {
    key = parsePublicKey(c.attester);
  } catch {
    return false;
  }
  if (typeof c.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(c.signature)) return false;
  return verifyEd25519(key, signingPayload(fields), Buffer.from(c.signature, 'base64'));
}

export function aggregateRelease(input: ReleaseInput): ReleaseDecision {
  return aggregateReleaseWith(input, (c) => signatureValid(input.registry, c));
}
