/**
 * M47 — release aggregation over on-chain certificates (ADR-0028). A pure function: the local
 * gate decision read from a verified bundle, the certificates and attester states read from the
 * registry, and a policy. Under REQUIRE_ONCHAIN_ATTESTER a PASS needs a certificate that an
 * enrolled, unrevoked (and, when keys are pinned, trusted) attester signed for exactly this
 * bundle; nothing on chain can turn a local FAIL, REVIEW or NOT_RUN into a PASS.
 */
import { describe, expect, it } from 'vitest';
import {
  aggregateRelease,
  generateSigner,
  publicKeyText,
  signCertificate,
  type AttesterState,
  type CertificateFields,
  type Ed25519Signer,
  type OnchainCertificate,
  type ReleaseInput,
} from '../src/index.ts';

const REGISTRY = 'registry.testnet';
const fields: CertificateFields = {
  registry: REGISTRY,
  project: 'org/repo',
  bundleDigest: `sha256:${'ab'.repeat(32)}`,
  verdict: 'PASS',
  corpusDigest: `sha256:${'cd'.repeat(32)}`,
  artifactDigest: `sha256:${'ef'.repeat(32)}`,
  commit: '0123456789abcdef0123456789abcdef01234567',
  timestampMs: 1_794_528_000_000,
};

function onchain(
  signer: Ed25519Signer,
  id: number,
  patch: Partial<CertificateFields> = {},
  registry = REGISTRY,
): OnchainCertificate {
  const f = { ...fields, ...patch };
  const signed = signCertificate(f, signer);
  return {
    id,
    registry,
    project: f.project,
    bundleDigest: f.bundleDigest,
    verdict: f.verdict,
    corpusDigest: f.corpusDigest,
    artifactDigest: f.artifactDigest,
    commit: f.commit,
    timestampMs: f.timestampMs,
    attester: signed.attester,
    signature: signed.signature,
    publishedAtMs: f.timestampMs + 5_000,
    publishedBlockHeight: 100 + id,
    attesterRevoked: false,
    attesterRevokedAtMs: null,
  };
}

function enrolled(signer: Ed25519Signer, patch: Partial<AttesterState> = {}): AttesterState {
  return {
    publicKey: publicKeyText(signer.publicKey),
    label: 'attester',
    enrolledAtMs: 1_794_000_000_000,
    enrolledBlockHeight: 10,
    revoked: false,
    revokedAtMs: null,
    revokedBlockHeight: null,
    revocationReason: null,
    certificates: 1,
    ...patch,
  };
}

const signer = generateSigner();
const key = publicKeyText(signer.publicKey);
const local = {
  decision: 'PASS' as const,
  artifactDigest: fields.artifactDigest,
  corpusDigest: fields.corpusDigest,
  commit: fields.commit,
  project: fields.project,
};

function input(patch: Partial<ReleaseInput> = {}): ReleaseInput {
  return {
    registry: REGISTRY,
    bundleDigest: fields.bundleDigest,
    local,
    certificates: [onchain(signer, 0)],
    attesters: { [key]: enrolled(signer) },
    policy: 'REQUIRE_ONCHAIN_ATTESTER',
    trustedAttesters: [],
    ...patch,
  };
}

