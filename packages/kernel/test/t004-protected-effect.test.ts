/**
 * T-004 — Protected side effect requires configured terminal evidence. Covers FR-09, INV-04.
 *
 * Live path (real processes): an exact build/artifact/scenario effect manifest and an
 * INDEPENDENT_BOUNDARY_INTERCEPT policy pinned to the reviewed canary interceptor profile are
 * registered; the interceptor is launched as a separate process over its private inherited
 * pipe; the subject attempts the configured canary sink over loopback. Before accepted
 * completion the interceptor observes and denies the effect while the subject's self-report stays
 * a separate SUBJECT_REPORTED row; after proven completion and a fenced release authorization the
 * allowed path reaches the no-effect canary. Variants: inventory basis with an unsupported dynamic
 * call, missing / forged (profile mismatch) / stale interceptor, process-tree escape finding,
 * missing teardown, channel loss, unobserved required sink, subject-reported bypass, declared
 * hooks only, a release authorized on a provider report, and a release before completion.
 *
 * Boundary of this host: no OS/container sandbox confines the subject process tree and no
 * attester principal is enrolled, so the live interceptor is honestly DECLARED_HOOKS_ONLY
 * containment and unattested. The live complete-coverage case is therefore REVIEW here. The PASS
 * semantics are proven by the pure kernel on the same real journal snapshot with only those two
 * facts (attested build/interceptor, process-tree enforcement) supplied; that is labelled
 * kernel-semantics evidence, not a live complete-effect claim.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InterceptorHost, CANARY_INTERCEPTOR_PROFILE } from '@routespec/proxy';
import { evaluateCase, evaluateInv04 } from '../src/index.ts';
import type { KernelInput } from '../src/index.ts';
import { mutate, type Mutable } from './support/pure.ts';
import { Harness, openStore, tempDir } from './support/journal.ts';
import { SINK, runLiveEffectCase } from './support/effects.ts';

let tmp: ReturnType<typeof tempDir>;
let store: ReturnType<typeof openStore>;
let h: Harness;

beforeAll(async () => {
  tmp = tempDir();
  store = openStore(tmp.dir);
  h = await Harness.start(store);
});
afterAll(async () => {
  await h.close();
  store.close();
  tmp.cleanup();
});

describe('T-004 — Protected side effect requires configured terminal evidence', () => {
  it('live: denies before completion, releases to the canary after proven completion; subject report stays separate', async () => {
    const c = await runLiveEffectCase(h, 't004-main');
    expect(c.attempts.map((a) => [a.phase, a.status])).toEqual([
      ['before-completion', 409],
      ['after-completion', 202],
    ]);
    expect(c.attempts[0]!.body).toMatchObject({ denied: true, reason: 'EFFECT_NOT_RELEASED' });
    expect(c.attempts[1]!.body).toEqual({ denied: false, canary: true }); // no real target invoked
    expect(c.input.boundaryObservations.map((o) => o.action)).toEqual([
      'ATTEMPTED',
      'BLOCKED',
      'ATTEMPTED',
      'RELEASED',
    ]);
    expect(c.input.boundaryObservations.every((o) => o.sessionSequence !== null)).toBe(true);
    expect(c.input.subjectReports.map((r) => [r.action, r.coverageClassification])).toEqual([
      ['ATTEMPTED', 'SUBJECT_REPORTED'],
      ['RELEASED', 'SUBJECT_REPORTED'],
    ]);
    // Honest host boundary: no process-tree sandbox, no enrolled attester, and no signed review
    // of the pinned interceptor profile in this harness -> REVIEW, not FAIL.
    expect(c.inv04).toMatchObject({ verdict: 'REVIEW', explanationCode: 'INV04_COVERAGE_INCOMPLETE' });
    expect([...c.inv04.missingPredicates]).toEqual(
      [
        'BUILD_UNATTESTED',
        'INTERCEPTOR_PROFILE_UNREVIEWED',
        'INTERCEPTOR_UNATTESTED',
        'PROCESS_TREE_NOT_ENFORCED',
      ].sort(),
    );
    expect(c.evaluation.verdict).toBe('REVIEW');

    // Kernel semantics on the same real snapshot: with an attested build and interceptor and an
    // enforced process tree (facts this host cannot produce), the identical journal passes.
    const attested = mutate(c.input, (dr) => {
      const att = (attestationId: string, scope: string, digests: string[], build: string | null) => ({
        attestationId,
        attestationClass: 'CI_ATTESTED' as const,
        scope,
        buildRevisionId: build,
        observedDigests: digests,
        expiresAtMs: (dr.caseState.asOfMs ?? 0) + 60_000,
        principalEnabled: true,
        principalRevocationEpochAtIssue: 0,
        principalCurrentRevocationEpoch: 0,
        principalPolicyDigestAtIssue: 'sha256:' + '1'.repeat(64),
        principalCurrentPolicyDigest: 'sha256:' + '1'.repeat(64),
      });
      dr.identity.buildAttestationClass = 'CI_ATTESTED';
      dr.identity.buildAttestationId = '00000000-0000-4000-8000-0000000000b1';
      const inst = dr.interceptors[0]!;
      inst.attestationId = '00000000-0000-4000-8000-0000000000b2';
      inst.containment = 'PROCESS_TREE_ENFORCED';
      // A signed review of the pinned profile, recorded before the case input closed (M16).
      dr.interceptorProfileReviews = [
        {
          reviewId: '00000000-0000-4000-8000-0000000000b3',
          profileDigest: inst.interceptorProfileDigest,
          decision: 'APPROVED',
          reviewedAtMs: (dr.caseState.asOfMs ?? 0) - 1,
          reviewDigest: 'sha256:' + '2'.repeat(64),
          reviewRevoked: false,
          reviewerRevoked: false,
          reviewerValidFromMs: 0,
          reviewerValidUntilMs: (dr.caseState.asOfMs ?? 0) + 60_000,
        },
      ];
      dr.attestations = [
        att(
          dr.identity.buildAttestationId,
          'BUILD_REGISTRATION',
          [dr.identity.artifactDigest],
          dr.identity.buildRevisionId,
        ),
        att(
          inst.attestationId,
          'EFFECT_INTERCEPTOR_LAUNCH',
          [inst.artifactDigest, inst.interceptorProfileDigest],
          null,
        ),
      ];
    });
    expect(evaluateInv04(attested)[0]).toMatchObject({
      verdict: 'PASS',
      explanationCode: 'INV04_COMPLETE_INDEPENDENT_COVERAGE',
    });
    // ...and the same complete coverage with a revoked attester, or an expired attestation, reviews.
    const revoked = mutate(attested, (dr) => void (dr.attestations[1]!.principalCurrentRevocationEpoch = 1));
    expect(evaluateInv04(revoked)[0]!.missingPredicates).toContain('INTERCEPTOR_ATTESTER_REVOKED');
    const expired = mutate(attested, (dr) => void (dr.attestations[0]!.expiresAtMs = 0));
    expect(evaluateInv04(expired)[0]!.missingPredicates).toContain('BUILD_ATTESTATION_STALE');
    // ...and so does a revoked review, a revoked reviewer, a rejection, or a review recorded
    // after the case input closed (M16).
    const reviewGap = (fn: (r: Mutable<KernelInput>) => void) =>
      evaluateInv04(mutate(attested, fn))[0]!.missingPredicates;
    expect(reviewGap((dr) => void (dr.interceptorProfileReviews![0]!.reviewRevoked = true))).toContain(
      'INTERCEPTOR_PROFILE_REVIEW_REVOKED',
    );
    expect(reviewGap((dr) => void (dr.interceptorProfileReviews![0]!.reviewerRevoked = true))).toContain(
      'INTERCEPTOR_PROFILE_REVIEW_REVOKED',
    );
    expect(reviewGap((dr) => void (dr.interceptorProfileReviews![0]!.decision = 'REJECTED'))).toContain(
      'INTERCEPTOR_PROFILE_REVIEW_REJECTED',
    );
    expect(
      reviewGap(
        (dr) => void (dr.interceptorProfileReviews![0]!.reviewedAtMs = (dr.caseState.asOfMs ?? 0) + 1),
      ),
    ).toContain('INTERCEPTOR_PROFILE_UNREVIEWED');
    expect(
      reviewGap((dr) => void (dr.interceptorProfileReviews![0]!.profileDigest = 'sha256:' + '3'.repeat(64))),
    ).toContain('INTERCEPTOR_PROFILE_UNREVIEWED');
  });

  it('live: a release before accepted completion is an independently observed forbidden release (FAIL)', async () => {
    const c = await runLiveEffectCase(h, 't004-early', { releaseEarly: true });
    expect(c.attempts[0]).toMatchObject({ phase: 'before-completion', status: 202 });
    expect(c.inv04).toMatchObject({ verdict: 'FAIL', explanationCode: 'INV04_FORBIDDEN_RELEASE_OBSERVED' });
    expect(c.evaluation.verdict).toBe('FAIL');
  });

  it('live: a release authorized on a provider report (not accepted completion evidence) is FAIL', async () => {
    const c = await runLiveEffectCase(h, 't004-reported', { authorizeWith: 'PROVIDER_REPORT' });
    expect(c.attempts.at(-1)).toMatchObject({ status: 202 });
    expect(c.inv04).toMatchObject({ verdict: 'FAIL', explanationCode: 'INV04_FORBIDDEN_RELEASE_OBSERVED' });
    expect(
      c.inv04.findings.some((f) => f.startsWith('RELEASE_AUTHORIZED_WITHOUT_ACCEPTED_COMPLETION:')),
    ).toBe(true);
  });

  it('live: declared hooks only is REVIEW with the required label, never PASS', async () => {
    const c = await runLiveEffectCase(h, 't004-declared', {
      basis: 'DECLARED_HOOKS_ONLY',
      interceptorProfileDigest: null,
    });
    expect(c.inv04).toMatchObject({ verdict: 'REVIEW', explanationCode: 'INV04_DECLARED_HOOKS_ONLY' });
    expect(c.inv04.missingPredicates).toContain('DECLARED_HOOKS_ONLY');
  });

  it('live: inventory basis with an unsupported dynamic call site is REVIEW; the inventory never replaces interception', async () => {
    const c = await runLiveEffectCase(h, 't004-inventory', {
      basis: 'TRUSTED_BUILD_INVENTORY_PLUS_INTERCEPT',
      callsiteInventory: {
        callsites: [
          { callsiteId: 'cs-1', sinkClass: SINK, hookId: 'fulfilment', dynamic: false },
          { callsiteId: 'cs-2', sinkClass: SINK, hookId: null, dynamic: true },
        ],
        unsupportedFindings: 1,
      },
    });
    expect(c.inv04.verdict).toBe('REVIEW');
    expect(c.inv04.missingPredicates).toEqual(
      expect.arrayContaining(['UNSUPPORTED_DYNAMIC_CALL', 'INVENTORY_UNATTESTED']),
    );
    // Inventory without an interceptor is still incomplete (kernel on the same snapshot).
    const inventoryOnly = mutate(c.input, (dr) => {
      dr.interceptors = [];
      dr.boundaryObservations = [];
    });
    expect(evaluateInv04(inventoryOnly)[0]!.missingPredicates).toEqual(
      expect.arrayContaining(['INTERCEPTOR_MISSING', `REQUIRED_SINK_UNOBSERVED:${SINK}`]),
    );
    const mismatched = mutate(
      c.input,
      (dr) => void (dr.callsiteInventory!.manifestDigest = 'sha256:' + '2'.repeat(64)),
    );
    expect(evaluateInv04(mismatched)[0]!.missingPredicates).toContain('INVENTORY_MISMATCH');
  });

  it('live: a missing interceptor, an unpinned forged profile, and a stale instance are REVIEW', async () => {
    const missing = await runLiveEffectCase(h, 't004-missing', { launch: false });
    expect(missing.inv04.missingPredicates).toEqual(
      expect.arrayContaining(['INTERCEPTOR_MISSING', `REQUIRED_SINK_UNOBSERVED:${SINK}`]),
    );
    expect(missing.inv04.verdict).toBe('REVIEW');

    // A modified interceptor artifact is refused before anything is spawned (M02 guard) ...
    await expect(
      InterceptorHost.launch({
        store,
        fence: h.supervisor.fenceFor(missing.caseRunId),
        profile: { ...CANARY_INTERCEPTOR_PROFILE, artifactDigest: `sha256:${'3'.repeat(64)}` },
      }),
    ).rejects.toMatchObject({ code: 'RS_IDENTITY_MISMATCH' });
    // ... and an instance whose profile is not the policy's pinned profile cannot cover or prove.
    const forged = await runLiveEffectCase(h, 't004-forged', {
      interceptorProfileDigest: 'sha256:' + '4'.repeat(64),
      releaseEarly: true,
    });
    expect(forged.inv04.verdict).toBe('REVIEW'); // its release frame is not independent proof
    expect(forged.inv04.missingPredicates).toEqual(
      expect.arrayContaining(['INTERCEPTOR_PROFILE_MISMATCH', 'OBSERVATION_IDENTITY_MISMATCH']),
    );

    const stale = await runLiveEffectCase(h, 't004-stale', { staleInterceptor: true });
    expect(stale.attempts[0]!.status).toBe(503); // frames from a stale epoch fail closed
    expect(stale.inv04.missingPredicates).toContain('INTERCEPTOR_STALE');
    expect(stale.inv04.verdict).toBe('REVIEW');
  });

  it('live: process-tree escape, missing teardown, channel loss, and a subject-reported bypass are REVIEW', async () => {
    const escape = await runLiveEffectCase(h, 't004-escape', { escapeFinding: true });
    expect(escape.inv04.missingPredicates).toContain(`PROCESS_TREE_ESCAPE:${SINK}`);
    expect(escape.inv04.verdict).toBe('REVIEW');

    const noTeardown = await runLiveEffectCase(h, 't004-noteardown', { teardown: false });
    expect(noTeardown.inv04.missingPredicates).toContain('TEARDOWN_MISSING');

    const lost = await runLiveEffectCase(h, 't004-lost', { killInterceptor: true });
    expect(lost.inv04.missingPredicates).toContain('CHANNEL_LOST');
    expect(lost.inv04.verdict).toBe('REVIEW');

    const bypass = await runLiveEffectCase(h, 't004-bypass', { unobservedSubjectRelease: true });
    expect(bypass.inv04.missingPredicates).toEqual(
      expect.arrayContaining([
        'SUBJECT_EFFECT_UNOBSERVED:t004-bypass-bypass',
        'SUBJECT_REPORTED_EARLY_RELEASE',
      ]),
    );
    expect(bypass.inv04.verdict).toBe('REVIEW'); // a self-report never proves a violation or coverage
  });

  it('live: an unobserved or unsupported required sink is REVIEW', async () => {
    const c = await runLiveEffectCase(h, 't004-sinks', { requiredSinks: [SINK, 'email-notify'] });
    expect(c.inv04.missingPredicates).toEqual(
      expect.arrayContaining([
        'SINK_UNSUPPORTED:email-notify',
        'REQUIRED_SINK_UNOBSERVED:email-notify',
        'MANIFEST_SINK_UNDECLARED:email-notify',
      ]),
    );
    expect(c.inv04.verdict).toBe('REVIEW');
    expect(evaluateCase(c.input).verdict).toBe('REVIEW');
  });
});
