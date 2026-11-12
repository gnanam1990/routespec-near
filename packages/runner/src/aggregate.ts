/**
 * Release-gate aggregation (FR-13, INV-12; TDD.md section 14). Pure: no clock, I/O, or database.
 *
 * Precedence, fail closed:
 * 1. FAIL if any required case has a complete, identity-valid, digest-valid FAIL result.
 * 2. NOT_RUN if zero required cases started and zero required results completed.
 * 3. REVIEW if any required case is missing, queued while others ran, running, recovery-pending,
 *    cancelled/aborted, errored, interrupted, teardown-incomplete, identity-mismatched, stale,
 *    tampered, REVIEW/UNSUPPORTED/NOT_RUN, a promoted capture that is not release evidence
 *    (diagnostic-only or unclassified, M16), or if a gate-level gap exists (stale evaluator/proxy,
 *    unattested build under a policy that requires trusted attestation, no required cases).
 * 4. PASS only when every exact required case run is a complete PASS under the same immutable
 *    gate-run snapshot.
 *
 * `NOT_VISIBLE` stays an evidence reason (finding text); it is never a decision. The decision
 * never depends on artifact readiness or enforcement mode.
 */
import {
  corpusClassAllowedAsRequired,
  digestValue,
  type CanonicalCaseResult,
  type CorpusEvidenceClass,
  type EnforcementMode,
  type ExecutionLifecycle,
  type SubjectAttestationClass,
  type Verdict,
} from '@routespec/contracts';

export const AGGREGATOR_REVISION = 'routespec-gate@1.1.0' as const;
export const GATE_IDENTITY_DOMAIN = 'routespec.gate-identity/1';
export const GATE_DECISION_DOMAIN = 'routespec.gate-decision/1';
export const GATE_ENFORCEMENT_DOMAIN = 'routespec.gate-enforcement/1';

export type BuildAttestationPolicy = 'ALLOW_USER_ASSERTED' | 'REQUIRE_TRUSTED';

/** The immutable identity a gate decision is valid for (INV-12). */
export interface GateIdentity {
  readonly gateRunId: string;
  readonly gateRunIdentityDigest: string;
  readonly gateDefinitionRevisionId: string | null;
  readonly projectId: string;
  readonly integrationRevisionId: string;
  readonly buildRevisionId: string;
  readonly artifactDigest: string;
  readonly buildAttestationClass: SubjectAttestationClass;
  readonly buildAttestationId: string | null;
  readonly corpusRevisionId: string;
  readonly protocolProfileId: string;
  readonly adapterRevision: string;
  readonly evaluatorRevision: string;
  readonly proxyRevision: string;
  readonly configurationDigest: string;
  readonly effectManifestDigest: string;
  readonly effectCoveragePolicyDigest: string;
  readonly callsiteInventoryDigest: string | null;
  readonly interceptorProfileDigest: string | null;
  readonly maxParallelCases: number;
  readonly journalSchemaVersion: number;
  readonly canonicalResultSchemaVersion: string;
  readonly buildAttestationPolicy: BuildAttestationPolicy;
  readonly cases: ReadonlyArray<{
    readonly ordinal: number;
    readonly caseRunId: string | null;
    readonly scenarioRevisionId: string;
    readonly sessionId: string | null;
    readonly fencingEpoch: number | null;
    /** Present only for a case with its own effect-coverage policy (M14). */
    readonly effectCoveragePolicyDigest?: string;
  }>;
}

export interface GateCaseRunInput {
  readonly caseRunId: string;
  readonly gateRunId: string;
  readonly scenarioRevisionId: string;
  readonly requiredInvariants: readonly string[];
  readonly adapterRevision: string;
  readonly lifecycle: ExecutionLifecycle;
  readonly verdict: Verdict | null;
  readonly fencingEpoch: number;
  readonly sessionId: string | null;
  readonly clientInstanceDigest: string | null;
  readonly teardownRecorded: boolean;
  readonly terminalResultDigest: string | null;
  /** The case's own effect-coverage policy (M14); null: the gate run's policy. */
  readonly effectCoveragePolicyDigest?: string | null;
}

export interface GateCaseResultInput {
  readonly storedDigest: string;
  /** Digest recomputed from the stored canonical JSON (tamper detection). */
  readonly recomputedDigest: string | null;
  readonly canonical: CanonicalCaseResult | null;
  readonly verdict: Verdict;
  readonly evaluatorRevision: string;
  readonly fencingEpoch: number;
  readonly sessionId: string;
}

