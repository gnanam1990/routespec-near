/**
 * Protocol profile `oneclick-v0@1.0.0`: the four-phase material contract derived from the pinned
 * official SDK (see sdk-pin.ts). Field lists are copied from the SDK 0.1.26 type declarations
 * (QuoteRequest, QuoteResponse, Quote, SubmitDepositTxRequest, getExecutionStatus query).
 *
 * Phases:
 *   QUOTE_REQUEST            request-known fields only; a deposit address is never request-known
 *   QUOTE_FINALIZATION       first complete response atomically assigns quote/correlation
 *                            identity, constraints, response-assigned deposit address, extensions
 *   COMMIT_MUTATION          first commit binds method/route, body digest, finalized quote,
 *                            deposit address, and transaction digest
 *   READ_ONLY_RECONCILIATION status reads by the already bound deposit address only
 *
 * Unknown fields fail closed (RS_UNKNOWN_MATERIAL_FIELD); this module performs pure validation
 * and digesting only — persistence/atomicity is enforced by the journal (M01).
 */
import { digestValue, type Digest } from '../canonical/digest.ts';
import { RAW_PROVIDER_STATUSES, type MaterialFieldClass, type OperationPhase } from '../enums.ts';
import { RouteSpecError } from '../errors.ts';
import { BaseUnitAmount, z } from '../schemas/common.ts';
import { isMissingValueIssue } from '../schemas/issues.ts';
import { ROUTESPEC_HEADERS } from './headers.ts';
import { ONECLICK_SDK_PIN, ONECLICK_SDK_ROUTES } from './sdk-pin.ts';
import { RAW_STATUS_NORMALIZATION, TERMINAL_RAW_STATUSES } from './status.ts';

export const ONECLICK_PROFILE_ID = 'oneclick-v0@1.0.0' as const;

const Str = (max: number) => z.string().min(1).max(max);
const IsoTime = z
  .string()
  .max(64)
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/);

const AppFee = z.object({ recipient: Str(256), fee: z.number().int().min(0).max(10_000) }).strict();
const Rebate = z.object({ recipient: Str(256), share: z.number().int().min(0).max(100) }).strict();

export const QuoteRequestMaterial = z
  .object({
    dry: z.boolean(),
    depositMode: z.enum(['SIMPLE', 'MEMO']).optional(),
    swapType: z.enum(['EXACT_INPUT', 'EXACT_OUTPUT', 'FLEX_INPUT', 'ANY_INPUT']),
    slippageTolerance: z.number().int().min(0).max(10_000),
    originAsset: Str(256),
    depositType: z.enum(['ORIGIN_CHAIN', 'INTENTS', 'CONFIDENTIAL_INTENTS']),
    destinationAsset: Str(256),
    amount: BaseUnitAmount,
    refundTo: Str(256),
    refundType: z.enum(['ORIGIN_CHAIN', 'INTENTS', 'CONFIDENTIAL_INTENTS']),
    recipient: Str(256),
    connectedWallets: z.array(Str(256)).max(32).optional(),
    sessionId: Str(256).optional(),
    virtualChainRecipient: Str(256).optional(),
    virtualChainRefundRecipient: Str(256).optional(),
    customRecipientMsg: z.string().max(4096).optional(),
    recipientType: z.enum(['DESTINATION_CHAIN', 'INTENTS', 'CONFIDENTIAL_INTENTS']),
    deadline: IsoTime,
    confidentiality: z.enum(['public', 'basic', 'advanced']).optional(),
    referral: Str(128).optional(),
    rebates: z.array(Rebate).max(3).optional(),
    quoteWaitingTimeMs: z.number().int().min(0).max(600_000).optional(),
    appFees: z.array(AppFee).max(16).optional(),
    insured: z.boolean().optional(),
  })
  .strict();
export type QuoteRequestMaterial = z.infer<typeof QuoteRequestMaterial>;

