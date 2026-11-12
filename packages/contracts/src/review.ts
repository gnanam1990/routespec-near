/**
 * Interceptor profile review and release-evidence classification rules (M16; REAL-PRODUCT-GATE
 * RP-02, RP-06, RP-08; API-SPEC effect-coverage policies).
 *
 * Shared by the store (record time, views, promotion) and the pure kernel (evaluation time), so
 * there is exactly one definition of "reviewed" and of "release evidence".
 *
 * Profile review: a reviewer principal, enrolled separately from every launcher/CI attester with
 * its own Ed25519 public key, signs one canonical statement that binds the exact registered
 * profile (digest and every declared field), a decision, the review checklist, a single-use
 * server challenge, and the reviewer identity. The private key never enters RouteSpec. A review
 * record is immutable; a revocation is a separate append-only record. The effective state of a
 * profile is derived from those records, never stored as a mutable flag.
 */
import { canonicalJson } from './canonical/encoding.ts';
import { digestValue } from './canonical/digest.ts';

export const PROFILE_REVIEW_STATEMENT_DOMAIN = 'routespec.interceptor-profile-review/1' as const;
export const PROFILE_REVIEW_DIGEST_DOMAIN = 'routespec.interceptor-profile-review-record/1' as const;
export const REVIEWER_KEY_DIGEST_DOMAIN = 'routespec.profile-reviewer-key/1' as const;

export const PROFILE_REVIEW_STATES = Object.freeze([
  'DECLARED_UNREVIEWED',
  'REVIEWED',
  'REVIEW_REJECTED',
  'REVIEW_REVOKED',
] as const);
export type ProfileReviewState = (typeof PROFILE_REVIEW_STATES)[number];

export const PROFILE_REVIEW_DECISIONS = Object.freeze(['APPROVED', 'REJECTED'] as const);
export type ProfileReviewDecision = (typeof PROFILE_REVIEW_DECISIONS)[number];

/** What an approving reviewer must explicitly confirm about the profile. */
export const PROFILE_REVIEW_CHECKLIST = Object.freeze([
  'ARTIFACT_DIGEST_VERIFIED',
  'PROCESS_TREE_SCOPE_CONFINES_SUBJECT',
  'SUPPORTED_SINKS_COMPLETE',
  'DENIAL_MECHANISM_HAS_NO_EFFECT',
  'PRIVATE_CHANNEL_ISOLATED_FROM_SUBJECT',
] as const);
export type ProfileReviewCheck = (typeof PROFILE_REVIEW_CHECKLIST)[number];

export interface ProfileReviewStatement {
  readonly domain: typeof PROFILE_REVIEW_STATEMENT_DOMAIN;
  readonly projectId: string;
  readonly profileId: string;
  readonly profileDigest: string;
  readonly profile: {
    readonly interceptorArtifactDigest: string;
    readonly containment: string;
    readonly processTreeScope: string;
    readonly supportedSinks: readonly string[];
    readonly denialMechanism: string;
  };
  readonly reviewerId: string;
  readonly reviewerKeyDigest: string;
  readonly decision: ProfileReviewDecision;
  readonly checklist: Readonly<Record<ProfileReviewCheck, boolean>>;
  readonly challengeId: string;
  readonly nonce: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
}

/** The exact bytes a reviewer signs (Ed25519, no prehash). */
export function profileReviewSigningBytes(statement: ProfileReviewStatement): Buffer {
  return Buffer.from(`${PROFILE_REVIEW_STATEMENT_DOMAIN}\n${canonicalJson(statement)}`, 'utf8');
}

export function profileReviewStatementDigest(statement: ProfileReviewStatement): string {
  return digestValue(PROFILE_REVIEW_STATEMENT_DOMAIN, statement);
}

/** Identity of a reviewer public key (an Ed25519 JWK `x` value). */
export function reviewerKeyDigest(publicKeyX: string): string {
  return digestValue(REVIEWER_KEY_DIGEST_DOMAIN, { kty: 'OKP', crv: 'Ed25519', x: publicKeyX });
}

/** One review as both the store and the kernel see it (current revocation state included). */
export interface ProfileReviewFact {
  readonly reviewId: string;
  readonly profileDigest: string;
  readonly decision: ProfileReviewDecision;
  readonly reviewedAtMs: number;
  readonly reviewDigest: string;
  readonly reviewRevoked: boolean;
  readonly reviewerRevoked: boolean;
  readonly reviewerValidFromMs: number;
  readonly reviewerValidUntilMs: number;
}