export interface GateCaseInput {
  readonly ordinal: number;
  /** The pinned corpus case at this ordinal (null: the case run has no corpus case). */
  readonly corpusCase: {
    readonly scenarioRevisionId: string;
    readonly requiredInvariants: readonly string[];
    readonly gatePolicy: string;
    /**
     * How the case's scenario revision may be used (M16, RP-08). A required case whose revision
     * is a promoted capture that is not release evidence can never contribute PASS. Absent in
     * pure inputs that do not model promotions: treated as AUTHORED.
     */
    readonly evidenceClass?: CorpusEvidenceClass;
  } | null;
  /** The case run at this ordinal (null: missing). */
  readonly caseRun: GateCaseRunInput | null;
  readonly result: GateCaseResultInput | null;
  readonly interrupted: boolean;
}

export interface GateInput {
  readonly identity: GateIdentity;
  readonly gateLifecycle: ExecutionLifecycle;
  readonly enforcementMode: EnforcementMode;
  readonly cases: readonly GateCaseInput[];
  /** The revisions of the runtime doing this evaluation. */
  readonly runtime: { readonly evaluatorRevision: string; readonly proxyRevision: string };
}

export interface GateCaseOutcome {
  readonly ordinal: number;
  readonly caseRunId: string | null;
  readonly required: boolean;
  readonly started: boolean;
  readonly lifecycle: ExecutionLifecycle | null;
  readonly caseVerdict: Verdict | null;
  readonly resultDigest: string | null;
  readonly fencingEpoch: number | null;
  readonly contribution: Verdict;
  readonly findings: readonly string[];
}

export interface GateCounts {
  readonly total: number;
  readonly required: number;
  readonly started: number;
  readonly pass: number;
  readonly fail: number;
  readonly review: number;
  readonly notRun: number;
  readonly unsupported: number;
}