const ChainDepositAddress = z
  .object({ blockchain: Str(64), address: Str(256), memo: Str(256).optional() })
  .strict();

export const QuoteMaterial = z
  .object({
    depositAddress: Str(256).optional(),
    depositMemo: Str(256).optional(),
    chainDepositAddresses: z.array(ChainDepositAddress).max(64).optional(),
    amountIn: BaseUnitAmount,
    amountInFormatted: z.string().max(128),
    amountInUsd: z.string().max(128),
    minAmountIn: BaseUnitAmount,
    amountOut: BaseUnitAmount,
    amountOutFormatted: z.string().max(128),
    amountOutUsd: z.string().max(128),
    minAmountOut: BaseUnitAmount,
    deadline: IsoTime.optional(),
    timeWhenInactive: IsoTime.optional(),
    timeEstimate: z.number().int().min(0).max(31_536_000),
    virtualChainRecipient: Str(256).optional(),
    virtualChainRefundRecipient: Str(256).optional(),
    customRecipientMsg: z.string().max(4096).optional(),
    refundFee: BaseUnitAmount.optional(),
    withdrawFee: BaseUnitAmount.optional(),
  })
  .strict();

export const QuoteResponseMaterial = z
  .object({
    correlationId: Str(256),
    timestamp: IsoTime,
    signature: Str(4096),
    quoteRequest: z.unknown(),
    quote: QuoteMaterial,
  })
  .strict();
export type QuoteResponseMaterial = z.infer<typeof QuoteResponseMaterial>;

export const CommitRequestMaterial = z
  .object({
    txHash: Str(256),
    depositAddress: Str(256),
    nearSenderAccount: Str(256).optional(),
    memo: Str(256).optional(),
  })
  .strict();
export type CommitRequestMaterial = z.infer<typeof CommitRequestMaterial>;

export const StatusQueryMaterial = z
  .object({ depositAddress: Str(256), depositMemo: Str(256).optional() })
  .strict();
export type StatusQueryMaterial = z.infer<typeof StatusQueryMaterial>;

/** Material-field registry: every field the profile knows, classified by phase authority. */
export const MATERIAL_FIELD_REGISTRY: Readonly<Record<string, MaterialFieldClass>> = Object.freeze({
  ...Object.fromEntries(
    Object.keys(QuoteRequestMaterial.shape).map((k) => [`quoteRequest.${k}`, 'QUOTE_REQUEST_KNOWN']),
  ),
  'quoteRequest.depositAddress': 'PROHIBITED_IN_REQUEST',
  'quoteRequest.depositMemo': 'PROHIBITED_IN_REQUEST',
  'quoteResponse.correlationId': 'QUOTE_RESPONSE_ASSIGNED',
  'quoteResponse.timestamp': 'QUOTE_RESPONSE_ASSIGNED',
  'quoteResponse.signature': 'QUOTE_RESPONSE_ASSIGNED',
  'quoteResponse.quoteRequest': 'QUOTE_RESPONSE_ASSIGNED',
  'quoteResponse.quote.depositAddress': 'QUOTE_RESPONSE_ASSIGNED',
  'quoteResponse.quote.depositMemo': 'QUOTE_RESPONSE_ASSIGNED',
  'quoteResponse.quote.chainDepositAddresses': 'QUOTE_RESPONSE_ASSIGNED',
  'quoteResponse.quote.amountIn': 'QUOTE_RESPONSE_ASSIGNED',
  'quoteResponse.quote.minAmountIn': 'QUOTE_RESPONSE_ASSIGNED',
  'quoteResponse.quote.amountOut': 'QUOTE_RESPONSE_ASSIGNED',
  'quoteResponse.quote.minAmountOut': 'QUOTE_RESPONSE_ASSIGNED',
  'quoteResponse.quote.deadline': 'QUOTE_RESPONSE_ASSIGNED',
  'quoteResponse.quote.timeWhenInactive': 'QUOTE_RESPONSE_ASSIGNED',
  'quoteResponse.quote.timeEstimate': 'QUOTE_RESPONSE_ASSIGNED',
  'quoteResponse.quote.virtualChainRecipient': 'QUOTE_RESPONSE_ASSIGNED',
  'quoteResponse.quote.virtualChainRefundRecipient': 'QUOTE_RESPONSE_ASSIGNED',
  'quoteResponse.quote.customRecipientMsg': 'QUOTE_RESPONSE_ASSIGNED',
  'quoteResponse.quote.refundFee': 'QUOTE_RESPONSE_ASSIGNED',
  'quoteResponse.quote.withdrawFee': 'QUOTE_RESPONSE_ASSIGNED',
  'quoteResponse.quote.amountInFormatted': 'QUOTE_RESPONSE_DISPLAY',
  'quoteResponse.quote.amountInUsd': 'QUOTE_RESPONSE_DISPLAY',
  'quoteResponse.quote.amountOutFormatted': 'QUOTE_RESPONSE_DISPLAY',
  'quoteResponse.quote.amountOutUsd': 'QUOTE_RESPONSE_DISPLAY',
  'commit.txHash': 'COMMIT_MATERIAL',
  'commit.depositAddress': 'COMMIT_MATERIAL',
  'commit.nearSenderAccount': 'COMMIT_MATERIAL',
  'commit.memo': 'COMMIT_MATERIAL',
  'status.depositAddress': 'RECONCILIATION_ONLY',
  'status.depositMemo': 'RECONCILIATION_ONLY',
}) as Readonly<Record<string, MaterialFieldClass>>;

