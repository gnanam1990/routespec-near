/**
 * Strict authoring schema for RouteSpec scenarios, schema version 1.0 (FR-05, TDD.md section 6).
 *
 * Scenario source is untrusted data. Every executable structure is a closed `.strict()` object,
 * so unknown fields such as `script`, `exec`, `command`, `url`, `file`, `callback`, or `regex`
 * are rejected rather than stripped. Steps are a closed discriminated union; request matchers
 * compare enumerated routes and selected profile fields by exact equality only (no regular
 * expressions, no templates, no code). Amounts are base-unit decimal strings.
 */
import {
  CommitRequestMaterial,
  EVIDENCE_CLASSES,
  EVIDENCE_SCOPES,
  NORMALIZED_FACTS,
  ONECLICK_PROFILE_ID,
  PROVENANCE_CLASSES,
  QuoteRequestMaterial,
  RAW_PROVIDER_STATUSES,
  StatusQueryMaterial,
  VERDICTS,
  z,
} from '@routespec/contracts';
import { BUDGET_KEYS, HARD_CAPS } from './budget.ts';

export const SCENARIO_SCHEMA_VERSION = '1.0' as const;

const Amount = z.string().regex(/^(0|[1-9][0-9]{0,77})$/, 'expected base-unit integer string');
const Label = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), 'control characters are not permitted');
const StepId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/, 'expected lowercase step id');
const EventId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/, 'expected lowercase event id');
const Ms = z.number().int().min(0).max(HARD_CAPS.maxVirtualDurationMs);
/** Raw provider status text. Unknown values are allowed so REVIEW behavior can be exercised. */
const RawStatusText = z.string().regex(/^[A-Z][A-Z0-9_]{0,31}$/, 'expected an upper-case status token');

export const SCENARIO_ROUTES = ['QUOTE', 'COMMIT', 'STATUS'] as const;
export type ScenarioRoute = (typeof SCENARIO_ROUTES)[number];

export const ROUTE_FIELDS: Readonly<Record<ScenarioRoute, readonly string[]>> = Object.freeze({
  QUOTE: Object.keys(QuoteRequestMaterial.shape),
  COMMIT: Object.keys(CommitRequestMaterial.shape),
  STATUS: Object.keys(StatusQueryMaterial.shape),
});

const Scalar = z.union([z.string().max(HARD_CAPS.maxStringLength), z.number().int(), z.boolean()]);

export const RequestMatch = z
  .object({
    route: z.enum(SCENARIO_ROUTES),
    /** Exact-equality matchers over selected top-level profile fields of that route. */
    fields: z.record(z.string(), Scalar).optional(),
  })
  .strict()
  .superRefine((m, ctx) => {
    for (const key of Object.keys(m.fields ?? {})) {
      if (!ROUTE_FIELDS[m.route].includes(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['fields', key],
          message: `field is not a ${m.route} profile field`,
        });
      }
    }
    if (Object.keys(m.fields ?? {}).length > 16) {
      ctx.addIssue({ code: 'custom', path: ['fields'], message: 'at most 16 field matchers' });
    }
  });
export type RequestMatch = z.infer<typeof RequestMatch>;

const base = { id: StepId };

export const Step = z.discriminatedUnion('type', [
  z
    .object({
      ...base,
      type: z.literal('respond'),
      match: RequestMatch,
      delayMs: Ms.optional(),
      status: RawStatusText.optional(),
    })
    .strict(),
  z.object({ ...base, type: z.literal('drop_response'), match: RequestMatch }).strict(),
  z
    .object({
      ...base,
      type: z.literal('connection_barrier'),
      match: RequestMatch,
      releaseOn: z
        .object({ route: z.enum(SCENARIO_ROUTES) })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('transport_error'),
      match: RequestMatch,
      error: z.enum(['CONNECTION_RESET']).optional(),
    })
    .strict(),
  z.object({ ...base, type: z.literal('delay_virtual'), ms: Ms }).strict(),
  z.object({ ...base, type: z.literal('provider_status'), status: RawStatusText }).strict(),
  z.object({ ...base, type: z.literal('ground_truth'), event: EventId }).strict(),
  z.object({ ...base, type: z.literal('assert_request'), match: RequestMatch }).strict(),
  z
    .object({
      ...base,
      type: z.literal('duplicate'),
      of: z.enum(['LAST_GROUND_TRUTH', 'LAST_PROVIDER_STATUS']),
    })
    .strict(),
  z.object({ ...base, type: z.literal('reorder'), statuses: z.array(RawStatusText).min(2).max(16) }).strict(),
  z.object({ ...base, type: z.literal('late_success'), afterMs: Ms }).strict(),
  z.object({ ...base, type: z.literal('incomplete_deposit'), event: EventId }).strict(),
  z.object({ ...base, type: z.literal('refund'), event: EventId }).strict(),
  z.object({ ...base, type: z.literal('end') }).strict(),
]);
export type Step = z.infer<typeof Step>;
export type StepType = Step['type'];

