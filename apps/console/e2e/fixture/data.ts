/**
 * Contract fixture for console shell tests.
 *
 * SIMULATED: these records are hand-built examples of the response shapes the console expects
 * from the M08 control API (docs/adr/0007-console-shell-and-control-client.md). They exercise
 * rendering of every axis and state. They are not persisted product records, were not produced
 * by the evaluator, and are not acceptance evidence for any product gate.
 */
import { createHash } from 'node:crypto';
import type {
  CaseRun,
  Evidence,
  GateRun,
  ImportDetail,
  InvariantResult,
  Matrix,
  MatrixRow,
  Project,
  RunOperation,
  Settings,
  StatusAxes,
  TimelineEvent,
} from '../../src/api/schemas.ts';

export const d = (label: string): string => `sha256:${createHash('sha256').update(label).digest('hex')}`;
const T0 = Date.parse('2026-11-10T09:00:00Z');
export const at = (offsetSeconds: number): string => new Date(T0 + offsetSeconds * 1000).toISOString();

export const PROJECTS: Project[] = [
  {
    projectId: 'proj-alpha',
    name: 'Swap client',
    description: 'Fixture project with recorded gate runs',
    settingsRevision: 3,
  },
  { projectId: 'proj-empty', name: 'Empty project', description: null, settingsRevision: 1 },
  {
    projectId: 'proj-legacy',
    name: 'Legacy service',
    description: 'Older control API revision',
    settingsRevision: 1,
  },
];

const axes = (over: Partial<StatusAxes>): StatusAxes => ({
  lifecycle: 'COMPLETED',
  verdict: 'NOT_RUN',
  verdictReason: null,
  evidence: { class: 'PROVEN', scope: 'SIMULATED_GROUND_TRUTH', reasons: [] },
  attestation: {
    class: 'USER_ASSERTED_LOCAL',
    attestationId: null,
    observedAt: null,
    freshness: 'NOT_APPLICABLE',
  },
  effectCoverage: {
    basis: 'INDEPENDENT_BOUNDARY_INTERCEPT',
    finding: 'COMPLETE',
    missing: [],
    interceptorProfileId: 'icp-01',
    interceptorFreshness: 'FRESH',
    processTreeScope: 'subject process tree',
  },
  artifactReady: true,
  enforcementMode: 'LOCAL_ADVISORY',
  officialCompatibility: { status: 'NOT_RUN', recordId: null, observedAt: null },
  evaluatedAt: at(600),
  evidenceObservedAt: at(540),
  ...over,
});

const counts = (
  total: number,
  passed: number,
  failed: number,
  review: number,
  unsupportedRequired: number,
) => ({
  total,
  passed,
  failed,
  review,
  unsupportedRequired,
  notRun: total - passed - failed - review - unsupportedRequired,
});

