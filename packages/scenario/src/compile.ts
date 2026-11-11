/**
 * Scenario compiler (FR-05, TDD.md section 6, DATA-MODEL.md "Scenario revision digest").
 *
 * Pipeline: bounded data-only parse -> declared major version check -> strict schema (unknown
 * fields rejected, executable-looking fields reported as unsafe) -> semantic checks (unique ids,
 * resolvable references, amount constraints, budgets) -> explicit defaults -> canonical JSON ->
 * immutable revision digest + static route/step plan.
 *
 * The digest is computed exactly as the journal computes `scenario_revisions.revision_digest`
 * (`routespec.scenario-revision/1` over schema version, compiled plan, seed, resource budget,
 * provenance class, and compiler revision), so a compiled scenario and its stored revision
 * share one identity.
 */
import {
  ONECLICK_PROFILE,
  RouteSpecError,
  canonicalJson,
  digestValue,
  type Digest,
  type EvidenceClass,
  type EvidenceScope,
  type NormalizedFact,
  type ProvenanceClass,
  type RawProviderStatus,
  type Verdict,
} from '@routespec/contracts';
import { DEFAULT_BUDGET, limitExceeded, resolveBudget, type ResourceBudget } from './budget.ts';
import { parseScenarioSource, type ParseLimits, type SourceFormat } from './parse.ts';
import {
  REQUEST_STEP_TYPES,
  SCENARIO_SCHEMA_VERSION,
  ScenarioSource,
  type GroundTruthFact,
  type ScenarioRoute,
  type Step,
} from './schema.ts';

export const COMPILER_REVISION = 'routespec-scenario-compiler@1.0.0' as const;
export const COMPILED_SCHEMA_VERSION = '1.0' as const;

export const ROUTE_BINDINGS: Readonly<
  Record<ScenarioRoute, { method: 'GET' | 'POST'; path: string; phases: readonly string[] }>
> = Object.freeze({
  QUOTE: { method: 'POST', path: '/v0/quote', phases: ['QUOTE_REQUEST', 'QUOTE_FINALIZATION'] },
  COMMIT: { method: 'POST', path: '/v0/deposit/submit', phases: ['COMMIT_MUTATION'] },
  STATUS: { method: 'GET', path: '/v0/status', phases: ['READ_ONLY_RECONCILIATION'] },
});

const EXECUTABLE_KEY =
  /^(script|scripts|exec|execute|command|cmd|shell|eval|code|function|fn|callback|hook|import|require|module|url|href|uri|fetch|file|filename|path|include|regex|regexp|pattern|template|run)$/i;

export interface CompiledMatch {
  readonly route: ScenarioRoute;
  readonly fields: Readonly<Record<string, string | number | boolean>>;
}

export type CompiledStep =
  | {
      readonly ordinal: number;
      readonly id: string;
      readonly type: 'respond';
      readonly match: CompiledMatch;
      readonly delayMs: number;
      readonly status: string | null;
    }
  | {
      readonly ordinal: number;
      readonly id: string;
      readonly type: 'drop_response';
      readonly match: CompiledMatch;
    }
  | {
      readonly ordinal: number;
      readonly id: string;
      readonly type: 'connection_barrier';
      readonly match: CompiledMatch;
      readonly releaseOn: ScenarioRoute | null;
    }
  | {
      readonly ordinal: number;
      readonly id: string;
      readonly type: 'transport_error';
      readonly match: CompiledMatch;
      readonly error: 'CONNECTION_RESET';
    }
  | { readonly ordinal: number; readonly id: string; readonly type: 'delay_virtual'; readonly ms: number }
  | {
      readonly ordinal: number;
      readonly id: string;
      readonly type: 'provider_status';
      readonly status: string;
    }
  | { readonly ordinal: number; readonly id: string; readonly type: 'ground_truth'; readonly event: string }
  | {
      readonly ordinal: number;
      readonly id: string;
      readonly type: 'assert_request';
      readonly match: CompiledMatch;
    }
  | {
      readonly ordinal: number;
      readonly id: string;
      readonly type: 'duplicate';
      readonly of: 'LAST_GROUND_TRUTH' | 'LAST_PROVIDER_STATUS';
    }
  | {
      readonly ordinal: number;
      readonly id: string;
      readonly type: 'reorder';
      readonly statuses: readonly string[];
    }
  | { readonly ordinal: number; readonly id: string; readonly type: 'late_success'; readonly afterMs: number }
  | {
      readonly ordinal: number;
      readonly id: string;
      readonly type: 'incomplete_deposit';
      readonly event: string;
    }
  | { readonly ordinal: number; readonly id: string; readonly type: 'refund'; readonly event: string }
  | { readonly ordinal: number; readonly id: string; readonly type: 'end' };

