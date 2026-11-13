/**
 * The documented shape of the Intents Explorer API, as far as the importer uses it (M50).
 *
 * Source: the public OpenAPI document of the service (`EXPLORER_API_SPEC`). It was read on the
 * date below and its SHA-256 is recorded so a later reader can tell whether the document has
 * changed since. Nothing here was checked against the running service: that needs a partner
 * key, which the importer takes from the environment at run time.
 *
 * Explorer records are untrusted data. Two schemas are applied to each one:
 * - `ExplorerTransactionCore`: only the fields the importer reads. A record that fails it is
 *   counted as rejected and contributes nothing.
 * - `ExplorerTransactionDocumented`: every field the document lists as required. A record that
 *   fails it is counted as a deviation from the documented shape, which is how a change in the
 *   real service becomes visible in the import counts.
 * Unknown fields are dropped by both; no field is ever copied into the output.
 */
import { RouteSpecError, z } from '@routespec/contracts';

export const EXPLORER_ORIGIN = 'https://explorer.near-intents.org' as const;
export const EXPLORER_TRANSACTIONS_PATH = '/api/v0/transactions' as const;
export const EXPLORER_ENDPOINT = `GET ${EXPLORER_ORIGIN}${EXPLORER_TRANSACTIONS_PATH}` as const;

export const EXPLORER_API_SPEC = Object.freeze({
  title: 'Intents Explorer API',
  version: '0.0.0',
  url: 'https://explorer.near-intents.org/api/v0/openapi.yaml',
  retrievedOn: '2026-11-13',
  sha256: 'sha256:eec0c12615083b0b409ec746fac96183b81c7c74359dc7fffecacf62b77ffb5e',
  /** "Each partner can make a maximum of 1 request every 5 seconds." */
  minRequestIntervalMs: 5000,
  maxTransactionsPerRequest: 1000,
} as const);

export const EXPLORER_STATUSES = [
  'SUCCESS',
  'FAILED',
  'INCOMPLETE_DEPOSIT',
  'PENDING_DEPOSIT',
  'PROCESSING',
  'REFUNDED',
] as const;
export type ExplorerStatus = (typeof EXPLORER_STATUSES)[number];

/** The "known values" of `refundReason`, in the order the document lists them. */
export const KNOWN_REFUND_REASONS = [
  'AMOUNT_LESS_THAN_MIN_AMOUNT_OUT',
  'AMOUNT_MORE_THAN_BALANCE',
  'INTENT_SUBMIT_FAILED',
  'PARTIAL_DEPOSIT',
  'CIRCUIT_BREAKER_BLOCKED',
  'FEE_ESTIMATION_FAILED',
  'NO_LIQUIDITY',
  'AMOUNT_LESS_THAN_MIN_WITHDRAWABLE',
  'INSUFFICIENT_BALANCE',
  'REFUND_ADD_FAILED',
  'UNKNOWN',
] as const;
export type KnownRefundReason = (typeof KNOWN_REFUND_REASONS)[number];

export const DEPOSIT_TYPES = ['ORIGIN_CHAIN', 'INTENTS', 'CONFIDENTIAL_INTENTS'] as const;
export const RECIPIENT_TYPES = ['DESTINATION_CHAIN', 'INTENTS', 'CONFIDENTIAL_INTENTS'] as const;
export const REFUND_TYPES = ['ORIGIN_CHAIN', 'INTENTS', 'CONFIDENTIAL_INTENTS'] as const;

const Text = z.string().max(2048);
const TextList = z.array(Text).max(256);

export const ExplorerTransactionCore = z.object({
  depositAddress: Text.min(1),
  depositMemo: Text.nullable().optional(),
  status: z.enum(EXPLORER_STATUSES),
  /** Unix seconds (the document's example is 1767182400). A fraction is tolerated and floored. */
  createdAtTimestamp: z.number().min(0).max(32_503_680_000),
  refundReason: Text.nullable().optional(),
  nearTxHashes: TextList.optional(),
  originChainTxHashes: TextList.optional(),
  depositType: Text.optional(),
  recipientType: Text.optional(),
  refundType: Text.optional(),
});
export type ExplorerTransactionCore = z.infer<typeof ExplorerTransactionCore>;