export const GATE_AXES: Record<string, StatusAxes> = {
  'gr-fail': axes({
    verdict: 'FAIL',
    verdictReason: 'INV-03 violated in case "accepted then response lost" (run operation op-fail-1).',
    artifactReady: false,
  }),
  'gr-review': axes({
    verdict: 'REVIEW',
    verdictReason: 'Required settlement evidence is private and not visible; one case did not complete.',
    evidence: { class: 'UNKNOWN', scope: 'PRIVATE_NOT_VISIBLE', reasons: ['NOT_VISIBLE', 'PRIVATE'] },
    effectCoverage: {
      basis: 'DECLARED_HOOKS_ONLY',
      finding: 'INCOMPLETE',
      missing: ['payout sink not independently observed'],
      interceptorProfileId: null,
      interceptorFreshness: 'NOT_APPLICABLE',
      processTreeScope: null,
    },
    enforcementMode: 'CI_CHECK',
    officialCompatibility: { status: 'UNKNOWN', recordId: 'cmp-02', observedAt: at(300) },
  }),
  'gr-pass': axes({
    verdict: 'PASS',
    attestation: {
      class: 'TRUSTED_LAUNCHER',
      attestationId: 'att-07',
      observedAt: at(100),
      freshness: 'FRESH',
    },
    effectCoverage: {
      basis: 'TRUSTED_BUILD_INVENTORY_PLUS_INTERCEPT',
      finding: 'COMPLETE',
      missing: [],
      interceptorProfileId: 'icp-01',
      interceptorFreshness: 'FRESH',
      processTreeScope: 'subject process tree',
    },
    artifactReady: false,
    enforcementMode: 'REQUIRED_CHECK_UNVERIFIED',
    officialCompatibility: {
      status: 'OFFICIAL_ENDPOINT_COMPATIBLE',
      recordId: 'cmp-03',
      observedAt: at(700),
    },
  }),
  'gr-running': axes({
    lifecycle: 'RUNNING',
    verdict: 'NOT_RUN',
    evidence: { class: 'UNKNOWN', scope: null, reasons: ['MISSING'] },
    effectCoverage: {
      basis: 'INDEPENDENT_BOUNDARY_INTERCEPT',
      finding: 'NOT_EVALUATED',
      missing: [],
      interceptorProfileId: 'icp-01',
      interceptorFreshness: 'FRESH',
      processTreeScope: 'subject process tree',
    },
    artifactReady: null,
    evaluatedAt: null,
    evidenceObservedAt: null,
  }),
};

const GATE_COUNTS: Record<string, ReturnType<typeof counts>> = {
  'gr-fail': counts(4, 1, 1, 1, 0),
  'gr-review': counts(6, 4, 0, 1, 0),
  'gr-pass': counts(6, 6, 0, 0, 0),
  'gr-running': counts(100, 3, 0, 0, 0),
};

const REVISIONS: Record<string, { revisionId: string; label: string; commit: string }> = {
  'gr-fail': { revisionId: 'rev-140', label: 'v1.4.0', commit: '4a1c9e0b7d2f6a8c1e3b5d7f9a0c2e4b6d8f0a1c' },
  'gr-review': { revisionId: 'rev-141', label: 'v1.4.1', commit: '5b2d0f1c8e3a7b9d2f4c6e8a0b1d3f5a7c9e1b2d' },
  'gr-pass': { revisionId: 'rev-150', label: 'v1.5.0', commit: '6c3e1a2d9f4b8c0e3a5d7f9b1c2e4a6b8d0f2c3e' },
  'gr-running': {
    revisionId: 'rev-160',
    label: 'v1.6.0-rc.1',
    commit: '7d4f2b3e0a5c9d1f4b6e8a0c2d3f5b7c9e1a3d4f',
  },
};

export function matrixRow(
  gateRunId: string,
  statusAxes: StatusAxes,
  c: ReturnType<typeof counts>,
): MatrixRow {
  const rev = REVISIONS[gateRunId] ?? {
    revisionId: `rev-${gateRunId}`,
    label: gateRunId,
    commit: '0'.repeat(40),
  };
  return {
    ...statusAxes,
    revisionId: rev.revisionId,
    revisionLabel: rev.label,
    commitSha: rev.commit,
    buildRevisionId: `build-${rev.revisionId}`,
    artifactDigest: d(`artifact-${gateRunId}`),
    corpusRevisionId: gateRunId === 'gr-running' ? 'corpus-dense-100' : 'corpus-core-6',
    corpusDigest: d(`corpus-${gateRunId}`),
    caseCount: c.total,
    gateRunId,
    counts: c,
  };
}

