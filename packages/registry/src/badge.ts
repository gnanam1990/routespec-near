/**
 * "RouteSpec Certified" badge (M49): one status for a release as read from the registry, and the
 * shields.io endpoint JSON for it. No Node dependency: `certificate badge` (CLI, in CI) and the
 * static verify page derive the status from the same `ReleaseDecision` with this same function.
 *
 * The status is computed for a bundle digest alone (no local bundle check), under
 * REQUIRE_ONCHAIN_ATTESTER: "certified" means at least one certificate for exactly this bundle,
 * signed (checked locally) by an attester the registry reports as enrolled and not revoked (and
 * pinned, when keys are pinned), with no such attester disagreeing. The badge then shows the
 * verdict that attester signed, which can be FAIL.
 */
import type { ReleaseDecision } from './release-core.ts';

export const BADGE_STATUSES = [
  'CERTIFIED_PASS',
  'CERTIFIED_FAIL',
  'CERTIFIED_REVIEW',
  'CERTIFIED_NOT_RUN',
  'ATTESTER_REVOKED',
  'ATTESTERS_DISAGREE',
  'NO_CERTIFICATE',
  'NOT_CERTIFIED',
  'REGISTRY_CODE_UNKNOWN',
  'UNVERIFIED',
] as const;
export type BadgeStatus = (typeof BADGE_STATUSES)[number];

/** The shields.io "endpoint" badge schema (only the keys shields accepts). */
export interface ShieldsEndpointBadge {
  readonly schemaVersion: 1;
  readonly label: string;
  readonly message: string;
  readonly color: string;
  readonly isError?: true;
  readonly cacheSeconds: number;
}

const LOOK: Readonly<Record<BadgeStatus, { message: string; color: string }>> = {
  CERTIFIED_PASS: { message: 'certified PASS', color: 'brightgreen' },
  CERTIFIED_FAIL: { message: 'certified FAIL', color: 'red' },
  CERTIFIED_REVIEW: { message: 'certified REVIEW', color: 'yellow' },
  CERTIFIED_NOT_RUN: { message: 'certified NOT_RUN', color: 'lightgrey' },
  ATTESTER_REVOKED: { message: 'attester revoked', color: 'orange' },
  ATTESTERS_DISAGREE: { message: 'attesters disagree', color: 'orange' },
  NO_CERTIFICATE: { message: 'no certificate', color: 'lightgrey' },
  NOT_CERTIFIED: { message: 'not certified', color: 'lightgrey' },
  REGISTRY_CODE_UNKNOWN: { message: 'unknown registry code', color: 'orange' },
  UNVERIFIED: { message: 'unverified', color: 'lightgrey' },
};

/** Plain-language meaning of each status, shown on the verify page. */
export const BADGE_STATUS_TEXT: Readonly<Record<BadgeStatus, string>> = {
  CERTIFIED_PASS:
    'An attester in good standing signed a PASS certificate for exactly this bundle, and no attester in good standing disagrees.',
  CERTIFIED_FAIL: 'An attester in good standing certified that this bundle records a FAIL decision.',
  CERTIFIED_REVIEW: 'An attester in good standing certified that this bundle records a REVIEW decision.',
  CERTIFIED_NOT_RUN: 'An attester in good standing certified that this bundle records a NOT_RUN decision.',
  ATTESTER_REVOKED:
    'A certificate exists, but its attester has been revoked by the registry owner. It does not count.',
  ATTESTERS_DISAGREE: 'Attesters in good standing signed different verdicts for this bundle.',
  NO_CERTIFICATE: 'The registry holds no certificate for this bundle.',
  NOT_CERTIFIED: 'The registry holds certificates for this bundle, but none is accepted.',
  REGISTRY_CODE_UNKNOWN:
    'The registry account runs code whose hash is not a known reproducible build of routespec-registry.',
  UNVERIFIED: 'The registry could not be read, so nothing was verified.',
};

/**
 * The badge status for a digest-only release decision. `release` null: the registry could not be
 * read. `codeHashKnown` false: the account's code is not a known build (null: not checked).
 */
export function badgeStatus(
  release: ReleaseDecision | null,
  codeHashKnown: boolean | null = null,
): BadgeStatus {
  if (release === null) return 'UNVERIFIED';
  if (codeHashKnown === false) return 'REGISTRY_CODE_UNKNOWN';
  const certified =
    release.acceptedCertificateIds.length > 0 && !release.findings.includes('ONCHAIN_ATTESTATION_REQUIRED');
  if (certified) return `CERTIFIED_${release.decision}`;
  if (release.findings.includes('TRUSTED_ATTESTERS_DISAGREE')) return 'ATTESTERS_DISAGREE';
  if (release.findings.includes('CERTIFICATE_NOT_FOUND')) return 'NO_CERTIFICATE';
  if (release.certificates.some((c) => c.findings.includes('ATTESTER_REVOKED'))) return 'ATTESTER_REVOKED';
  return 'NOT_CERTIFIED';
}

export const DEFAULT_BADGE_LABEL = 'RouteSpec';
export const BADGE_CACHE_SECONDS = 3600;

export function shieldsBadge(status: BadgeStatus, label: string = DEFAULT_BADGE_LABEL): ShieldsEndpointBadge {
  const look = LOOK[status];
  return {
    schemaVersion: 1,
    label: label.slice(0, 40),
    message: look.message,
    color: look.color,
    ...(status === 'UNVERIFIED' ? { isError: true as const } : {}),
    cacheSeconds: BADGE_CACHE_SECONDS,
  };
}
