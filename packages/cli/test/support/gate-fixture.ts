/**
 * Explicit GateRun/CaseRun state fixtures for the pure gate aggregator (T-034, T-012). Every
 * case result is a real closed `CanonicalCaseResult` normalized by the contracts schema and
 * digested with the production digest function; nothing about the decision is pre-computed.
 */
import {
  CANONICAL_RESULT_SCHEMA_VERSION,
  computeCanonicalResultDigest,
  normalizeCanonicalResult,
  type CanonicalCaseResult,
  type ExecutionLifecycle,
  type Verdict,
} from '@routespec/contracts';
import { RUNTIME_REVISIONS, type GateCaseInput, type GateIdentity, type GateInput } from '@routespec/runner';
import { d } from './product.ts';

export const INVARIANTS = ['INV-03', 'INV-05'];

let counter = 0;
export function uuid(): string {
  counter++;
  const hex = counter.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
}

export function identity(overrides: Partial<GateIdentity> = {}): GateIdentity {
  return {
    gateRunId: '10000000-0000-4000-8000-000000000001',
    gateRunIdentityDigest: d('gate-run-identity'),
    gateDefinitionRevisionId: null,
    projectId: '10000000-0000-4000-8000-000000000002',
    integrationRevisionId: '10000000-0000-4000-8000-000000000003',
    buildRevisionId: '10000000-0000-4000-8000-000000000004',
    artifactDigest: d('artifact'),
    buildAttestationClass: 'USER_ASSERTED_LOCAL',
    buildAttestationId: null,
    corpusRevisionId: '10000000-0000-4000-8000-000000000005',
    protocolProfileId: 'oneclick-v0@1.0.0',
    adapterRevision: 'routespec-adapter@1.0.0',
    evaluatorRevision: RUNTIME_REVISIONS.evaluatorRevision,
    proxyRevision: RUNTIME_REVISIONS.proxyRevision,
    configurationDigest: d('config'),
    effectManifestDigest: d('manifest'),
    effectCoveragePolicyDigest: d('policy'),
    callsiteInventoryDigest: null,
    interceptorProfileDigest: null,
    maxParallelCases: 4,
    journalSchemaVersion: 6,
    canonicalResultSchemaVersion: CANONICAL_RESULT_SCHEMA_VERSION,
    buildAttestationPolicy: 'ALLOW_USER_ASSERTED',
    cases: [],
    ...overrides,
  };
}

export function canonical(
  id: GateIdentity,
  c: { caseRunId: string; sessionId: string; scenarioRevisionId: string; fencingEpoch: number },
  verdict: Verdict,
  options: { reasons?: string[]; overrides?: Record<string, unknown> } = {},
): CanonicalCaseResult {
  return normalizeCanonicalResult({
    schemaVersion: CANONICAL_RESULT_SCHEMA_VERSION,
    projectId: id.projectId,
    integrationRevisionId: id.integrationRevisionId,
    buildRevisionId: id.buildRevisionId,
    artifactDigest: id.artifactDigest,
    buildAttestationClass: id.buildAttestationClass,
    buildAttestationId: id.buildAttestationId,
    caseLaunchAttestationId: null,
    gateRunId: id.gateRunId,
    caseRunId: c.caseRunId,
    sessionId: c.sessionId,
    corpusRevisionId: id.corpusRevisionId,
    scenarioRevisionId: c.scenarioRevisionId,
    seed: 'fixture-seed',
    protocolProfileId: id.protocolProfileId,
    adapterRevision: id.adapterRevision,
    evaluatorRevision: id.evaluatorRevision,
    configurationDigest: id.configurationDigest,
    effectCoveragePolicyDigest: id.effectCoveragePolicyDigest,
    effectManifestDigest: id.effectManifestDigest,
    callsiteInventoryDigest: id.callsiteInventoryDigest,
    interceptorInstanceId: null,
    fencingEpoch: c.fencingEpoch,
    runOperations: [],
    exchanges: [],
    facts: [],
    invariantResults: INVARIANTS.map((invariantId) => ({
      invariantId,
      verdict: verdict === 'UNSUPPORTED' && invariantId === 'INV-05' ? 'UNSUPPORTED' : verdict,
      evidenceIds: [],
      missingPredicates: verdict === 'PASS' ? [] : ['FIXTURE_PREDICATE'],
      reasons: verdict === 'PASS' ? [] : (options.reasons ?? []),
    })),
    verdict,
    ...(options.overrides ?? {}),
  });
}

/** Every distinct CaseRun state the aggregator must classify. */
export const CASE_KINDS = [
  'PASS',
  'FAIL',
  'REVIEW',
  'UNSUPPORTED',
  'RESULT_NOT_RUN',
  'PRIVATE_NOT_VISIBLE',
  'PENDING',
  'QUEUED',
  'RUNNING',
  'EVALUATING',
  'RECOVERY_REQUIRED',
  'ABORTED_STARTED',
  'CANCELLED_UNSTARTED',
  'ERROR',
  'MISSING',
  'INTERRUPTED_PASS',
  'TEARDOWN_MISSING_PASS',
  'IDENTITY_MISMATCH_PASS',
  'IDENTITY_MISMATCH_FAIL',
  'TAMPERED_PASS',
  'STALE_EVALUATOR_PASS',
  'RESULT_MISSING',
] as const;
export type CaseKind = (typeof CASE_KINDS)[number];