export function buildMatrix(projectId: string, extraGateRuns: GateRun[]): Matrix {
  if (projectId === 'proj-empty' || projectId === 'proj-legacy') {
    return {
      projectId,
      projectName: PROJECTS.find((p) => p.projectId === projectId)?.name ?? projectId,
      rows: [],
      nextCursor: null,
    };
  }
  const rows = Object.keys(GATE_AXES).map((g) =>
    matrixRow(g, GATE_AXES[g] as StatusAxes, GATE_COUNTS[g] as ReturnType<typeof counts>),
  );
  for (const g of extraGateRuns) {
    rows.push({
      ...matrixRow(g.gateRunId, g, g.counts),
      revisionId: g.revisionId,
      revisionLabel: `${g.revisionId} (new)`,
    });
  }
  return { projectId, projectName: 'Swap client', rows, nextCursor: null };
}

export function gateRun(gateRunId: string): GateRun | null {
  const statusAxes = GATE_AXES[gateRunId];
  const c = GATE_COUNTS[gateRunId];
  const rev = REVISIONS[gateRunId];
  if (!statusAxes || !c || !rev) return null;
  return {
    ...statusAxes,
    gateRunId,
    projectId: 'proj-alpha',
    revisionId: rev.revisionId,
    mode: 'SIMULATE',
    identity: identity(gateRunId, `build-${rev.revisionId}`),
    interceptorAttestation:
      statusAxes.effectCoverage.basis === 'DECLARED_HOOKS_ONLY'
        ? null
        : { class: 'TRUSTED_LAUNCHER', attestationId: 'att-icp-01', observedAt: at(120), freshness: 'FRESH' },
    parallelism:
      gateRunId === 'gr-running'
        ? { declared: 4, running: 4, queued: 93 }
        : { declared: 2, running: 0, queued: 0 },
    counts: c,
    findings:
      gateRunId === 'gr-fail'
        ? [
            {
              code: 'RS_INV_03_VIOLATED',
              level: 'FAIL',
              message: 'Second commit was attempted after an accepted commit lost its response.',
              caseRunId: 'c-fail-1',
            },
            {
              code: 'RS_RECOVERY_PENDING',
              level: 'REVIEW',
              message: 'Case "runner crash mid-commit" needs read-only reconciliation.',
              caseRunId: 'c-fail-2',
            },
          ]
        : gateRunId === 'gr-review'
          ? [
              {
                code: 'RS_EVIDENCE_NOT_VISIBLE',
                level: 'REVIEW',
                message: 'Settlement evidence is private to the provider.',
                caseRunId: null,
              },
            ]
          : [],
    revision: 5,
  };
}

export function identity(seed: string, buildRevisionId: string): GateRun['identity'] {
  return {
    repository: 'local:swap-client',
    commitSha: REVISIONS[seed]?.commit ?? '1'.repeat(40),
    dirtyTreeDigest: null,
    buildRevisionId,
    artifactDigest: d(`artifact-${seed}`),
    effectPolicyDigest: d(`policy-${seed}`),
    effectManifestDigest: d(`manifest-${seed}`),
    callSiteInventoryDigest: seed === 'gr-pass' ? d(`inventory-${seed}`) : null,
    interceptorProfileDigest: d('icp-01'),
    corpusRevisionId: seed === 'gr-running' ? 'corpus-dense-100' : 'corpus-core-6',
    corpusDigest: d(`corpus-${seed}`),
    evaluatorRevision: 'kernel@1.0.0',
    adapterRevision: 'one-click-sdk-adapter@0.1.26+1',
    protocolProfileId: 'oneclick-v0@1.0.0',
    configurationDigest: d(`config-${seed}`),
    workflowRunId: null,
    appRevision: 'routespec@0.0.0',
  };
}

const coverageComplete: CaseRun['effectCoverage'] = {
  basis: 'INDEPENDENT_BOUNDARY_INTERCEPT',
  finding: 'COMPLETE',
  missing: [],
  interceptorProfileId: 'icp-01',
  interceptorFreshness: 'FRESH',
  processTreeScope: 'subject process tree',
};

