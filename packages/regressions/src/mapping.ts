/**
 * Raw-to-normalized mapping (FR-11; API-SPEC `POST /imports/{importId}/mapping`; TDD.md 13.4-5).
 *
 * A mapping is the reviewer's typed statement of how a sanitized trace becomes a regression:
 * run-operation lineage across the four phases, the scenario timeline, expected and forbidden
 * behavior, evidence limits, required effect sinks/hooks with the coverage basis and its
 * limitations, and provenance. RouteSpec can propose one (`proposeMapping`) but a proposal is
 * non-authoritative; only `validateMapping` decides whether a mapping is acceptable, and it
 * compares every claim with the trace itself:
 * - phases must be exactly the trace's phases (typed lineage, no invented operations);
 * - the scenario's request steps must reproduce the observed exchange sequence;
 * - evidence limits may not be weakened below PROVEN in an accepted scope;
 * - a leg the trace shows as not visible cannot become visible proof;
 * - imported self-reports or inventory can never become independent boundary proof;
 * - disputed evidence can only become a disputed ambiguity case that expects REVIEW;
 * - an issue-derived, not reproduced case can never assert successful settlement.
 * Mapping never executes code or fetches anything: it is data compiled by the M03 compiler.
 */
import {
  EFFECT_COVERAGE_BASES,
  ONECLICK_PROFILE_ID,
  PROVENANCE_CLASSES,
  type EffectCoverageBasis,
  type ProvenanceClass,
  z,
} from '@routespec/contracts';
import {
  GroundTruthEvent,
  ScenarioSource,
  Step,
  compileScenario,
  type CompiledPlan,
  type CompiledScenario,
  type CompiledStep,
} from '@routespec/scenario';
import type { TraceDocument } from './trace.ts';

export const MAPPING_SCHEMA = 'routespec.import-mapping/1' as const;

export const COVERAGE_LIMITATIONS = Object.freeze([
  'DECLARED_HOOKS_ONLY',
  'NO_INDEPENDENT_BOUNDARY_OBSERVATION',
  'SUBJECT_REPORTED_ONLY',
  'IMPORTED_OBSERVATIONS_NOT_INDEPENDENT',
  'PROCESS_TREE_NOT_CONFINED',
  'PRIVATE_LEG_NOT_VISIBLE',
  'DISPUTED_GROUND_TRUTH',
] as const);
export type CoverageLimitation = (typeof COVERAGE_LIMITATIONS)[number];

const Seq = z.number().int().min(0);
const Id = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const InvariantId = z.string().regex(/^INV-(0[1-9]|1[0-2])$/);
const Text = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), 'control characters are not permitted');

export const Mapping = z
  .object({
    mappingSchema: z.literal(MAPPING_SCHEMA),
    scenario: z
      .object({
        scenarioId: z.string().regex(/^regression-[a-z0-9][a-z0-9-]{2,51}$/),
        title: Text(200),
        seed: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
        initialState: ScenarioSource.shape.initialState,
        operationTemplate: ScenarioSource.shape.operationTemplate,
        steps: z.array(Step).min(1).max(256),
        groundTruthEvents: z.array(GroundTruthEvent).max(64),
      })
      .strict(),
    operations: z
      .array(
        z
          .object({
            ref: z.string().regex(/^op-[0-9]{1,6}$/),
            logicalJobRef: z.string().regex(/^job-[0-9]{1,6}$/),
            phases: z
              .object({
                quoteRequest: Seq.nullable(),
                quoteFinalization: Seq.nullable(),
                commitMutation: Seq.nullable(),
                readOnlyReconciliation: z.array(Seq).max(256),
              })
              .strict(),
            lineage: z.literal('PROMOTED_FROM'),
          })
          .strict(),
      )
      .max(64),
    expected: ScenarioSource.shape.expectedOutcomes,
    forbiddenBehaviors: ScenarioSource.shape.forbiddenBehaviors,
    requiredEvidence: ScenarioSource.shape.requiredEvidence,
    requiredInvariants: z.array(InvariantId).min(1).max(12),
    effectCoverage: z
      .object({
        requiredSinkClasses: z.array(Id).max(16),
        requiredHooks: z.array(Id).max(32),
        basis: z.enum(EFFECT_COVERAGE_BASES),
        limitations: z.array(z.enum(COVERAGE_LIMITATIONS)).max(16),
      })
      .strict(),
    provenance: z
      .object({
        class: z.enum(PROVENANCE_CLASSES),
        locator: Text(256).nullable(),
        notes: Text(1024).nullable(),
      })
      .strict(),
  })
  .strict();