export interface EffectiveProfileReview {
  readonly state: ProfileReviewState;
  /** The review that makes the profile REVIEWED or REVIEW_REJECTED (latest effective one). */
  readonly reviewId: string | null;
  readonly reviewDigest: string | null;
  readonly reviewCount: number;
}

/**
 * Effective review state of one profile at `asOfMs`, fail closed:
 * - a review counts only when it was recorded at or before `asOfMs`, is not revoked, and its
 *   reviewer is not revoked and was valid at `asOfMs`;
 * - any effective REJECTED review wins (REVIEW_REJECTED);
 * - otherwise any effective APPROVED review makes it REVIEWED;
 * - otherwise REVIEW_REVOKED if a review recorded by `asOfMs` is no longer effective (revoked,
 *   or its reviewer revoked or outside its window), else DECLARED_UNREVIEWED.
 * A null `asOfMs` (no time reference) never yields REVIEWED.
 */
export function effectiveProfileReview(
  profileDigest: string,
  reviews: readonly ProfileReviewFact[],
  asOfMs: number | null,
): EffectiveProfileReview {
  const mine = reviews.filter((r) => r.profileDigest === profileDigest);
  const live = mine
    .filter(
      (r) =>
        asOfMs !== null &&
        r.reviewedAtMs <= asOfMs &&
        !r.reviewRevoked &&
        !r.reviewerRevoked &&
        r.reviewerValidFromMs <= asOfMs &&
        asOfMs < r.reviewerValidUntilMs,
    )
    .sort((a, b) =>
      a.reviewedAtMs !== b.reviewedAtMs ? b.reviewedAtMs - a.reviewedAtMs : a.reviewId < b.reviewId ? -1 : 1,
    );
  const pick = (state: ProfileReviewState, r: ProfileReviewFact | undefined): EffectiveProfileReview => ({
    state,
    reviewId: r?.reviewId ?? null,
    reviewDigest: r?.reviewDigest ?? null,
    reviewCount: mine.length,
  });
  const rejected = live.find((r) => r.decision === 'REJECTED');
  if (rejected) return pick('REVIEW_REJECTED', rejected);
  const approved = live.find((r) => r.decision === 'APPROVED');
  if (approved) return pick('REVIEWED', approved);
  const earlier = mine.filter((r) => asOfMs !== null && r.reviewedAtMs <= asOfMs);
  return pick(earlier.length > 0 ? 'REVIEW_REVOKED' : 'DECLARED_UNREVIEWED', undefined);
}

// -----------------------------------------------------------------------------------------------
// Release-evidence classification of a promoted capture (RP-08).

export const EVIDENCE_USES = Object.freeze(['RELEASE_EVIDENCE', 'DIAGNOSTIC_ONLY'] as const);
export type EvidenceUse = (typeof EVIDENCE_USES)[number];

/**
 * Why a capture cannot be release evidence. Stable codes: the API, CLI, console, gate findings,
 * and bundle manifests all carry them unchanged.
 */
export const RELEASE_EVIDENCE_REFUSALS = Object.freeze([
  'NOT_INSTALLED_CAPTURE',
  'DECLARED_HOOKS_ONLY',
  'PROCESS_TREE_NOT_CONFINED',
  'NO_INDEPENDENT_BOUNDARY_OBSERVATION',
  'INTERCEPTOR_COVERAGE_INCOMPLETE',
  'INTERCEPTOR_PROFILE_UNPINNED',
  'INTERCEPTOR_PROFILE_NOT_REVIEWED',
  'UNATTESTED_IDENTITY',
] as const);
export type ReleaseEvidenceRefusal = (typeof RELEASE_EVIDENCE_REFUSALS)[number];

/** How a corpus case's scenario revision may be used by a gate. */
export const CORPUS_EVIDENCE_CLASSES = Object.freeze([
  'AUTHORED',
  'RELEASE_EVIDENCE',
  'DIAGNOSTIC_ONLY',
  'UNCLASSIFIED',
] as const);
export type CorpusEvidenceClass = (typeof CORPUS_EVIDENCE_CLASSES)[number];

/** Only authored scenarios and promotions classified as release evidence may be REQUIRED. */
export function corpusClassAllowedAsRequired(c: CorpusEvidenceClass): boolean {
  return c === 'AUTHORED' || c === 'RELEASE_EVIDENCE';
}