function baseCase(
  over: Partial<CaseRun> & Pick<CaseRun, 'caseRunId' | 'gateRunId' | 'ordinal' | 'scenarioName'>,
): CaseRun {
  return {
    scenarioRevisionId: `scn-${over.ordinal}`,
    lineageRole: 'BASELINE',
    logicalJobLabel: 'job: swap-usdc-near',
    lifecycle: 'COMPLETED',
    verdict: 'PASS',
    verdictReason: null,
    evidence: { class: 'PROVEN', scope: 'SIMULATED_GROUND_TRUTH', reasons: [] },
    clientState: 'TORN_DOWN',
    resetState: 'COMPLETE',
    token: { state: 'REVOKED', purpose: 'EXECUTION', expiresAt: null },
    fencingEpoch: 1,
    effectCoverage: coverageComplete,
    severity: null,
    requiredInvariants: ['INV-01', 'INV-03'],
    queuePosition: null,
    recovery: null,
    sessionId: null,
    runOperationIds: [],
    provenance: 'SYNTHETIC',
    ...over,
  };
}

export function initialCases(): Record<string, CaseRun[]> {
  const fail: CaseRun[] = [
    baseCase({
      caseRunId: 'c-fail-1',
      gateRunId: 'gr-fail',
      ordinal: 1,
      scenarioName: 'Accepted then response lost',
      verdict: 'FAIL',
      verdictReason: 'INV-03: a second commit was attempted for run operation op-fail-1.',
      severity: 'CRITICAL',
      sessionId: 's-fail-1',
      runOperationIds: ['op-fail-1'],
    }),
    baseCase({
      caseRunId: 'c-fail-2',
      gateRunId: 'gr-fail',
      ordinal: 2,
      scenarioName: 'Runner crash mid-commit',
      lifecycle: 'RECOVERY_REQUIRED',
      verdict: 'NOT_RUN',
      evidence: { class: 'UNKNOWN', scope: null, reasons: ['MISSING'] },
      clientState: 'TEARDOWN_INCOMPLETE',
      resetState: 'INCOMPLETE',
      token: { state: 'ACTIVE', purpose: 'EXECUTION', expiresAt: at(3600) },
      fencingEpoch: 2,
      recovery: {
        available: true,
        action: 'RECONCILE_EXISTING_OPERATION',
        readOnly: true,
        reasonCode: 'RS_LEASE_EXPIRED',
      },
      runOperationIds: ['op-fail-2'],
    }),
    baseCase({
      caseRunId: 'c-fail-3',
      gateRunId: 'gr-fail',
      ordinal: 3,
      scenarioName: 'Refund after incomplete deposit',
      lineageRole: 'CORRECTED',
    }),
    baseCase({
      caseRunId: 'c-fail-4',
      gateRunId: 'gr-fail',
      ordinal: 4,
      scenarioName: 'Late success after timeout',
      lineageRole: 'REPLAY',
      verdict: 'REVIEW',
      verdictReason: 'External wall timer observed; noncanonical evidence.',
      evidence: { class: 'REPORTED', scope: 'PROVIDER_REPORTED', reasons: ['NONCANONICAL_TIMER'] },
    }),
  ];
  const running: CaseRun[] = Array.from({ length: 100 }, (_, i) => {
    const n = i + 1;
    const done = n <= 3;
    const active = n > 3 && n <= 7;
    return baseCase({
      caseRunId: `c-run-${String(n).padStart(3, '0')}`,
      gateRunId: 'gr-running',
      ordinal: n,
      scenarioName: `Dense corpus case ${n}`,
      lifecycle: done ? 'COMPLETED' : active ? 'RUNNING' : 'PENDING',
      verdict: done ? 'PASS' : 'NOT_RUN',
      evidence: done
        ? { class: 'PROVEN', scope: 'SIMULATED_GROUND_TRUTH', reasons: [] }
        : { class: 'UNKNOWN', scope: null, reasons: ['MISSING'] },
      clientState: done ? 'TORN_DOWN' : active ? 'CONNECTED' : 'NOT_STARTED',
      resetState: done ? 'COMPLETE' : 'PENDING',
      token: done
        ? { state: 'REVOKED', purpose: 'EXECUTION', expiresAt: null }
        : active
          ? { state: 'ACTIVE', purpose: 'EXECUTION', expiresAt: at(3600) }
          : { state: 'NOT_ISSUED', purpose: null, expiresAt: null },
      queuePosition: !done && !active ? n - 7 : null,
      effectCoverage: done ? coverageComplete : { ...coverageComplete, finding: 'NOT_EVALUATED' },
      sessionId: n === 4 ? 's-dense' : null,
    });
  });
  const review: CaseRun[] = [
    baseCase({
      caseRunId: 'c-rev-1',
      gateRunId: 'gr-review',
      ordinal: 1,
      scenarioName: 'Private settlement',
      verdict: 'REVIEW',
      verdictReason: 'Settlement evidence is private and not visible.',
      evidence: { class: 'UNKNOWN', scope: 'PRIVATE_NOT_VISIBLE', reasons: ['NOT_VISIBLE'] },
      effectCoverage: {
        basis: 'DECLARED_HOOKS_ONLY',
        finding: 'INCOMPLETE',
        missing: ['payout sink'],
        interceptorProfileId: null,
        interceptorFreshness: 'NOT_APPLICABLE',
        processTreeScope: null,
      },
    }),
  ];
  const pass: CaseRun[] = [
    baseCase({
      caseRunId: 'c-pass-1',
      gateRunId: 'gr-pass',
      ordinal: 1,
      scenarioName: 'Happy path quote and commit',
    }),
  ];
  return { 'gr-fail': fail, 'gr-running': running, 'gr-review': review, 'gr-pass': pass };
}

