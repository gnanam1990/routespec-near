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

export const CERTIFICATE_PAYLOAD_DOMAIN = 'routespec.certificate/1' as const;
export const CERTIFICATE_VERDICTS = ['PASS', 'FAIL', 'REVIEW', 'NOT_RUN'] as const;
export type CertificateVerdict = (typeof CERTIFICATE_VERDICTS)[number];

/** A signed timestamp may be at most this far ahead of the block time (same as the contract). */
export const MAX_FUTURE_SKEW_MS = 10 * 60 * 1000;
/** A signed timestamp may be at most this old when published (same as the contract). */
export const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const ACCOUNT_ID = /^(?=.{2,64}$)[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const PROJECT_KEY = /^[a-z0-9][a-z0-9._/-]{0,95}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export interface CertificateFields {
  /** The registry contract account the certificate is published to. */
  readonly registry: string;
  /** Project key chosen by the attester, for example a repository slug. */
  readonly project: string;
  /** SHA-256 of the evidence bundle archive bytes. */
  readonly bundleDigest: string;
  readonly verdict: string;
  readonly corpusDigest: string;
  readonly artifactDigest: string;
  readonly commit: string;
  readonly timestampMs: number;
}

export function isRegistryAccountId(value: unknown): value is string {
  return typeof value === 'string' && ACCOUNT_ID.test(value);
}

export function isProjectKey(value: unknown): value is string {
  return typeof value === 'string' && PROJECT_KEY.test(value);
}

export function isCommitId(value: unknown): value is string {
  return typeof value === 'string' && COMMIT.test(value);
}

/** The contract's refusal code for the first invalid field, or null when every field is valid. */
export function certificateFieldError(f: CertificateFields): string | null {
  const text = (v: unknown, re: RegExp): boolean => typeof v === 'string' && re.test(v);
  if (!text(f.registry, ACCOUNT_ID)) return 'RSREG_FIELD_INVALID:registry';
  if (!text(f.project, PROJECT_KEY)) return 'RSREG_FIELD_INVALID:project';
  if (!text(f.bundleDigest, DIGEST)) return 'RSREG_FIELD_INVALID:bundle_digest';
  if (!(CERTIFICATE_VERDICTS as readonly unknown[]).includes(f.verdict)) return 'RSREG_FIELD_INVALID:verdict';
  if (!text(f.corpusDigest, DIGEST)) return 'RSREG_FIELD_INVALID:corpus_digest';
  if (!text(f.artifactDigest, DIGEST)) return 'RSREG_FIELD_INVALID:artifact_digest';
  if (!text(f.commit, COMMIT)) return 'RSREG_FIELD_INVALID:commit';
  if (typeof f.timestampMs !== 'number' || !Number.isSafeInteger(f.timestampMs) || f.timestampMs <= 0) {
    return 'RSREG_FIELD_INVALID:timestamp_ms';
  }
  return null;
}

/** The exact bytes the attester signs. Throws `RS_CERTIFICATE_INVALID` for an invalid field. */
export function signingPayload(f: CertificateFields): Uint8Array {
  const reason = certificateFieldError(f);
  if (reason !== null) {
    throw new RouteSpecError('RS_CERTIFICATE_INVALID', 'A certificate field is not valid.', {
      details: { reason },
    });
  }
  const text =
    `${CERTIFICATE_PAYLOAD_DOMAIN}\n` +
    `registry:${f.registry}\n` +
    `project:${f.project}\n` +
    `bundle:${f.bundleDigest}\n` +
    `verdict:${f.verdict}\n` +
    `corpus:${f.corpusDigest}\n` +
    `artifact:${f.artifactDigest}\n` +
    `commit:${f.commit}\n` +
    `timestamp:${String(f.timestampMs)}\n`;
  return new Uint8Array(Buffer.from(text, 'utf8'));
}

/** The contract's timestamp rule relative to `nowMs`; null when the timestamp is acceptable. */
export function checkTimestampWindow(timestampMs: number, nowMs: number): string | null {
  if (timestampMs > nowMs + MAX_FUTURE_SKEW_MS) return 'RSREG_TIMESTAMP_FUTURE';
  if (nowMs - timestampMs > MAX_AGE_MS) return 'RSREG_TIMESTAMP_STALE';
  return null;
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
