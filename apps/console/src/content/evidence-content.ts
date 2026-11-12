/**
 * Plain-language text for release-evidence refusals and interceptor profile review states
 * (M16; RP-02, RP-06, RP-08). Codes come from the service unchanged; the console only explains
 * them and never decides eligibility itself.
 */
export const RELEASE_EVIDENCE_REFUSAL_TEXT: Readonly<Record<string, string>> = Object.freeze({
  NOT_INSTALLED_CAPTURE: 'Imported file: only a capture of the installed client can be release evidence.',
  DECLARED_HOOKS_ONLY: 'Declared hooks only: no independent boundary interception covered the effect.',
  PROCESS_TREE_NOT_CONFINED: "The subject's process tree was not confined by a verified container.",
  NO_INDEPENDENT_BOUNDARY_OBSERVATION: 'No independent boundary interceptor observed the case.',
  INTERCEPTOR_COVERAGE_INCOMPLETE: 'Independent effect coverage of the source case is incomplete.',
  INTERCEPTOR_PROFILE_UNPINNED: 'The case did not pin an interceptor profile.',
  INTERCEPTOR_PROFILE_NOT_REVIEWED: 'The pinned interceptor profile has no effective signed review.',
  UNATTESTED_IDENTITY: 'The build or interceptor launch was not attested by an enrolled launcher.',
});

export function refusalText(code: string): string {
  return RELEASE_EVIDENCE_REFUSAL_TEXT[code] ?? code;
}

export const PROFILE_REVIEW_STATE_TEXT: Readonly<Record<string, string>> = Object.freeze({
  DECLARED_UNREVIEWED: 'Declared, not reviewed',
  REVIEWED: 'Reviewed (signed review recorded)',
  REVIEW_REJECTED: 'Review rejected',
  REVIEW_REVOKED: 'Review revoked or no longer effective',
});

export const EVIDENCE_USE_TEXT: Readonly<Record<string, string>> = Object.freeze({
  RELEASE_EVIDENCE: 'Release evidence',
  DIAGNOSTIC_ONLY: 'Diagnostic only (advisory, never a required case)',
  UNCLASSIFIED: 'Unclassified (promoted before evidence classes existed; never release evidence)',
});
