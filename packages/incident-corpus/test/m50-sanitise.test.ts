/**
 * M50: sanitisation. A swap record becomes a closed descriptor (class, held status, refund
 * reason, coarse delay bucket, deposit seen or not) and nothing else. No address, hash,
 * account, asset identifier, memo, referral or amount can pass through, because nothing
 * free-form is copied: the output is built only from closed enumerations.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DELAY_BUCKETS,
  ExplorerTransactionCore,
  RecordingSource,
  bucketForAge,
  buildCorpus,
  classifySighting,
  runImport,
} from '../src/index.ts';
import { WINDOW, fixtureDoc, sensitiveStrings } from './support/fixture.ts';

const T = Date.parse('2026-11-13T12:00:00.000Z');

function rec(status: string, ageMin: number, extra: Record<string, unknown> = {}) {
  return ExplorerTransactionCore.parse({
    depositAddress: 'addr',
    depositMemo: null,
    status,
    createdAtTimestamp: Math.floor((T - ageMin * 60_000) / 1000),
    nearTxHashes: [],
    originChainTxHashes: ['0xabc'],
    ...extra,
  });
}
const opts = { stuckAfterSec: 900 };

describe('M50 sanitisation', () => {
  it('buckets a delay by its lower bound and never reports below the threshold', () => {
    expect(DELAY_BUCKETS.map((b) => b.label)).toEqual([
      'ge-15m',
      'ge-30m',
      'ge-1h',
      'ge-3h',
      'ge-6h',
      'ge-12h',
      'ge-24h',
    ]);
    expect(bucketForAge(899, 900)).toBeNull();
    expect(bucketForAge(900, 900)).toBe('ge-15m');
    expect(bucketForAge(1799, 900)).toBe('ge-15m');
    expect(bucketForAge(1800, 900)).toBe('ge-30m');
    expect(bucketForAge(3600, 3600)).toBe('ge-1h');
    expect(bucketForAge(3599, 3600)).toBeNull();
    expect(bucketForAge(10 * 86_400, 900)).toBe('ge-24h');
    expect(() => bucketForAge(1000, 1234)).toThrow();
  });

  it('classifies refunded, failed, stuck and ordinary records from one sighting', () => {
    expect(classifySighting({ record: rec('SUCCESS', 3), observedAtMs: T }, null, opts)).toEqual({
      kind: 'NOT_INCIDENT',
      reason: 'ORDINARY_SUCCESS',
    });
    expect(classifySighting({ record: rec('PENDING_DEPOSIT', 600), observedAtMs: T }, null, opts)).toEqual({
      kind: 'NOT_INCIDENT',
      reason: 'UNUSED_QUOTE',
    });
    expect(classifySighting({ record: rec('PROCESSING', 14), observedAtMs: T }, null, opts)).toEqual({
      kind: 'NOT_INCIDENT',
      reason: 'IN_FLIGHT_YOUNG',
    });
    expect(
      classifySighting(
        { record: rec('REFUNDED', 50, { refundReason: 'NO_LIQUIDITY' }), observedAtMs: T },
        null,
        opts,
      ),
    ).toMatchObject({
      kind: 'INCIDENT',
      descriptor: {
        class: 'REFUNDED',
        heldStatus: null,
        refundReason: 'NO_LIQUIDITY',
        delay: 'not-observed',
        depositObserved: true,
      },
    });
    expect(
      classifySighting({ record: rec('REFUNDED', 50, { refundReason: null }), observedAtMs: T }, null, opts),
    ).toMatchObject({ descriptor: { class: 'REFUNDED', refundReason: 'NONE_REPORTED' } });
    expect(
      classifySighting(
        { record: rec('FAILED', 5, { originChainTxHashes: [], nearTxHashes: [] }), observedAtMs: T },
        null,
        opts,
      ),
    ).toMatchObject({
      descriptor: { class: 'FAILED', refundReason: null, delay: 'not-observed', depositObserved: false },
    });
    expect(classifySighting({ record: rec('PROCESSING', 61), observedAtMs: T }, null, opts)).toMatchObject({
      descriptor: { class: 'STUCK', heldStatus: 'PROCESSING', delay: 'ge-1h', refundReason: null },
    });
    expect(
      classifySighting({ record: rec('INCOMPLETE_DEPOSIT', 200), observedAtMs: T }, null, opts),
    ).toMatchObject({ descriptor: { class: 'STUCK', heldStatus: 'INCOMPLETE_DEPOSIT', delay: 'ge-3h' } });
  });

  it('classifies a held swap by what a later sighting shows', () => {
    const first = { record: rec('PROCESSING', 40), observedAtMs: T };
    const later = (status: string, extra: Record<string, unknown> = {}) => ({
      record: rec(status, 40, extra),
      observedAtMs: T + 3_600_000,
    });
    // Late success: still PROCESSING 40 minutes after creation, SUCCESS when looked at again.
    // The delay is the proven lower bound (the first sighting), not the time of the second look.
    expect(classifySighting(first, later('SUCCESS'), opts)).toMatchObject({
      descriptor: { class: 'LATE_SUCCESS', heldStatus: 'PROCESSING', delay: 'ge-30m', refundReason: null },
    });
    expect(
      classifySighting(first, later('REFUNDED', { refundReason: 'INTENT_SUBMIT_FAILED' }), opts),
    ).toMatchObject({
      descriptor: {
        class: 'REFUNDED',
        heldStatus: 'PROCESSING',
        delay: 'ge-30m',
        refundReason: 'INTENT_SUBMIT_FAILED',
      },
    });
    expect(classifySighting(first, later('FAILED'), opts)).toMatchObject({
      descriptor: { class: 'FAILED', heldStatus: 'PROCESSING', delay: 'ge-30m', depositObserved: true },
    });
    // Still held at the second look: stuck for at least the later age (100 minutes).
    expect(classifySighting(first, later('PROCESSING'), opts)).toMatchObject({
      descriptor: { class: 'STUCK', heldStatus: 'PROCESSING', delay: 'ge-1h' },
    });
  });

  it('never copies an unrecognised refund reason', () => {
    const out = classifySighting(
      { record: rec('REFUNDED', 5, { refundReason: 'acct-victim.near owes 5000' }), observedAtMs: T },
      null,
      opts,
    );
    expect(out).toMatchObject({ descriptor: { refundReason: 'UNRECOGNISED' } });
    expect(JSON.stringify(out)).not.toContain('victim');
  });

  it('keeps no address, hash, account, asset, memo, referral or amount of the fixture', async () => {
    const doc = fixtureDoc();
    const summary = await runImport(new RecordingSource(doc), {
      window: WINDOW,
      stuckAfterSec: 900,
      recheckAfterSec: 3600,
    });
    const corpus = buildCorpus(summary, { label: 'explorer-shape-fixture' });
    const everything =
      JSON.stringify(summary) + JSON.stringify(corpus.manifest) + Object.values(corpus.files).join('\n');
    const secrets = sensitiveStrings(doc.observations.flatMap((o) => o.transactions));
    expect(secrets.length).toBeGreaterThan(150);
    for (const s of secrets) expect(everything.includes(s), `leaked: ${s}`).toBe(false);
    expect(everything).not.toMatch(/fixture-(deposit|recipient|refund|fee|destination|referral)/i);
    expect(everything).not.toMatch(/0x[0-9a-f]{6,}/i);
  });

  it('property: no free-form value of any record reaches the output, and every record is counted once', async () => {
    const token = fc.stringMatching(/^[a-z0-9]{12,40}$/).map((s) => `zq${s}`);
    const statuses = ['SUCCESS', 'FAILED', 'INCOMPLETE_DEPOSIT', 'PENDING_DEPOSIT', 'PROCESSING', 'REFUNDED'];
    const record = fc.record({
      depositAddress: token,
      depositMemo: fc.option(token, { nil: null }),
      recipient: token,
      refundTo: token,
      originAsset: token,
      destinationAsset: token,
      referral: fc.option(token, { nil: null }),
      intentHashes: fc.option(token, { nil: null }),
      senders: fc.array(token, { maxLength: 2 }),
      nearTxHashes: fc.array(token, { maxLength: 2 }),
      originChainTxHashes: fc.array(token, { maxLength: 2 }),
      destinationChainTxHashes: fc.array(token, { maxLength: 2 }),
      amountIn: token,
      amountOut: token,
      refundFee: fc.option(token, { nil: null }),
      refundReason: fc.option(fc.oneof(token, fc.constantFrom('NO_LIQUIDITY', 'UNKNOWN')), { nil: null }),
      status: fc.constantFrom(...statuses),
      ageMin: fc.integer({ min: 0, max: 3000 }),
    });
    await fc.assert(
      fc.asyncProperty(fc.array(record, { minLength: 1, maxLength: 12 }), async (rows) => {
        const transactions = rows.map(({ ageMin, ...r }, i) => ({
          ...r,
          depositAddress: `${r.depositAddress}${i}`,
          createdAt: new Date(T - ageMin * 60_000).toISOString(),
          createdAtTimestamp: Math.floor((T - ageMin * 60_000) / 1000),
        }));
        const summary = await runImport(
          new RecordingSource({
            recordingKind: 'DOCUMENTED_SHAPE_FIXTURE',
            note: 'property test',
            apiSpecDigest: fixtureDoc().apiSpecDigest,
            observations: [{ observedAt: new Date(T).toISOString(), transactions }],
          }),
          {
            window: WINDOW,
            stuckAfterSec: 900,
            recheckAfterSec: 0,
            statuses: [
              'SUCCESS',
              'FAILED',
              'INCOMPLETE_DEPOSIT',
              'PENDING_DEPOSIT',
              'PROCESSING',
              'REFUNDED',
            ],
          },
        );
        const corpus = buildCorpus(summary, { label: 'explorer-shape-fixture' });
        const text =
          JSON.stringify(summary) + JSON.stringify(corpus.manifest) + Object.values(corpus.files).join('\n');
        expect(text).not.toMatch(/zq[a-z0-9]{12}/);
        const c = summary.counts;
        expect(c.recordsRead).toBe(rows.length);
        expect(c.recordsRead).toBe(
          c.rejectedShape +
            c.duplicates +
            c.notIncident.ordinarySuccess +
            c.notIncident.inFlightYoung +
            c.notIncident.unusedQuote +
            c.incidents,
        );
        expect(corpus.manifest.templates.reduce((n, t) => n + t.count, 0)).toBe(c.incidents);
      }),
      { numRuns: 60 },
    );
  });
});
