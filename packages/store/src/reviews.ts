/**
 * Interceptor profile review workflow (M16; REAL-PRODUCT-GATE RP-02, RP-06; API-SPEC effect-
 * coverage policies "require a reviewed interceptor profile").
 *
 * Roles:
 * - the operator holds the control token and the launcher key; it can register profiles, issue
 *   review challenges, submit a reviewer's signature, and revoke (lowering trust only);
 * - a reviewer is a separate principal with its own Ed25519 key, enrolled only with an explicit
 *   local confirmation. Its key may not be an enrolled launcher key, and a launcher key may not
 *   later be enrolled as a reviewer key. Only a signature by the reviewer's private key — which
 *   never enters RouteSpec — can create a review record.
 *
 * Flow: enroll reviewer -> challenge (server builds the exact canonical statement: profile
 * digest and fields, decision, checklist, reviewer, single-use nonce, expiry) -> the reviewer
 * signs the statement bytes offline -> `recordReview` verifies the signature against the
 * enrolled key, consumes the challenge, and writes one immutable review. Revocation of a review
 * or of a reviewer is a separate append-only record. The profile row itself never changes; its
 * effective state comes from `effectiveProfileReview` over these records.
 */
import { createPublicKey, randomBytes, randomUUID, verify as verifySignature } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  PROFILE_REVIEW_CHECKLIST,
  PROFILE_REVIEW_DIGEST_DOMAIN,
  RouteSpecError,
  canonicalJson,
  digestValue,
  effectiveProfileReview,
  profileReviewSigningBytes,
  profileReviewStatementDigest,
  reviewerKeyDigest,
  type EffectiveProfileReview,
  type ErrorCode,
  type ProfileReviewCheck,
  type ProfileReviewDecision,
  type ProfileReviewFact,
  type ProfileReviewStatement,
} from '@routespec/contracts';
import type { ControlJournal } from './control.ts';
import type { RouteSpecStore } from './store.ts';

type Row = Record<string, unknown>;
type Param = string | number | null;

function fail(
  code: ErrorCode,
  message: string,
  details?: Record<string, string | number | boolean | null>,
): never {
  throw new RouteSpecError(code, message, details ? { details } : undefined);
}
function one(db: DatabaseSync, sql: string, ...params: Param[]): Row | undefined {
  return db.prepare(sql).get(...params) as Row | undefined;
}
function all(db: DatabaseSync, sql: string, ...params: Param[]): Row[] {
  return db.prepare(sql).all(...params) as Row[];
}
function run(db: DatabaseSync, sql: string, ...params: Param[]): void {
  db.prepare(sql).run(...params);
}
function s(row: Row, key: string): string {
  const v = row[key];
  if (typeof v !== 'string') throw new RouteSpecError('RS_INTERNAL', 'Journal row has an unexpected shape.');
  return v;
}
function n(row: Row, key: string): number {
  const v = row[key];
  if (typeof v !== 'number') throw new RouteSpecError('RS_INTERNAL', 'Journal row has an unexpected shape.');
  return v;
}

export const REVIEWER_REVOCATION_REASONS = Object.freeze([
  'KEY_COMPROMISED',
  'REVIEWER_RETIRED',
  'OPERATOR_REQUEST',
] as const);
export const REVIEW_REVOCATION_REASONS = Object.freeze([
  'PROFILE_DEFECT_FOUND',
  'REVIEW_IN_ERROR',
  'OPERATOR_REQUEST',
] as const);

const KEY_X = /^[A-Za-z0-9_-]{43}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;

export interface ReviewerEnrollmentPlan {
  readonly projectId: string;
  readonly label: string;
  readonly publicKeyX: string;
  readonly validFromMs: number;
  readonly validUntilMs: number;
}

export function reviewerEnrollmentPlanDigest(plan: ReviewerEnrollmentPlan): string {
  return digestValue('routespec.profile-reviewer-enrollment/1', plan);
}

/**
 * Journal rows of every review of `profileDigest` in `projectId`, with current revocation state.
 * Used inside other read transactions (the kernel evaluation snapshot) and by the views.
 */