export interface ProfileRoute {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly phases: readonly OperationPhase[];
  readonly mutationShaped: boolean;
  readonly liveDryPolicy: 'ALLOW_IF_DRY_TRUE' | 'DENY' | 'DISABLED_BY_DEFAULT';
}

export const PROFILE_ROUTES: readonly ProfileRoute[] = Object.freeze([
  {
    method: 'POST',
    path: '/v0/quote',
    phases: ['QUOTE_REQUEST', 'QUOTE_FINALIZATION'],
    mutationShaped: true,
    liveDryPolicy: 'ALLOW_IF_DRY_TRUE',
  },
  {
    method: 'POST',
    path: '/v0/deposit/submit',
    phases: ['COMMIT_MUTATION'],
    mutationShaped: true,
    liveDryPolicy: 'DENY',
  },
  {
    method: 'GET',
    path: '/v0/status',
    phases: ['READ_ONLY_RECONCILIATION'],
    mutationShaped: false,
    liveDryPolicy: 'DISABLED_BY_DEFAULT',
  },
]);

export function resolveProfileRoute(method: string, path: string): ProfileRoute {
  const route = PROFILE_ROUTES.find((r) => r.method === method && r.path === path);
  if (!route) {
    throw new RouteSpecError('RS_UNSUPPORTED_ROUTE', 'Route is not part of the pinned protocol profile.', {
      details: { method, path, upstreamAttempted: false },
    });
  }
  return route;
}

function describeSchema(schema: z.ZodObject<z.ZodRawShape>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(schema.shape).map(([k, v]) => [
      k,
      (v as z.ZodTypeAny).isOptional() ? 'optional' : 'required',
    ]),
  );
}

/**
 * Request-echo equivalence constants (see "Request-echo equivalence" below). They are validation
 * rules, like the schemas' refinements, and are not part of the digested profile body: the
 * profile's field sets, routes and statuses are unchanged, so its integrity digest (and every
 * golden replay vector that carries it) stays the same.
 */
/** Documented defaults of optional request fields the provider may echo when they were omitted. */
export const ECHO_DOCUMENTED_DEFAULTS: Readonly<Record<string, unknown>> = Object.freeze({
  depositMode: 'SIMPLE',
  confidentiality: 'public',
  quoteWaitingTimeMs: 0,
  insured: false,
});

