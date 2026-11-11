/**
 * CI attestation availability (FR-01, SECURITY.md TB-07; ADR-0013 decision 9, ADR-0015).
 *
 * A `CI_ATTESTED` record needs (1) a `CI_OIDC` principal that a local administrator enrolled in
 * the journal the job uses, with a second local confirmation, and (2) an OIDC token whose
 * `nonce` claim equals `digest(challengeId, nonce, observedDigests)` (`ciNonceBinding` in the
 * control API), so the issuer's signature covers the digests the job measured.
 *
 * The hosted GitHub Actions issuer lets a job choose only the `audience` of its token; it has no
 * caller-controlled `nonce` claim. A job also starts from an empty journal and CI may never enroll
 * a principal itself (authorization matrix). So the gate action never requests an OIDC token and
 * never claims an attestation: the build stays `USER_ASSERTED_LOCAL`, and a gate that requires an
 * attested build reports REVIEW (`BUILD_UNATTESTED`). The decision is recorded with its reason.
 */
import type { CiContext } from './context.ts';

export type CiAttestationState =
  | { readonly status: 'NOT_APPLICABLE'; readonly reason: 'NOT_IN_CI' }
  | {
      readonly status: 'UNAVAILABLE';
      readonly reason: 'HOSTED_ISSUER_CANNOT_BIND_NONCE';
      readonly principalEnrolled: false;
      readonly tokenRequested: false;
    };

export function ciAttestationState(ctx: CiContext): CiAttestationState {
  if (ctx.provider === 'LOCAL') return { status: 'NOT_APPLICABLE', reason: 'NOT_IN_CI' };
  return {
    status: 'UNAVAILABLE',
    reason: 'HOSTED_ISSUER_CANNOT_BIND_NONCE',
    principalEnrolled: false,
    tokenRequested: false,
  };
}