export function profileReviewFactRows(db: DatabaseSync, projectId: string, profileDigest: string): Row[] {
  return all(
    db,
    `SELECT r.review_id, r.profile_digest, r.decision, r.reviewed_at_ms, r.review_digest, r.reviewer_id,
            CASE WHEN rr.review_id IS NULL THEN 0 ELSE 1 END AS review_revoked,
            CASE WHEN pr.reviewer_id IS NULL THEN 0 ELSE 1 END AS reviewer_revoked,
            p.valid_from_ms AS reviewer_valid_from_ms, p.valid_until_ms AS reviewer_valid_until_ms
       FROM interceptor_profile_reviews r
       JOIN profile_reviewers p USING (reviewer_id)
       LEFT JOIN interceptor_profile_review_revocations rr ON rr.review_id = r.review_id
       LEFT JOIN profile_reviewer_revocations pr ON pr.reviewer_id = r.reviewer_id
      WHERE r.project_id = ? AND r.profile_digest = ?
      ORDER BY r.reviewed_at_ms, r.review_id`,
    projectId,
    profileDigest,
  );
}

export function reviewFactFromRow(r: Row): ProfileReviewFact {
  return {
    reviewId: s(r, 'review_id'),
    profileDigest: s(r, 'profile_digest'),
    decision: s(r, 'decision') as ProfileReviewDecision,
    reviewedAtMs: n(r, 'reviewed_at_ms'),
    reviewDigest: s(r, 'review_digest'),
    reviewRevoked: n(r, 'review_revoked') === 1,
    reviewerRevoked: n(r, 'reviewer_revoked') === 1,
    reviewerValidFromMs: n(r, 'reviewer_valid_from_ms'),
    reviewerValidUntilMs: n(r, 'reviewer_valid_until_ms'),
  };
}

export interface ReviewChallenge {
  readonly challengeId: string;
  readonly statement: ProfileReviewStatement;
  readonly statementDigest: string;
  /** base64url of the exact bytes to sign. */
  readonly signingPayload: string;
  readonly expiresAtMs: number;
}

export class ProfileReviewJournal {
  readonly store: RouteSpecStore;
  readonly control: ControlJournal;

  constructor(control: ControlJournal) {
    this.control = control;
    this.store = control.store;
  }

  private now(): number {
    return this.store.clock.nowMs();
  }
  private tx<T>(label: string, fn: (db: DatabaseSync) => T): T {
    return this.store.journal.transact(label, fn);
  }
  private read<T>(fn: (db: DatabaseSync) => T): T {
    return this.store.journal.read(fn);
  }

  // -------------------------------------------------------------------------------------------
  // Reviewer principals.

  enrollReviewer(input: {
    projectId: string;
    label: string;
    publicKeyJwk: { kty: string; crv: string; x: string };
    validFromMs: number;
    validUntilMs: number;
    confirmation: { confirmationId: string; code: string; planDigest: string };
  }): { reviewerId: string; keyDigest: string; planDigest: string } {
    const k = input.publicKeyJwk;
    if (k.kty !== 'OKP' || k.crv !== 'Ed25519' || !KEY_X.test(k.x)) {
      fail('RS_SCHEMA_INVALID', 'A reviewer key must be an Ed25519 public key.');
    }
    if (input.validUntilMs <= input.validFromMs || input.validUntilMs <= this.now()) {
      fail('RS_SCHEMA_INVALID', 'The validity window is empty or already over.');
    }
    const plan: ReviewerEnrollmentPlan = {
      projectId: input.projectId,
      label: input.label,
      publicKeyX: k.x,
      validFromMs: input.validFromMs,
      validUntilMs: input.validUntilMs,
    };
    const planDigest = reviewerEnrollmentPlanDigest(plan);
    if (planDigest !== input.confirmation.planDigest) {
      fail('RS_LOCAL_CONFIRMATION_INVALID', 'The confirmation was issued for a different enrollment plan.');
    }
    const keyDigest = reviewerKeyDigest(k.x);
    return this.tx('review.reviewer.enroll', (db) => {
      if (!one(db, 'SELECT 1 AS x FROM projects WHERE project_id = ?', input.projectId)) {
        fail('RS_NOT_FOUND', 'Project not found.');
      }
      this.control.consumeConfirmation(db, { ...input.confirmation, actionCode: 'PROFILE_REVIEWER_ENROLL' });
      // Independence from the operator: no enrolled launcher key may review.
      for (const p of all(
        db,
        "SELECT policy_json FROM attester_policies WHERE policy_json LIKE '%publicKeyJwk%'",
      )) {
        const pol = JSON.parse(s(p, 'policy_json')) as { publicKeyJwk?: { x?: string } };
        if (pol.publicKeyJwk?.x === k.x) {
          fail(
            'RS_REVIEWER_NOT_INDEPENDENT',
            'This key is an enrolled launcher key; a reviewer needs its own key.',
          );
        }
      }
      if (
        one(
          db,
          'SELECT 1 AS x FROM profile_reviewers WHERE project_id = ? AND key_digest = ?',
          input.projectId,
          keyDigest,
        )
      ) {
        fail('RS_DUPLICATE', 'This reviewer key is already enrolled in the project.');
      }
      const reviewerId = randomUUID();
      run(
        db,
        `INSERT INTO profile_reviewers(reviewer_id, project_id, label, kind, public_key_x, key_digest, valid_from_ms,
           valid_until_ms, plan_digest, confirmation_id, enrolled_at_ms)
         VALUES (?,?,?,'LOCAL_REVIEWER_KEY',?,?,?,?,?,?,?)`,
        reviewerId,
        input.projectId,
        input.label,
        k.x,
        keyDigest,
        input.validFromMs,
        input.validUntilMs,
        planDigest,
        input.confirmation.confirmationId,
        this.now(),
      );
      this.control.auditIn(db, 'PROFILE_REVIEWER_ENROLLED', 'profile_reviewer', reviewerId, { keyDigest });
      return { reviewerId, keyDigest, planDigest };
    });
  }