export const STEP_TYPES = Object.freeze([
  'respond',
  'drop_response',
  'connection_barrier',
  'transport_error',
  'delay_virtual',
  'provider_status',
  'ground_truth',
  'assert_request',
  'duplicate',
  'reorder',
  'late_success',
  'incomplete_deposit',
  'refund',
  'end',
] as const satisfies readonly StepType[]);

/** Steps that consume one matching client request. All others are timeline steps. */
export const REQUEST_STEP_TYPES: readonly StepType[] = Object.freeze([
  'respond',
  'drop_response',
  'connection_barrier',
  'transport_error',
]);

export const GROUND_TRUTH_FACTS = [
  'ORIGIN_DEPOSIT',
  'DESTINATION_CREDIT',
  'REFUND',
  'ORIGIN_FEE',
  'LOCKED_VALUE',
  'EFFECT_COMPLETION_ACCEPTED',
] as const;
export type GroundTruthFact = (typeof GROUND_TRUTH_FACTS)[number];

export const GroundTruthEvent = z
  .object({
    id: EventId,
    fact: z.enum(GROUND_TRUTH_FACTS),
    assetId: Label(256).optional(),
    amount: Amount.optional(),
    recipient: Label(256).optional(),
    visibility: z.enum(['VISIBLE', 'PRIVATE']).optional(),
    singleUse: z.boolean().optional(),
  })
  .strict();
export type GroundTruthEvent = z.infer<typeof GroundTruthEvent>;

export const FORBIDDEN_BEHAVIORS = [
  'SECOND_COMMIT_UNDER_UNCERTAINTY',
  'COMMIT_WITHOUT_FINALIZATION',
  'QUOTE_MATERIAL_CHANGE',
  'STATUS_FOR_UNBOUND_ADDRESS',
  'EFFECT_RELEASE_BEFORE_COMPLETION',
] as const;

export const EVIDENCE_PREDICATES = [
  'ORIGIN_DEBIT',
  'DESTINATION_CREDIT',
  'REFUND_SETTLEMENT',
  'EFFECT_COMPLETION',
] as const;

const InvariantId = z.string().regex(/^INV-(0[1-9]|1[0-2])$/);

export const ScenarioSource = z
  .object({
    schemaVersion: z.string().regex(/^(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$/),
    scenarioId: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/),
    revisionLabel: Label(64),
    title: Label(200),
    protocolProfile: z.literal(ONECLICK_PROFILE_ID),
    seed: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
    initialState: z
      .object({
        virtualStartMs: Ms.optional(),
        clientClock: z.enum(['INJECTED', 'EXTERNAL_WALL']).optional(),
        providerStatus: RawStatusText.optional(),
        /** Virtual time charged for each unscripted status poll (models polling cadence). */
        statusPollIntervalMs: z.number().int().min(0).max(3_600_000).optional(),
      })
      .strict(),
    operationTemplate: z
      .object({
        originAsset: Label(256),
        destinationAsset: Label(256),
        amountIn: Amount,
        amountOut: Amount,
        minAmountOut: Amount,
        recipient: Label(256).optional(),
        refundTo: Label(256).optional(),
        timeEstimateSec: z.number().int().min(0).max(86_400).optional(),
        refundFee: Amount.optional(),
        withdrawFee: Amount.optional(),
        maxLogicalJobs: z.number().int().min(1).max(64).optional(),
      })
      .strict(),
    steps: z.array(Step).min(1).max(HARD_CAPS.maxSteps),
    groundTruthEvents: z.array(GroundTruthEvent).max(HARD_CAPS.maxGroundTruthEvents),
    expectedOutcomes: z
      .object({
        terminalStatus: z.enum(RAW_PROVIDER_STATUSES).nullable().optional(),
        normalizedOutcome: z.enum(NORMALIZED_FACTS).nullable().optional(),
        invariants: z.record(InvariantId, z.enum(VERDICTS)).optional(),
      })
      .strict(),
    forbiddenBehaviors: z.array(z.enum(FORBIDDEN_BEHAVIORS)).max(FORBIDDEN_BEHAVIORS.length),
    requiredEvidence: z
      .array(
        z
          .object({
            predicate: z.enum(EVIDENCE_PREDICATES),
            classes: z.array(z.enum(EVIDENCE_CLASSES)).min(1).max(EVIDENCE_CLASSES.length).optional(),
            scopes: z.array(z.enum(EVIDENCE_SCOPES)).min(1).max(EVIDENCE_SCOPES.length).optional(),
          })
          .strict(),
      )
      .max(EVIDENCE_PREDICATES.length),
    resourceBudget: z
      .object(
        Object.fromEntries(BUDGET_KEYS.map((k) => [k, z.number().int().min(0).optional()])) as Record<
          (typeof BUDGET_KEYS)[number],
          z.ZodOptional<z.ZodNumber>
        >,
      )
      .strict(),
    sourceProvenance: z
      .object({
        class: z.enum(PROVENANCE_CLASSES),
        /** A redacted textual locator. It is data only: the compiler never fetches it. */
        locator: Label(512).optional(),
        notes: Label(1024).optional(),
      })
      .strict(),
  })
  .strict();
export type ScenarioSource = z.infer<typeof ScenarioSource>;