const INVARIANT_TITLES = [
  'Logical jobs never merge run-scoped operations',
  'Finalized operation binding is immutable',
  'No second commit after an accepted commit',
  'Amounts are exact integers',
  'Refund evidence is proven before refund claim',
  'Terminal status folds monotonically',
  'Evidence is single-use',
  'Deposit address is response-assigned',
  'Status reconciliation is read-only',
  'Unknown raw status is REVIEW',
  'Effects are independently observed',
  'Local headers never reach upstream',
];

export function runOperation(runOperationId: string): RunOperation | null {
  if (runOperationId !== 'op-fail-1' && runOperationId !== 'op-fail-2') return null;
  const failing = runOperationId === 'op-fail-1';
  const evidence: Evidence[] = [
    {
      evidenceId: 'ev-gt-1',
      class: 'PROVEN',
      scope: 'SIMULATED_GROUND_TRUTH',
      reasons: [],
      provenance: 'scenario ground truth',
      subject: 'first commit accepted',
      observedAt: at(30),
      collectedAt: at(31),
      freshness: 'FRESH',
      digest: d('ev-gt-1'),
      redacted: false,
    },
    {
      evidenceId: 'ev-sub-1',
      class: 'REPORTED',
      scope: 'SUBJECT_REPORTED',
      reasons: [],
      provenance: 'subject effect hook',
      subject: 'payout hook ATTEMPTED',
      observedAt: at(40),
      collectedAt: at(41),
      freshness: 'FRESH',
      digest: d('ev-sub-1'),
      redacted: false,
    },
    {
      evidenceId: 'ev-prov-1',
      class: 'REPORTED',
      scope: 'PROVIDER_REPORTED',
      reasons: [],
      provenance: 'scenario provider status queue',
      subject: 'status SUCCESS',
      observedAt: at(50),
      collectedAt: at(51),
      freshness: 'FRESH',
      digest: d('ev-prov-1'),
      redacted: true,
    },
    {
      evidenceId: 'ev-priv-1',
      class: 'UNKNOWN',
      scope: 'PRIVATE_NOT_VISIBLE',
      reasons: ['NOT_VISIBLE'],
      provenance: 'provider private ledger',
      subject: 'settlement',
      observedAt: null,
      collectedAt: at(52),
      freshness: 'NOT_APPLICABLE',
      digest: d('ev-priv-1'),
      redacted: true,
    },
  ];
  const invariants: InvariantResult[] = INVARIANT_TITLES.map((title, i) => {
    const id = `INV-${String(i + 1).padStart(2, '0')}`;
    const status: InvariantResult['status'] =
      failing && id === 'INV-03' ? 'FAIL' : id === 'INV-11' ? 'REVIEW' : 'PASS';
    return {
      invariantId: id,
      title,
      status,
      applicable: true,
      facts: status === 'FAIL' ? ['commit accepted at seq 12', 'second commit attempted at seq 19'] : [],
      evidenceIds: status === 'FAIL' ? ['ev-gt-1'] : id === 'INV-11' ? ['ev-sub-1'] : [],
      missingPredicates: id === 'INV-11' ? ['independent observation of payout sink'] : [],
      remediationCode: status === 'FAIL' ? 'RS_REMEDIATE_RECONCILE_BEFORE_RETRY' : null,
    };
  });
  return {
    runOperationId,
    logicalJobDigest: d('job: swap-usdc-near'),
    logicalJobLabel: 'job: swap-usdc-near',
    bindingDigest: d(`binding-${runOperationId}`),
    lineage: failing ? [{ relation: 'BASELINE_OF', runOperationId: 'op-fail-2' }] : [],
    identity: {
      projectId: 'proj-alpha',
      buildRevisionId: 'build-rev-140',
      artifactDigest: d('artifact-gr-fail'),
      gateRunId: 'gr-fail',
      caseRunId: failing ? 'c-fail-1' : 'c-fail-2',
      sessionId: failing ? 's-fail-1' : 's-fail-2',
      adapterRevision: 'one-click-sdk-adapter@0.1.26+1',
      effectPolicyDigest: d('policy-gr-fail'),
      effectManifestDigest: d('manifest-gr-fail'),
      callSiteInventoryDigest: null,
      interceptorProfileDigest: d('icp-01'),
      fencingEpoch: 1,
    },
    currentPhase: 'READ_ONLY_RECONCILIATION',
    phases: {
      quoteRequest: {
        state: 'BOUND',
        digest: d('qr'),
        boundAt: at(10),
        fields: [
          { name: 'amountIn', value: '1000000', masked: false },
          { name: 'depositType', value: 'ORIGIN_CHAIN', masked: false },
        ],
      },
      quoteFinalization: {
        state: 'BOUND',
        digest: d('qf'),
        boundAt: at(11),
        fields: [{ name: 'depositAddress', value: '0x••••c0de', masked: true }],
      },
      commitBinding: {
        state: 'BOUND',
        digest: d('cb'),
        boundAt: at(12),
        fields: [{ name: 'txDigest', value: d('tx').slice(0, 23), masked: false }],
      },
      reconciliation: { observations: 3, lastObservedAt: at(50) },
    },
    conflicts: failing
      ? [
          {
            code: 'RS_SECOND_COMMIT_REJECTED',
            phase: 'COMMIT_MUTATION',
            message: 'Second commit with changed material rejected; original binding kept.',
            observedAt: at(19),
          },
        ]
      : [],
    providerReported: {
      rawStatus: 'SUCCESS',
      rawStatusKnown: true,
      normalizedFact: 'SUCCESS_REPORTED',
      observedAt: at(50),
    },
    evaluatedOutcome: { verdict: failing ? 'FAIL' : 'NOT_RUN', fact: failing ? 'SUCCESS_PROVEN' : null },
    attempts: { count: failing ? 3 : 1, uncertainty: failing ? 'NONE' : 'OUTCOME_UNKNOWN' },
    effectCoverage: coverageComplete,
    sinkObservations: [
      {
        observationId: 'obs-s1',
        source: 'SUBJECT_REPORTED',
        hookId: 'hook.payout@1',
        sinkClass: 'HTTP_EGRESS',
        effectType: 'payout',
        action: 'ATTEMPTED',
        sequence: 14,
        interceptorProfileId: null,
        processTreeScope: null,
        freshness: 'FRESH',
      },
      {
        observationId: 'obs-b1',
        source: 'INDEPENDENT_BOUNDARY',
        hookId: null,
        sinkClass: 'HTTP_EGRESS',
        effectType: 'payout',
        action: 'BLOCKED',
        sequence: 15,
        interceptorProfileId: 'icp-01',
        processTreeScope: 'subject process tree',
        freshness: 'FRESH',
      },
    ],
    evidence,
    invariants,
  };
}

