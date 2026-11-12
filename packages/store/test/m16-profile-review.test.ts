/**
 * M16 — interceptor profile review workflow at the journal boundary (RP-02, RP-06).
 *
 * Real Ed25519 keys generated for a local test reviewer; real local confirmations; the journal
 * verifies every signature. The independent human review itself is NOT_RUN: this proves the
 * workflow, not that anyone outside the operator reviewed the canary interceptor.
 */
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROFILE_REVIEW_CHECKLIST, digestValue, isRouteSpecError } from '@routespec/contracts';
import {
  ControlJournal,
  ProfileReviewJournal,
  RouteSpecStore,
  reviewRevocationPlanDigest,
  reviewerEnrollmentPlanDigest,
  reviewerRevocationPlanDigest,
} from '../src/index.ts';
import { ManualClock, d, openStore, tempDir } from './support/fixture.ts';

interface Key {
  readonly x: string;
  readonly privateKey: KeyObject;
}

function newKey(): Key {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { x: String(publicKey.export({ format: 'jwk' }).x), privateKey };
}

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return isRouteSpecError(error) ? error.code : `UNTYPED:${String(error)}`;
  }
}

const allChecked = Object.fromEntries(PROFILE_REVIEW_CHECKLIST.map((c) => [c, true]));

let tmp: ReturnType<typeof tempDir>;
let clock: ManualClock;
let store: RouteSpecStore;
let control: ControlJournal;
let reviews: ProfileReviewJournal;
let projectId: string;
let profileDigest: string;

function confirm(actionCode: string, planDigest: string) {
  const c = control.issueConfirmation({ actionCode, planDigest, ttlMs: 60_000 });
  return { confirmationId: c.confirmationId, code: c.code, planDigest };
}

function enroll(key: Key, label = 'test reviewer') {
  const plan = {
    projectId,
    label,
    publicKeyX: key.x,
    validFromMs: clock.nowMs() - 1000,
    validUntilMs: clock.nowMs() + 86_400_000,
  };
  return reviews.enrollReviewer({
    projectId,
    label,
    publicKeyJwk: { kty: 'OKP', crv: 'Ed25519', x: key.x },
    validFromMs: plan.validFromMs,
    validUntilMs: plan.validUntilMs,
    confirmation: confirm('PROFILE_REVIEWER_ENROLL', reviewerEnrollmentPlanDigest(plan)),
  });
}

function review(reviewerId: string, key: Key, decision: 'APPROVED' | 'REJECTED' = 'APPROVED') {
  const c = reviews.createReviewChallenge({
    projectId,
    profileDigest,
    reviewerId,
    decision,
    checklist: allChecked,
    ttlMs: 60_000,
  });
  const signature = sign(null, Buffer.from(c.signingPayload, 'base64url'), key.privateKey).toString(
    'base64url',
  );
  return {
    challenge: c,
    signature,
    recorded: reviews.recordReview({ challengeId: c.challengeId, signature }),
  };
}

beforeEach(() => {
  tmp = tempDir('routespec-m16-review-');
  clock = new ManualClock();
  store = openStore(tmp.dir, { clock });
  control = new ControlJournal(store);
  reviews = new ProfileReviewJournal(control);
  projectId = store.createProject({ name: 'm16 review', idempotencyKey: 'm16-review-project' }).projectId;
  profileDigest = control.registerInterceptorProfile({
    projectId,
    interceptorArtifactDigest: d('canary-interceptor'),
    containment: 'PROCESS_TREE_ENFORCED',
    processTreeScope: 'container:subject',
    supportedSinks: ['fulfilment-webhook'],
    denialMechanism: 'CANARY_REDIRECT',
  }).profileDigest;
});

afterEach(() => {
  store.close();
  tmp.cleanup();
});

