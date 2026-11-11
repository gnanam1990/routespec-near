/**
 * Shared status content map (UI-SPEC section 4, NFR-12). Every status the console shows is
 * looked up here from a typed API value; components never invent wording or colors.
 *
 * Nothing in this file derives one axis from another. In particular, no function here turns
 * evidence, coverage, artifact, enforcement, or compatibility into a verdict.
 */
import type {
  EffectCoverageBasis,
  EnforcementMode,
  EvidenceClass,
  EvidenceReason,
  EvidenceScope,
  ExecutionLifecycle,
  ImportState,
  SubjectAttestationClass,
  Verdict,
} from '@routespec/contracts/enums';
import type { IconName } from '../components/Icon.tsx';
import type { AttestationRef, CompatibilityRef, EffectCoverage, EvidenceSummary } from '../api/schemas.ts';

export type Tone = 'pass' | 'fail' | 'review' | 'private' | 'neutral';

export interface StatusContent {
  readonly label: string;
  readonly description: string;
  readonly icon: IconName;
  readonly tone: Tone;
}

export const AXIS_NAMES = [
  'Execution state',
  'Verdict',
  'Evidence',
  'Subject identity',
  'Effect coverage',
  'Artifact',
  'Enforcement',
  'Official compatibility',
] as const;
export type AxisName = (typeof AXIS_NAMES)[number];

export const AXIS_DEFINITIONS: Readonly<Record<AxisName, string>> = {
  'Execution state': 'Where the run is in its lifecycle. It is not an outcome.',
  Verdict: 'The deterministic evaluator result for these exact revisions. Only the evaluator sets it.',
  Evidence: 'How strongly the facts behind the result are established, and why any are missing.',
  'Subject identity': 'Who vouches for the subject build. A user assertion is never a verified build.',
  'Effect coverage': 'What observed the subject’s side effects. Self-reports never prove coverage.',
  Artifact: 'Whether the release artifact bundle is ready. Independent of the verdict.',
  Enforcement: 'What enforcement is actually claimed. RouteSpec never claims to stop a release.',
  'Official compatibility': 'Separate dry probe against the official endpoint. No settlement is tested.',
};

export const LIFECYCLE_CONTENT: Readonly<Record<ExecutionLifecycle, StatusContent>> = {
  PENDING: {
    label: 'Pending',
    description: 'Created; waiting to be scheduled.',
    icon: 'circle',
    tone: 'neutral',
  },
  DRAFT: {
    label: 'Draft',
    description: 'Identity selected; not yet validated.',
    icon: 'circle',
    tone: 'neutral',
  },
  VALIDATING: {
    label: 'Validating',
    description: 'Preflight checks are running.',
    icon: 'clock',
    tone: 'neutral',
  },
  READY: { label: 'Ready', description: 'Preflight passed; not started.', icon: 'circle', tone: 'neutral' },
  RUNNING: { label: 'Running', description: 'Cases are executing.', icon: 'activity', tone: 'neutral' },
  RECOVERY_REQUIRED: {
    label: 'Recovery required',
    description: 'A runner stopped mid-case. Only read-only reconciliation is available.',
    icon: 'alert',
    tone: 'review',
  },
  EVALUATING: {
    label: 'Evaluating',
    description: 'The deterministic evaluator is running.',
    icon: 'clock',
    tone: 'neutral',
  },
  COMPLETED: {
    label: 'Completed',
    description: 'Execution finished. See the verdict row.',
    icon: 'check',
    tone: 'neutral',
  },
  ABORTED: {
    label: 'Aborted',
    description: 'Execution was cancelled; evidence is incomplete.',
    icon: 'slash',
    tone: 'review',
  },
  ERROR: {
    label: 'Error',
    description: 'Execution stopped with an internal error.',
    icon: 'alert',
    tone: 'review',
  },
};