export type Mapping = z.infer<typeof Mapping>;

export interface MappingIssue {
  readonly code: string;
  readonly path: string;
}

const SUBJECT_FACT: Readonly<Record<string, string>> = Object.freeze({
  origin_debit: 'ORIGIN_DEPOSIT',
  destination_credit: 'DESTINATION_CREDIT',
  refund_settlement: 'REFUND',
  origin_fee: 'ORIGIN_FEE',
  locked_value: 'LOCKED_VALUE',
  effect_completion: 'EFFECT_COMPLETION_ACCEPTED',
});

const BASIS_RANK: Readonly<Record<EffectCoverageBasis, number>> = Object.freeze({
  DECLARED_HOOKS_ONLY: 0,
  TRUSTED_BUILD_INVENTORY_PLUS_INTERCEPT: 1,
  INDEPENDENT_BOUNDARY_INTERCEPT: 2,
});

const ACCEPTED_SCOPES = new Set(['SIMULATED_GROUND_TRUTH', 'PUBLIC_CHAIN_OBSERVATION']);

/** The four-phase lineage the trace itself shows for each run operation. */
export function tracePhases(trace: TraceDocument): Mapping['operations'] {
  return trace.operations.map((op) => {
    const ex = trace.exchanges.filter((x) => x.operationRef === op.ref);
    const finalized = trace.events.find((e) => e.operationRef === op.ref && e.kind === 'QUOTE_FINALIZED');
    return {
      ref: op.ref,
      logicalJobRef: op.logicalJobRef,
      phases: {
        quoteRequest: ex.find((x) => x.route === 'QUOTE')?.sequence ?? null,
        quoteFinalization: finalized?.sequence ?? null,
        commitMutation: ex.find((x) => x.route === 'COMMIT')?.sequence ?? null,
        readOnlyReconciliation: ex.filter((x) => x.route === 'STATUS').map((x) => x.sequence),
      },
      lineage: 'PROMOTED_FROM' as const,
    };
  });
}

function notVisibleSubjects(trace: TraceDocument): Set<string> {
  return new Set(
    trace.evidence
      .filter((e) => e.evidenceScope === 'PRIVATE_NOT_VISIBLE' || e.reasons.includes('NOT_VISIBLE'))
      .map((e) => e.subject),
  );
}

/** True when the trace carries contradictory or explicitly disputed evidence. */
export function traceIsDisputed(trace: TraceDocument): boolean {
  if (trace.annotations.disputed) return true;
  if (trace.evidence.some((e) => e.reasons.includes('CONTRADICTORY'))) return true;
  const hidden = notVisibleSubjects(trace);
  return trace.evidence.some(
    (e) => hidden.has(e.subject) && e.evidenceClass === 'PROVEN' && ACCEPTED_SCOPES.has(e.evidenceScope),
  );
}