/** Documented provider fee rates (bps) applied when an authenticated or public request omits appFees. */
export const ECHO_PROVIDER_DEFAULT_FEE_BPS: readonly number[] = Object.freeze([1, 20, 25]);

const profileBody = {
  profileId: ONECLICK_PROFILE_ID,
  sdk: ONECLICK_SDK_PIN,
  sdkRoutes: ONECLICK_SDK_ROUTES,
  routes: PROFILE_ROUTES,
  schemas: {
    quoteRequest: describeSchema(QuoteRequestMaterial),
    quote: describeSchema(QuoteMaterial),
    quoteResponse: describeSchema(QuoteResponseMaterial),
    commitRequest: describeSchema(CommitRequestMaterial),
    statusQuery: describeSchema(StatusQueryMaterial),
  },
  materialFields: MATERIAL_FIELD_REGISTRY,
  rawStatuses: RAW_PROVIDER_STATUSES,
  statusNormalization: RAW_STATUS_NORMALIZATION,
  terminalRawStatuses: TERMINAL_RAW_STATUSES,
  unknownStatusPolicy: 'PRESERVE_RAW_AND_REVIEW',
  unknownFieldPolicy: 'FAIL_CLOSED',
  correlationHeaders: ROUTESPEC_HEADERS,
  liveDryAllowlist: [{ method: 'POST', path: '/v0/quote', requires: { dry: true } }],
};

/** The full pinned profile with separate route/material/status schema digests and an integrity digest. */
export const ONECLICK_PROFILE = Object.freeze({
  ...profileBody,
  routeSchemaDigest: digestValue('routespec.profile.routes/1', {
    routes: profileBody.routes,
    schemas: profileBody.schemas,
  }),
  materialRegistryDigest: digestValue('routespec.profile.material-fields/1', profileBody.materialFields),
  statusSchemaDigest: digestValue('routespec.profile.status/1', {
    rawStatuses: profileBody.rawStatuses,
    statusNormalization: profileBody.statusNormalization,
    terminalRawStatuses: profileBody.terminalRawStatuses,
    unknownStatusPolicy: profileBody.unknownStatusPolicy,
  }),
  integrityDigest: digestValue('routespec.protocol-profile/1', profileBody),
});

// ---------------------------------------------------------------------------------------------
// Validation and digests for each phase.

function unknownKeys(input: unknown, known: readonly string[]): string[] {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return [];
  return Object.keys(input).filter((k) => !known.includes(k));
}

function invalid(phase: OperationPhase, error: z.ZodError): never {
  throw new RouteSpecError('RS_MATERIAL_INVALID', 'Material failed profile validation.', {
    details: { phase, issues: error.issues.slice(0, 8).map((i) => `${i.path.join('.')}: ${i.message}`) },
  });
}

function rejectUnknown(
  phase: OperationPhase,
  prefix: string,
  input: unknown,
  known: readonly string[],
): void {
  const unknown = unknownKeys(input, known);
  if (unknown.length > 0) {
    throw new RouteSpecError('RS_UNKNOWN_MATERIAL_FIELD', 'Unknown material field fails closed.', {
      details: { phase, fields: unknown.map((k) => `${prefix}.${k}`) },
    });
  }
}

export interface ValidatedQuoteRequest {
  readonly material: QuoteRequestMaterial;
  readonly quoteRequestDigest: Digest;
}

export function validateQuoteRequest(input: unknown): ValidatedQuoteRequest {
  if (typeof input === 'object' && input !== null && ('depositAddress' in input || 'depositMemo' in input)) {
    throw new RouteSpecError(
      'RS_DEPOSIT_ADDRESS_NOT_REQUEST_KNOWN',
      'A deposit address is response-assigned and cannot appear in a quote request.',
      { details: { phase: 'QUOTE_REQUEST' } },
    );
  }
  rejectUnknown('QUOTE_REQUEST', 'quoteRequest', input, Object.keys(QuoteRequestMaterial.shape));
  const parsed = QuoteRequestMaterial.safeParse(input);
  if (!parsed.success) invalid('QUOTE_REQUEST', parsed.error);
  return {
    material: parsed.data,
    quoteRequestDigest: digestValue('routespec.oneclick.quote-request/1', parsed.data),
  };
}