export const VERDICT_CONTENT: Readonly<Record<Verdict, StatusContent>> = {
  PASS: {
    label: 'PASS',
    description: 'All required cases passed for these exact revisions.',
    icon: 'check',
    tone: 'pass',
  },
  FAIL: { label: 'FAIL', description: 'A required invariant was violated.', icon: 'x', tone: 'fail' },
  REVIEW: {
    label: 'REVIEW',
    description: 'Evidence is missing, contradictory, private, stale, or unsupported.',
    icon: 'pause',
    tone: 'review',
  },
  NOT_RUN: {
    label: 'NOT_RUN',
    description: 'No complete evaluation exists.',
    icon: 'circle',
    tone: 'neutral',
  },
  UNSUPPORTED: {
    label: 'UNSUPPORTED',
    description: 'The current profile cannot evaluate this.',
    icon: 'slash',
    tone: 'neutral',
  },
};

export const EVIDENCE_CLASS_CONTENT: Readonly<Record<EvidenceClass, StatusContent>> = {
  PROVEN: {
    label: 'Proven',
    description: 'Established by an independent source.',
    icon: 'check',
    tone: 'neutral',
  },
  REPORTED: {
    label: 'Reported',
    description: 'Stated by a source; not independently proven.',
    icon: 'info',
    tone: 'neutral',
  },
  INFERRED: { label: 'Inferred', description: 'Derived from other facts.', icon: 'info', tone: 'neutral' },
  UNKNOWN: { label: 'Unknown', description: 'A required fact is absent.', icon: 'question', tone: 'review' },
  UNSUPPORTED: {
    label: 'Unsupported',
    description: 'The current profile cannot evaluate it.',
    icon: 'slash',
    tone: 'neutral',
  },
  STALE: {
    label: 'Stale',
    description: 'Observed outside its freshness window.',
    icon: 'clock',
    tone: 'review',
  },
};

export const EVIDENCE_SCOPE_CONTENT: Readonly<Record<EvidenceScope, StatusContent>> = {
  SIMULATED_GROUND_TRUTH: {
    label: 'proven within scenario',
    description: 'Scenario ground truth. It says nothing about live settlement.',
    icon: 'layers',
    tone: 'neutral',
  },
  PUBLIC_CHAIN_OBSERVATION: {
    label: 'Public chain observation',
    description: 'Observed on a public chain.',
    icon: 'eye',
    tone: 'neutral',
  },
  PROVIDER_REPORTED: {
    label: 'Provider reported',
    description: 'Stated by the provider; not independently proven.',
    icon: 'info',
    tone: 'neutral',
  },
  SUBJECT_REPORTED: {
    label: 'reported by subject; does not prove coverage',
    description: 'The subject build reported this about itself.',
    icon: 'info',
    tone: 'review',
  },
  PRIVATE_NOT_VISIBLE: {
    label: 'Private — not visible',
    description:
      'Behind an authorization or privacy boundary. Required facts here keep the result at REVIEW.',
    icon: 'eye-off',
    tone: 'private',
  },
};

export const EVIDENCE_REASON_TEXT: Readonly<Record<EvidenceReason, string>> = {
  NOT_VISIBLE: 'Not visible across the privacy boundary',
  MISSING: 'Required evidence is missing',
  CONTRADICTORY: 'Sources contradict each other',
  PRIVATE: 'Evidence is private',
  STALE: 'Evidence is stale',
  UNSUPPORTED: 'Unsupported by the current profile',
  NONCANONICAL_TIMER: 'External wall timer; noncanonical',
  UNATTESTED_BUILD: 'Build is not attested',
  IDENTITY_MISMATCH: 'Identity does not match the selection',
  EFFECT_COVERAGE_MISSING: 'Effect coverage is missing',
};

export const ATTESTATION_CONTENT: Readonly<Record<SubjectAttestationClass, StatusContent>> = {
  USER_ASSERTED_LOCAL: {
    label: 'User-asserted local build',
    description: 'Registered by the user. Not verified.',
    icon: 'identity',
    tone: 'neutral',
  },
  TRUSTED_LAUNCHER: {
    label: 'Trusted launcher attestation',
    description: 'Attested by an enrolled local launcher.',
    icon: 'shield',
    tone: 'neutral',
  },
  CI_ATTESTED: {
    label: 'CI attested',
    description: 'Attested by an enrolled CI principal.',
    icon: 'shield',
    tone: 'neutral',
  },
};