export const UNSTARTED: readonly CaseKind[] = ['PENDING', 'QUEUED', 'CANCELLED_UNSTARTED'];

export function caseOf(
  id: GateIdentity,
  ordinal: number,
  kind: CaseKind,
  gatePolicy = 'REQUIRED',
): GateCaseInput {
  const scenarioRevisionId = `20000000-0000-4000-8000-${String(ordinal).padStart(12, '0')}`;
  const corpusCase = { scenarioRevisionId, requiredInvariants: INVARIANTS, gatePolicy };
  if (kind === 'MISSING') return { ordinal, corpusCase, caseRun: null, result: null, interrupted: false };
  const caseRunId = uuid();
  const sessionId = uuid();
  const started = !UNSTARTED.includes(kind);
  const lifecycle: ExecutionLifecycle =
    kind === 'PENDING'
      ? 'PENDING'
      : kind === 'QUEUED'
        ? 'READY'
        : kind === 'RUNNING'
          ? 'RUNNING'
          : kind === 'EVALUATING'
            ? 'EVALUATING'
            : kind === 'RECOVERY_REQUIRED'
              ? 'RECOVERY_REQUIRED'
              : kind === 'ABORTED_STARTED' || kind === 'CANCELLED_UNSTARTED'
                ? 'ABORTED'
                : kind === 'ERROR'
                  ? 'ERROR'
                  : 'COMPLETED';
  const verdictFor: Partial<Record<CaseKind, Verdict>> = {
    FAIL: 'FAIL',
    IDENTITY_MISMATCH_FAIL: 'FAIL',
    REVIEW: 'REVIEW',
    PRIVATE_NOT_VISIBLE: 'REVIEW',
    UNSUPPORTED: 'UNSUPPORTED',
    RESULT_NOT_RUN: 'NOT_RUN',
  };
  const verdict: Verdict = verdictFor[kind] ?? 'PASS';
  const epoch = 1;
  const hasResult = lifecycle === 'COMPLETED' && kind !== 'RESULT_MISSING';
  let c: CanonicalCaseResult | null = null;
  if (hasResult) {
    const mismatch = kind === 'IDENTITY_MISMATCH_PASS' || kind === 'IDENTITY_MISMATCH_FAIL';
    const stale = kind === 'STALE_EVALUATOR_PASS';
    c = canonical(id, { caseRunId, sessionId, scenarioRevisionId, fencingEpoch: epoch }, verdict, {
      reasons: kind === 'PRIVATE_NOT_VISIBLE' ? ['NOT_VISIBLE'] : [],
      overrides: mismatch
        ? { artifactDigest: d('another-artifact') }
        : stale
          ? { evaluatorRevision: 'routespec-kernel@0.9.0' }
          : {},
    });
  }
  const digest = c ? computeCanonicalResultDigest(c) : null;
  const storedDigest = kind === 'TAMPERED_PASS' ? d('tampered') : digest;
  return {
    ordinal,
    corpusCase,
    caseRun: {
      caseRunId,
      gateRunId: id.gateRunId,
      scenarioRevisionId,
      requiredInvariants: INVARIANTS,
      adapterRevision: id.adapterRevision,
      lifecycle,
      verdict: hasResult ? verdict : null,
      fencingEpoch: started ? epoch : 0,
      sessionId: started ? sessionId : null,
      clientInstanceDigest: started ? d(`client-${caseRunId}`) : null,
      teardownRecorded: started && kind !== 'TEARDOWN_MISSING_PASS',
      terminalResultDigest: hasResult ? storedDigest : null,
    },
    result:
      hasResult && c
        ? {
            storedDigest: storedDigest as string,
            recomputedDigest: digest,
            canonical: c,
            verdict,
            evaluatorRevision:
              kind === 'STALE_EVALUATOR_PASS' ? 'routespec-kernel@0.9.0' : id.evaluatorRevision,
            fencingEpoch: epoch,
            sessionId,
          }
        : null,
    interrupted: kind === 'INTERRUPTED_PASS',
  };
}

export function gateInput(
  kinds: readonly CaseKind[],
  options: {
    identity?: Partial<GateIdentity>;
    lifecycle?: ExecutionLifecycle;
    runtime?: GateInput['runtime'];
    advisory?: readonly CaseKind[];
  } = {},
): GateInput {
  const id = identity(options.identity);
  const cases = [
    ...kinds.map((k, i) => caseOf(id, i, k)),
    ...(options.advisory ?? []).map((k, i) => caseOf(id, kinds.length + i, k, 'ADVISORY')),
  ];
  return {
    identity: { ...id, cases: [] },
    gateLifecycle: options.lifecycle ?? 'RUNNING',
    enforcementMode: 'LOCAL_ADVISORY',
    cases,
    runtime: options.runtime ?? RUNTIME_REVISIONS,
  };
}

/** Independent oracle for the documented precedence (TDD section 14). */
export function expectedDecision(kinds: readonly CaseKind[], gateGap = false): Verdict {
  if (kinds.includes('FAIL')) return 'FAIL';
  if (kinds.every((k) => UNSTARTED.includes(k) || k === 'MISSING')) return 'NOT_RUN';
  if (!gateGap && kinds.every((k) => k === 'PASS')) return 'PASS';
  return 'REVIEW';
}
