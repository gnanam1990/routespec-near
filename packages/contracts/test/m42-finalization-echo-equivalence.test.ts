/**
 * M42 — quote-finalization request-echo equivalence (RP-07 finding).
 *
 * The first official dry probe returned HTTP 201 whose `quoteRequest` echo differed from the
 * request sent in exactly these ways (redacted field-level diff recorded with the adapter's
 * `--debug-echo-diff` option):
 *   - `deadline`: same instant, re-serialized with milliseconds (`...:33Z` -> `...:33.000Z`);
 *   - `depositMode: "SIMPLE"`, `confidentiality: "public"`, `quoteWaitingTimeMs: 0`,
 *     `insured: false`: the documented defaults of fields the request omitted;
 *   - `appFees: [{ recipient: <64-hex account, not one we sent>, fee: 20 }]`: the documented
 *     1Click fee charged when an authenticated request omits `appFees` (20 bps; 1 bp for
 *     stablecoin/same-asset routes; 25 bps without an API key).
 * Every request-known field the client actually sent must still be echoed unchanged; only those
 * documented normalisations are equivalent. The fixture below has the real response *shape*
 * (field set and JSON types) with synthetic values.
 */
import { describe, expect, it } from 'vitest';
import {
  isRouteSpecError,
  validateQuoteFinalization,
  validateQuoteRequest,
  type ErrorCode,
} from '../src/index.ts';

const FEE_RECIPIENT = 'f'.repeat(64);
const ZERO = '0'.repeat(64);

function sentRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
    ...overrides,
  };
}

/** The echoed request exactly as the official endpoint normalised it (synthetic values). */
function officialEcho(
  sent: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...sent,
    deadline: '2026-11-13T05:01:33.000Z',
    depositMode: 'SIMPLE',
    confidentiality: 'public',
    quoteWaitingTimeMs: 0,
    insured: false,
    appFees: [{ recipient: FEE_RECIPIENT, fee: 20 }],
    ...overrides,
  };
}