describe('M16 — interceptor profile review workflow', () => {
  it('only a signed review by an enrolled reviewer moves the profile from DECLARED_UNREVIEWED to REVIEWED', () => {
    expect(reviews.profileReviewState(projectId, profileDigest).state).toBe('DECLARED_UNREVIEWED');
    const key = newKey();
    const { reviewerId } = enroll(key);
    // A signature by any other key is refused and records nothing.
    const c = reviews.createReviewChallenge({
      projectId,
      profileDigest,
      reviewerId,
      decision: 'APPROVED',
      checklist: allChecked,
      ttlMs: 60_000,
    });
    const forged = sign(null, Buffer.from(c.signingPayload, 'base64url'), newKey().privateKey).toString(
      'base64url',
    );
    expect(codeOf(() => reviews.recordReview({ challengeId: c.challengeId, signature: forged }))).toBe(
      'RS_REVIEW_SIGNATURE_INVALID',
    );
    // A signature over different bytes (a statement with another decision) is refused too.
    const other = sign(
      null,
      Buffer.from(
        Buffer.from(c.signingPayload, 'base64url').toString('utf8').replace('APPROVED', 'REJECTED'),
      ),
      key.privateKey,
    ).toString('base64url');
    expect(codeOf(() => reviews.recordReview({ challengeId: c.challengeId, signature: other }))).toBe(
      'RS_REVIEW_SIGNATURE_INVALID',
    );
    expect(reviews.profileReviewState(projectId, profileDigest).state).toBe('DECLARED_UNREVIEWED');
    // The real signature records one immutable review.
    const good = sign(null, Buffer.from(c.signingPayload, 'base64url'), key.privateKey).toString('base64url');
    const recorded = reviews.recordReview({ challengeId: c.challengeId, signature: good });
    expect(recorded).toMatchObject({ profileDigest, decision: 'APPROVED' });
    const state = reviews.profileReviewState(projectId, profileDigest);
    expect(state).toMatchObject({ state: 'REVIEWED', reviewId: recorded.reviewId, reviewCount: 1 });
    // The statement bound the exact registered profile and the reviewer's key.
    expect(c.statement).toMatchObject({
      profileDigest,
      reviewerId,
      decision: 'APPROVED',
      profile: { containment: 'PROCESS_TREE_ENFORCED', supportedSinks: ['fulfilment-webhook'] },
    });
    // The challenge is single use.
    expect(codeOf(() => reviews.recordReview({ challengeId: c.challengeId, signature: good }))).toBe(
      'RS_PROFILE_REVIEW_INVALID',
    );
    // Records are immutable; the declared profile row never changes.
    expect(
      codeOf(() =>
        store.journal.transact('t', (db) =>
          db.prepare("UPDATE interceptor_profile_reviews SET decision = 'REJECTED'").run(),
        ),
      ),
    ).not.toBeNull();
    expect(
      codeOf(() =>
        store.journal.transact('t', (db) => db.prepare('DELETE FROM interceptor_profile_reviews').run()),
      ),
    ).not.toBeNull();
    expect(control.getInterceptorProfile(projectId, profileDigest)?.['review_state']).toBe(
      'DECLARED_UNREVIEWED',
    );
  });

  it('an expired challenge, an incomplete checklist, or an unconfined profile cannot be approved', () => {
    const key = newKey();
    const { reviewerId } = enroll(key);
    const c = reviews.createReviewChallenge({
      projectId,
      profileDigest,
      reviewerId,
      decision: 'APPROVED',
      checklist: allChecked,
      ttlMs: 1000,
    });
    clock.advance(1001);
    const sig = sign(null, Buffer.from(c.signingPayload, 'base64url'), key.privateKey).toString('base64url');
    expect(codeOf(() => reviews.recordReview({ challengeId: c.challengeId, signature: sig }))).toBe(
      'RS_PROFILE_REVIEW_INVALID',
    );
    const partial = { ...allChecked, SUPPORTED_SINKS_COMPLETE: false };
    expect(
      codeOf(() =>
        reviews.createReviewChallenge({
          projectId,
          profileDigest,
          reviewerId,
          decision: 'APPROVED',
          checklist: partial,
          ttlMs: 60_000,
        }),
      ),
    ).toBe('RS_PROFILE_REVIEW_INVALID');
    const hooks = control.registerInterceptorProfile({
      projectId,
      interceptorArtifactDigest: d('canary-interceptor'),
      containment: 'DECLARED_HOOKS_ONLY',
      processTreeScope: 'host:unconfined',
      supportedSinks: ['fulfilment-webhook'],
      denialMechanism: 'DENY',
    }).profileDigest;
    expect(
      codeOf(() =>
        reviews.createReviewChallenge({
          projectId,
          profileDigest: hooks,
          reviewerId,
          decision: 'APPROVED',
          checklist: allChecked,
          ttlMs: 60_000,
        }),
      ),
    ).toBe('RS_PROFILE_REVIEW_INVALID');
    expect(reviews.profileReviewState(projectId, profileDigest).state).toBe('DECLARED_UNREVIEWED');
  });

  it('the reviewer is distinct from the operator: enrollment needs a local confirmation and a key that is not a launcher key', () => {
    const key = newKey();
    // Wrong or reused confirmation codes are refused.
    const plan = {
      projectId,
      label: 'test reviewer',
      publicKeyX: key.x,
      validFromMs: clock.nowMs() - 1000,
      validUntilMs: clock.nowMs() + 86_400_000,
    };
    const conf = confirm('PROFILE_REVIEWER_ENROLL', reviewerEnrollmentPlanDigest(plan));
    const attempt = (confirmation: typeof conf) =>
      codeOf(() =>
        reviews.enrollReviewer({
          projectId,
          label: plan.label,
          publicKeyJwk: { kty: 'OKP', crv: 'Ed25519', x: key.x },
          validFromMs: plan.validFromMs,
          validUntilMs: plan.validUntilMs,
          confirmation,
        }),
      );
    expect(attempt({ ...conf, code: 'not-the-code' })).toBe('RS_LOCAL_CONFIRMATION_INVALID');
    expect(attempt({ ...conf, planDigest: d('another-plan') })).toBe('RS_LOCAL_CONFIRMATION_INVALID');
    expect(attempt(conf)).toBeNull();
    expect(attempt(conf)).toBe('RS_LOCAL_CONFIRMATION_INVALID');

    // An enrolled launcher (operator) key can never be enrolled as a reviewer key ...
    const launcher = newKey();
    const policy = {
      kind: 'LOCAL_LAUNCHER_KEY',
      publicKeyJwk: { kty: 'OKP', crv: 'Ed25519', x: launcher.x },
      launcherArtifactDigest: d('launcher'),
      peerBinding: 'INHERITED_IPC_CHILD',
      validFromMs: clock.nowMs() - 1000,
      validUntilMs: clock.nowMs() + 86_400_000,
      maxFreshnessMs: 60_000,
    };
    const policyDigest = digestValue('routespec.attester-policy/1', { kind: policy.kind, policy });
    control.enrollPrincipal({
      projectId,
      label: 'operator launcher',
      kind: 'LOCAL_LAUNCHER_KEY',
      policy,
      keyOrIssuerPolicyDigest: d('k'),
      claimPolicyDigest: d('c'),
      audience: null,
      maxFreshnessMs: 60_000,
      validFromMs: policy.validFromMs,
      validUntilMs: policy.validUntilMs,
      confirmation: confirm('ATTESTER_ENROLL', policyDigest),
    });
    expect(codeOf(() => enroll(launcher, 'launcher as reviewer'))).toBe('RS_REVIEWER_NOT_INDEPENDENT');
    // ... and a reviewer key can never be enrolled as a launcher key.
    const reviewerPolicy = { ...policy, publicKeyJwk: { kty: 'OKP', crv: 'Ed25519', x: key.x } };
    const reviewerPolicyDigest = digestValue('routespec.attester-policy/1', {
      kind: reviewerPolicy.kind,
      policy: reviewerPolicy,
    });
    expect(
      codeOf(() =>
        control.enrollPrincipal({
          projectId,
          label: 'reviewer as launcher',
          kind: 'LOCAL_LAUNCHER_KEY',
          policy: reviewerPolicy,
          keyOrIssuerPolicyDigest: d('k2'),
          claimPolicyDigest: d('c2'),
          audience: null,
          maxFreshnessMs: 60_000,
          validFromMs: policy.validFromMs,
          validUntilMs: policy.validUntilMs,
          confirmation: confirm('ATTESTER_ENROLL', reviewerPolicyDigest),
        }),
      ),
    ).toBe('RS_REVIEWER_NOT_INDEPENDENT');
  });

  it('revocation of the review or of the reviewer leaves the record immutable and the profile no longer reviewed', () => {
    const key = newKey();
    const { reviewerId } = enroll(key);
    const first = review(reviewerId, key).recorded;
    expect(reviews.profileReviewState(projectId, profileDigest).state).toBe('REVIEWED');
    const reason = 'PROFILE_DEFECT_FOUND';
    expect(
      codeOf(() =>
        reviews.revokeReview({
          reviewId: first.reviewId,
          reasonCode: reason,
          confirmation: { ...confirm('PROFILE_REVIEW_REVOKE', d('x')), planDigest: d('x') },
        }),
      ),
    ).toBe('RS_LOCAL_CONFIRMATION_INVALID');
    reviews.revokeReview({
      reviewId: first.reviewId,
      reasonCode: reason,
      confirmation: confirm('PROFILE_REVIEW_REVOKE', reviewRevocationPlanDigest(first.reviewId, reason)),
    });
    expect(reviews.profileReviewState(projectId, profileDigest).state).toBe('REVIEW_REVOKED');
    expect(reviews.getReview(first.reviewId)).toMatchObject({ decision: 'APPROVED', revoked: 1 });
    // A new signed review restores it; a rejection by the same reviewer then wins.
    clock.advance(10);
    review(reviewerId, key);
    expect(reviews.profileReviewState(projectId, profileDigest).state).toBe('REVIEWED');
    clock.advance(10);
    review(reviewerId, key, 'REJECTED');
    expect(reviews.profileReviewState(projectId, profileDigest).state).toBe('REVIEW_REJECTED');
    // Revoking the reviewer makes all of its reviews ineffective and blocks new challenges.
    reviews.revokeReviewer({
      reviewerId,
      reasonCode: 'KEY_COMPROMISED',
      confirmation: confirm(
        'PROFILE_REVIEWER_REVOKE',
        reviewerRevocationPlanDigest(reviewerId, 'KEY_COMPROMISED'),
      ),
    });
    expect(reviews.profileReviewState(projectId, profileDigest).state).toBe('REVIEW_REVOKED');
    expect(codeOf(() => review(reviewerId, key))).toBe('RS_PROFILE_REVIEW_INVALID');
    expect(reviews.listReviews(projectId, profileDigest)).toHaveLength(3);
  });
});
