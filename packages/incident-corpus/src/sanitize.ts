/**
 * Sanitisation of Explorer swap records into closed incident descriptors (M50).
 *
 * What is kept from a record: its documented status, whether it was still held (and for how
 * long, as a coarse lower-bound bucket) when it was looked at, its refund reason if that is one
 * of the documented values, and whether any deposit transaction was listed. What is never kept:
 * addresses, memos, accounts, asset identifiers, transaction or intent hashes, referrals, fees
 * and amounts. The descriptor is assembled from closed enumerations only, so there is no path
 * by which a free-form value of a record can reach it.
 *
 * Timing honesty: the Explorer record carries a creation time and a current status, not a
 * settlement time. One look at a record therefore proves only "held for at least its age" for a
 * swap that is still in flight. A late success (or a late refund or failure) is recorded only
 * when the same swap was seen held at one time and terminal at a later time; the delay bucket
 * is the age at the first look, which is a proven lower bound.
 */
import { RouteSpecError, z } from '@routespec/contracts';
import {
  DEPOSIT_TYPES,
  KNOWN_REFUND_REASONS,
  RECIPIENT_TYPES,
  REFUND_TYPES,
  type ExplorerTransactionCore,
} from './explorer-shape.ts';

export const INCIDENT_CLASSES = ['STUCK', 'REFUNDED', 'FAILED', 'LATE_SUCCESS'] as const;
export type IncidentClass = (typeof INCIDENT_CLASSES)[number];

export const HELD_STATUSES = ['PROCESSING', 'INCOMPLETE_DEPOSIT'] as const;
export type HeldStatus = (typeof HELD_STATUSES)[number];

/** Lower bounds of the delay buckets, in seconds. A delay is reported as its largest bound. */
export const DELAY_BUCKETS = Object.freeze([
  { label: 'ge-15m', sec: 900, text: '15 min' },
  { label: 'ge-30m', sec: 1800, text: '30 min' },
  { label: 'ge-1h', sec: 3600, text: '1 h' },
  { label: 'ge-3h', sec: 10_800, text: '3 h' },
  { label: 'ge-6h', sec: 21_600, text: '6 h' },
  { label: 'ge-12h', sec: 43_200, text: '12 h' },
  { label: 'ge-24h', sec: 86_400, text: '24 h' },
] as const);
export type ObservedDelay = (typeof DELAY_BUCKETS)[number]['label'];
export const DELAY_LABELS = Object.freeze(DELAY_BUCKETS.map((b) => b.label)) as readonly ObservedDelay[];
export const DELAYS = ['not-observed', ...DELAY_LABELS] as const;
export type Delay = (typeof DELAYS)[number];

export const STUCK_THRESHOLDS_SEC = Object.freeze(DELAY_BUCKETS.map((b) => b.sec)) as readonly number[];

/** Refund reason of a descriptor: a documented value, none reported, or a value we do not know. */
export const REFUND_REASONS = [...KNOWN_REFUND_REASONS, 'NONE_REPORTED', 'UNRECOGNISED'] as const;
export type RefundReason = (typeof REFUND_REASONS)[number];

export const TemplateDescriptor = z
  .object({
    class: z.enum(INCIDENT_CLASSES),
    heldStatus: z.enum(HELD_STATUSES).nullable(),
    refundReason: z.enum(REFUND_REASONS).nullable(),
    delay: z.enum(DELAYS),
    depositObserved: z.boolean(),
  })
  .strict()
  .superRefine((d, ctx) => {
    const bad = (message: string) => ctx.addIssue({ code: 'custom', message });
    const held = d.heldStatus !== null;
    const timed = d.delay !== 'not-observed';
    if (held !== timed) bad('a delay is observed exactly when a held status was observed');
    if ((d.class === 'STUCK' || d.class === 'LATE_SUCCESS') && !held) bad('class needs a held status');
    if ((d.class === 'REFUNDED') !== (d.refundReason !== null)) bad('refund reason belongs to REFUNDED only');
    if (d.class !== 'FAILED' && !d.depositObserved) bad('only FAILED can lack an observed deposit');
    if (held && !d.depositObserved) bad('a held swap has a deposit');
  });
export type TemplateDescriptor = z.infer<typeof TemplateDescriptor>;

/** The largest bucket whose lower bound the age reaches, or null below the stuck threshold. */
export function bucketForAge(ageSec: number, stuckAfterSec: number): ObservedDelay | null {
  if (!STUCK_THRESHOLDS_SEC.includes(stuckAfterSec)) {
    throw new RouteSpecError('RS_CLI_USAGE', 'The stuck threshold must be one of the delay bucket bounds.', {
      details: { allowed: STUCK_THRESHOLDS_SEC.join(',') },
    });
  }
  if (!(ageSec >= stuckAfterSec)) return null;
  let label: ObservedDelay | null = null;
  for (const b of DELAY_BUCKETS) if (ageSec >= b.sec) label = b.label;
  return label;
}

export interface Sighting {
  readonly record: ExplorerTransactionCore;
  readonly observedAtMs: number;
}

export type NotIncidentReason = 'ORDINARY_SUCCESS' | 'IN_FLIGHT_YOUNG' | 'UNUSED_QUOTE';

/** Closed dimensions kept for the manifest histograms (never part of a scenario). */
export interface IncidentDimensions {
  readonly depositType: (typeof DEPOSIT_TYPES)[number] | 'UNRECOGNISED';
  readonly recipientType: (typeof RECIPIENT_TYPES)[number] | 'UNRECOGNISED';
  readonly refundType: (typeof REFUND_TYPES)[number] | 'UNRECOGNISED';
}