  revokeReviewer(input: {
    reviewerId: string;
    reasonCode: string;
    confirmation: { confirmationId: string; code: string; planDigest: string };
  }): { reviewerId: string; revoked: true } {
    if (!(REVIEWER_REVOCATION_REASONS as readonly string[]).includes(input.reasonCode)) {
      fail('RS_SCHEMA_INVALID', 'Unknown revocation reason.');
    }
    if (input.confirmation.planDigest !== reviewerRevocationPlanDigest(input.reviewerId, input.reasonCode)) {
      fail('RS_LOCAL_CONFIRMATION_INVALID', 'The confirmation was issued for a different revocation plan.');
    }
    return this.tx('review.reviewer.revoke', (db) => {
      if (!one(db, 'SELECT 1 AS x FROM profile_reviewers WHERE reviewer_id = ?', input.reviewerId)) {
        fail('RS_NOT_FOUND', 'Profile reviewer not found.');
      }
      if (
        one(db, 'SELECT 1 AS x FROM profile_reviewer_revocations WHERE reviewer_id = ?', input.reviewerId)
      ) {
        fail('RS_DUPLICATE', 'The reviewer is already revoked.');
      }
      this.control.consumeConfirmation(db, { ...input.confirmation, actionCode: 'PROFILE_REVIEWER_REVOKE' });
      run(
        db,
        `INSERT INTO profile_reviewer_revocations(revocation_id, reviewer_id, reason_code, confirmation_id, revoked_at_ms)
         VALUES (?,?,?,?,?)`,
        randomUUID(),
        input.reviewerId,
        input.reasonCode,
        input.confirmation.confirmationId,
        this.now(),
      );
      this.control.auditIn(db, 'PROFILE_REVIEWER_REVOKED', 'profile_reviewer', input.reviewerId, {
        reasonCode: input.reasonCode,
      });
      return { reviewerId: input.reviewerId, revoked: true as const };
    });
  }

  getReviewer(reviewerId: string): Row | undefined {
    return this.read((db) =>
      one(
        db,
        `SELECT p.*, CASE WHEN r.reviewer_id IS NULL THEN 0 ELSE 1 END AS revoked, r.reason_code AS revocation_reason
           FROM profile_reviewers p LEFT JOIN profile_reviewer_revocations r USING (reviewer_id) WHERE p.reviewer_id = ?`,
        reviewerId,
      ),
    );
  }

  listReviewers(projectId: string): Row[] {
    return this.read((db) =>
      all(
        db,
        `SELECT p.*, CASE WHEN r.reviewer_id IS NULL THEN 0 ELSE 1 END AS revoked
           FROM profile_reviewers p LEFT JOIN profile_reviewer_revocations r USING (reviewer_id)
          WHERE p.project_id = ? ORDER BY p.enrolled_at_ms, p.reviewer_id`,
        projectId,
      ),
    );
  }