export const COVERAGE_BASIS_CONTENT: Readonly<Record<EffectCoverageBasis, StatusContent>> = {
  INDEPENDENT_BOUNDARY_INTERCEPT: {
    label: 'Independent boundary',
    description: 'An independently launched interceptor observed the declared sinks.',
    icon: 'boundary',
    tone: 'neutral',
  },
  TRUSTED_BUILD_INVENTORY_PLUS_INTERCEPT: {
    label: 'Inventory + boundary',
    description: 'A trusted call-site inventory plus an independent interceptor.',
    icon: 'boundary',
    tone: 'neutral',
  },
  DECLARED_HOOKS_ONLY: {
    label: 'Declared hooks only — REVIEW',
    description: 'Only the subject’s own hooks. Complete-effect predicates stay at REVIEW.',
    icon: 'pause',
    tone: 'review',
  },
};

export const ENFORCEMENT_CONTENT: Readonly<Record<EnforcementMode, StatusContent>> = {
  LOCAL_ADVISORY: {
    label: 'Local advisory',
    description: 'Advice for the local engineer.',
    icon: 'shield',
    tone: 'neutral',
  },
  CI_CHECK: {
    label: 'CI check',
    description: 'Reported as a CI check result.',
    icon: 'shield',
    tone: 'neutral',
  },
  REQUIRED_CHECK_UNVERIFIED: {
    label: 'Required check — verification unavailable',
    description: 'Configured as required, but repository settings cannot be verified.',
    icon: 'shield',
    tone: 'neutral',
  },
};

export const COMPATIBILITY_CONTENT: Readonly<Record<CompatibilityRef['status'], StatusContent>> = {
  NOT_RUN: {
    label: 'Not run',
    description: 'No official dry probe record exists. The local result stands on its own.',
    icon: 'circle',
    tone: 'neutral',
  },
  DOCUMENTED_ONLY: {
    label: 'Documented only',
    description: 'Matches the documented profile; not probed.',
    icon: 'link',
    tone: 'neutral',
  },
  UNKNOWN: {
    label: 'Unknown',
    description: 'The dry probe could not establish compatibility. The local result remains available.',
    icon: 'question',
    tone: 'neutral',
  },
  INCOMPATIBLE: {
    label: 'Incompatible',
    description: 'The official endpoint returned an incompatible shape. The local result remains available.',
    icon: 'link',
    tone: 'neutral',
  },
  OFFICIAL_ENDPOINT_COMPATIBLE: {
    label: 'Official endpoint compatible',
    description: 'A separate dry probe succeeded. No settlement is tested; the local verdict is unchanged.',
    icon: 'link',
    tone: 'neutral',
  },
};

export const IMPORT_STATE_CONTENT: Readonly<Record<ImportState, StatusContent>> = {
  CAPTURED_UNTRUSTED: {
    label: 'Captured — untrusted',
    description: 'Not yet quarantined.',
    icon: 'archive',
    tone: 'neutral',
  },
  QUARANTINED: {
    label: 'Quarantined',
    description: 'Held without network access.',
    icon: 'archive',
    tone: 'review',
  },
  SANITIZED: {
    label: 'Sanitized',
    description: 'Secrets and unsafe material removed.',
    icon: 'check',
    tone: 'neutral',
  },
  MAPPED: { label: 'Mapped', description: 'Phases and effects mapped.', icon: 'layers', tone: 'neutral' },
  REPLAY_VERIFIED: {
    label: 'Replay verified',
    description: 'Replays deterministically.',
    icon: 'refresh',
    tone: 'neutral',
  },
  REVIEWED: { label: 'Reviewed', description: 'A review record exists.', icon: 'check', tone: 'neutral' },
  PROMOTED: {
    label: 'Promoted',
    description: 'Promoted to a new immutable scenario.',
    icon: 'check',
    tone: 'neutral',
  },
  REJECTED: { label: 'Rejected', description: 'Not eligible for promotion.', icon: 'x', tone: 'review' },
  PURGED: {
    label: 'Purged',
    description: 'Content deleted; digest retained.',
    icon: 'slash',
    tone: 'neutral',
  },
};