// ---------------------------------------------------------------------------------------------
// Request-echo equivalence. The official endpoint echoes the request in `quoteRequest` after its
// own normalisation (observed by the RP-07 dry probe and documented in the 1Click quote API):
//   1. `deadline` is re-serialized (milliseconds added); the instant is unchanged.
//   2. optional fields the client omitted are filled with their documented defaults.
//   3. an omitted `appFees` becomes the provider's own default fee entry (20 bps with an API
//      key, 1 bp on stablecoin/same-asset routes, 25 bps without a key) with a provider recipient.
// Only these are equivalent. Every field the client sent must be echoed unchanged (deadline: same
// instant), no sent field may be dropped, and nothing else may be added. The provider-defaulted
// values are response-assigned and are bound into the finalization extensions.

function sameInstant(a: string, b: string): boolean {
  if (!IsoTime.safeParse(a).success || !IsoTime.safeParse(b).success) return false;
  const fraction = (t: string) => /\.(\d+)/.exec(t)?.[1] ?? '';
  // Date.parse is millisecond-precise; reject a sub-millisecond difference rather than round it.
  if (fraction(a).replace(/0+$/, '').length > 3 || fraction(b).replace(/0+$/, '').length > 3) {
    return a === b;
  }
  const ma = Date.parse(a);
  const mb = Date.parse(b);
  return Number.isFinite(ma) && ma === mb;
}

function isProviderDefaultFee(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== 1) return false;
  const entry = value[0] as { fee?: unknown };
  return typeof entry.fee === 'number' && ECHO_PROVIDER_DEFAULT_FEE_BPS.includes(entry.fee);
}

/**
 * Compare a schema-valid echoed request with the bound one. Returns the provider-defaulted
 * fields (sorted) when the echo is equivalent, or null for a genuine mismatch.
 */
export function equivalentEcho(
  sent: QuoteRequestMaterial,
  echoed: QuoteRequestMaterial,
): Record<string, unknown> | null {
  const s = sent as Record<string, unknown>;
  const e = echoed as Record<string, unknown>;
  const same = (a: unknown, b: unknown) =>
    digestValue('routespec.oneclick.echo-field/1', a) === digestValue('routespec.oneclick.echo-field/1', b);
  for (const key of Object.keys(s)) {
    if (!(key in e)) return null;
    if (key === 'deadline') {
      if (!sameInstant(String(s[key]), String(e[key]))) return null;
    } else if (!same(s[key], e[key])) {
      return null;
    }
  }
  const defaulted: Record<string, unknown> = {};
  for (const key of Object.keys(e).sort()) {
    if (key in s) continue;
    if (key === 'appFees') {
      if (!isProviderDefaultFee(e[key])) return null;
    } else if (!(key in ECHO_DOCUMENTED_DEFAULTS) || !same(ECHO_DOCUMENTED_DEFAULTS[key], e[key])) {
      return null;
    }
    defaulted[key] = e[key];
  }
  return defaulted;
}

export interface QuoteFinalization {
  readonly quoteRequestDigest: Digest;
  readonly correlationId: string;
  readonly quoteTimestamp: string;
  readonly signatureDigest: Digest;
  readonly depositAddress: string | null;
  readonly depositMemo: string | null;
  readonly constraints: {
    readonly amountIn: string;
    readonly minAmountIn: string;
    readonly amountOut: string;
    readonly minAmountOut: string;
    readonly deadline: string | null;
    readonly timeWhenInactive: string | null;
    readonly timeEstimate: number;
    readonly refundFee: string | null;
    readonly withdrawFee: string | null;
  };
  readonly extensions: Readonly<Record<string, unknown>>;
  readonly responseDigest: Digest;
  readonly finalizationDigest: Digest;
}