export function validateMapping(
  trace: TraceDocument,
  origin: 'INSTALLED_ARTIFACT_CAPTURE' | 'USER_FILE',
  input: unknown,
): { mapping: Mapping | null; issues: MappingIssue[] } {
  const parsed = Mapping.safeParse(input);
  if (!parsed.success) {
    return {
      mapping: null,
      issues: parsed.error.issues.slice(0, 16).map((i) => ({
        code: 'MAPPING_SCHEMA_INVALID',
        path: `$.${i.path.map(String).join('.')}`.replace(/[^A-Za-z0-9_.[\]-]/g, '_').slice(0, 240),
      })),
    };
  }
  const m = parsed.data;
  const issues: MappingIssue[] = [];
  const issue = (code: string, path: string) => issues.push({ code, path });

  // 1. Typed four-phase run-operation lineage must be exactly the trace's.
  const expectedOps = tracePhases(trace);
  if (JSON.stringify(expectedOps) !== JSON.stringify(m.operations))
    issue('OPERATION_LINEAGE_MISMATCH', '$.operations');

  // 2. Request steps must reproduce the observed exchange sequence (a prefix of the timeline).
  const requestSteps = m.scenario.steps.filter((s) =>
    ['respond', 'drop_response', 'connection_barrier', 'transport_error'].includes(s.type),
  ) as Array<Extract<Step, { match: unknown }>>;
  trace.exchanges.forEach((ex, i) => {
    const st = requestSteps[i];
    const kindOk =
      st !== undefined &&
      (ex.outcome === 'RESPONSE_LOST' ? st.type === 'drop_response' : st.type === 'respond');
    if (!st || st.match.route !== ex.route || !kindOk)
      issue('STEPS_DIVERGE_FROM_TRACE', `$.scenario.steps[${i}]`);
  });

  // 3. Evidence limits can never be weakened below PROVEN in an accepted scope.
  m.requiredEvidence.forEach((r, i) => {
    if ((r.classes ?? ['PROVEN']).some((c) => c !== 'PROVEN'))
      issue('EVIDENCE_LIMIT_WEAKENED', `$.requiredEvidence[${i}].classes`);
    if ((r.scopes ?? []).some((s) => !ACCEPTED_SCOPES.has(s)))
      issue('EVIDENCE_LIMIT_WEAKENED', `$.requiredEvidence[${i}].scopes`);
  });

  // 4. A leg the trace shows as not visible cannot be promoted to visible proof.
  const hidden = notVisibleSubjects(trace);
  const hiddenFacts = new Set(
    [...hidden].map((s) => SUBJECT_FACT[s]).filter((f): f is string => f !== undefined),
  );
  m.scenario.groundTruthEvents.forEach((ev, i) => {
    if (hiddenFacts.has(ev.fact) && (ev.visibility ?? 'VISIBLE') !== 'PRIVATE') {
      issue('VISIBILITY_UPGRADE', `$.scenario.groundTruthEvents[${i}].visibility`);
    }
  });
  if (hiddenFacts.size > 0 && !m.effectCoverage.limitations.includes('PRIVATE_LEG_NOT_VISIBLE')) {
    issue('LIMITATION_MISSING', '$.effectCoverage.limitations');
  }

  // 5. Coverage basis can never exceed what the trace independently shows.
  const cov = m.effectCoverage;
  const need = (l: CoverageLimitation) => {
    if (!cov.limitations.includes(l)) issue('LIMITATION_MISSING', '$.effectCoverage.limitations');
  };
  if (origin === 'USER_FILE') {
    if (cov.basis !== 'DECLARED_HOOKS_ONLY') issue('COVERAGE_UPGRADE', '$.effectCoverage.basis');
    if (trace.boundaryObservations.length > 0) need('IMPORTED_OBSERVATIONS_NOT_INDEPENDENT');
  } else {
    const observed = trace.identity?.coverageBasis ?? 'DECLARED_HOOKS_ONLY';
    if (BASIS_RANK[cov.basis] > BASIS_RANK[observed]) issue('COVERAGE_UPGRADE', '$.effectCoverage.basis');
    if (cov.basis !== 'DECLARED_HOOKS_ONLY' && trace.boundaryObservations.length === 0) {
      issue('COVERAGE_UPGRADE', '$.effectCoverage.basis');
    }
  }
  if (cov.basis === 'DECLARED_HOOKS_ONLY') need('DECLARED_HOOKS_ONLY');
  if (trace.boundaryObservations.length === 0) need('NO_INDEPENDENT_BOUNDARY_OBSERVATION');
  if (trace.subjectReports.length > 0 && cov.basis === 'DECLARED_HOOKS_ONLY') need('SUBJECT_REPORTED_ONLY');

  // 6. Provenance rules.
  const prov: ProvenanceClass = m.provenance.class;
  const disputed = traceIsDisputed(trace);
  const visibleCredit = m.scenario.groundTruthEvents.some(
    (e) => e.fact === 'DESTINATION_CREDIT' && (e.visibility ?? 'VISIBLE') === 'VISIBLE',
  );
  if (disputed && prov !== 'DISPUTED_AMBIGUITY_CASE')
    issue('DISPUTE_REQUIRES_AMBIGUITY_CASE', '$.provenance.class');
  if (prov === 'DISPUTED_AMBIGUITY_CASE') {
    need('DISPUTED_GROUND_TRUTH');
    if (visibleCredit) issue('DISPUTED_GROUND_TRUTH_ASSERTED', '$.scenario.groundTruthEvents');
    for (const [inv, verdict] of Object.entries(m.expected.invariants ?? {})) {
      if (verdict !== 'REVIEW') issue('DISPUTED_VERDICT_ASSERTED', `$.expected.invariants.${inv}`);
    }
    if (
      m.expected.normalizedOutcome === 'SUCCESS_PROVEN' ||
      m.expected.normalizedOutcome === 'REFUND_PROVEN'
    ) {
      issue('DISPUTED_GROUND_TRUTH_ASSERTED', '$.expected.normalizedOutcome');
    }
    if (!m.requiredEvidence.some((r) => r.predicate === 'DESTINATION_CREDIT')) {
      issue('DISPUTED_EVIDENCE_REQUIREMENT_MISSING', '$.requiredEvidence');
    }
  }
  if (prov === 'ISSUE_DERIVED_NOT_REPRODUCED') {
    if (visibleCredit) issue('SETTLEMENT_ASSERTED', '$.scenario.groundTruthEvents');
    if (m.expected.terminalStatus === 'SUCCESS') issue('SETTLEMENT_ASSERTED', '$.expected.terminalStatus');
    if (m.expected.normalizedOutcome?.startsWith('SUCCESS'))
      issue('SETTLEMENT_ASSERTED', '$.expected.normalizedOutcome');
    for (const fb of ['SECOND_COMMIT_UNDER_UNCERTAINTY', 'EFFECT_RELEASE_BEFORE_COMPLETION'] as const) {
      if (!m.forbiddenBehaviors.includes(fb)) issue('FORBIDDEN_BEHAVIOR_MISSING', '$.forbiddenBehaviors');
    }
    if (m.provenance.locator === null) issue('PROVENANCE_LOCATOR_MISSING', '$.provenance.locator');
  }
  if (prov === 'INDEPENDENTLY_REPRODUCED' && origin !== 'INSTALLED_ARTIFACT_CAPTURE') {
    issue('REPRODUCTION_CLAIM_UNSUPPORTED', '$.provenance.class');
  }
  if (prov === 'SYNTHETIC' || prov === 'OFFICIAL_SPEC_DERIVED') {
    // A trace is observed data: it is never synthetic or spec-derived by itself.
    issue('PROVENANCE_NOT_APPLICABLE', '$.provenance.class');
  }
  return { mapping: m, issues };
}

