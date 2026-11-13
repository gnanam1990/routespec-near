/**
 * The import pipeline (M50): pages of raw records in, a sanitised summary out.
 *
 * Raw records live only in this function's memory. The summary holds counts and closed
 * descriptors; it has no field that could carry an address, hash, account, asset or amount.
 * Deposit addresses are used for exactly two things while the import runs: the documented
 * pagination cursor, and looking a held swap up again for the second look. They are dropped
 * when the function returns.
 *
 * Every record read is accounted for exactly once:
 *   recordsRead = rejectedShape + duplicates + notIncident.* + incidents
 */
import { RouteSpecError } from '@routespec/contracts';
import {
  EXPLORER_STATUSES,
  ExplorerTransactionCore,
  ExplorerTransactionDocumented,
  isIsoInstant,
  type ExplorerStatus,
} from './explorer-shape.ts';
import {
  INCIDENT_CLASSES,
  STUCK_THRESHOLDS_SEC,
  TemplateDescriptor,
  classifyFirst,
  classifySighting,
  type Classification,
  type IncidentClass,
  type Sighting,
} from './sanitize.ts';
import type { SourceKind, TransactionSource } from './source.ts';

/** Statuses the import asks for. SUCCESS and PENDING_DEPOSIT are not incidents and are not read. */
export const IMPORT_STATUSES = ['FAILED', 'INCOMPLETE_DEPOSIT', 'PROCESSING', 'REFUNDED'] as const;

export interface ImportOptions {
  readonly window: { readonly startTimestamp: string | null; readonly endTimestamp: string | null };
  /** A swap still held at this age is an incident. One of the delay bucket bounds. */
  readonly stuckAfterSec: number;
  /** Seconds to wait before looking held swaps up again; 0 disables the second look. */
  readonly recheckAfterSec: number;
  /** Held swaps looked up again at most (each lookup is one rate-limited request). Default 60. */
  readonly recheckMax?: number;
  readonly pageSize?: number;
  readonly maxPages?: number;
  readonly statuses?: readonly ExplorerStatus[];
  /** Progress notes for a person watching a long import. Counts only, never record content. */
  readonly onProgress?: (note: string) => void;
}

export interface ImportCounts {
  recordsRead: number;
  pagesRead: number;
  /**
   * Older records were not read: the page limit was reached while pages were still full, or a
   * full page brought nothing new (the cursor did not advance), so reading stopped.
   */
  truncated: boolean;
  rejectedShape: number;
  /** Accepted records that lack a field the public document lists as required. */
  documentedShapeDeviations: number;
  duplicates: number;
  notIncident: { ordinarySuccess: number; inFlightYoung: number; unusedQuote: number };
  incidents: number;
  byClass: Record<IncidentClass, number>;
  byRefundReason: Record<string, number>;
  byDepositType: Record<string, number>;
  byRecipientType: Record<string, number>;
  byRefundType: Record<string, number>;
  /** Held swaps looked up again, and how many of those lookups did not return the swap. */
  rechecked: number;
  recheckNotFound: number;
  /** Held swaps beyond `recheckMax`, classified from one look only. */
  recheckSkipped: number;
  rateLimited: number;
}

export interface ImportSummary {
  readonly sourceKind: SourceKind;
  readonly window: { readonly startTimestamp: string | null; readonly endTimestamp: string | null };
  /** Time of the first look and of the second look, rounded down to the hour. */
  readonly observedAtHour: string;
  readonly recheckedAtHour: string | null;
  readonly stuckAfterSec: number;
  readonly statusesQueried: readonly ExplorerStatus[];
  readonly counts: ImportCounts;
  /** One entry per distinct descriptor, with the number of swaps that produced it. */
  readonly observations: ReadonlyArray<{ readonly descriptor: TemplateDescriptor; readonly count: number }>;
}

function usage(message: string): never {
  throw new RouteSpecError('RS_CLI_USAGE', message);
}

function hour(ms: number): string {
  return new Date(Math.floor(ms / 3_600_000) * 3_600_000).toISOString();
}

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