describe('aggregateRelease under REQUIRE_ONCHAIN_ATTESTER', () => {
  it('passes with a certificate from an enrolled, unrevoked attester for this bundle', () => {
    const out = aggregateRelease(input());
    expect(out.decision).toBe('PASS');
    expect(out.acceptedCertificateIds).toEqual([0]);
    expect(out.findings).toEqual([]);
    expect(out.certificates[0]).toMatchObject({ id: 0, accepted: true, findings: [] });
  });

  it('is REVIEW when the registry has no certificate for the bundle', () => {
    const out = aggregateRelease(input({ certificates: [] }));
    expect(out.decision).toBe('REVIEW');
    expect(out.findings).toEqual(['CERTIFICATE_NOT_FOUND', 'ONCHAIN_ATTESTATION_REQUIRED']);
  });

  it('is REVIEW when the attester is revoked, unknown, or not one of the pinned keys', () => {
    const revoked = aggregateRelease(
      input({
        attesters: { [key]: enrolled(signer, { revoked: true, revokedAtMs: 1_794_600_000_000 }) },
      }),
    );
    expect(revoked.decision).toBe('REVIEW');
    expect(revoked.certificates[0]?.findings).toEqual(['ATTESTER_REVOKED']);
    expect(revoked.findings).toEqual(['ATTESTER_REVOKED', 'ONCHAIN_ATTESTATION_REQUIRED']);

    const unknown = aggregateRelease(input({ attesters: { [key]: null } }));
    expect(unknown.decision).toBe('REVIEW');
    expect(unknown.certificates[0]?.findings).toEqual(['ATTESTER_NOT_ENROLLED']);

    const missing = aggregateRelease(input({ attesters: {} }));
    expect(missing.certificates[0]?.findings).toEqual(['ATTESTER_NOT_ENROLLED']);

    const other = publicKeyText(generateSigner().publicKey);
    const untrusted = aggregateRelease(input({ trustedAttesters: [other] }));
    expect(untrusted.decision).toBe('REVIEW');
    expect(untrusted.certificates[0]?.findings).toEqual(['ATTESTER_NOT_TRUSTED']);

    expect(aggregateRelease(input({ trustedAttesters: [other, key] })).decision).toBe('PASS');
  });

  it('is REVIEW when the certificate was tampered with after signing', () => {
    const cases: Array<[Partial<OnchainCertificate>, string[]]> = [
      [{ verdict: 'FAIL' }, ['CERTIFICATE_SIGNATURE_INVALID', 'CERTIFICATE_VERDICT_MISMATCH']],
      [{ commit: 'f'.repeat(40) }, ['CERTIFICATE_COMMIT_MISMATCH', 'CERTIFICATE_SIGNATURE_INVALID']],
      [{ project: 'someone/else' }, ['CERTIFICATE_PROJECT_MISMATCH', 'CERTIFICATE_SIGNATURE_INVALID']],
      [{ timestampMs: fields.timestampMs + 1 }, ['CERTIFICATE_SIGNATURE_INVALID']],
      [{ signature: Buffer.alloc(64, 7).toString('base64') }, ['CERTIFICATE_SIGNATURE_INVALID']],
      [{ registry: 'other.testnet' }, ['CERTIFICATE_REGISTRY_MISMATCH']],
    ];
    for (const [patch, findings] of cases) {
      const out = aggregateRelease(input({ certificates: [{ ...onchain(signer, 0), ...patch }] }));
      expect(out.decision, JSON.stringify(patch)).toBe('REVIEW');
      expect(out.certificates[0]?.findings, JSON.stringify(patch)).toEqual(findings);
      expect(out.acceptedCertificateIds).toEqual([]);
    }
  });

  it('is REVIEW when a validly signed certificate is for other content than the local bundle', () => {
    const cases: Array<[Partial<CertificateFields>, string]> = [
      [{ bundleDigest: `sha256:${'11'.repeat(32)}` }, 'CERTIFICATE_BUNDLE_MISMATCH'],
      [{ artifactDigest: `sha256:${'11'.repeat(32)}` }, 'CERTIFICATE_ARTIFACT_MISMATCH'],
      [{ corpusDigest: `sha256:${'11'.repeat(32)}` }, 'CERTIFICATE_CORPUS_MISMATCH'],
      [{ verdict: 'FAIL' }, 'CERTIFICATE_VERDICT_MISMATCH'],
    ];
    for (const [patch, finding] of cases) {
      const out = aggregateRelease(input({ certificates: [onchain(signer, 0, patch)] }));
      expect(out.decision, finding).toBe('REVIEW');
      expect(out.certificates[0]?.findings, finding).toEqual([finding]);
    }
  });

  it('does not let one good certificate hide a trusted attester that disagrees', () => {
    const second = generateSigner();
    const out = aggregateRelease(
      input({
        certificates: [onchain(signer, 0), onchain(second, 1, { verdict: 'FAIL' })],
        attesters: { [key]: enrolled(signer), [publicKeyText(second.publicKey)]: enrolled(second) },
      }),
    );
    expect(out.decision).toBe('REVIEW');
    expect(out.findings).toEqual(['CERTIFICATE_VERDICT_MISMATCH', 'TRUSTED_ATTESTERS_DISAGREE']);
    expect(out.acceptedCertificateIds).toEqual([0]);
  });

  it('ignores a disagreeing certificate from a revoked or unpinned attester', () => {
    const second = generateSigner();
    const secondKey = publicKeyText(second.publicKey);
    const certificates = [onchain(signer, 0), onchain(second, 1, { verdict: 'FAIL' })];
    const revoked = aggregateRelease(
      input({
        certificates,
        attesters: { [key]: enrolled(signer), [secondKey]: enrolled(second, { revoked: true }) },
      }),
    );
    expect(revoked.decision).toBe('PASS');
    const unpinned = aggregateRelease(
      input({
        certificates,
        attesters: { [key]: enrolled(signer), [secondKey]: enrolled(second) },
        trustedAttesters: [key],
      }),
    );
    expect(unpinned.decision).toBe('PASS');
  });

  it('never upgrades a local FAIL, REVIEW or NOT_RUN', () => {
    for (const decision of ['FAIL', 'REVIEW', 'NOT_RUN'] as const) {
      const passCertificate = aggregateRelease(input({ local: { ...local, decision } }));
      expect(passCertificate.decision).toBe(decision);
      const matching = aggregateRelease(
        input({ local: { ...local, decision }, certificates: [onchain(signer, 0, { verdict: decision })] }),
      );
      expect(matching.decision).toBe(decision);
      expect(matching.acceptedCertificateIds).toEqual([0]);
    }
  });
});