function sourceStep(st: CompiledStep): Step {
  const match = (m: {
    route: 'QUOTE' | 'COMMIT' | 'STATUS';
    fields: Readonly<Record<string, string | number | boolean>>;
  }) => (Object.keys(m.fields).length > 0 ? { route: m.route, fields: { ...m.fields } } : { route: m.route });
  switch (st.type) {
    case 'respond':
      return {
        id: st.id,
        type: 'respond',
        match: match(st.match),
        ...(st.delayMs > 0 ? { delayMs: st.delayMs } : {}),
        ...(st.status !== null ? { status: st.status } : {}),
      };
    case 'drop_response':
      return { id: st.id, type: 'drop_response', match: match(st.match) };
    case 'connection_barrier':
      return {
        id: st.id,
        type: 'connection_barrier',
        match: match(st.match),
        ...(st.releaseOn !== null ? { releaseOn: { route: st.releaseOn } } : {}),
      };
    case 'transport_error':
      return { id: st.id, type: 'transport_error', match: match(st.match), error: st.error };
    case 'assert_request':
      return { id: st.id, type: 'assert_request', match: match(st.match) };
    case 'delay_virtual':
      return { id: st.id, type: 'delay_virtual', ms: st.ms };
    case 'provider_status':
      return { id: st.id, type: 'provider_status', status: st.status };
    case 'ground_truth':
      return { id: st.id, type: 'ground_truth', event: st.event };
    case 'duplicate':
      return { id: st.id, type: 'duplicate', of: st.of };
    case 'reorder':
      return { id: st.id, type: 'reorder', statuses: [...st.statuses] };
    case 'late_success':
      return { id: st.id, type: 'late_success', afterMs: st.afterMs };
    case 'incomplete_deposit':
      return { id: st.id, type: 'incomplete_deposit', event: st.event };
    case 'refund':
      return { id: st.id, type: 'refund', event: st.event };
    case 'end':
      return { id: st.id, type: 'end' };
  }
}