function sorted(map: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(map).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export async function runImport(source: TransactionSource, options: ImportOptions): Promise<ImportSummary> {
  const pageSize = options.pageSize ?? 1000;
  const maxPages = options.maxPages ?? 20;
  const recheckMax = options.recheckMax ?? 60;
  const statuses = [...(options.statuses ?? IMPORT_STATUSES)].sort();
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000) usage('Page size must be 1 to 1000.');
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 500) usage('Page limit must be 1 to 500.');
  if (!Number.isInteger(recheckMax) || recheckMax < 0 || recheckMax > 500)
    usage('Recheck limit must be 0 to 500.');
  if (!STUCK_THRESHOLDS_SEC.includes(options.stuckAfterSec)) {
    usage(`The stuck threshold must be one of ${STUCK_THRESHOLDS_SEC.join(', ')} seconds.`);
  }
  if (
    !Number.isInteger(options.recheckAfterSec) ||
    options.recheckAfterSec < 0 ||
    options.recheckAfterSec > 86_400
  ) {
    usage('The recheck wait must be 0 to 86400 seconds.');
  }
  if (statuses.length === 0 || statuses.some((s) => !EXPLORER_STATUSES.includes(s))) usage('Unknown status.');
  for (const t of [options.window.startTimestamp, options.window.endTimestamp]) {
    if (t !== null && !isIsoInstant(t)) usage('Window bounds must be ISO 8601 UTC instants.');
  }

  const counts: ImportCounts = {
    recordsRead: 0,
    pagesRead: 0,
    truncated: false,
    rejectedShape: 0,
    documentedShapeDeviations: 0,
    duplicates: 0,
    notIncident: { ordinarySuccess: 0, inFlightYoung: 0, unusedQuote: 0 },
    incidents: 0,
    byClass: Object.fromEntries(INCIDENT_CLASSES.map((c) => [c, 0])) as Record<IncidentClass, number>,
    byRefundReason: {},
    byDepositType: {},
    byRecipientType: {},
    byRefundType: {},
    rechecked: 0,
    recheckNotFound: 0,
    recheckSkipped: 0,
    rateLimited: 0,
  };
  const tally = new Map<string, { descriptor: TemplateDescriptor; count: number }>();
  const settle = (c: Exclude<Classification, { kind: 'HELD' }>): void => {
    if (c.kind === 'NOT_INCIDENT') {
      if (c.reason === 'ORDINARY_SUCCESS') counts.notIncident.ordinarySuccess++;
      else if (c.reason === 'IN_FLIGHT_YOUNG') counts.notIncident.inFlightYoung++;
      else counts.notIncident.unusedQuote++;
      return;
    }
    counts.incidents++;
    counts.byClass[c.descriptor.class]++;
    if (c.descriptor.refundReason !== null) bump(counts.byRefundReason, c.descriptor.refundReason);
    bump(counts.byDepositType, c.dimensions.depositType);
    bump(counts.byRecipientType, c.dimensions.recipientType);
    bump(counts.byRefundType, c.dimensions.refundType);
    const key = JSON.stringify(c.descriptor);
    const entry = tally.get(key);
    if (entry) entry.count++;
    else tally.set(key, { descriptor: c.descriptor, count: 1 });
  };

  // In-memory only: identities seen (to count a swap once) and held swaps awaiting a second look.
  const seen = new Set<string>();
  const held: Sighting[] = [];
  const classifyOptions = { stuckAfterSec: options.stuckAfterSec };

  const firstLookMs = source.nowMs();
  let cursor: { depositAddress: string; depositMemo: string | null } | null = null;
  for (;;) {
    const page = await source.listPage({
      statuses,
      startTimestamp: options.window.startTimestamp,
      endTimestamp: options.window.endTimestamp,
      numberOfTransactions: pageSize,
      cursor,
    });
    counts.pagesRead++;
    const observedAtMs = source.nowMs();
    const seenBefore = seen.size;
    let last: ExplorerTransactionCore | null = null;
    for (const raw of page) {
      counts.recordsRead++;
      const parsed = ExplorerTransactionCore.safeParse(raw);
      if (!parsed.success) {
        counts.rejectedShape++;
        continue;
      }
      const record = parsed.data;
      last = record;
      const identity = JSON.stringify([record.depositAddress, record.depositMemo ?? null]);
      if (seen.has(identity)) {
        counts.duplicates++;
        continue;
      }
      seen.add(identity);
      if (!ExplorerTransactionDocumented.safeParse(raw).success) counts.documentedShapeDeviations++;
      const sighting: Sighting = { record, observedAtMs };
      const first = classifyFirst(sighting, classifyOptions);
      if (first.kind === 'HELD') held.push(sighting);
      else settle(first);
    }
    options.onProgress?.(`page ${counts.pagesRead}: ${page.length} records, ${held.length} held so far`);
    if (page.length < pageSize || last === null) break;
    if (counts.pagesRead >= maxPages || seen.size === seenBefore) {
      counts.truncated = true;
      break;
    }
    cursor = { depositAddress: last.depositAddress, depositMemo: last.depositMemo ?? null };
  }

  let recheckedAtHour: string | null = null;
  const second = options.recheckAfterSec > 0 && held.length > 0 && recheckMax > 0;
  if (second) {
    options.onProgress?.(
      `waiting ${options.recheckAfterSec} s before looking ${Math.min(held.length, recheckMax)} held swaps up again`,
    );
    await source.wait(options.recheckAfterSec * 1000);
  }
  for (const [i, sighting] of held.entries()) {
    if (!second || i >= recheckMax) {
      if (second) counts.recheckSkipped++;
      settle(classifySighting(sighting, null, classifyOptions));
      continue;
    }
    const memo = sighting.record.depositMemo ?? null;
    const rows = await source.lookup(sighting.record.depositAddress, memo);
    const observedAtMs = source.nowMs();
    recheckedAtHour ??= hour(observedAtMs);
    counts.rechecked++;
    let later: Sighting | null = null;
    for (const raw of rows) {
      const parsed = ExplorerTransactionCore.safeParse(raw);
      if (
        parsed.success &&
        parsed.data.depositAddress === sighting.record.depositAddress &&
        (parsed.data.depositMemo ?? null) === memo &&
        parsed.data.createdAtTimestamp === sighting.record.createdAtTimestamp
      ) {
        later = { record: parsed.data, observedAtMs };
        break;
      }
    }
    if (later === null) counts.recheckNotFound++;
    settle(classifySighting(sighting, later, classifyOptions));
  }
  counts.rateLimited = source.rateLimitedCount();
  counts.byRefundReason = sorted(counts.byRefundReason);
  counts.byDepositType = sorted(counts.byDepositType);
  counts.byRecipientType = sorted(counts.byRecipientType);
  counts.byRefundType = sorted(counts.byRefundType);

  return {
    sourceKind: source.kind,
    window: { startTimestamp: options.window.startTimestamp, endTimestamp: options.window.endTimestamp },
    observedAtHour: hour(firstLookMs),
    recheckedAtHour,
    stuckAfterSec: options.stuckAfterSec,
    statusesQueried: statuses,
    counts,
    observations: [...tally.values()],
  };
}
