/**
 * Certificate field rules and the exact signing payload text (M47), with no Node dependency so
 * that the static verify page (M49) builds the same bytes in a browser. `certificate.ts`
 * re-exports everything here and adds the error-throwing and signing surfaces.
 */
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

export function isBundleDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
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

/** The payload text for fields that are already known to be valid (see `certificateFieldError`). */
export function payloadText(f: CertificateFields): string {
  return (
    `${CERTIFICATE_PAYLOAD_DOMAIN}\n` +
    `registry:${f.registry}\n` +
    `project:${f.project}\n` +
    `bundle:${f.bundleDigest}\n` +
    `verdict:${f.verdict}\n` +
    `corpus:${f.corpusDigest}\n` +
    `artifact:${f.artifactDigest}\n` +
    `commit:${f.commit}\n` +
    `timestamp:${String(f.timestampMs)}\n`
  );
}

/** The contract's timestamp rule relative to `nowMs`; null when the timestamp is acceptable. */
export function checkTimestampWindow(timestampMs: number, nowMs: number): string | null {
  if (timestampMs > nowMs + MAX_FUTURE_SKEW_MS) return 'RSREG_TIMESTAMP_FUTURE';
  if (nowMs - timestampMs > MAX_AGE_MS) return 'RSREG_TIMESTAMP_STALE';
  return null;
}
