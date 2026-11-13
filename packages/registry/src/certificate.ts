/**
 * RouteSpec release certificate (M47): the fields an attester signs, the exact signing payload,
 * and the signed envelope.
 *
 * This is the TypeScript twin of the `routespec-certificate` Rust crate that the registry
 * contract uses. Both are checked against `contracts/routespec-registry/vectors/certificate-v1.json`.
 *
 * Signing payload (UTF-8, every line ends with one `\n`):
 *
 *   routespec.certificate/1
 *   registry:<registry account id>
 *   project:<project key>
 *   bundle:sha256:<64 hex>
 *   verdict:<PASS|FAIL|REVIEW|NOT_RUN>
 *   corpus:sha256:<64 hex>
 *   artifact:sha256:<64 hex>
 *   commit:<40 or 64 hex>
 *   timestamp:<milliseconds since the Unix epoch>
 *
 * The signed envelope (`SignedCertificate`) is exactly the JSON argument object of the
 * contract's `publish` method, so a file holding it can be submitted with any NEAR tool.
 */
import { z } from 'zod';
import { RouteSpecError } from '@routespec/contracts';
import { isPublicKeyText, parsePublicKey, publicKeyText, verifyEd25519, type Ed25519Signer } from './keys.ts';

import { certificateFieldError, payloadText, type CertificateFields } from './payload.ts';

export * from './payload.ts';

/** The exact bytes the attester signs. Throws `RS_CERTIFICATE_INVALID` for an invalid field. */
export function signingPayload(f: CertificateFields): Uint8Array {
  const reason = certificateFieldError(f);
  if (reason !== null) {
    throw new RouteSpecError('RS_CERTIFICATE_INVALID', 'A certificate field is not valid.', {
      details: { reason },
    });
  }
  return new Uint8Array(Buffer.from(payloadText(f), 'utf8'));
}

const signature = z
  .string()
  .regex(/^[A-Za-z0-9+/]{86}==$/)
  .refine((s) => Buffer.from(s, 'base64').length === 64);

const signedCertificateSchema = z
  .object({
    certificate: z
      .object({
        project: z.string().max(96),
        bundle_digest: z.string().max(80),
        verdict: z.string().max(16),
        corpus_digest: z.string().max(80),
        artifact_digest: z.string().max(80),
        commit: z.string().max(64),
        timestamp_ms: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      })
      .strict(),
    attester: z.string().max(64).refine(isPublicKeyText),
    signature,
  })
  .strict();

/** The signed envelope: exactly the JSON arguments of the contract's `publish` method. */
export type SignedCertificate = z.infer<typeof signedCertificateSchema>;

export function parseSignedCertificate(value: unknown): SignedCertificate {
  const parsed = signedCertificateSchema.safeParse(value);
  if (!parsed.success) {
    throw new RouteSpecError('RS_CERTIFICATE_INVALID', 'The signed certificate is not well formed.', {
      details: { path: (parsed.error.issues[0]?.path ?? []).join('.').slice(0, 80) },
    });
  }
  return parsed.data;
}

export function fieldsOf(registry: string, signed: SignedCertificate): CertificateFields {
  const c = signed.certificate;
  return {
    registry,
    project: c.project,
    bundleDigest: c.bundle_digest,
    verdict: c.verdict,
    corpusDigest: c.corpus_digest,
    artifactDigest: c.artifact_digest,
    commit: c.commit,
    timestampMs: c.timestamp_ms,
  };
}

export function signCertificate(fields: CertificateFields, signer: Ed25519Signer): SignedCertificate {
  const payload = signingPayload(fields);
  return {
    certificate: {
      project: fields.project,
      bundle_digest: fields.bundleDigest,
      verdict: fields.verdict,
      corpus_digest: fields.corpusDigest,
      artifact_digest: fields.artifactDigest,
      commit: fields.commit,
      timestamp_ms: fields.timestampMs,
    },
    attester: publicKeyText(signer.publicKey),
    signature: signer.sign(payload).toString('base64'),
  };
}

/**
 * Check a signed certificate offline for one registry account: every field is valid and the
 * signature is the named attester's signature over the payload. Never throws.
 */
export function verifySignedCertificate(
  registry: string,
  signed: SignedCertificate,
): { ok: boolean; reason: string | null } {
  const fields = fieldsOf(registry, signed);
  const reason = certificateFieldError(fields);
  if (reason !== null) return { ok: false, reason };
  let key: Uint8Array;
  try {
    key = parsePublicKey(signed.attester);
  } catch {
    return { ok: false, reason: 'CERTIFICATE_SIGNATURE_INVALID' };
  }
  const ok = verifyEd25519(key, signingPayload(fields), Buffer.from(signed.signature, 'base64'));
  return ok ? { ok: true, reason: null } : { ok: false, reason: 'CERTIFICATE_SIGNATURE_INVALID' };
}