const KINDS: TimelineEvent['kind'][] = [
  'CLIENT_REQUEST',
  'PROXY_RESPONSE',
  'PHASE_BINDING',
  'PROVIDER_OBSERVATION',
  'SUBJECT_REPORT',
  'BOUNDARY_OBSERVATION',
  'EVIDENCE',
  'INVARIANT',
];

/** Deterministic dense session: 10,000 events for s-fail-1 and s-dense, 40 for others. */
export function sessionEventCount(sessionId: string): number {
  return sessionId === 's-fail-1' || sessionId === 's-dense' ? 10_000 : 40;
}

export function sessionEvent(sessionId: string, sequence: number): TimelineEvent {
  const kind = KINDS[(sequence - 1) % KINDS.length] as TimelineEvent['kind'];
  const phases = [
    'QUOTE_REQUEST',
    'QUOTE_FINALIZATION',
    'COMMIT_MUTATION',
    'READ_ONLY_RECONCILIATION',
  ] as const;
  const scoped = kind === 'EVIDENCE' || kind === 'SUBJECT_REPORT' || kind === 'BOUNDARY_OBSERVATION';
  return {
    sequence,
    kind,
    eventCode: `${kind}.${sequence % 7}`,
    phase: phases[sequence % 4] ?? null,
    runOperationId: sessionId === 's-fail-1' ? 'op-fail-1' : null,
    source:
      kind === 'SUBJECT_REPORT'
        ? 'SUBJECT'
        : kind === 'BOUNDARY_OBSERVATION'
          ? 'INTERCEPTOR'
          : kind === 'INVARIANT'
            ? 'EVALUATOR'
            : 'PROXY',
    evidenceClass: scoped ? (kind === 'SUBJECT_REPORT' ? 'REPORTED' : 'PROVEN') : null,
    evidenceScope:
      kind === 'SUBJECT_REPORT' ? 'SUBJECT_REPORTED' : kind === 'EVIDENCE' ? 'SIMULATED_GROUND_TRUTH' : null,
    evidenceReasons: [],
    virtualMs: sequence * 10,
    wallTime: at(sequence / 10),
    timerCanonical: sequence % 997 !== 0,
    summary: `${kind.toLowerCase().replace(/_/g, ' ')} ${sequence} in ${sessionId}`,
  };
}

