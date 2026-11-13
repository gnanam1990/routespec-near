/**
 * Release aggregation over on-chain certificates (M47, ADR-0028).
 *
 * The gate evaluation itself stays networkless and is never changed by anything on chain. This
 * is the step after it: a pure function over (a) the local gate decision read from a verified
 * evidence bundle, (b) the certificates and attester states read from the registry, and (c) a
 * policy. It answers "may this release count as certified?".
 *
 * - `REQUIRE_ONCHAIN_ATTESTER`: a local PASS stays PASS only when at least one certificate for
 *   exactly this bundle was signed by an attester that is enrolled and not revoked in the
 *   registry (and is one of the pinned keys, when keys are pinned), and no such attester
 *   disagrees. Otherwise the release is REVIEW. A local FAIL, REVIEW or NOT_RUN is never
 *   upgraded.
 * - `ADVISORY`: the local decision is kept; the findings say what the registry holds.
 *
 * Every certificate signature is verified again here, so a dishonest RPC endpoint cannot invent
 * a certificate for a pinned attester key. It can still hide certificates or misreport
 * enrolment; pin the attester keys and use an endpoint you trust.
 */
import { certificateFieldError, signingPayload, type CertificateVerdict } from './certificate.ts';
import { parsePublicKey, verifyEd25519 } from './keys.ts';

export interface OnchainCertificate {
  readonly id: number;
  readonly registry: string;
  readonly project: string;
  readonly bundleDigest: string;
  readonly verdict: string;
  readonly corpusDigest: string;
  readonly artifactDigest: string;
  readonly commit: string;
  readonly timestampMs: number;
  readonly attester: string;
  /** Base64 of the 64 signature bytes. */
  readonly signature: string;
  readonly publishedAtMs: number;
  readonly publishedBlockHeight: number;
  readonly attesterRevoked: boolean;
  readonly attesterRevokedAtMs: number | null;
}

export interface AttesterState {
  readonly publicKey: string;
  readonly label: string;
  readonly enrolledAtMs: number;
  readonly enrolledBlockHeight: number;
  readonly revoked: boolean;
  readonly revokedAtMs: number | null;
  readonly revokedBlockHeight: number | null;
  readonly revocationReason: string | null;
  readonly certificates: number;
}

export const CERTIFICATE_POLICIES = ['ADVISORY', 'REQUIRE_ONCHAIN_ATTESTER'] as const;
export type CertificatePolicy = (typeof CERTIFICATE_POLICIES)[number];

/** What the verified local bundle says. A null field was not available and is not compared. */
export interface LocalRelease {
  readonly decision: CertificateVerdict;
  readonly artifactDigest: string | null;
  readonly corpusDigest: string | null;
  readonly commit: string | null;
  readonly project: string | null;
}

export interface ReleaseInput {
  readonly registry: string;
  readonly bundleDigest: string;
  /** Null: only a digest was given, no bundle was checked locally. */
  readonly local: LocalRelease | null;
  readonly certificates: readonly OnchainCertificate[];
  /** Attester state by `ed25519:` key text as read from the registry; null or absent: not enrolled. */
  readonly attesters: Readonly<Record<string, AttesterState | null>>;
  readonly policy: CertificatePolicy;
  /** Pinned attester keys. Empty: any enrolled, unrevoked attester of the registry is trusted. */
  readonly trustedAttesters: readonly string[];
}

export interface CertificateAssessment {
  readonly id: number;
  readonly attester: string;
  readonly verdict: string;
  readonly accepted: boolean;
  readonly findings: readonly string[];
}

export interface ReleaseDecision {
  readonly decision: CertificateVerdict;
  readonly policy: CertificatePolicy;
  readonly localDecision: CertificateVerdict | null;
  readonly acceptedCertificateIds: readonly number[];
  readonly findings: readonly string[];
  readonly certificates: readonly CertificateAssessment[];
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

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
  const local = input.local;
  const assessed = input.certificates.map((c) => {
    const authentic: string[] = [];
    if (c.registry !== input.registry) authentic.push('CERTIFICATE_REGISTRY_MISMATCH');
    if (!signatureValid(input.registry, c)) authentic.push('CERTIFICATE_SIGNATURE_INVALID');
    if (c.bundleDigest !== input.bundleDigest) authentic.push('CERTIFICATE_BUNDLE_MISMATCH');
    const state = input.attesters[c.attester] ?? null;
    if (state === null) authentic.push('ATTESTER_NOT_ENROLLED');
    else if (state.revoked) authentic.push('ATTESTER_REVOKED');
    if (input.trustedAttesters.length > 0 && !input.trustedAttesters.includes(c.attester)) {
      authentic.push('ATTESTER_NOT_TRUSTED');
    }
    const content: string[] = [];
    if (local !== null) {
      if (c.verdict !== local.decision) content.push('CERTIFICATE_VERDICT_MISMATCH');
      if (local.artifactDigest !== null && c.artifactDigest !== local.artifactDigest) {
        content.push('CERTIFICATE_ARTIFACT_MISMATCH');
      }
      if (local.corpusDigest !== null && c.corpusDigest !== local.corpusDigest) {
        content.push('CERTIFICATE_CORPUS_MISMATCH');
      }
      if (local.commit !== null && c.commit !== local.commit) content.push('CERTIFICATE_COMMIT_MISMATCH');
      if (local.project !== null && c.project !== local.project) content.push('CERTIFICATE_PROJECT_MISMATCH');
    }
    const findings = sortedUnique([...authentic, ...content]);
    return {
      certificate: c,
      /** A real statement by an attester in good standing about this bundle. */
      standing: authentic.length === 0,
      assessment: {
        id: c.id,
        attester: c.attester,
        verdict: c.verdict,
        accepted: findings.length === 0,
        findings,
      } satisfies CertificateAssessment,
    };
  });

  const accepted = assessed.filter((a) => a.assessment.accepted);
  const standing = assessed.filter((a) => a.standing);
  const standingVerdicts = new Set(standing.map((a) => a.certificate.verdict));
  const disagree =
    standingVerdicts.size > 1 ||
    (local !== null && standing.some((a) => a.certificate.verdict !== local.decision));

  const findings: string[] = assessed.flatMap((a) =>
    a.assessment.accepted ? [] : [...a.assessment.findings],
  );
  if (input.certificates.length === 0) findings.push('CERTIFICATE_NOT_FOUND');
  if (disagree) findings.push('TRUSTED_ATTESTERS_DISAGREE');
  if (local === null) findings.push('BUNDLE_NOT_CHECKED_LOCALLY');

  let decision: CertificateVerdict;
  if (local === null) {
    // Digest only: the certificates are the only statement there is.
    const only = standingVerdicts.size === 1 ? ([...standingVerdicts][0] as CertificateVerdict) : null;
    if (accepted.length > 0 && !disagree && only !== null) decision = only;
    else {
      decision = 'REVIEW';
      findings.push('ONCHAIN_ATTESTATION_REQUIRED');
    }
  } else if (input.policy === 'ADVISORY' || local.decision !== 'PASS') {
    decision = local.decision;
  } else if (accepted.length > 0 && !disagree) {
    decision = 'PASS';
  } else {
    decision = 'REVIEW';
    if (accepted.length === 0) findings.push('ONCHAIN_ATTESTATION_REQUIRED');
  }

  return {
    decision,
    policy: input.policy,
    localDecision: local?.decision ?? null,
    acceptedCertificateIds: accepted.map((a) => a.assessment.id),
    findings: sortedUnique(findings),
    certificates: assessed.map((a) => a.assessment),
  };
}