function limitationsFor(
  trace: TraceDocument,
  basis: EffectCoverageBasis,
  disputed: boolean,
): CoverageLimitation[] {
  const out = new Set<CoverageLimitation>();
  if (basis === 'DECLARED_HOOKS_ONLY') out.add('DECLARED_HOOKS_ONLY');
  if (trace.boundaryObservations.length === 0) out.add('NO_INDEPENDENT_BOUNDARY_OBSERVATION');
  if (trace.subjectReports.length > 0 && basis === 'DECLARED_HOOKS_ONLY') out.add('SUBJECT_REPORTED_ONLY');
  if (trace.origin === 'USER_FILE' && trace.boundaryObservations.length > 0) {
    out.add('IMPORTED_OBSERVATIONS_NOT_INDEPENDENT');
  }
  if (notVisibleSubjects(trace).size > 0) out.add('PRIVATE_LEG_NOT_VISIBLE');
  if (disputed) out.add('DISPUTED_GROUND_TRUTH');
  // Only an installed capture whose journal shows every interceptor instance confining the
  // subject's process tree (M14) drops this limitation; imported files never do.
  if (
    trace.origin !== 'INSTALLED_ARTIFACT_CAPTURE' ||
    trace.identity?.processTreeContainment !== 'PROCESS_TREE_ENFORCED'
  )
    out.add('PROCESS_TREE_NOT_CONFINED');
  return [...out].sort();
}

/**
 * Provenance of a trace mapped onto its source scenario. A trace is observed data, so it is never
 * `SYNTHETIC` or spec-derived even when its source schedule is: an installed capture of such a
 * schedule is the installed artifact reproducing the behaviour under RouteSpec
 * (`INDEPENDENTLY_REPRODUCED`, which only an installed capture may claim); anything else is a
 * customer-provided trace. Issue-derived and other observed classes pass through unchanged.
 */
function traceProvenance(source: ProvenanceClass, origin: TraceDocument['origin']): ProvenanceClass {
  if (source !== 'SYNTHETIC' && source !== 'OFFICIAL_SPEC_DERIVED') return source;
  return origin === 'INSTALLED_ARTIFACT_CAPTURE' ? 'INDEPENDENTLY_REPRODUCED' : 'CUSTOMER_PROVIDED_REDACTED';
}

/**
 * Non-authoritative mapping proposal. For an installed capture the timeline comes from the exact
 * scenario revision the capture is bound to; for a user file it is reconstructed from the trace.
 */
