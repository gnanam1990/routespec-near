/**
 * M42 — classification of the real official dry-response shape (RP-07 finding).
 *
 * The fixture reproduces the field set and JSON types of the official 1Click response observed
 * by the first RP-07 probe (values are synthetic). Its redacted shape digest must equal the one
 * recorded from the real endpoint, proving the fixture is that shape. The adapter must judge it
 * SHAPE_COMPATIBLE now that documented echo normalisations are equivalent, still reject a genuine
 * echo mismatch, and expose a redacted field-level diff (names and value classes only) for the
 * `--debug-echo-diff` evidence option.
 */
import { describe, expect, it } from 'vitest';
import { classifyLiveDryRequest, classifyOutcome, diffEchoedQuoteRequest } from '../src/index.ts';

/** Shape digest recorded from the real official endpoint by the RP-07 probe. */
const REAL_OFFICIAL_SHAPE_DIGEST = 'sha256:f2c466cf3c383b66fe4526a0c59dbbcd3159ceec7d90fbc0a7dd0ddbe6fe092a';

const ZERO = '0'.repeat(64);
const FEE_RECIPIENT = 'f'.repeat(64);

const sent = {
  dry: true,
  swapType: 'EXACT_INPUT',
  slippageTolerance: 100,
  originAsset: 'nep141:wrap.near',
  depositType: 'ORIGIN_CHAIN',
  destinationAsset: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
  amount: '100000000000000000000000',
  refundTo: ZERO,
  refundType: 'ORIGIN_CHAIN',
  recipient: ZERO,
  recipientType: 'DESTINATION_CHAIN',
  deadline: '2026-11-13T05:01:33Z',
};

function officialBody(echoOverrides: Record<string, unknown> = {}) {
  return {
    correlationId: '00000000-0000-4000-8000-000000000000',
    timestamp: '2026-11-13T04:01:34.512Z',
    signature: 'ed25519:SYNTHETIC',
    quoteRequest: {
      ...sent,
      deadline: '2026-11-13T05:01:33.000Z',
      depositMode: 'SIMPLE',
      confidentiality: 'public',
      quoteWaitingTimeMs: 0,
      insured: false,
      appFees: [{ recipient: FEE_RECIPIENT, fee: 20 }],
      ...echoOverrides,
    },
    quote: {
      amountIn: '100000000000000000000000',
      amountInFormatted: '0.1',
      amountInUsd: '0.2',
      minAmountIn: '100000000000000000000000',
      amountOut: '200000',
      amountOutFormatted: '0.2',
      amountOutUsd: '0.2',
      minAmountOut: '198000',
      timeEstimate: 10,
      refundFee: '1000',
      withdrawFee: '0',
    },
  };
}

function outcome(body: unknown) {
  return {
    kind: 'RESPONSE' as const,
    status: 201,
    contentType: 'application/json; charset=utf-8',
    body: Buffer.from(JSON.stringify(body)),
    timing: { dnsMs: 1, connectMs: 1, ttfbMs: 1, totalMs: 3 },
    boundary: {
      credentialAttached: true,
      dnsAttempted: true,
      socketAttempted: true,
      upstreamAttempted: true,
    },
    pinnedFamily: 4 as const,
  };
}

const allowance = classifyLiveDryRequest({
  method: 'POST',
  target: '/v0/quote',
  headers: { 'content-type': 'application/json' },
  body: Buffer.from(JSON.stringify(sent)),
});
if (!allowance.allowed) throw new Error('fixture must be allowed');

describe('M42 official dry-response shape and echo equivalence', () => {
  it('the fixture is the real official shape and is judged compatible', () => {
    const r = classifyOutcome({ allowance, outcome: outcome(officialBody()), officialTransport: true });
    expect(r.responseShapeDigest).toBe(REAL_OFFICIAL_SHAPE_DIGEST);
    expect(r).toMatchObject({
      compatibility: 'OFFICIAL_ENDPOINT_COMPATIBLE',
      shapeResult: 'SHAPE_COMPATIBLE',
      reasonCode: 'PROFILE_SHAPE_MATCHED',
      httpStatus: 201,
      responseAssignedAddress: 'ABSENT',
    });
    expect(r.requestEchoDiff).toBeUndefined();
    const injected = classifyOutcome({
      allowance,
      outcome: outcome(officialBody()),
      officialTransport: false,
    });
    expect(injected.compatibility).toBe('UNKNOWN');
  });

  it('a genuine echo mismatch stays INCOMPATIBLE with a redacted field-level diff', () => {
    const r = classifyOutcome({
      allowance,
      outcome: outcome(officialBody({ recipient: '1'.repeat(64), appFees: [{ recipient: ZERO, fee: 75 }] })),
      officialTransport: true,
    });
    expect(r).toMatchObject({
      compatibility: 'INCOMPATIBLE',
      reasonCode: 'RS_FINALIZATION_REQUEST_MISMATCH',
    });
    const fields = Object.fromEntries((r.requestEchoDiff ?? []).map((d) => [d.field, d]));
    expect(fields['recipient']).toEqual({
      field: 'recipient',
      change: 'CHANGED',
      sent: 'string:SAME_AS_SENT_recipient',
      echoed: 'string:NEAR_IMPLICIT_HEX64',
    });
    expect(fields['appFees']?.echoed).toBe(
      'array[1]:[{"fee":"number:75","recipient":"string:SAME_AS_SENT_recipient"}]',
    );
    expect(JSON.stringify(r.requestEchoDiff)).not.toContain('1'.repeat(64));
  });

  it('the diff names every normalised field and never carries an address value', () => {
    const diff = diffEchoedQuoteRequest(sent, officialBody().quoteRequest);
    expect(diff.map((d) => `${d.field}:${d.change}`)).toEqual([
      'appFees:ADDED_BY_PROVIDER',
      'confidentiality:ADDED_BY_PROVIDER',
      'deadline:CHANGED',
      'depositMode:ADDED_BY_PROVIDER',
      'insured:ADDED_BY_PROVIDER',
      'quoteWaitingTimeMs:ADDED_BY_PROVIDER',
    ]);
    expect(diff.find((d) => d.field === 'deadline')?.echoed).toBe(
      'iso:dddd-dd-ddTdd:dd:dd.dddZ (SAME_INSTANT_AS_SENT)',
    );
    expect(JSON.stringify(diff)).not.toContain(FEE_RECIPIENT);
  });
});