/** Evidence summary: the scope phrase takes precedence because it carries required wording. */
export function evidenceContent(evidence: EvidenceSummary): StatusContent {
  const cls = EVIDENCE_CLASS_CONTENT[evidence.class];
  const scope = evidence.scope === null ? null : EVIDENCE_SCOPE_CONTENT[evidence.scope];
  const reasons = evidence.reasons.map((r) => EVIDENCE_REASON_TEXT[r]);
  const label = scope === null ? cls.label : `${cls.label} — ${scope.label}`;
  const description = [scope?.description ?? cls.description, ...reasons].join('. ');
  const tone: Tone =
    evidence.scope === 'PRIVATE_NOT_VISIBLE' || evidence.reasons.includes('NOT_VISIBLE')
      ? 'private'
      : scope?.tone === 'review'
        ? 'review'
        : cls.tone;
  const icon = evidence.scope === 'PRIVATE_NOT_VISIBLE' ? 'eye-off' : cls.icon;
  return { label, description, icon, tone };
}

export function attestationContent(ref: AttestationRef): StatusContent {
  const base = ATTESTATION_CONTENT[ref.class];
  if (ref.freshness === 'STALE')
    return { ...base, label: `${base.label} — stale`, icon: 'clock', tone: 'review' };
  if (ref.freshness === 'REVOKED')
    return { ...base, label: `${base.label} — revoked`, icon: 'x', tone: 'review' };
  return base;
}

export function coverageContent(coverage: EffectCoverage): StatusContent {
  if (coverage.basis === null) {
    return {
      label: 'No coverage basis',
      description: 'No effect-coverage policy is selected. Complete-effect predicates stay at REVIEW.',
      icon: 'question',
      tone: 'review',
    };
  }
  const base = COVERAGE_BASIS_CONTENT[coverage.basis];
  if (coverage.basis !== 'DECLARED_HOOKS_ONLY' && coverage.finding === 'INCOMPLETE') {
    return {
      label: `${base.label} — incomplete, REVIEW`,
      description: ['Coverage is incomplete', ...coverage.missing].join('. '),
      icon: 'pause',
      tone: 'review',
    };
  }
  if (coverage.interceptorFreshness === 'STALE' || coverage.interceptorFreshness === 'REVOKED') {
    return {
      label: `${base.label} — interceptor ${coverage.interceptorFreshness.toLowerCase()}, REVIEW`,
      description: 'The interceptor attestation is not current.',
      icon: 'clock',
      tone: 'review',
    };
  }
  if (coverage.finding === 'NOT_EVALUATED' && coverage.basis !== 'DECLARED_HOOKS_ONLY') {
    return { ...base, label: `${base.label} — not evaluated` };
  }
  return base;
}

export function artifactContent(ready: boolean | null): StatusContent {
  if (ready === null) {
    return {
      label: 'Not evaluated',
      description: 'No artifact readiness record exists.',
      icon: 'package',
      tone: 'neutral',
    };
  }
  return ready
    ? {
        label: 'Artifact ready',
        description: 'The redacted bundle is ready.',
        icon: 'package',
        tone: 'neutral',
      }
    : {
        label: 'Artifact not ready',
        description: 'Artifact generation is incomplete. The verdict above is unaffected.',
        icon: 'package',
        tone: 'neutral',
      };
}

/** Wording RouteSpec v2 must never display (UI-SPEC 3.1, 4). */
export const PROHIBITED_PHRASES = [
  'Blocks release',
  'blocks release',
  'Release blocked',
  'Branch protected',
] as const;
