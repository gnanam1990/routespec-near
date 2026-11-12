/**
 * INV-04 — Protected side effects wait for accepted completion evidence (FR-09, TB-08,
 * TDD.md sections 10 and 18).
 *
 * Release ordering: every independent boundary frame and every release authorization carries a
 * position in the case journal order. A release authorization is valid only when it cites at
 * least one completion item (`effect_completion` or `destination_credit`) that is PROVEN in an
 * independent proof scope under the exact case identity and precedes the authorization. A
 * boundary `RELEASED` frame before the first valid authorization is a forbidden release.
 *
 * Verdict:
 * - FAIL when an identity-bound independent interceptor observed a forbidden release. This needs
 *   no completeness: one independent observation proves the violation.
 * - Otherwise REVIEW for any coverage gap: declared-hooks-only basis, user-asserted build,
 *   missing/mismatched/forged/stale/unattested interceptor, containment that does not confine
 *   the process tree, unsupported or unobserved required sink, missing teardown, channel loss,
 *   process-tree escape or unsupported dynamic call findings, inventory missing/mismatched/
 *   unattested/dynamic (for the inventory basis), unresolved attempts, subject reports that the
 *   boundary did not observe, or a subject-reported early release (self-report never proves).
 * - PASS only with complete, attested, independent runtime boundary coverage through a reviewed
 *   interceptor profile (M16): an unreviewed, rejected, or revoked profile review is a gap.
 */
import { checkAttestation } from '../attestation.ts';
import { judgeItem, proofPredicate } from '../evidence.ts';
import { invariantResult } from '../result.ts';
import type {
  BoundaryObservationRecord,
  InterceptorInstanceRecord,
  InvariantResult,
  KernelInput,
} from '../types.ts';
import { effectiveProfileReview, type EvidenceReason, type ProfileReviewState } from '@routespec/contracts';

const ID = 'INV-04';

/** The coverage gap for each non-reviewed profile state (M16). */
export const PROFILE_REVIEW_GAP: Readonly<Record<Exclude<ProfileReviewState, 'REVIEWED'>, string>> =
  Object.freeze({
    DECLARED_UNREVIEWED: 'INTERCEPTOR_PROFILE_UNREVIEWED',
    REVIEW_REJECTED: 'INTERCEPTOR_PROFILE_REVIEW_REJECTED',
    REVIEW_REVOKED: 'INTERCEPTOR_PROFILE_REVIEW_REVOKED',
  });

/** Evidence subjects that can establish accepted completion for protected effects. */
export const COMPLETION_SUBJECTS: readonly string[] = Object.freeze([
  'effect_completion',
  'destination_credit',
]);

function instanceBindingMismatches(inst: InterceptorInstanceRecord, input: KernelInput): string[] {
  const id = input.identity;
  const out: string[] = [];
  if (inst.buildRevisionId !== id.buildRevisionId) out.push('buildRevisionId');
  if (inst.gateRunId !== id.gateRunId) out.push('gateRunId');
  if (inst.caseRunId !== id.caseRunId) out.push('caseRunId');
  if (inst.sessionId !== id.sessionId) out.push('sessionId');
  if (inst.policyDigest !== id.effectCoveragePolicyDigest) out.push('policyDigest');
  if (inst.manifestDigest !== id.effectManifestDigest) out.push('manifestDigest');
  return out;
}

function observationBindingOk(
  o: BoundaryObservationRecord,
  inst: InterceptorInstanceRecord,
  input: KernelInput,
): boolean {
  const id = input.identity;
  return (
    o.buildRevisionId === id.buildRevisionId &&
    o.artifactDigest === id.artifactDigest &&
    o.gateRunId === id.gateRunId &&
    o.caseRunId === id.caseRunId &&
    o.sessionId === id.sessionId &&
    o.scenarioRevisionId === id.scenarioRevisionId &&
    o.policyDigest === id.effectCoveragePolicyDigest &&
    o.manifestDigest === id.effectManifestDigest &&
    o.interceptorProfileDigest === inst.interceptorProfileDigest &&
    o.fencingEpoch === inst.fencingEpoch
  );
}