export function proposeMapping(input: {
  trace: TraceDocument;
  sourcePlan: CompiledPlan | null;
  requiredInvariants: readonly string[];
  requiredSinkClasses?: readonly string[];
  requiredHooks?: readonly string[];
}): Mapping {
  const { trace, sourcePlan } = input;
  const disputed = traceIsDisputed(trace);
  const basis: EffectCoverageBasis =
    trace.origin === 'INSTALLED_ARTIFACT_CAPTURE' && trace.boundaryObservations.length > 0
      ? (trace.identity?.coverageBasis ?? 'DECLARED_HOOKS_ONLY')
      : 'DECLARED_HOOKS_ONLY';
  const hidden = new Set(
    [...notVisibleSubjects(trace)].map((s) => SUBJECT_FACT[s]).filter((f): f is string => f !== undefined),
  );
  let scenario: Mapping['scenario'];
  let expected: Mapping['expected'];
  let forbidden: Mapping['forbiddenBehaviors'];
  let requiredEvidence: Mapping['requiredEvidence'];
  let provenance: Mapping['provenance'];
  if (sourcePlan !== null) {
    const p = sourcePlan;
    scenario = {
      scenarioId: `regression-${p.scenarioId}`.slice(0, 63).replace(/-+$/, ''),
      title: `Regression: ${p.title}`.slice(0, 200),
      seed: p.seed,
      initialState: {
        virtualStartMs: p.initialState.virtualStartMs,
        clientClock: p.initialState.clientClock,
        providerStatus: p.initialState.providerStatus,
        statusPollIntervalMs: p.initialState.statusPollIntervalMs,
      },
      operationTemplate: {
        originAsset: p.operationTemplate.originAsset,
        destinationAsset: p.operationTemplate.destinationAsset,
        amountIn: p.operationTemplate.amountIn,
        amountOut: p.operationTemplate.amountOut,
        minAmountOut: p.operationTemplate.minAmountOut,
        ...(p.operationTemplate.recipient !== null ? { recipient: p.operationTemplate.recipient } : {}),
        ...(p.operationTemplate.refundTo !== null ? { refundTo: p.operationTemplate.refundTo } : {}),
        timeEstimateSec: p.operationTemplate.timeEstimateSec,
        ...(p.operationTemplate.refundFee !== null ? { refundFee: p.operationTemplate.refundFee } : {}),
        ...(p.operationTemplate.withdrawFee !== null ? { withdrawFee: p.operationTemplate.withdrawFee } : {}),
        maxLogicalJobs: p.operationTemplate.maxLogicalJobs,
      },
      steps: p.steps.map(sourceStep),
      groundTruthEvents: p.groundTruthEvents.map((e) => ({
        id: e.id,
        fact: e.fact,
        ...(e.assetId !== null ? { assetId: e.assetId } : {}),
        ...(e.amount !== null ? { amount: e.amount } : {}),
        ...(e.recipient !== null ? { recipient: e.recipient } : {}),
        visibility: hidden.has(e.fact) ? 'PRIVATE' : e.visibility,
        singleUse: e.singleUse,
      })),
    };
    expected = {
      terminalStatus: p.expectedOutcomes.terminalStatus,
      normalizedOutcome: p.expectedOutcomes.normalizedOutcome,
      invariants: { ...p.expectedOutcomes.invariants },
    };
    forbidden = [...p.forbiddenBehaviors] as Mapping['forbiddenBehaviors'];
    requiredEvidence = p.requiredEvidence.map((r) => ({
      predicate: r.predicate as Mapping['requiredEvidence'][number]['predicate'],
      classes: [...r.classes],
      scopes: [...r.scopes],
    }));
    provenance = {
      class: disputed ? 'DISPUTED_AMBIGUITY_CASE' : traceProvenance(p.sourceProvenance.class, trace.origin),
      locator: p.sourceProvenance.locator,
      notes: null,
    };
  } else {
    const firstQuote = trace.exchanges.find((x) => x.route === 'QUOTE')?.material ?? {};
    const steps: Step[] = [];
    let lastStatus: string | null = null;
    trace.exchanges.forEach((ex, i) => {
      if (ex.route === 'STATUS' && ex.observedRawStatus !== null && ex.observedRawStatus !== lastStatus) {
        steps.push({ id: `provider-status-${i}`, type: 'provider_status', status: ex.observedRawStatus });
        lastStatus = ex.observedRawStatus;
      }
      steps.push({
        id: `${ex.route.toLowerCase()}-${i}`,
        type: ex.outcome === 'RESPONSE_LOST' ? 'drop_response' : 'respond',
        match: { route: ex.route },
      });
    });
    steps.push({ id: 'end', type: 'end' });
    const amount = typeof firstQuote['amount'] === 'string' ? firstQuote['amount'] : '1';
    scenario = {
      scenarioId: 'regression-imported-trace',
      title: (trace.annotations.title ?? 'Imported trace')
        .slice(0, 200)
        .replace(/[\u0000-\u001f\u007f]/g, ' '),
      seed: 'imported-trace',
      initialState: { clientClock: 'INJECTED' },
      operationTemplate: {
        originAsset: String(firstQuote['originAsset'] ?? 'unresolved'),
        destinationAsset: String(firstQuote['destinationAsset'] ?? 'unresolved'),
        amountIn: amount,
        amountOut: amount,
        minAmountOut: amount,
        ...(typeof firstQuote['recipient'] === 'string' ? { recipient: firstQuote['recipient'] } : {}),
        ...(typeof firstQuote['refundTo'] === 'string' ? { refundTo: firstQuote['refundTo'] } : {}),
      },
      steps,
      groundTruthEvents: [],
    };
    expected = { terminalStatus: null, normalizedOutcome: null, invariants: {} };
    forbidden = ['SECOND_COMMIT_UNDER_UNCERTAINTY'];
    requiredEvidence = [];
    provenance = {
      class: disputed ? 'DISPUTED_AMBIGUITY_CASE' : 'CUSTOMER_PROVIDED_REDACTED',
      locator: null,
      notes: null,
    };
  }
  return {
    mappingSchema: MAPPING_SCHEMA,
    scenario,
    operations: tracePhases(trace),
    expected,
    forbiddenBehaviors: forbidden,
    requiredEvidence,
    requiredInvariants: [...input.requiredInvariants],
    effectCoverage: {
      requiredSinkClasses: [...(input.requiredSinkClasses ?? [])],
      requiredHooks: [...(input.requiredHooks ?? [])],
      basis,
      limitations: limitationsFor(trace, basis, disputed),
    },
    provenance,
  };
}