export interface CompiledGroundTruthEvent {
  readonly id: string;
  readonly fact: GroundTruthFact;
  readonly assetId: string | null;
  readonly amount: string | null;
  readonly recipient: string | null;
  readonly visibility: 'VISIBLE' | 'PRIVATE';
  readonly singleUse: boolean;
}

export interface CompiledPlan {
  readonly compiledSchemaVersion: typeof COMPILED_SCHEMA_VERSION;
  readonly compilerRevision: typeof COMPILER_REVISION;
  readonly sourceSchemaVersion: typeof SCENARIO_SCHEMA_VERSION;
  readonly scenarioId: string;
  readonly revisionLabel: string;
  readonly title: string;
  readonly protocolProfile: string;
  readonly protocolProfileIntegrityDigest: string;
  readonly seed: string;
  readonly initialState: {
    readonly virtualStartMs: number;
    readonly clientClock: 'INJECTED' | 'EXTERNAL_WALL';
    readonly providerStatus: string;
    readonly statusPollIntervalMs: number;
  };
  readonly operationTemplate: {
    readonly originAsset: string;
    readonly destinationAsset: string;
    readonly amountIn: string;
    readonly amountOut: string;
    readonly minAmountOut: string;
    readonly recipient: string | null;
    readonly refundTo: string | null;
    readonly timeEstimateSec: number;
    readonly refundFee: string | null;
    readonly withdrawFee: string | null;
    readonly maxLogicalJobs: number;
  };
  readonly steps: readonly CompiledStep[];
  readonly groundTruthEvents: readonly CompiledGroundTruthEvent[];
  readonly expectedOutcomes: {
    readonly terminalStatus: RawProviderStatus | null;
    readonly normalizedOutcome: NormalizedFact | null;
    readonly invariants: Readonly<Record<string, Verdict>>;
  };
  readonly forbiddenBehaviors: readonly string[];
  readonly requiredEvidence: ReadonlyArray<{
    readonly predicate: string;
    readonly classes: readonly EvidenceClass[];
    readonly scopes: readonly EvidenceScope[];
  }>;
  readonly resourceBudget: ResourceBudget;
  readonly sourceProvenance: {
    readonly class: ProvenanceClass;
    readonly locator: string | null;
    readonly notes: string | null;
  };
  /** Static route/step plan: every request-consuming step with its enumerated method/path. */
  readonly routePlan: ReadonlyArray<{
    readonly stepId: string;
    readonly ordinal: number;
    readonly type: string;
    readonly method: 'GET' | 'POST';
    readonly path: string;
    readonly phases: readonly string[];
    readonly fields: Readonly<Record<string, string | number | boolean>>;
  }>;
  readonly totalDeclaredVirtualMs: number;
}

export interface CompiledScenario {
  readonly plan: CompiledPlan;
  /** Canonical JSON of the compiled plan (sorted keys, no whitespace). */
  readonly canonicalJson: string;
  readonly revisionDigest: Digest;
  /** The exact input the journal uses for `createScenarioRevision`. */
  readonly revisionInput: {
    readonly scenarioStableId: string;
    readonly schemaVersion: string;
    readonly compiled: CompiledPlan;
    readonly seed: string;
    readonly resourceBudget: ResourceBudget;
    readonly provenanceClass: ProvenanceClass;
    readonly compilerRevision: string;
  };
}

export interface CompileOptions {
  readonly format?: SourceFormat;
  /** Pre-parse limits (before the declared budget is known). Defaults to DEFAULT_BUDGET. */
  readonly parseLimits?: Partial<ParseLimits>;
}

function invalid(reason: string, details: Record<string, string | number | readonly string[]> = {}): never {
  throw new RouteSpecError('RS_SCENARIO_INVALID', 'Scenario failed strict validation.', {
    details: { reason, ...details },
  });
}