export function initialImports(): ImportDetail[] {
  const lineage = (states: ImportDetail['lineage'][number]['state'][]): ImportDetail['lineage'] =>
    (
      [
        'CAPTURE',
        'QUARANTINE',
        'SANITIZE',
        'MAP',
        'REPLAY_VERIFICATION',
        'REVIEW',
        'PROMOTED_SCENARIO',
        'NEW_CORPUS',
        'CORRECTED_RERUN',
      ] as const
    ).map((stage, i) => ({
      stage,
      state: states[i] ?? 'PENDING',
      recordId: states[i] === 'DONE' ? `${stage.toLowerCase()}-rec` : null,
      digest: states[i] === 'DONE' ? d(stage) : null,
    }));
  return [
    {
      importId: 'imp-secret',
      revision: 1,
      origin: 'INSTALLED_ARTIFACT_CAPTURE',
      source: {
        buildRevisionId: 'build-rev-140',
        gateRunId: 'gr-fail',
        caseRunId: 'c-fail-1',
        sessionId: 's-fail-1',
      },
      sanitizedName: 'capture-c-fail-1',
      digest: d('imp-secret'),
      sizeBytes: 18_432,
      state: 'QUARANTINED',
      findings: { secret: 1, nondeterminism: 0, unresolved: 2 },
      expiresAt: at(86_400),
      promotable: false,
      blockers: [
        {
          field: 'redaction',
          code: 'RS_SECRET_DETECTED',
          message: 'A secret-shaped value was found at events[4].headers; it must be removed before review.',
        },
        {
          field: 'material',
          code: 'RS_UNRESOLVED_MATERIAL',
          message: 'Two commit-material fields are unresolved.',
        },
      ],
      lineage: lineage(['DONE', 'DONE', 'BLOCKED']),
      sourceEvents: [{ sequence: 1, summary: 'POST /v0/quote (body digest only)' }],
      proposedEvents: [],
      replayOnlyPass: false,
    },
    {
      importId: 'imp-mapped',
      revision: 4,
      origin: 'INSTALLED_ARTIFACT_CAPTURE',
      source: {
        buildRevisionId: 'build-rev-140',
        gateRunId: 'gr-fail',
        caseRunId: 'c-fail-1',
        sessionId: 's-fail-1',
      },
      sanitizedName: 'capture-response-loss',
      digest: d('imp-mapped'),
      sizeBytes: 9_216,
      state: 'MAPPED',
      findings: { secret: 0, nondeterminism: 0, unresolved: 0 },
      expiresAt: at(86_400),
      promotable: false,
      blockers: [
        {
          field: 'replay',
          code: 'RS_REPLAY_NOT_VERIFIED',
          message: 'Deterministic replay has not been verified.',
        },
      ],
      lineage: lineage(['DONE', 'DONE', 'DONE', 'DONE']),
      sourceEvents: [
        { sequence: 1, summary: 'POST /v0/quote' },
        { sequence: 2, summary: 'quote response (deposit address assigned)' },
        { sequence: 3, summary: 'POST /v0/deposit/submit — response dropped' },
      ],
      proposedEvents: [
        { sequence: 1, phase: 'QUOTE_REQUEST', summary: 'quote request' },
        { sequence: 2, phase: 'QUOTE_FINALIZATION', summary: 'finalization' },
        { sequence: 3, phase: 'COMMIT_MUTATION', summary: 'commit; response lost' },
      ],
      replayOnlyPass: false,
    },
  ];
}

export function fixtureSettings(): Settings {
  return {
    bindAddress: '127.0.0.1',
    port: 0,
    modes: [
      { mode: 'SIMULATE', supported: true, runtime: 'NETWORKLESS_SCENARIO' },
      { mode: 'REPLAY', supported: true, runtime: 'NETWORKLESS_SCENARIO' },
      { mode: 'LIVE_DRY_PROBE', supported: true, runtime: 'LIVE_DRY_ADAPTER' },
      { mode: 'COMMITTED_LIVE', supported: false, runtime: 'NONE' },
    ],
    providerTokenState: 'NOT_REQUIRED',
    upstreamOrigin: null,
    allowlistedRoutes: ['POST /v0/quote (dry: true only)'],
    retention: { days: 30, storageBytes: 1_048_576 },
    exportPolicy: 'Redacted bundles only; no credentials, raw authorization, or unreviewed traces.',
    versions: {
      app: 'routespec@0.0.0',
      protocolProfile: 'oneclick-v0@1.0.0',
      evaluator: 'kernel@1.0.0',
      sdk: '@defuse-protocol/one-click-sdk-typescript@0.1.26',
    },
    compatibilityRecords: [],
    dryProbe: { authorized: false, expiresAt: null },
  };
}