/** Real official dry-response shape: no deposit address/deadline; refundFee and withdrawFee set. */
export function officialDryResponse(echo: Record<string, unknown>): Record<string, unknown> {
  return {
    correlationId: '00000000-0000-4000-8000-000000000000',
    timestamp: '2026-11-13T04:01:34.512Z',
    signature: 'ed25519:SYNTHETIC',
    quoteRequest: echo,
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

function codeOf(fn: () => unknown): ErrorCode | 'NO_ERROR' {
  try {
    fn();
    return 'NO_ERROR';
  } catch (error) {
    if (isRouteSpecError(error)) return error.code;
    throw error;
  }
}

describe('M42 finalization request-echo equivalence (oneclick-v0)', () => {
  const sent = sentRequest();
  const bound = validateQuoteRequest(sent);

  it('accepts the official echo with its documented normalisations and binds them', () => {
    const fin = validateQuoteFinalization(bound, officialDryResponse(officialEcho(sent)));
    expect(fin.quoteRequestDigest).toBe(bound.quoteRequestDigest);
    expect(fin.depositAddress).toBeNull();
    expect(fin.extensions['providerDefaultedRequestFields']).toEqual({
      appFees: [{ recipient: FEE_RECIPIENT, fee: 20 }],
      confidentiality: 'public',
      depositMode: 'SIMPLE',
      insured: false,
      quoteWaitingTimeMs: 0,
    });
    // A different provider-assigned fee recipient is a different finalization, not the same one.
    const other = validateQuoteFinalization(
      bound,
      officialDryResponse(officialEcho(sent, { appFees: [{ recipient: 'e'.repeat(64), fee: 20 }] })),
    );
    expect(other.finalizationDigest).not.toBe(fin.finalizationDigest);
  });

  it('still accepts an exact echo with no provider additions (no extension recorded)', () => {
    const fin = validateQuoteFinalization(bound, officialDryResponse({ ...sent }));
    expect(fin.extensions['providerDefaultedRequestFields']).toBeUndefined();
  });

  it('accepts each documented default fee rate (1, 20, 25 bps) and nothing else', () => {
    for (const fee of [1, 20, 25]) {
      const echo = officialEcho(sent, { appFees: [{ recipient: FEE_RECIPIENT, fee }] });
      expect(codeOf(() => validateQuoteFinalization(bound, officialDryResponse(echo)))).toBe('NO_ERROR');
    }
    for (const appFees of [
      [{ recipient: FEE_RECIPIENT, fee: 50 }],
      [{ recipient: FEE_RECIPIENT, fee: 0 }],
      [],
      [
        { recipient: FEE_RECIPIENT, fee: 20 },
        { recipient: 'e'.repeat(64), fee: 20 },
      ],
    ]) {
      const echo = officialEcho(sent, { appFees });
      expect(codeOf(() => validateQuoteFinalization(bound, officialDryResponse(echo)))).toBe(
        'RS_FINALIZATION_REQUEST_MISMATCH',
      );
    }
  });

  it('rejects any change to a sent request-known field', () => {
    const changes: Record<string, unknown> = {
      amount: '100000000000000000000001',
      originAsset: 'nep141:usdt.tether-token.near',
      destinationAsset: 'nep141:wrap.near',
      recipient: '1'.repeat(64),
      refundTo: '1'.repeat(64),
      dry: false,
      swapType: 'EXACT_OUTPUT',
      slippageTolerance: 50,
      depositType: 'INTENTS',
      refundType: 'INTENTS',
      recipientType: 'INTENTS',
      deadline: '2026-11-13T05:01:34.000Z',
    };
    for (const [field, value] of Object.entries(changes)) {
      const echo = officialEcho(sent, { [field]: value });
      expect(
        codeOf(() => validateQuoteFinalization(bound, officialDryResponse(echo))),
        `changed ${field}`,
      ).toBe('RS_FINALIZATION_REQUEST_MISMATCH');
    }
  });

  it('rejects a dropped sent field and a provider change to an optional field the client sent', () => {
    const { slippageTolerance: _s, ...dropped } = officialEcho(sent);
    expect(codeOf(() => validateQuoteFinalization(bound, officialDryResponse(dropped)))).not.toBe('NO_ERROR');
    const withFees = sentRequest({ appFees: [{ recipient: ZERO, fee: 30 }], insured: false });
    const b2 = validateQuoteRequest(withFees);
    expect(codeOf(() => validateQuoteFinalization(b2, officialDryResponse(officialEcho(withFees))))).toBe(
      'RS_FINALIZATION_REQUEST_MISMATCH',
    );
    expect(
      codeOf(() =>
        validateQuoteFinalization(
          b2,
          officialDryResponse(officialEcho(withFees, { appFees: [{ recipient: ZERO, fee: 30 }] })),
        ),
      ),
    ).toBe('NO_ERROR');
    const insured = sentRequest({ insured: true });
    expect(
      codeOf(() =>
        validateQuoteFinalization(validateQuoteRequest(insured), officialDryResponse(officialEcho(insured))),
      ),
    ).toBe('RS_FINALIZATION_REQUEST_MISMATCH');
  });

  it('rejects a provider-added non-default value or a field with no documented default', () => {
    const cases: Record<string, unknown> = {
      depositMode: 'MEMO',
      confidentiality: 'basic',
      quoteWaitingTimeMs: 3000,
      insured: true,
      referral: 'someone',
      sessionId: 'session-x',
      connectedWallets: [ZERO],
      virtualChainRecipient: '0x' + '1'.repeat(40),
      customRecipientMsg: 'msg',
      rebates: [{ recipient: FEE_RECIPIENT, share: 100 }],
    };
    for (const [field, value] of Object.entries(cases)) {
      const echo = officialEcho(sent, { [field]: value });
      expect(
        codeOf(() => validateQuoteFinalization(bound, officialDryResponse(echo))),
        `added ${field}`,
      ).toBe('RS_FINALIZATION_REQUEST_MISMATCH');
    }
  });

  it('treats a deadline as equivalent only for the same instant in strict ISO form', () => {
    for (const deadline of [
      '2026-11-13T05:01:33.000Z',
      '2026-11-13T05:01:33Z',
      '2026-11-13T06:01:33+01:00',
    ]) {
      const echo = officialEcho(sent, { deadline });
      expect(
        codeOf(() => validateQuoteFinalization(bound, officialDryResponse(echo))),
        deadline,
      ).toBe('NO_ERROR');
    }
    for (const deadline of [
      '2026-11-13T05:01:33.001Z',
      '2026-11-13T05:01:32.999Z',
      '2026-11-13T05:01:33.0000001Z',
      'not-a-time',
    ]) {
      const echo = officialEcho(sent, { deadline });
      expect(
        codeOf(() => validateQuoteFinalization(bound, officialDryResponse(echo))),
        deadline,
      ).not.toBe('NO_ERROR');
    }
    // Sub-millisecond precision is not rounded away: it must match exactly.
    const fine = sentRequest({ deadline: '2026-11-13T05:01:33.0000001Z' });
    const fineBound = validateQuoteRequest(fine);
    expect(
      codeOf(() =>
        validateQuoteFinalization(
          fineBound,
          officialDryResponse(officialEcho(fine, { deadline: '2026-11-13T05:01:33.000Z' })),
        ),
      ),
    ).toBe('RS_FINALIZATION_REQUEST_MISMATCH');
    expect(
      codeOf(() =>
        validateQuoteFinalization(
          fineBound,
          officialDryResponse(officialEcho(fine, { deadline: '2026-11-13T05:01:33.0000001Z' })),
        ),
      ),
    ).toBe('NO_ERROR');
  });
});
