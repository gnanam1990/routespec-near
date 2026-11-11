/**
 * Enforcement mode and CI conclusion (FR-13, FR-14, NFR-12, INV-12; T-056).
 *
 * Enforcement is capped at `REQUIRED_CHECK_UNVERIFIED`. Outside CI the only mode is
 * `LOCAL_ADVISORY`; in CI the default is `CI_CHECK`, and a configuration may ask for
 * `REQUIRED_CHECK_UNVERIFIED` (the workflow intends to be a required check, which RouteSpec cannot
 * verify). No input, flag, file, or event payload can produce a verified or blocking state: the
 * output type has no such field value.
 *
 * Conclusions follow the RouteSpec exit code. Only exit 0 (gate decision PASS) is `success`;
 * REVIEW and NOT_RUN are never converted to success, and artifact readiness never changes the
 * conclusion.
 */
import type { EnforcementMode, Verdict } from '@routespec/contracts';
import type { CiContext } from './context.ts';

export interface EnforcementState {
  readonly mode: EnforcementMode;
  readonly verified: false;
  readonly blocking: false;
  readonly findings: readonly string[];
}

export function resolveEnforcement(ctx: CiContext, requested: EnforcementMode | null): EnforcementState {
  const findings: string[] = [];
  let mode: EnforcementMode;
  if (ctx.provider === 'LOCAL') {
    mode = 'LOCAL_ADVISORY';
    if (requested !== null && requested !== 'LOCAL_ADVISORY')
      findings.push('ENFORCEMENT_DOWNGRADED_OUTSIDE_CI');
  } else {
    mode = requested ?? 'CI_CHECK';
  }
  if (mode === 'REQUIRED_CHECK_UNVERIFIED') findings.push('REQUIRED_CHECK_STATE_UNVERIFIED');
  return { mode, verified: false, blocking: false, findings };
}

export type CiConclusion =
  | 'success'
  | 'failure'
  | 'review_required'
  | 'not_run'
  | 'identity_mismatch'
  | 'configuration_error'
  | 'internal_error'
  | 'policy_denied';

export function conclusionFor(exitCode: number, decision: Verdict | null): CiConclusion {
  switch (exitCode) {
    case 0:
      return decision === 'PASS' ? 'success' : 'internal_error';
    case 2:
      return 'failure';
    case 3:
      return decision === 'NOT_RUN' ? 'not_run' : 'review_required';
    case 4:
      return 'configuration_error';
    case 6:
      return 'policy_denied';
    default:
      return 'internal_error';
  }
}