/**
 * Validate a complete quote response against the already bound quote request. Partial
 * responses (missing a response-assigned field required for the request's dry flag) throw
 * RS_PARTIAL_FINALIZATION so the caller writes nothing.
 */
export function validateQuoteFinalization(bound: ValidatedQuoteRequest, input: unknown): QuoteFinalization {
  rejectUnknown('QUOTE_FINALIZATION', 'quoteResponse', input, Object.keys(QuoteResponseMaterial.shape));
  if (typeof input === 'object' && input !== null && 'quote' in input) {
    rejectUnknown(
      'QUOTE_FINALIZATION',
      'quoteResponse.quote',
      (input as { quote: unknown }).quote,
      Object.keys(QuoteMaterial.shape),
    );
  }
  const parsed = QuoteResponseMaterial.safeParse(input);
  if (!parsed.success) {
    const missing = parsed.error.issues.some((i) => isMissingValueIssue(i, input));
    if (missing) {
      throw new RouteSpecError(
        'RS_PARTIAL_FINALIZATION',
        'Quote response is incomplete; nothing was finalized.',
        {
          details: {
            phase: 'QUOTE_FINALIZATION',
            missing: parsed.error.issues.map((i) => i.path.join('.')).slice(0, 8),
          },
        },
      );
    }
    invalid('QUOTE_FINALIZATION', parsed.error);
  }
  const r = parsed.data;
  const echoed = validateQuoteRequest(r.quoteRequest);
  const providerDefaulted =
    echoed.quoteRequestDigest === bound.quoteRequestDigest
      ? {}
      : equivalentEcho(bound.material, echoed.material);
  if (providerDefaulted === null) {
    throw new RouteSpecError(
      'RS_FINALIZATION_REQUEST_MISMATCH',
      'Quote response echoes a different request.',
      {
        details: { phase: 'QUOTE_FINALIZATION' },
      },
    );
  }
  const q = r.quote;
  if (!bound.material.dry && q.depositAddress === undefined) {
    throw new RouteSpecError(
      'RS_PARTIAL_FINALIZATION',
      'Non-dry quote response lacks its assigned deposit address.',
      {
        details: { phase: 'QUOTE_FINALIZATION', missing: ['quote.depositAddress'] },
      },
    );
  }
  if (bound.material.depositMode === 'MEMO' && !bound.material.dry && q.depositMemo === undefined) {
    throw new RouteSpecError('RS_PARTIAL_FINALIZATION', 'MEMO-mode quote response lacks its deposit memo.', {
      details: { phase: 'QUOTE_FINALIZATION', missing: ['quote.depositMemo'] },
    });
  }
  const constraints = {
    amountIn: q.amountIn,
    minAmountIn: q.minAmountIn,
    amountOut: q.amountOut,
    minAmountOut: q.minAmountOut,
    deadline: q.deadline ?? null,
    timeWhenInactive: q.timeWhenInactive ?? null,
    timeEstimate: q.timeEstimate,
    refundFee: q.refundFee ?? null,
    withdrawFee: q.withdrawFee ?? null,
  };
  const extensions: Record<string, unknown> = {};
  for (const key of [
    'chainDepositAddresses',
    'virtualChainRecipient',
    'virtualChainRefundRecipient',
    'customRecipientMsg',
    'amountInFormatted',
    'amountInUsd',
    'amountOutFormatted',
    'amountOutUsd',
  ] as const) {
    if (q[key] !== undefined) extensions[key] = q[key];
  }
  if (Object.keys(providerDefaulted).length > 0)
    extensions['providerDefaultedRequestFields'] = providerDefaulted;
  const signatureDigest = digestValue('routespec.oneclick.quote-signature/1', r.signature);
  const responseDigest = digestValue('routespec.oneclick.quote-response/1', r);
  const finalizationBody = {
    quoteRequestDigest: bound.quoteRequestDigest,
    correlationId: r.correlationId,
    quoteTimestamp: r.timestamp,
    signatureDigest,
    depositAddress: q.depositAddress ?? null,
    depositMemo: q.depositMemo ?? null,
    constraints,
    extensions,
  };
  return {
    ...finalizationBody,
    responseDigest,
    finalizationDigest: digestValue('routespec.oneclick.quote-finalization/1', finalizationBody),
  };
}