export function evaluateInv04(input: KernelInput): InvariantResult[] {
  const id = input.identity;
  const policy = input.effectPolicy;
  const manifest = input.effectManifest;
  const required = [...(policy?.requiredSinkClasses ?? [])].sort();
  const gaps: string[] = [];
  const reasons = new Set<EvidenceReason>();
  const facts: string[] = [];
  const evidenceIds: string[] = [];

  if (
    policy !== null &&
    required.length === 0 &&
    input.boundaryObservations.length === 0 &&
    input.subjectReports.length === 0
  ) {
    return [invariantResult({ invariantId: ID, runOperationId: null, code: 'INV04_NO_PROTECTED_EFFECTS' })];
  }

  // --- policy and manifest identity -------------------------------------------------------
  if (policy === null) {
    gaps.push('POLICY_MISSING');
  } else {
    if (policy.policyDigest !== id.effectCoveragePolicyDigest) gaps.push('POLICY_MISMATCH');
    if (
      policy.buildRevisionId !== id.buildRevisionId ||
      policy.artifactDigest !== id.artifactDigest ||
      policy.scenarioRevisionId !== id.scenarioRevisionId ||
      policy.manifestDigest !== id.effectManifestDigest
    ) {
      gaps.push('POLICY_IDENTITY_MISMATCH');
    }
    if (policy.basis === 'DECLARED_HOOKS_ONLY') gaps.push('DECLARED_HOOKS_ONLY');
  }
  if (manifest === null) {
    gaps.push('MANIFEST_MISSING');
  } else {
    if (
      manifest.manifestDigest !== id.effectManifestDigest ||
      manifest.buildRevisionId !== id.buildRevisionId ||
      manifest.artifactDigest !== id.artifactDigest
    ) {
      gaps.push('MANIFEST_MISMATCH');
    }
    for (const sink of required) {
      if (!manifest.hooks.some((h) => h.sinkClass === sink && h.coverageExpectation === 'REQUIRED')) {
        gaps.push(`MANIFEST_SINK_UNDECLARED:${sink}`);
      }
    }
  }

  // --- subject build attestation: a user-asserted build never upgrades effect completeness ---
  if (id.buildAttestationClass === 'USER_ASSERTED_LOCAL') {
    gaps.push('BUILD_UNATTESTED');
    reasons.add('UNATTESTED_BUILD');
  } else {
    const b = checkAttestation(input, id.buildAttestationId, {
      scope: 'BUILD_REGISTRATION',
      buildRevisionId: id.buildRevisionId,
      digests: [id.artifactDigest],
      label: 'BUILD',
    });
    if (!b.ok) {
      gaps.push(...b.findings);
      reasons.add('UNATTESTED_BUILD');
    }
  }

  // --- interceptors ---------------------------------------------------------------------------
  const pinnedProfile = policy?.interceptorProfileDigest ?? null;
  // A complete-effect basis requires a reviewed interceptor profile (API-SPEC, RP-02): an
  // effective signed review recorded before the case input closed, not revoked, by a reviewer
  // that is neither revoked nor outside its validity window.
  if (policy !== null && policy.basis !== 'DECLARED_HOOKS_ONLY' && pinnedProfile !== null) {
    const review = effectiveProfileReview(
      pinnedProfile,
      input.interceptorProfileReviews ?? [],
      input.caseState.asOfMs,
    );
    if (review.state !== 'REVIEWED') gaps.push(PROFILE_REVIEW_GAP[review.state]);
    else facts.push(review.reviewId as string);
  }
  const violationCapable = new Set<string>();
  if (policy !== null && policy.basis !== 'DECLARED_HOOKS_ONLY' && input.interceptors.length === 0) {
    gaps.push('INTERCEPTOR_MISSING');
  }
  for (const inst of input.interceptors) {
    const mismatched = instanceBindingMismatches(inst, input);
    const profileOk = pinnedProfile === null || inst.interceptorProfileDigest === pinnedProfile;
    if (mismatched.length > 0) {
      gaps.push(...mismatched.map((f) => `INTERCEPTOR_IDENTITY_MISMATCH:${f}`));
      reasons.add('IDENTITY_MISMATCH');
    }
    if (!profileOk) {
      gaps.push('INTERCEPTOR_PROFILE_MISMATCH');
      reasons.add('IDENTITY_MISMATCH');
    }
    if (pinnedProfile === null) gaps.push('INTERCEPTOR_PROFILE_UNPINNED');
    if (mismatched.length === 0 && profileOk) violationCapable.add(inst.interceptorInstanceId);
    if (inst.fencingEpoch !== id.fencingEpoch) {
      gaps.push('INTERCEPTOR_STALE');
      reasons.add('STALE');
    }
    const a = checkAttestation(input, inst.attestationId, {
      scope: 'EFFECT_INTERCEPTOR_LAUNCH',
      buildRevisionId: null,
      digests: [inst.artifactDigest, inst.interceptorProfileDigest],
      label: 'INTERCEPTOR',
    });
    if (!a.ok) gaps.push(...a.findings);
    if (inst.containment !== 'PROCESS_TREE_ENFORCED') gaps.push('PROCESS_TREE_NOT_ENFORCED');
    for (const sink of required) {
      if (!inst.supportedSinks.includes(sink)) gaps.push(`SINK_UNSUPPORTED:${sink}`);
    }
    if (inst.teardownReason === null) gaps.push('TEARDOWN_MISSING');
    else if (inst.teardownReason === 'CHANNEL_LOST') gaps.push('CHANNEL_LOST');
  }

  // --- trusted build call-site inventory (supplemental, never a replacement) ------------------
  if (policy !== null && policy.basis === 'TRUSTED_BUILD_INVENTORY_PLUS_INTERCEPT') {
    const inv = input.callsiteInventory;
    if (inv === null) {
      gaps.push('INVENTORY_MISSING');
    } else {
      if (
        inv.inventoryDigest !== policy.callsiteInventoryDigest ||
        inv.buildRevisionId !== id.buildRevisionId ||
        inv.manifestDigest !== id.effectManifestDigest
      ) {
        gaps.push('INVENTORY_MISMATCH');
        reasons.add('IDENTITY_MISMATCH');
      }
      const a = checkAttestation(input, inv.attestationId, {
        scope: 'EFFECT_INVENTORY',
        buildRevisionId: id.buildRevisionId,
        digests: [inv.inventoryDigest, id.artifactDigest],
        label: 'INVENTORY',
      });
      if (!a.ok) gaps.push(...a.findings);
      if (inv.unsupportedFindings > 0 || inv.callsites.some((c) => c.dynamic)) {
        gaps.push('UNSUPPORTED_DYNAMIC_CALL');
        reasons.add('UNSUPPORTED');
      }
      for (const c of inv.callsites) {
        const covered =
          required.includes(c.sinkClass) &&
          input.interceptors.some((i) => i.supportedSinks.includes(c.sinkClass));
        if (!covered) gaps.push(`INVENTORY_SINK_UNCOVERED:${c.sinkClass}`);
      }
    }
  }

  // --- interceptor-reported coverage defects -------------------------------------------------
  for (const f of input.coverageFindings) {
    gaps.push(f.sinkClass === null ? f.kind : `${f.kind}:${f.sinkClass}`);
    if (f.kind === 'UNSUPPORTED_DYNAMIC_CALL') reasons.add('UNSUPPORTED');
  }

  // --- independent observations ----------------------------------------------------------------
  const instById = new Map(input.interceptors.map((i) => [i.interceptorInstanceId, i]));
  const valid: BoundaryObservationRecord[] = [];
  for (const o of input.boundaryObservations) {
    const inst = instById.get(o.interceptorInstanceId);
    if (!inst || !violationCapable.has(inst.interceptorInstanceId) || !observationBindingOk(o, inst, input)) {
      gaps.push('OBSERVATION_IDENTITY_MISMATCH');
      reasons.add('IDENTITY_MISMATCH');
      continue;
    }
    valid.push(o);
    facts.push(o.observationId);
  }
  for (const sink of required) {
    if (!valid.some((o) => o.sinkClass === sink)) gaps.push(`REQUIRED_SINK_UNOBSERVED:${sink}`);
  }

  // --- accepted completion and release authorization ----------------------------------------
  const evidenceById = new Map(input.evidence.map((e) => [e.evidenceId, e]));
  let firstValidAuth = Infinity;
  for (const auth of input.releaseAuthorizations) {
    const accepted = auth.completionEvidenceIds.filter((evId) => {
      const e = evidenceById.get(evId);
      if (!e || !COMPLETION_SUBJECTS.includes(e.subject) || e.sequence >= auth.sessionSequence) return false;
      return (
        judgeItem(e, proofPredicate('EFFECT_COMPLETION', e.subject, e.runOperationId), id).kind ===
        'SATISFIES'
      );
    });
    facts.push(auth.authorizationId);
    if (accepted.length > 0) {
      evidenceIds.push(...accepted);
      firstValidAuth = Math.min(firstValidAuth, auth.sessionSequence);
    } else {
      gaps.push(`RELEASE_AUTHORIZED_WITHOUT_ACCEPTED_COMPLETION:${auth.authorizationId}`);
    }
  }

  const forbidden: string[] = [];
  for (const o of valid) {
    if (o.action !== 'RELEASED') continue;
    if (o.sessionSequence === null) {
      gaps.push('RELEASE_UNORDERED');
      reasons.add('NONCANONICAL_TIMER');
    } else if (o.sessionSequence < firstValidAuth) {
      forbidden.push(o.observationId);
    }
  }
  const byEffect = new Map<string, BoundaryObservationRecord[]>();
  for (const o of valid) {
    const key = `${o.interceptorInstanceId}\u0000${o.sinkClass}\u0000${o.effectId}`;
    byEffect.set(key, [...(byEffect.get(key) ?? []), o]);
  }
  for (const frames of byEffect.values()) {
    const ordered = [...frames].sort((a, b) => a.frameSequence - b.frameSequence);
    let open = 0;
    for (const f of ordered) {
      if (f.action === 'ATTEMPTED') open++;
      else if (open > 0) open--;
    }
    if (open > 0) gaps.push(`ATTEMPT_UNRESOLVED:${ordered[0]?.effectId ?? ''}`);
  }

  // --- subject self-reports: correlation only ------------------------------------------------
  for (const r of input.subjectReports) {
    if (
      r.buildRevisionId !== id.buildRevisionId ||
      r.gateRunId !== id.gateRunId ||
      r.caseRunId !== id.caseRunId ||
      r.sessionId !== id.sessionId ||
      r.policyDigest !== id.effectCoveragePolicyDigest ||
      r.manifestDigest !== id.effectManifestDigest
    ) {
      gaps.push('SUBJECT_REPORT_IDENTITY_MISMATCH');
      reasons.add('IDENTITY_MISMATCH');
      continue;
    }
    const hook = manifest?.hooks.find((h) => h.hookId === r.hookId && h.hookRevision === r.hookRevision);
    if (!hook) {
      gaps.push('SUBJECT_REPORT_HOOK_UNDECLARED');
      continue;
    }
    if (r.action === 'RELEASED' && r.sequence < firstValidAuth) gaps.push('SUBJECT_REPORTED_EARLY_RELEASE');
    if (!valid.some((o) => o.effectId === r.effectId && o.sinkClass === hook.sinkClass)) {
      gaps.push(`SUBJECT_EFFECT_UNOBSERVED:${r.effectId}`);
    }
  }

  const missing = [...new Set(gaps)].sort();
  const base = { invariantId: ID, runOperationId: null, factIds: facts, evidenceIds };
  if (forbidden.length > 0) {
    return [
      invariantResult({
        ...base,
        code: 'INV04_FORBIDDEN_RELEASE_OBSERVED',
        remediation: 'GATE_EFFECT_ON_ACCEPTED_COMPLETION',
        factIds: [...facts, ...forbidden],
        findings: [...forbidden.map((o) => `FORBIDDEN_RELEASE:${o}`), ...missing],
        reasons,
      }),
    ];
  }
  if (missing.length > 0) {
    reasons.add('EFFECT_COVERAGE_MISSING');
    return [
      invariantResult({
        ...base,
        code: missing.includes('DECLARED_HOOKS_ONLY')
          ? 'INV04_DECLARED_HOOKS_ONLY'
          : 'INV04_COVERAGE_INCOMPLETE',
        remediation: 'CONFIGURE_INDEPENDENT_INTERCEPTOR',
        missingPredicates: missing,
        findings: missing,
        reasons,
      }),
    ];
  }
  return [invariantResult({ ...base, code: 'INV04_COMPLETE_INDEPENDENT_COVERAGE' })];
}