describe('aggregateRelease under ADVISORY', () => {
  it('keeps the local decision and reports what the registry holds', () => {
    const none = aggregateRelease(input({ policy: 'ADVISORY', certificates: [] }));
    expect(none.decision).toBe('PASS');
    expect(none.findings).toEqual(['CERTIFICATE_NOT_FOUND']);
    const revoked = aggregateRelease(
      input({ policy: 'ADVISORY', attesters: { [key]: enrolled(signer, { revoked: true }) } }),
    );
    expect(revoked.decision).toBe('PASS');
    expect(revoked.findings).toEqual(['ATTESTER_REVOKED']);
    const fail = aggregateRelease(input({ policy: 'ADVISORY', local: { ...local, decision: 'FAIL' } }));
    expect(fail.decision).toBe('FAIL');
  });
});

describe('aggregateRelease without a local bundle (digest only)', () => {
  it('reports the verdict the accepted certificates agree on', () => {
    const pass = aggregateRelease(input({ local: null }));
    expect(pass.decision).toBe('PASS');
    expect(pass.findings).toEqual(['BUNDLE_NOT_CHECKED_LOCALLY']);
    const fail = aggregateRelease(
      input({ local: null, certificates: [onchain(signer, 0, { verdict: 'FAIL' })] }),
    );
    expect(fail.decision).toBe('FAIL');
  });

  it('is REVIEW without an accepted certificate or when accepted certificates disagree', () => {
    expect(aggregateRelease(input({ local: null, certificates: [] })).decision).toBe('REVIEW');
    expect(aggregateRelease(input({ local: null, attesters: {} })).decision).toBe('REVIEW');
    const second = generateSigner();
    const out = aggregateRelease(
      input({
        local: null,
        certificates: [onchain(signer, 0), onchain(second, 1, { verdict: 'FAIL' })],
        attesters: { [key]: enrolled(signer), [publicKeyText(second.publicKey)]: enrolled(second) },
      }),
    );
    expect(out.decision).toBe('REVIEW');
    expect(out.findings).toContain('TRUSTED_ATTESTERS_DISAGREE');
  });
});