function scanExecutableKeys(value: unknown, path: string, out: string[]): void {
  if (out.length >= 8) return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => scanExecutableKeys(v, `${path}[${i}]`, out));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // `match.fields` keys are profile field names and are validated separately.
      if (EXECUTABLE_KEY.test(k) && !path.endsWith('.fields')) out.push(`${path}.${k}`);
      scanExecutableKeys(v, `${path}.${k}`, out);
    }
  }
}

function compileMatch(m: {
  route: ScenarioRoute;
  fields?: Record<string, string | number | boolean> | undefined;
}): CompiledMatch {
  const fields: Record<string, string | number | boolean> = {};
  for (const key of Object.keys(m.fields ?? {}).sort())
    fields[key] = (m.fields as Record<string, string | number | boolean>)[key] as string | number | boolean;
  return { route: m.route, fields };
}

function compileStep(step: Step, ordinal: number): CompiledStep {
  switch (step.type) {
    case 'respond':
      return {
        ordinal,
        id: step.id,
        type: 'respond',
        match: compileMatch(step.match),
        delayMs: step.delayMs ?? 0,
        status: step.status ?? null,
      };
    case 'drop_response':
      return { ordinal, id: step.id, type: 'drop_response', match: compileMatch(step.match) };
    case 'connection_barrier':
      return {
        ordinal,
        id: step.id,
        type: 'connection_barrier',
        match: compileMatch(step.match),
        releaseOn: step.releaseOn?.route ?? null,
      };
    case 'transport_error':
      return {
        ordinal,
        id: step.id,
        type: 'transport_error',
        match: compileMatch(step.match),
        error: step.error ?? 'CONNECTION_RESET',
      };
    case 'delay_virtual':
      return { ordinal, id: step.id, type: 'delay_virtual', ms: step.ms };
    case 'provider_status':
      return { ordinal, id: step.id, type: 'provider_status', status: step.status };
    case 'ground_truth':
      return { ordinal, id: step.id, type: 'ground_truth', event: step.event };
    case 'assert_request':
      return { ordinal, id: step.id, type: 'assert_request', match: compileMatch(step.match) };
    case 'duplicate':
      return { ordinal, id: step.id, type: 'duplicate', of: step.of };
    case 'reorder':
      return { ordinal, id: step.id, type: 'reorder', statuses: [...step.statuses] };
    case 'late_success':
      return { ordinal, id: step.id, type: 'late_success', afterMs: step.afterMs };
    case 'incomplete_deposit':
      return { ordinal, id: step.id, type: 'incomplete_deposit', event: step.event };
    case 'refund':
      return { ordinal, id: step.id, type: 'refund', event: step.event };
    case 'end':
      return { ordinal, id: step.id, type: 'end' };
  }
}

/** Revision digest exactly as the journal computes it for `scenario_revisions`. */
export function scenarioRevisionDigest(input: CompiledScenario['revisionInput']): Digest {
  return digestValue('routespec.scenario-revision/1', {
    schemaVersion: input.schemaVersion,
    compiled: input.compiled,
    seed: input.seed,
    resourceBudget: input.resourceBudget,
    provenanceClass: input.provenanceClass,
    compilerRevision: input.compilerRevision,
  });
}