  private activeReviewer(db: DatabaseSync, reviewerId: string, projectId: string): Row {
    const r = one(db, 'SELECT * FROM profile_reviewers WHERE reviewer_id = ?', reviewerId);
    if (!r || r['project_id'] !== projectId) fail('RS_NOT_FOUND', 'Profile reviewer not found.');
    if (one(db, 'SELECT 1 AS x FROM profile_reviewer_revocations WHERE reviewer_id = ?', reviewerId)) {
      fail('RS_PROFILE_REVIEW_INVALID', 'The reviewer is revoked.');
    }
    const now = this.now();
    if (now < n(r, 'valid_from_ms') || now >= n(r, 'valid_until_ms')) {
      fail('RS_PROFILE_REVIEW_INVALID', 'The reviewer is outside its validity window.');
    }
    return r;
  }

  // -------------------------------------------------------------------------------------------
  // Registered profiles (read only; registration lives in ControlJournal).

  getProfile(profileId: string): Row | undefined {
    return this.read((db) => one(db, 'SELECT * FROM interceptor_profiles WHERE profile_id = ?', profileId));
  }

  listProfiles(projectId: string): Row[] {
    return this.read((db) =>
      all(
        db,
        'SELECT * FROM interceptor_profiles WHERE project_id = ? ORDER BY created_at_ms, profile_id',
        projectId,
      ),
    );
  }

  // -------------------------------------------------------------------------------------------
  // Challenges and signed reviews.

  createReviewChallenge(input: {
    projectId: string;
    profileDigest: string;
    reviewerId: string;
    decision: ProfileReviewDecision;
    checklist: Readonly<Record<string, boolean>>;
    ttlMs: number;
  }): ReviewChallenge {
    const keys = Object.keys(input.checklist).sort();
    const expected = [...PROFILE_REVIEW_CHECKLIST].sort();
    if (keys.length !== expected.length || !keys.every((k, i) => k === expected[i])) {
      fail('RS_PROFILE_REVIEW_INVALID', 'The checklist must answer exactly the review checklist items.');
    }
    if (
      input.decision === 'APPROVED' &&
      !PROFILE_REVIEW_CHECKLIST.every((c) => input.checklist[c] === true)
    ) {
      fail('RS_PROFILE_REVIEW_INVALID', 'An approving review must confirm every checklist item.');
    }
    return this.tx('review.challenge', (db) => {
      const profile = one(
        db,
        'SELECT * FROM interceptor_profiles WHERE project_id = ? AND profile_digest = ?',
        input.projectId,
        input.profileDigest,
      );
      if (!profile) fail('RS_NOT_FOUND', 'Interceptor profile not found.');
      if (input.decision === 'APPROVED' && profile['containment'] !== 'PROCESS_TREE_ENFORCED') {
        fail(
          'RS_PROFILE_REVIEW_INVALID',
          'A profile that does not confine the process tree cannot be approved.',
        );
      }
      const reviewer = this.activeReviewer(db, input.reviewerId, input.projectId);
      const now = this.now();
      const challengeId = randomUUID();
      const checklist = Object.fromEntries(
        PROFILE_REVIEW_CHECKLIST.map((c) => [c, input.checklist[c] === true]),
      ) as Record<ProfileReviewCheck, boolean>;
      const statement: ProfileReviewStatement = {
        domain: 'routespec.interceptor-profile-review/1',
        projectId: input.projectId,
        profileId: s(profile, 'profile_id'),
        profileDigest: input.profileDigest,
        profile: {
          interceptorArtifactDigest: s(profile, 'interceptor_artifact_digest'),
          containment: s(profile, 'containment'),
          processTreeScope: s(profile, 'process_tree_scope'),
          supportedSinks: JSON.parse(s(profile, 'supported_sinks_json')) as string[],
          denialMechanism: s(profile, 'denial_mechanism'),
        },
        reviewerId: input.reviewerId,
        reviewerKeyDigest: s(reviewer, 'key_digest'),
        decision: input.decision,
        checklist,
        challengeId,
        nonce: randomBytes(24).toString('base64url'),
        issuedAtMs: now,
        expiresAtMs: now + input.ttlMs,
      };
      const statementDigest = profileReviewStatementDigest(statement);
      run(
        db,
        `INSERT INTO profile_review_challenges(challenge_id, project_id, profile_id, profile_digest, reviewer_id, decision,
           statement_json, statement_digest, issued_at_ms, expires_at_ms, consumed_at_ms)
         VALUES (?,?,?,?,?,?,?,?,?,?,NULL)`,
        challengeId,
        input.projectId,
        statement.profileId,
        input.profileDigest,
        input.reviewerId,
        input.decision,
        canonicalJson(statement),
        statementDigest,
        now,
        statement.expiresAtMs,
      );
      return {
        challengeId,
        statement,
        statementDigest,
        signingPayload: profileReviewSigningBytes(statement).toString('base64url'),
        expiresAtMs: statement.expiresAtMs,
      };
    });
  }

