/**
 * M49 — the badge status and the shields.io endpoint JSON. The status is derived from a real
 * digest-only `aggregateRelease` over really signed certificates; the JSON carries only the keys
 * the shields "endpoint" schema accepts, so shields renders it instead of an error badge.
 */
import { describe, expect, it } from 'vitest';
import {
  aggregateRelease,
  badgeStatus,
  BADGE_STATUSES,
  BADGE_STATUS_TEXT,
  generateSigner,
  latestCertificate,
  publicKeyText,
  shieldsBadge,
  signCertificate,
  type AttesterState,
  type CertificateFields,
  type Ed25519Signer,
  type OnchainCertificate,
} from '../src/index.ts';

const REGISTRY = 'registry.testnet';
const BUNDLE = `sha256:${'ab'.repeat(32)}`;
const base: CertificateFields = {
  registry: REGISTRY,
  project: 'org/repo',
  bundleDigest: BUNDLE,
  verdict: 'PASS',
  corpusDigest: `sha256:${'cd'.repeat(32)}`,
  artifactDigest: `sha256:${'ef'.repeat(32)}`,
  commit: '0123456789abcdef0123456789abcdef01234567',
  timestampMs: 1_794_528_000_000,
};

function cert(signer: Ed25519Signer, id: number, patch: Partial<CertificateFields> = {}): OnchainCertificate {
  const f = { ...base, ...patch };
  const s = signCertificate(f, signer);
  return {
    id,
    registry: REGISTRY,
    project: f.project,
    bundleDigest: f.bundleDigest,
    verdict: f.verdict,
    corpusDigest: f.corpusDigest,
    artifactDigest: f.artifactDigest,
    commit: f.commit,
    timestampMs: f.timestampMs,
    attester: s.attester,
    signature: s.signature,
    publishedAtMs: f.timestampMs,
    publishedBlockHeight: 10 + id,
    attesterRevoked: false,
    attesterRevokedAtMs: null,
  };
}

function state(signer: Ed25519Signer, revoked = false): AttesterState {
  return {
    publicKey: publicKeyText(signer.publicKey),
    label: 'ci',
    enrolledAtMs: 1,
    enrolledBlockHeight: 1,
    revoked,
    revokedAtMs: revoked ? 2 : null,
    revokedBlockHeight: revoked ? 2 : null,
    revocationReason: revoked ? 'rotated' : null,
    certificates: 1,
  };
}

const a = generateSigner();
const b = generateSigner();
const ka = publicKeyText(a.publicKey);
const kb = publicKeyText(b.publicKey);

function status(
  certificates: OnchainCertificate[],
  attesters: Record<string, AttesterState | null>,
  codeHashKnown: boolean | null = null,
): string {
  const release = aggregateRelease({
    registry: REGISTRY,
    bundleDigest: BUNDLE,
    local: null,
    certificates,
    attesters,
    policy: 'REQUIRE_ONCHAIN_ATTESTER',
    trustedAttesters: [],
  });
  return badgeStatus(release, codeHashKnown);
}

describe('badge status', () => {
  it('is certified with the signed verdict only for an accepted certificate', () => {
    expect(status([cert(a, 0)], { [ka]: state(a) })).toBe('CERTIFIED_PASS');
    expect(status([cert(a, 0, { verdict: 'FAIL' })], { [ka]: state(a) })).toBe('CERTIFIED_FAIL');
    expect(status([cert(a, 0, { verdict: 'REVIEW' })], { [ka]: state(a) })).toBe('CERTIFIED_REVIEW');
    expect(status([cert(a, 0, { verdict: 'NOT_RUN' })], { [ka]: state(a) })).toBe('CERTIFIED_NOT_RUN');
  });

  it('says why a bundle is not certified', () => {
    expect(status([], {})).toBe('NO_CERTIFICATE');
    expect(status([cert(a, 0)], { [ka]: state(a, true) })).toBe('ATTESTER_REVOKED');
    expect(status([cert(a, 0)], { [ka]: null })).toBe('NOT_CERTIFIED');
    expect(status([{ ...cert(a, 0), verdict: 'FAIL' }], { [ka]: state(a) })).toBe('NOT_CERTIFIED');
    expect(status([cert(a, 0), cert(b, 1, { verdict: 'FAIL' })], { [ka]: state(a), [kb]: state(b) })).toBe(
      'ATTESTERS_DISAGREE',
    );
  });

  it('never certifies on unknown registry code or an unread registry', () => {
    expect(status([cert(a, 0)], { [ka]: state(a) }, false)).toBe('REGISTRY_CODE_UNKNOWN');
    expect(status([cert(a, 0)], { [ka]: state(a) }, true)).toBe('CERTIFIED_PASS');
    expect(badgeStatus(null)).toBe('UNVERIFIED');
  });
});

describe('shields endpoint JSON', () => {
  it('uses only shields endpoint keys and a message per status', () => {
    const allowed = new Set(['schemaVersion', 'label', 'message', 'color', 'isError', 'cacheSeconds']);
    const messages = new Set<string>();
    for (const s of BADGE_STATUSES) {
      const badge = shieldsBadge(s);
      for (const k of Object.keys(badge)) expect(allowed.has(k), `${s}:${k}`).toBe(true);
      expect(badge.schemaVersion).toBe(1);
      expect(badge.label).toBe('RouteSpec');
      expect(badge.message.length).toBeGreaterThan(0);
      expect(BADGE_STATUS_TEXT[s].length).toBeGreaterThan(10);
      messages.add(badge.message);
    }
    expect(messages.size).toBe(BADGE_STATUSES.length);
    expect(shieldsBadge('CERTIFIED_PASS')).toEqual({
      schemaVersion: 1,
      label: 'RouteSpec',
      message: 'certified PASS',
      color: 'brightgreen',
      cacheSeconds: 3600,
    });
    expect(shieldsBadge('UNVERIFIED', 'RouteSpec testnet')).toMatchObject({
      isError: true,
      label: 'RouteSpec testnet',
    });
  });
});

describe('latest project certificate', () => {
  it('picks the newest certificate of the project, from a pinned attester when pinned', () => {
    const page = [cert(a, 3), cert(b, 7), cert(a, 5), cert(a, 9, { project: 'other/repo' })];
    expect(latestCertificate(page, 'org/repo', [])?.id).toBe(7);
    expect(latestCertificate(page, 'org/repo', [ka])?.id).toBe(5);
    expect(latestCertificate(page, 'none/repo', [])).toBeNull();
  });
});