export function compileScenario(source: string | unknown, options: CompileOptions = {}): CompiledScenario {
  const limits: ParseLimits = {
    maxSourceBytes: options.parseLimits?.maxSourceBytes ?? DEFAULT_BUDGET.maxSourceBytes,
    maxDepth: options.parseLimits?.maxDepth ?? DEFAULT_BUDGET.maxDepth,
    maxAliases: options.parseLimits?.maxAliases ?? DEFAULT_BUDGET.maxAliases,
    maxStringLength: options.parseLimits?.maxStringLength ?? DEFAULT_BUDGET.maxStringLength,
  };
  let sourceBytes = 0;
  let raw: unknown;
  if (typeof source === 'string') {
    sourceBytes = Buffer.byteLength(source, 'utf8');
    raw = parseScenarioSource(source, options.format ?? 'yaml', limits);
  } else {
    // An already-parsed object is re-serialized and parsed as JSON so the same bounds apply.
    let text: string;
    try {
      text = JSON.stringify(source);
    } catch {
      invalid('not-serializable');
    }
    if (typeof text !== 'string') invalid('not-serializable');
    sourceBytes = Buffer.byteLength(text, 'utf8');
    raw = parseScenarioSource(text, 'json', limits);
  }

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) invalid('root-not-object');
  const version = (raw as Record<string, unknown>)['schemaVersion'];
  if (typeof version !== 'string') invalid('missing-schema-version');
  const [major, minor] = version.split('.');
  if (major !== '1') {
    throw new RouteSpecError(
      'RS_SCHEMA_VERSION_UNSUPPORTED',
      'Scenario schema major version is not supported.',
      {
        details: { schemaVersion: version.slice(0, 16), supported: SCENARIO_SCHEMA_VERSION },
      },
    );
  }
  if (minor !== '0') {
    throw new RouteSpecError(
      'RS_SCHEMA_VERSION_UNSUPPORTED',
      'Scenario schema minor version is newer than this compiler.',
      {
        details: { schemaVersion: version.slice(0, 16), supported: SCENARIO_SCHEMA_VERSION },
      },
    );
  }

  const executable: string[] = [];
  scanExecutableKeys(raw, '$', executable);
  if (executable.length > 0) {
    throw new RouteSpecError(
      'RS_SCENARIO_UNSAFE_CONSTRUCT',
      'Scenario source contains an executable construct.',
      {
        details: { reason: 'executable-field', paths: executable },
      },
    );
  }

  const parsed = ScenarioSource.safeParse(raw);
  if (!parsed.success) {
    const unknown = parsed.error.issues.filter((i) => i.code === 'unrecognized_keys');
    invalid(unknown.length > 0 ? 'unknown-field' : 'schema', {
      issues: parsed.error.issues.slice(0, 8).map((i) => `${i.path.join('.')}: ${i.code}`),
    });
  }
  const s = parsed.data;
  const budget = resolveBudget(s.resourceBudget);
  if (sourceBytes > budget.maxSourceBytes)
    limitExceeded('maxSourceBytes', sourceBytes, budget.maxSourceBytes);
  if (s.steps.length > budget.maxSteps) limitExceeded('maxSteps', s.steps.length, budget.maxSteps);
  if (s.groundTruthEvents.length > budget.maxGroundTruthEvents) {
    limitExceeded('maxGroundTruthEvents', s.groundTruthEvents.length, budget.maxGroundTruthEvents);
  }

  const stepIds = new Set<string>();
  for (const step of s.steps) {
    if (stepIds.has(step.id)) invalid('duplicate-step-id', { stepId: step.id });
    stepIds.add(step.id);
  }
  const events = new Map<string, GroundTruthFact>();
  for (const ev of s.groundTruthEvents) {
    if (events.has(ev.id)) invalid('duplicate-event-id', { eventId: ev.id });
    events.set(ev.id, ev.fact);
    if (ev.amount !== undefined && ev.assetId === undefined)
      invalid('amount-without-asset', { eventId: ev.id });
  }
  const endIndex = s.steps.findIndex((st) => st.type === 'end');
  if (endIndex !== -1 && endIndex !== s.steps.length - 1) invalid('end-not-last');
  if (!s.steps.some((st) => REQUEST_STEP_TYPES.includes(st.type))) invalid('no-request-step');
  let declaredMs = 0;
  for (const step of s.steps) {
    if (step.type === 'ground_truth' && !events.has(step.event))
      invalid('unknown-event', { stepId: step.id });
    if (step.type === 'incomplete_deposit' && events.get(step.event) !== 'ORIGIN_DEPOSIT') {
      invalid('incomplete-deposit-event-kind', { stepId: step.id });
    }
    if (step.type === 'refund' && events.get(step.event) !== 'REFUND')
      invalid('refund-event-kind', { stepId: step.id });
    if (step.type === 'delay_virtual') declaredMs += step.ms;
    if (step.type === 'respond') declaredMs += step.delayMs ?? 0;
    if (step.type === 'late_success') declaredMs += step.afterMs;
  }
  if (declaredMs > budget.maxVirtualDurationMs) {
    limitExceeded('maxVirtualDurationMs', declaredMs, budget.maxVirtualDurationMs);
  }
  const t = s.operationTemplate;
  if (BigInt(t.minAmountOut) > BigInt(t.amountOut)) invalid('min-amount-out-exceeds-amount-out');
  if (BigInt(t.amountIn) === 0n) invalid('zero-amount-in');

  const steps = s.steps.map(compileStep);
  const plan: CompiledPlan = {
    compiledSchemaVersion: COMPILED_SCHEMA_VERSION,
    compilerRevision: COMPILER_REVISION,
    sourceSchemaVersion: SCENARIO_SCHEMA_VERSION,
    scenarioId: s.scenarioId,
    revisionLabel: s.revisionLabel,
    title: s.title,
    protocolProfile: s.protocolProfile,
    protocolProfileIntegrityDigest: ONECLICK_PROFILE.integrityDigest,
    seed: s.seed,
    initialState: {
      virtualStartMs: s.initialState.virtualStartMs ?? 0,
      clientClock: s.initialState.clientClock ?? 'EXTERNAL_WALL',
      providerStatus: s.initialState.providerStatus ?? 'PENDING_DEPOSIT',
      statusPollIntervalMs: s.initialState.statusPollIntervalMs ?? 1000,
    },
    operationTemplate: {
      originAsset: t.originAsset,
      destinationAsset: t.destinationAsset,
      amountIn: t.amountIn,
      amountOut: t.amountOut,
      minAmountOut: t.minAmountOut,
      recipient: t.recipient ?? null,
      refundTo: t.refundTo ?? null,
      timeEstimateSec: t.timeEstimateSec ?? 60,
      refundFee: t.refundFee ?? null,
      withdrawFee: t.withdrawFee ?? null,
      maxLogicalJobs: t.maxLogicalJobs ?? 1,
    },
    steps,
    groundTruthEvents: s.groundTruthEvents.map((ev) => ({
      id: ev.id,
      fact: ev.fact,
      assetId: ev.assetId ?? null,
      amount: ev.amount ?? null,
      recipient: ev.recipient ?? null,
      visibility: ev.visibility ?? 'VISIBLE',
      singleUse: ev.singleUse ?? true,
    })),
    expectedOutcomes: {
      terminalStatus: s.expectedOutcomes.terminalStatus ?? null,
      normalizedOutcome: s.expectedOutcomes.normalizedOutcome ?? null,
      invariants: Object.fromEntries(
        Object.entries(s.expectedOutcomes.invariants ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      ),
    },
    forbiddenBehaviors: [...new Set(s.forbiddenBehaviors)].sort(),
    requiredEvidence: [...s.requiredEvidence]
      .map((r) => ({
        predicate: r.predicate,
        classes: [...new Set(r.classes ?? (['PROVEN'] as EvidenceClass[]))].sort(),
        scopes: [
          ...new Set(r.scopes ?? (['SIMULATED_GROUND_TRUTH', 'PUBLIC_CHAIN_OBSERVATION'] as EvidenceScope[])),
        ].sort(),
      }))
      .sort((a, b) => (a.predicate < b.predicate ? -1 : a.predicate > b.predicate ? 1 : 0)),
    resourceBudget: budget,
    sourceProvenance: {
      class: s.sourceProvenance.class,
      locator: s.sourceProvenance.locator ?? null,
      notes: s.sourceProvenance.notes ?? null,
    },
    routePlan: steps
      .filter(
        (st): st is Extract<CompiledStep, { match: CompiledMatch }> =>
          'match' in st && st.type !== 'assert_request',
      )
      .map((st) => ({
        stepId: st.id,
        ordinal: st.ordinal,
        type: st.type,
        method: ROUTE_BINDINGS[st.match.route].method,
        path: ROUTE_BINDINGS[st.match.route].path,
        phases: ROUTE_BINDINGS[st.match.route].phases,
        fields: st.match.fields,
      })),
    totalDeclaredVirtualMs: declaredMs,
  };
  for (const r of plan.requiredEvidence) {
    if (new Set(plan.requiredEvidence.map((x) => x.predicate)).size !== plan.requiredEvidence.length) {
      invalid('duplicate-required-evidence', { predicate: r.predicate });
    }
  }
  const revisionInput = {
    scenarioStableId: plan.scenarioId,
    schemaVersion: SCENARIO_SCHEMA_VERSION,
    compiled: plan,
    seed: plan.seed,
    resourceBudget: budget,
    provenanceClass: plan.sourceProvenance.class,
    compilerRevision: COMPILER_REVISION,
  };
  return Object.freeze({
    plan,
    canonicalJson: canonicalJson(plan),
    revisionDigest: scenarioRevisionDigest(revisionInput),
    revisionInput,
  });
}