  getChallenge(challengeId: string): Row | undefined {
    return this.read((db) =>
      one(db, 'SELECT * FROM profile_review_challenges WHERE challenge_id = ?', challengeId),
    );
  }

  /** Verify the reviewer's signature over the challenge statement and record the review. */
  recordReview(input: { challengeId: string; signature: string }): {
    reviewId: string;
    reviewDigest: string;
    profileDigest: string;
    decision: ProfileReviewDecision;
    reviewedAtMs: number;
  } {
    if (!SIGNATURE.test(input.signature))
      fail('RS_REVIEW_SIGNATURE_INVALID', 'The review signature is malformed.');
    return this.tx('review.record', (db) => {
      const c = one(db, 'SELECT * FROM profile_review_challenges WHERE challenge_id = ?', input.challengeId);
      if (!c) fail('RS_NOT_FOUND', 'Review challenge not found.');
      const now = this.now();
      if (c['consumed_at_ms'] !== null || n(c, 'expires_at_ms') <= now) {
        fail('RS_PROFILE_REVIEW_INVALID', 'The review challenge is used or expired.');
      }
      const statement = JSON.parse(s(c, 'statement_json')) as ProfileReviewStatement;
      if (profileReviewStatementDigest(statement) !== s(c, 'statement_digest')) {
        fail('RS_IDENTITY_MISMATCH', 'The stored review statement does not match its digest.');
      }
      const reviewer = this.activeReviewer(db, s(c, 'reviewer_id'), s(c, 'project_id'));
      if (s(reviewer, 'key_digest') !== statement.reviewerKeyDigest) {
        fail('RS_IDENTITY_MISMATCH', 'The statement names a different reviewer key.');
      }
      const key = createPublicKey({
        key: { kty: 'OKP', crv: 'Ed25519', x: s(reviewer, 'public_key_x') },
        format: 'jwk',
      });
      const ok = verifySignature(
        null,
        profileReviewSigningBytes(statement),
        key,
        Buffer.from(input.signature, 'base64url'),
      );
      if (!ok)
        fail(
          'RS_REVIEW_SIGNATURE_INVALID',
          'The signature does not verify against the enrolled reviewer key.',
        );
      const profile = one(db, 'SELECT * FROM interceptor_profiles WHERE profile_id = ?', s(c, 'profile_id'));
      if (!profile || profile['profile_digest'] !== statement.profileDigest) {
        fail('RS_IDENTITY_MISMATCH', 'The statement does not bind the registered profile.');
      }
      run(
        db,
        'UPDATE profile_review_challenges SET consumed_at_ms = ? WHERE challenge_id = ?',
        now,
        input.challengeId,
      );
      const reviewId = randomUUID();
      const reviewDigest = digestValue(PROFILE_REVIEW_DIGEST_DOMAIN, {
        statementDigest: s(c, 'statement_digest'),
        signature: input.signature,
        reviewerKeyDigest: statement.reviewerKeyDigest,
      });
      run(
        db,
        `INSERT INTO interceptor_profile_reviews(review_id, project_id, profile_id, profile_digest, reviewer_id,
           reviewer_key_digest, challenge_id, decision, checklist_json, statement_json, statement_digest, signature,
           review_digest, reviewed_at_ms)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        reviewId,
        s(c, 'project_id'),
        s(c, 'profile_id'),
        statement.profileDigest,
        s(c, 'reviewer_id'),
        statement.reviewerKeyDigest,
        input.challengeId,
        statement.decision,
        canonicalJson(statement.checklist),
        s(c, 'statement_json'),
        s(c, 'statement_digest'),
        input.signature,
        reviewDigest,
        now,
      );
      this.control.auditIn(db, 'INTERCEPTOR_PROFILE_REVIEWED', 'interceptor_profile', s(c, 'profile_id'), {
        reviewId,
        decision: statement.decision,
      });
      return {
        reviewId,
        reviewDigest,
        profileDigest: statement.profileDigest,
        decision: statement.decision,
        reviewedAtMs: now,
      };
    });
  }

  revokeReview(input: {
    reviewId: string;
    reasonCode: string;
    confirmation: { confirmationId: string; code: string; planDigest: string };
  }): { reviewId: string; revoked: true } {
    if (!(REVIEW_REVOCATION_REASONS as readonly string[]).includes(input.reasonCode)) {
      fail('RS_SCHEMA_INVALID', 'Unknown revocation reason.');
    }
    if (input.confirmation.planDigest !== reviewRevocationPlanDigest(input.reviewId, input.reasonCode)) {
      fail('RS_LOCAL_CONFIRMATION_INVALID', 'The confirmation was issued for a different revocation plan.');
    }
    return this.tx('review.revoke', (db) => {
      const r = one(db, 'SELECT * FROM interceptor_profile_reviews WHERE review_id = ?', input.reviewId);
      if (!r) fail('RS_NOT_FOUND', 'Profile review not found.');
      if (
        one(
          db,
          'SELECT 1 AS x FROM interceptor_profile_review_revocations WHERE review_id = ?',
          input.reviewId,
        )
      ) {
        fail('RS_DUPLICATE', 'The review is already revoked.');
      }
      this.control.consumeConfirmation(db, { ...input.confirmation, actionCode: 'PROFILE_REVIEW_REVOKE' });
      run(
        db,
        `INSERT INTO interceptor_profile_review_revocations(revocation_id, review_id, reason_code, confirmation_id, revoked_at_ms)
         VALUES (?,?,?,?,?)`,
        randomUUID(),
        input.reviewId,
        input.reasonCode,
        input.confirmation.confirmationId,
        this.now(),
      );
      this.control.auditIn(
        db,
        'INTERCEPTOR_PROFILE_REVIEW_REVOKED',
        'interceptor_profile',
        s(r, 'profile_id'),
        {
          reviewId: input.reviewId,
          reasonCode: input.reasonCode,
        },
      );
      return { reviewId: input.reviewId, revoked: true as const };
    });
  }

  getReview(reviewId: string): Row | undefined {
    return this.read((db) =>
      one(
        db,
        `SELECT r.*, CASE WHEN v.review_id IS NULL THEN 0 ELSE 1 END AS revoked, v.reason_code AS revocation_reason,
                v.revoked_at_ms
           FROM interceptor_profile_reviews r LEFT JOIN interceptor_profile_review_revocations v USING (review_id)
          WHERE r.review_id = ?`,
        reviewId,
      ),
    );
  }

  listReviews(projectId: string, profileDigest: string): Row[] {
    return this.read((db) =>
      all(
        db,
        `SELECT r.review_id, r.profile_digest, r.reviewer_id, r.decision, r.checklist_json, r.statement_digest,
                r.review_digest, r.reviewed_at_ms, CASE WHEN v.review_id IS NULL THEN 0 ELSE 1 END AS revoked,
                v.reason_code AS revocation_reason, v.revoked_at_ms
           FROM interceptor_profile_reviews r LEFT JOIN interceptor_profile_review_revocations v USING (review_id)
          WHERE r.project_id = ? AND r.profile_digest = ? ORDER BY r.reviewed_at_ms, r.review_id`,
        projectId,
        profileDigest,
      ),
    );
  }

  /** Effective review state of a registered profile now (or at `asOfMs`). */
  profileReviewState(
    projectId: string,
    profileDigest: string,
    asOfMs: number = this.now(),
  ): EffectiveProfileReview {
    return this.read((db) =>
      effectiveProfileReview(
        profileDigest,
        profileReviewFactRows(db, projectId, profileDigest).map(reviewFactFromRow),
        asOfMs,
      ),
    );
  }
}

export function reviewerRevocationPlanDigest(reviewerId: string, reasonCode: string): string {
  return digestValue('routespec.profile-reviewer-revocation/1', { reviewerId, reasonCode });
}

export function reviewRevocationPlanDigest(reviewId: string, reasonCode: string): string {
  return digestValue('routespec.profile-review-revocation/1', { reviewId, reasonCode });
}
