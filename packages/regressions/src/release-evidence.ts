/**
 * Release-evidence classification of a capture (M16; REAL-PRODUCT-GATE RP-08: "Reject ...
 * declared-hooks-only, interceptor-incomplete, or unreviewed captures"; FR-11: such traces "can
 * never enter a required corpus").
 *
 * A capture can be release evidence only when every one of these holds, derived from the
 * journal (never from the trace document or the caller):
 * - it is an installed-artifact capture (a user file is never independent evidence);
 * - its case ran under a complete-effect basis (not `DECLARED_HOOKS_ONLY`);
 * - every interceptor instance of the case confined the subject's process tree;
 * - an independent boundary interceptor observed the case;
 * - the case's pinned interceptor profile has an effective signed review now;
 * - the kernel's INV-04 over the current journal reports complete coverage (PASS, or a FAIL
 *   whose only findings are independently observed forbidden releases), with attested identity.
 *
 * Every failed condition contributes one stable refusal code. The classification never changes
 * a verdict; promotion uses it to refuse, or to record an explicit diagnostic-only promotion.
 */
import type { ReleaseEvidenceRefusal } from '@routespec/contracts';
import { effectiveProfileReview } from '@routespec/contracts';
import { evaluateInv04, snapshotFromJournal } from '@routespec/kernel';
import type { ImportJournal, ReleaseEvidenceClassification } from '@routespec/store';
import { deriveInstalledCapture } from './capture.ts';

export interface CaptureEvidenceClassification extends ReleaseEvidenceClassification {
  readonly refusalReasons: readonly ReleaseEvidenceRefusal[];
  readonly releaseEvidence: boolean;
}

function gapRefusal(gap: string): ReleaseEvidenceRefusal {
  if (gap === 'DECLARED_HOOKS_ONLY') return 'DECLARED_HOOKS_ONLY';
  if (gap === 'PROCESS_TREE_NOT_ENFORCED') return 'PROCESS_TREE_NOT_CONFINED';
  if (gap === 'INTERCEPTOR_PROFILE_UNPINNED') return 'INTERCEPTOR_PROFILE_UNPINNED';
  if (gap.startsWith('INTERCEPTOR_PROFILE_')) return 'INTERCEPTOR_PROFILE_NOT_REVIEWED';
  if (gap.startsWith('BUILD_') || gap.endsWith('_UNATTESTED') || /_ATTEST(ATION|ER)_/.test(gap)) {
    return 'UNATTESTED_IDENTITY';
  }
  return 'INTERCEPTOR_COVERAGE_INCOMPLETE';
}

/** Classify the capture behind `importId` against the current journal. */
export function classifyCaptureEvidence(
  journal: ImportJournal,
  importId: string,
  nowMs: number = journal.store.clock.nowMs(),
): CaptureEvidenceClassification {
  const view = journal.getImport(importId);
  const reasons = new Set<ReleaseEvidenceRefusal>();
  const done = (profile: string | null, reviewId: string | null): CaptureEvidenceClassification => {
    const refusalReasons = [...reasons].sort();
    return {
      refusalReasons,
      releaseEvidence: refusalReasons.length === 0,
      interceptorProfileDigest: profile,
      interceptorReviewId: reviewId,
    };
  };
  const caseRunId = view.captureBinding === null ? null : String(view.captureBinding['case_run_id']);
  if (view.origin !== 'INSTALLED_ARTIFACT_CAPTURE' || caseRunId === null) {
    reasons.add('NOT_INSTALLED_CAPTURE');
    reasons.add('DECLARED_HOOKS_ONLY');
    return done(null, null);
  }
  const store = journal.store;
  const capture = deriveInstalledCapture(store, caseRunId);
  const rows = store.readEvaluationSnapshot(caseRunId);
  const input = snapshotFromJournal(rows);
  const policy = input.effectPolicy;
  if (policy === null || policy.basis === 'DECLARED_HOOKS_ONLY') reasons.add('DECLARED_HOOKS_ONLY');
  if (capture.trace.identity?.processTreeContainment !== 'PROCESS_TREE_ENFORCED') {
    reasons.add('PROCESS_TREE_NOT_CONFINED');
  }
  if (capture.trace.boundaryObservations.length === 0) reasons.add('NO_INDEPENDENT_BOUNDARY_OBSERVATION');

  const profile = policy?.interceptorProfileDigest ?? null;
  let reviewId: string | null = null;
  if (profile === null) {
    reasons.add('INTERCEPTOR_PROFILE_UNPINNED');
  } else {
    // Revocation after the case ran still refuses: the review must be effective now.
    const now = effectiveProfileReview(profile, input.interceptorProfileReviews ?? [], nowMs);
    if (now.state !== 'REVIEWED') reasons.add('INTERCEPTOR_PROFILE_NOT_REVIEWED');
    else reviewId = now.reviewId;
  }

  const inv04 = evaluateInv04(input)[0];
  if (inv04 === undefined) {
    reasons.add('INTERCEPTOR_COVERAGE_INCOMPLETE');
  } else if (inv04.verdict !== 'PASS') {
    const gaps =
      inv04.explanationCode === 'INV04_FORBIDDEN_RELEASE_OBSERVED'
        ? inv04.findings.filter((f) => !f.startsWith('FORBIDDEN_RELEASE:'))
        : inv04.missingPredicates.length > 0
          ? inv04.missingPredicates
          : ['COVERAGE_NOT_COMPLETE'];
    for (const g of gaps) reasons.add(gapRefusal(g));
  }
  return done(profile, reviewId);
}