/** The scenario source a mapping produces; the locator binds it to its import. */
export function scenarioSourceFromMapping(mapping: Mapping, importId: string): ScenarioSource {
  const locator = `routespec-import:${importId}${mapping.provenance.locator ? ` source:${mapping.provenance.locator}` : ''}`;
  return {
    schemaVersion: '1.0',
    scenarioId: mapping.scenario.scenarioId,
    revisionLabel: `import-${importId.slice(0, 8)}`,
    title: mapping.scenario.title,
    protocolProfile: ONECLICK_PROFILE_ID,
    seed: mapping.scenario.seed,
    initialState: mapping.scenario.initialState,
    operationTemplate: mapping.scenario.operationTemplate,
    steps: mapping.scenario.steps,
    groundTruthEvents: mapping.scenario.groundTruthEvents,
    expectedOutcomes: mapping.expected,
    forbiddenBehaviors: mapping.forbiddenBehaviors,
    requiredEvidence: mapping.requiredEvidence,
    resourceBudget: {},
    sourceProvenance: {
      class: mapping.provenance.class,
      locator: locator.slice(0, 512),
      ...(mapping.provenance.notes !== null ? { notes: mapping.provenance.notes } : {}),
    },
  };
}

export function compileMapping(mapping: Mapping, importId: string): CompiledScenario {
  return compileScenario(scenarioSourceFromMapping(mapping, importId), { format: 'json' });
}