export const ExplorerTransactionDocumented = z.object({
  originAsset: Text,
  destinationAsset: Text,
  depositAddress: Text,
  depositMemo: Text.nullable(),
  depositAddressAndMemo: Text,
  recipient: Text,
  status: z.enum(EXPLORER_STATUSES),
  createdAt: Text,
  createdAtTimestamp: z.number(),
  intentHashes: Text.nullable(),
  referral: Text.nullable(),
  amountInFormatted: Text,
  amountOutFormatted: Text,
  appFees: z.array(z.object({ recipient: Text, fee: z.number() })).max(64),
  nearTxHashes: TextList,
  originChainTxHashes: TextList,
  destinationChainTxHashes: TextList,
  amountIn: Text,
  amountInUsd: Text,
  amountOut: Text,
  amountOutUsd: Text,
  refundTo: Text,
  senders: TextList,
  refundReason: Text.nullable().optional(),
  refundFee: Text.nullable().optional(),
  refundFeeFormatted: Text.nullable(),
  depositType: z.enum(DEPOSIT_TYPES),
  recipientType: z.enum(RECIPIENT_TYPES),
  refundType: z.enum(REFUND_TYPES),
});

export interface TransactionsQuery {
  readonly statuses: readonly ExplorerStatus[];
  /** ISO 8601, non-inclusive, or null for no bound. */
  readonly startTimestamp: string | null;
  readonly endTimestamp: string | null;
  readonly numberOfTransactions: number;
  /** The `depositAddress` and `depositMemo` of the last record of the previous page. */
  readonly cursor: { readonly depositAddress: string; readonly depositMemo: string | null } | null;
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

export function isIsoInstant(value: unknown): value is string {
  return typeof value === 'string' && ISO_INSTANT.test(value) && Number.isFinite(Date.parse(value));
}

function usage(message: string, details: Record<string, string> = {}): never {
  throw new RouteSpecError('RS_CLI_USAGE', message, { details });
}

/** Query string of one listing request. Only parameters the document defines are produced. */
export function buildTransactionsQuery(q: TransactionsQuery): URLSearchParams {
  if (
    !Number.isInteger(q.numberOfTransactions) ||
    q.numberOfTransactions < 1 ||
    q.numberOfTransactions > EXPLORER_API_SPEC.maxTransactionsPerRequest
  ) {
    usage('numberOfTransactions must be between 1 and 1000.');
  }
  if (q.statuses.length === 0 || q.statuses.some((s) => !EXPLORER_STATUSES.includes(s))) {
    usage('statuses must be documented status values.');
  }
  for (const t of [q.startTimestamp, q.endTimestamp]) {
    if (t !== null && !isIsoInstant(t)) usage('Timestamps must be ISO 8601 UTC instants.');
  }
  const p = new URLSearchParams();
  p.set('numberOfTransactions', String(q.numberOfTransactions));
  p.set('statuses', q.statuses.join(','));
  if (q.startTimestamp !== null) p.set('startTimestamp', q.startTimestamp);
  if (q.endTimestamp !== null) p.set('endTimestamp', q.endTimestamp);
  p.set('direction', 'next');
  if (q.cursor !== null) {
    p.set('lastDepositAddress', q.cursor.depositAddress);
    if (q.cursor.depositMemo !== null) p.set('lastDepositMemo', q.cursor.depositMemo);
  }
  return p;
}

/** Query string of a lookup of one swap by its deposit address (the documented `search`). */
export function buildLookupQuery(depositAddress: string, depositMemo: string | null): URLSearchParams {
  const p = new URLSearchParams();
  p.set('numberOfTransactions', '10');
  p.set('statuses', EXPLORER_STATUSES.join(','));
  p.set('search', depositAddress);
  if (depositMemo !== null) p.set('depositMemo', depositMemo);
  return p;
}