export interface CommitBinding {
  readonly method: 'POST';
  readonly route: '/v0/deposit/submit';
  readonly bodyDigest: Digest;
  readonly quoteFinalizationDigest: Digest;
  readonly depositAddressDigest: Digest;
  readonly transactionDigest: Digest;
  readonly bindingDigest: Digest;
}

export function validateCommit(finalization: QuoteFinalization | null, input: unknown): CommitBinding {
  if (finalization === null) {
    throw new RouteSpecError('RS_COMMIT_WITHOUT_FINALIZATION', 'Commit requires a finalized quote.', {
      details: { phase: 'COMMIT_MUTATION' },
    });
  }
  rejectUnknown('COMMIT_MUTATION', 'commit', input, Object.keys(CommitRequestMaterial.shape));
  const parsed = CommitRequestMaterial.safeParse(input);
  if (!parsed.success) invalid('COMMIT_MUTATION', parsed.error);
  const c = parsed.data;
  if (finalization.depositAddress === null) {
    throw new RouteSpecError(
      'RS_COMMIT_WITHOUT_FINALIZATION',
      'Finalized quote has no assigned deposit address.',
      {
        details: { phase: 'COMMIT_MUTATION' },
      },
    );
  }
  if (c.depositAddress !== finalization.depositAddress) {
    throw new RouteSpecError(
      'RS_COMMIT_MATERIAL_MISMATCH',
      'Commit deposit address differs from the finalized quote.',
      {
        details: { phase: 'COMMIT_MUTATION', field: 'depositAddress' },
      },
    );
  }
  if ((c.memo ?? null) !== finalization.depositMemo) {
    throw new RouteSpecError(
      'RS_COMMIT_MATERIAL_MISMATCH',
      'Commit memo differs from the finalized quote memo.',
      {
        details: { phase: 'COMMIT_MUTATION', field: 'memo' },
      },
    );
  }
  const body = {
    method: 'POST' as const,
    route: '/v0/deposit/submit' as const,
    bodyDigest: digestValue('routespec.oneclick.commit-body/1', c),
    quoteFinalizationDigest: finalization.finalizationDigest,
    depositAddressDigest: digestValue('routespec.oneclick.deposit-address/1', c.depositAddress),
    transactionDigest: digestValue('routespec.oneclick.tx-hash/1', c.txHash),
  };
  return { ...body, bindingDigest: digestValue('routespec.oneclick.commit-binding/1', body) };
}

export function validateStatusQuery(
  finalization: QuoteFinalization | null,
  input: unknown,
): StatusQueryMaterial {
  if (finalization === null || finalization.depositAddress === null) {
    throw new RouteSpecError('RS_PHASE_INVALID', 'Status reconciliation requires a bound deposit address.', {
      details: { phase: 'READ_ONLY_RECONCILIATION' },
    });
  }
  rejectUnknown('READ_ONLY_RECONCILIATION', 'status', input, Object.keys(StatusQueryMaterial.shape));
  const parsed = StatusQueryMaterial.safeParse(input);
  if (!parsed.success) invalid('READ_ONLY_RECONCILIATION', parsed.error);
  if (parsed.data.depositAddress !== finalization.depositAddress) {
    throw new RouteSpecError('RS_IDENTITY_MISMATCH', 'Status query targets a different deposit address.', {
      details: { phase: 'READ_ONLY_RECONCILIATION' },
    });
  }
  return parsed.data;
}