export interface GateDecision {
  readonly aggregatorRevision: typeof AGGREGATOR_REVISION;
  readonly identity: GateIdentity;
  readonly identityDigest: string;
  readonly decision: Verdict;
  readonly findings: readonly string[];
  readonly cases: readonly GateCaseOutcome[];
  readonly counts: GateCounts;
  readonly caseResultDigests: readonly string[];
  readonly decisionDigest: string;
  readonly enforcement: {
    readonly mode: EnforcementMode;
    readonly verified: false;
    readonly blocking: false;
    readonly digest: string;
  };
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  const x = sortedUnique(a);
  const y = sortedUnique(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/** Every canonical identity field that must equal the gate run / case run it is reused for. */
function identityMismatches(
  id: GateIdentity,
  caseRun: GateCaseRunInput,
  r: GateCaseResultInput,
  c: CanonicalCaseResult,
): string[] {
  const expected: Array<[string, unknown, unknown]> = [
    ['projectId', c.projectId, id.projectId],
    ['integrationRevisionId', c.integrationRevisionId, id.integrationRevisionId],
    ['buildRevisionId', c.buildRevisionId, id.buildRevisionId],
    ['artifactDigest', c.artifactDigest, id.artifactDigest],
    ['buildAttestationClass', c.buildAttestationClass, id.buildAttestationClass],
    ['buildAttestationId', c.buildAttestationId, id.buildAttestationId],
    ['gateRunId', c.gateRunId, id.gateRunId],
    ['caseRunId', c.caseRunId, caseRun.caseRunId],
    ['sessionId', c.sessionId, caseRun.sessionId],
    ['sessionId', r.sessionId, caseRun.sessionId],
    ['corpusRevisionId', c.corpusRevisionId, id.corpusRevisionId],
    ['scenarioRevisionId', c.scenarioRevisionId, caseRun.scenarioRevisionId],
    ['protocolProfileId', c.protocolProfileId, id.protocolProfileId],
    ['adapterRevision', c.adapterRevision, id.adapterRevision],
    ['adapterRevision', caseRun.adapterRevision, id.adapterRevision],
    ['evaluatorRevision', c.evaluatorRevision, id.evaluatorRevision],
    ['evaluatorRevision', r.evaluatorRevision, id.evaluatorRevision],
    ['configurationDigest', c.configurationDigest, id.configurationDigest],
    [
      'effectCoveragePolicyDigest',
      c.effectCoveragePolicyDigest,
      caseRun.effectCoveragePolicyDigest ?? id.effectCoveragePolicyDigest,
    ],
    ['effectManifestDigest', c.effectManifestDigest, id.effectManifestDigest],
    ['callsiteInventoryDigest', c.callsiteInventoryDigest, id.callsiteInventoryDigest],
    ['fencingEpoch', c.fencingEpoch, caseRun.fencingEpoch],
    ['fencingEpoch', r.fencingEpoch, caseRun.fencingEpoch],
    ['verdict', c.verdict, r.verdict],
    ['verdict', caseRun.verdict, r.verdict],
    ['canonicalSchemaVersion', c.schemaVersion, id.canonicalResultSchemaVersion],
  ];
  return sortedUnique(expected.filter(([, a, b]) => a !== b).map(([f]) => `IDENTITY_MISMATCH:${f}`));
}

function caseOutcome(
  input: GateInput,
  c: GateCaseInput,
  reusedClients: ReadonlySet<string>,
): GateCaseOutcome {
  const required = c.corpusCase?.gatePolicy === 'REQUIRED';
  const base = {
    ordinal: c.ordinal,
    caseRunId: c.caseRun?.caseRunId ?? null,
    required: c.corpusCase === null ? true : required,
    started: c.caseRun?.sessionId != null,
    lifecycle: c.caseRun?.lifecycle ?? null,
    caseVerdict: c.caseRun?.verdict ?? null,
    resultDigest: c.result?.storedDigest ?? null,
    fencingEpoch: c.caseRun?.fencingEpoch ?? null,
  };
  const out = (contribution: Verdict, findings: string[]): GateCaseOutcome => ({
    ...base,
    contribution,
    findings: sortedUnique(findings),
  });
  const run = c.caseRun;
  if (run === null) return out('REVIEW', ['CASE_MISSING']);
  const findings: string[] = [];
  if (c.corpusCase === null) findings.push('CASE_NOT_IN_CORPUS');
  else {
    const cls = c.corpusCase.evidenceClass ?? 'AUTHORED';
    if (required && !corpusClassAllowedAsRequired(cls)) findings.push(`CAPTURE_NOT_RELEASE_EVIDENCE:${cls}`);
    if (c.corpusCase.scenarioRevisionId !== run.scenarioRevisionId) {
      findings.push('IDENTITY_MISMATCH:scenarioRevisionId');
    }
    if (!sameList(c.corpusCase.requiredInvariants, run.requiredInvariants)) {
      findings.push('REQUIRED_INVARIANTS_MISMATCH');
    }
  }
  if (run.gateRunId !== input.identity.gateRunId) findings.push('IDENTITY_MISMATCH:gateRunId');
  if (c.interrupted) findings.push('CASE_INTERRUPTED');
  if (run.clientInstanceDigest !== null && reusedClients.has(run.clientInstanceDigest)) {
    findings.push('CLIENT_INSTANCE_REUSED');
  }
  switch (run.lifecycle) {
    case 'PENDING':
    case 'VALIDATING':
    case 'READY':
    case 'DRAFT':
      return out('NOT_RUN', [...findings, 'CASE_NOT_STARTED']);
    case 'RUNNING':
    case 'EVALUATING':
      return out('REVIEW', [...findings, 'CASE_INCOMPLETE']);
    case 'RECOVERY_REQUIRED':
      return out('REVIEW', [...findings, 'CASE_RECOVERY_PENDING']);
    case 'ABORTED':
      return run.sessionId === null
        ? out('NOT_RUN', [...findings, 'CASE_CANCELLED_BEFORE_START'])
        : out('REVIEW', [...findings, 'CASE_ABORTED']);
    case 'ERROR':
      return out('REVIEW', [...findings, 'CASE_ERROR']);
    case 'COMPLETED':
      break;
  }
  const r = c.result;
  if (r === null) return out('REVIEW', [...findings, 'CASE_RESULT_MISSING']);
  if (r.canonical === null || r.recomputedDigest === null) {
    return out('REVIEW', [...findings, 'CASE_RESULT_UNREADABLE']);
  }
  if (r.recomputedDigest !== r.storedDigest || run.terminalResultDigest !== r.storedDigest) {
    return out('REVIEW', [...findings, 'RESULT_DIGEST_MISMATCH']);
  }
  const mismatches = identityMismatches(input.identity, run, r, r.canonical);
  findings.push(...mismatches);
  if (r.evaluatorRevision !== input.runtime.evaluatorRevision) findings.push('EVALUATOR_STALE');
  const valid = mismatches.length === 0 && r.evaluatorRevision === input.runtime.evaluatorRevision;
  // FAIL dominates every other case finding, but only from a result valid for this gate.
  if (valid && r.verdict === 'FAIL') return out('FAIL', [...findings, 'CASE_FAIL']);
  if (!run.teardownRecorded) findings.push('TEARDOWN_MISSING');
  for (const ir of r.canonical.invariantResults) {
    if (!run.requiredInvariants.includes(ir.invariantId) || ir.verdict === 'PASS') continue;
    findings.push(`INVARIANT_${ir.verdict}:${ir.invariantId}`);
    for (const reason of ir.reasons) findings.push(`EVIDENCE_REASON:${reason}`);
    for (const p of ir.missingPredicates.slice(0, 16)) findings.push(`MISSING:${ir.invariantId}:${p}`);
  }
  for (const inv of run.requiredInvariants) {
    if (!r.canonical.invariantResults.some((ir) => ir.invariantId === inv))
      findings.push(`INVARIANT_ABSENT:${inv}`);
  }
  if (r.verdict === 'REVIEW') findings.push('CASE_REVIEW');
  if (r.verdict === 'UNSUPPORTED') return out('UNSUPPORTED', [...findings, 'CASE_UNSUPPORTED']);
  if (r.verdict === 'NOT_RUN') findings.push('CASE_RESULT_NOT_RUN');
  const blocking = findings.filter((f) => !f.startsWith('EVIDENCE_REASON:') && !f.startsWith('MISSING:'));
  if (r.verdict === 'PASS' && blocking.length === 0 && valid) return out('PASS', findings);
  return out('REVIEW', findings);
}

/** Pure gate aggregation over one consistent snapshot. */
export function aggregateGate(input: GateInput): GateDecision {
  const id = input.identity;
  const clientCounts = new Map<string, number>();
  for (const c of input.cases) {
    const digest = c.caseRun?.clientInstanceDigest;
    if (digest) clientCounts.set(digest, (clientCounts.get(digest) ?? 0) + 1);
  }
  const reused = new Set([...clientCounts].filter(([, k]) => k > 1).map(([d]) => d));
  const cases = input.cases.map((c) => caseOutcome(input, c, reused));
  const required = cases.filter((c) => c.required);

  const gateFindings: string[] = [];
  if (required.length === 0) gateFindings.push('NO_REQUIRED_CASES');
  if (id.evaluatorRevision !== input.runtime.evaluatorRevision) gateFindings.push('GATE_EVALUATOR_STALE');
  if (id.proxyRevision !== input.runtime.proxyRevision) gateFindings.push('GATE_PROXY_STALE');
  if (id.buildAttestationClass === 'USER_ASSERTED_LOCAL') {
    gateFindings.push(
      id.buildAttestationPolicy === 'REQUIRE_TRUSTED' ? 'BUILD_UNATTESTED' : 'BUILD_USER_ASSERTED_LOCAL',
    );
  }
  if (input.gateLifecycle === 'ABORTED') gateFindings.push('GATE_RUN_ABORTED');
  if (input.gateLifecycle === 'ERROR') gateFindings.push('GATE_RUN_ERROR');
  if (input.gateLifecycle === 'RECOVERY_REQUIRED') gateFindings.push('GATE_RUN_RECOVERY_PENDING');
  // Informational only: an honest user-asserted label under a policy that allows it.
  const gateReview = gateFindings.filter(
    (f) => f !== 'BUILD_USER_ASSERTED_LOCAL' && f !== 'GATE_RUN_ABORTED',
  );

  let decision: Verdict;
  const anyStarted = required.some((c) => c.started || c.resultDigest !== null);
  if (required.some((c) => c.contribution === 'FAIL')) decision = 'FAIL';
  else if (!anyStarted) decision = 'NOT_RUN';
  else if (gateReview.length > 0 || required.some((c) => c.contribution !== 'PASS')) decision = 'REVIEW';
  else decision = 'PASS';

  const counts: GateCounts = {
    total: cases.length,
    required: required.length,
    started: cases.filter((c) => c.started).length,
    pass: cases.filter((c) => c.contribution === 'PASS').length,
    fail: cases.filter((c) => c.contribution === 'FAIL').length,
    review: cases.filter((c) => c.contribution === 'REVIEW').length,
    notRun: cases.filter((c) => c.contribution === 'NOT_RUN').length,
    unsupported: cases.filter((c) => c.contribution === 'UNSUPPORTED').length,
  };
  const identityDigest = digestValue(GATE_IDENTITY_DOMAIN, id);
  const caseResultDigests = cases.flatMap((c) => (c.resultDigest === null ? [] : [c.resultDigest]));
  const findings = sortedUnique(gateFindings);
  const decisionDigest = digestValue(GATE_DECISION_DOMAIN, {
    aggregatorRevision: AGGREGATOR_REVISION,
    identityDigest,
    runtime: input.runtime,
    cases,
    decision,
    findings,
  });
  return {
    aggregatorRevision: AGGREGATOR_REVISION,
    identity: id,
    identityDigest,
    decision,
    findings,
    cases,
    counts,
    caseResultDigests,
    decisionDigest,
    enforcement: {
      mode: input.enforcementMode,
      verified: false,
      blocking: false,
      digest: digestValue(GATE_ENFORCEMENT_DOMAIN, {
        decisionDigest,
        mode: input.enforcementMode,
        verified: false,
        blocking: false,
      }),
    },
  };
}

/** Stable CLI exit code for a decision (API-SPEC section 6). */
export function exitCodeForDecision(decision: Verdict): 0 | 2 | 3 {
  if (decision === 'PASS') return 0;
  if (decision === 'FAIL') return 2;
  return 3;
}