export type Classification =
  | { readonly kind: 'NOT_INCIDENT'; readonly reason: NotIncidentReason }
  | {
      readonly kind: 'INCIDENT';
      readonly descriptor: TemplateDescriptor;
      readonly dimensions: IncidentDimensions;
    }
  /** Held past the threshold on this look; a later look can settle what it became. */
  | { readonly kind: 'HELD'; readonly heldStatus: HeldStatus; readonly delay: ObservedDelay };

function closed<T extends string>(values: readonly T[], value: unknown): T | 'UNRECOGNISED' {
  return typeof value === 'string' && (values as readonly string[]).includes(value)
    ? (value as T)
    : 'UNRECOGNISED';
}

function reasonOf(record: ExplorerTransactionCore): RefundReason {
  const r = record.refundReason;
  if (r === null || r === undefined || r === '') return 'NONE_REPORTED';
  return closed(KNOWN_REFUND_REASONS, r);
}

function dimensionsOf(record: ExplorerTransactionCore): IncidentDimensions {
  return {
    depositType: closed(DEPOSIT_TYPES, record.depositType),
    recipientType: closed(RECIPIENT_TYPES, record.recipientType),
    refundType: closed(REFUND_TYPES, record.refundType),
  };
}

function depositSeen(record: ExplorerTransactionCore): boolean {
  return (record.originChainTxHashes?.length ?? 0) + (record.nearTxHashes?.length ?? 0) > 0;
}

function ageSec(s: Sighting): number {
  return Math.max(0, Math.floor(s.observedAtMs / 1000) - Math.floor(s.record.createdAtTimestamp));
}

function incident(
  record: ExplorerTransactionCore,
  descriptor: TemplateDescriptor,
): Extract<Classification, { kind: 'INCIDENT' }> {
  return {
    kind: 'INCIDENT',
    descriptor: TemplateDescriptor.parse(descriptor),
    dimensions: dimensionsOf(record),
  };
}

/** What one look at a record shows. */
export function classifyFirst(first: Sighting, options: { stuckAfterSec: number }): Classification {
  const r = first.record;
  switch (r.status) {
    case 'SUCCESS':
      return { kind: 'NOT_INCIDENT', reason: 'ORDINARY_SUCCESS' };
    case 'PENDING_DEPOSIT':
      return { kind: 'NOT_INCIDENT', reason: 'UNUSED_QUOTE' };
    case 'REFUNDED':
      return incident(r, {
        class: 'REFUNDED',
        heldStatus: null,
        refundReason: reasonOf(r),
        delay: 'not-observed',
        depositObserved: true,
      });
    case 'FAILED':
      return incident(r, {
        class: 'FAILED',
        heldStatus: null,
        refundReason: null,
        delay: 'not-observed',
        depositObserved: depositSeen(r),
      });
    case 'PROCESSING':
    case 'INCOMPLETE_DEPOSIT': {
      const delay = bucketForAge(ageSec(first), options.stuckAfterSec);
      if (delay === null) return { kind: 'NOT_INCIDENT', reason: 'IN_FLIGHT_YOUNG' };
      return { kind: 'HELD', heldStatus: r.status, delay };
    }
  }
}

/**
 * Classify a swap from its first sighting and, when it was held then, an optional later one.
 * A held swap with no later sighting is STUCK for at least its age at the first look.
 */
export function classifySighting(
  first: Sighting,
  later: Sighting | null,
  options: { stuckAfterSec: number },
): Exclude<Classification, { kind: 'HELD' }> {
  const one = classifyFirst(first, options);
  if (one.kind !== 'HELD') return one;
  const stuck = (heldStatus: HeldStatus, delay: ObservedDelay) =>
    incident(first.record, {
      class: 'STUCK',
      heldStatus,
      refundReason: null,
      delay,
      depositObserved: true,
    });
  if (later === null) return stuck(one.heldStatus, one.delay);
  const r = later.record;
  const base = { heldStatus: one.heldStatus, delay: one.delay, depositObserved: true } as const;
  switch (r.status) {
    case 'SUCCESS':
      return incident(r, { ...base, class: 'LATE_SUCCESS', refundReason: null });
    case 'REFUNDED':
      return incident(r, { ...base, class: 'REFUNDED', refundReason: reasonOf(r) });
    case 'FAILED':
      return incident(r, { ...base, class: 'FAILED', refundReason: null });
    case 'PROCESSING':
    case 'INCOMPLETE_DEPOSIT':
      return stuck(r.status, bucketForAge(ageSec(later), options.stuckAfterSec) ?? one.delay);
    case 'PENDING_DEPOSIT':
      return stuck(one.heldStatus, one.delay);
  }
}

/** Every valid descriptor, in a stable order. The space is closed and finite. */
export function allTemplateDescriptors(): TemplateDescriptor[] {
  const out: TemplateDescriptor[] = [];
  const heldTimings: Array<{ heldStatus: HeldStatus | null; delay: Delay }> = [
    { heldStatus: null, delay: 'not-observed' },
    ...HELD_STATUSES.flatMap((heldStatus) => DELAY_LABELS.map((delay) => ({ heldStatus, delay }))),
  ];
  for (const t of heldTimings) {
    if (t.heldStatus !== null) {
      out.push({ class: 'STUCK', ...t, refundReason: null, depositObserved: true });
      out.push({ class: 'LATE_SUCCESS', ...t, refundReason: null, depositObserved: true });
    }
    for (const refundReason of REFUND_REASONS) {
      out.push({ class: 'REFUNDED', ...t, refundReason, depositObserved: true });
    }
    out.push({ class: 'FAILED', ...t, refundReason: null, depositObserved: true });
    if (t.heldStatus === null) {
      out.push({ class: 'FAILED', ...t, refundReason: null, depositObserved: false });
    }
  }
  return out.map((d) => TemplateDescriptor.parse(d));
}
