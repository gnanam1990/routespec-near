/**
 * Attestation acceptability (TB-07, TB-08). Pure: the only time reference is the journal's
 * case-input-closed time carried in the input.
 *
 * An attestation is acceptable for a purpose only when it exists, has the expected scope, its
 * principal is still enabled with the same revocation epoch and policy digest it was issued
 * under, it had not expired at the case's input-closed time, it binds the expected build (when
 * one is expected), and its observed digests include every digest it must vouch for.
 */
import type { AttestationRecord, KernelInput } from './types.ts';

export interface AttestationCheck {
  readonly ok: boolean;
  readonly findings: readonly string[];
}

export function checkAttestation(
  input: KernelInput,
  attestationId: string | null,
  expect: { scope: string; buildRevisionId: string | null; digests: readonly string[]; label: string },
): AttestationCheck {
  const label = expect.label;
  if (attestationId === null) return { ok: false, findings: [`${label}_UNATTESTED`] };
  const a: AttestationRecord | undefined = input.attestations.find((x) => x.attestationId === attestationId);
  if (!a) return { ok: false, findings: [`${label}_ATTESTATION_NOT_FOUND`] };
  const findings: string[] = [];
  if (a.scope !== expect.scope) findings.push(`${label}_ATTESTATION_SCOPE_MISMATCH`);
  if (!a.principalEnabled) findings.push(`${label}_ATTESTER_DISABLED`);
  if (a.principalCurrentRevocationEpoch !== a.principalRevocationEpochAtIssue) {
    findings.push(`${label}_ATTESTER_REVOKED`);
  }
  if (a.principalCurrentPolicyDigest !== a.principalPolicyDigestAtIssue) {
    findings.push(`${label}_ATTESTER_POLICY_CHANGED`);
  }
  const asOf = input.caseState.asOfMs;
  if (asOf === null || a.expiresAtMs <= asOf) findings.push(`${label}_ATTESTATION_STALE`);
  if (expect.buildRevisionId !== null && a.buildRevisionId !== expect.buildRevisionId) {
    findings.push(`${label}_ATTESTATION_BUILD_MISMATCH`);
  }
  for (const d of expect.digests) {
    if (!a.observedDigests.includes(d)) findings.push(`${label}_ATTESTATION_DIGEST_MISMATCH`);
  }
  return { ok: findings.length === 0, findings: [...new Set(findings)].sort() };
}
