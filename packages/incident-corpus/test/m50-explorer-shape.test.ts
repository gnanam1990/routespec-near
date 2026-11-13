/**
 * M50: the importer's view of the Intents Explorer API is the documented one. The schema and
 * the query builder are checked against values taken from the public OpenAPI document
 * (`EXPLORER_API_SPEC`), and the hand-authored fixture is checked to be that shape.
 */
import { describe, expect, it } from 'vitest';
import {
  EXPLORER_API_SPEC,
  EXPLORER_ORIGIN,
  EXPLORER_STATUSES,
  EXPLORER_TRANSACTIONS_PATH,
  ExplorerTransactionCore,
  ExplorerTransactionDocumented,
  KNOWN_REFUND_REASONS,
  buildTransactionsQuery,
} from '../src/index.ts';
import { fixtureDoc } from './support/fixture.ts';

describe('M50 documented Explorer API shape', () => {
  it('pins the documented origin, path, statuses and refund reasons', () => {
    expect(EXPLORER_ORIGIN).toBe('https://explorer.near-intents.org');
    expect(EXPLORER_TRANSACTIONS_PATH).toBe('/api/v0/transactions');
    expect([...EXPLORER_STATUSES].sort()).toEqual(
      ['FAILED', 'INCOMPLETE_DEPOSIT', 'PENDING_DEPOSIT', 'PROCESSING', 'REFUNDED', 'SUCCESS'].sort(),
    );
    expect(KNOWN_REFUND_REASONS).toEqual([
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
    ]);
    expect(EXPLORER_API_SPEC.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('accepts the example record of the public document', () => {
    // Field values are the `example` values printed in the public OpenAPI document.
    const example = {
      originAsset: 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near',
      destinationAsset: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
      depositAddress: 'GDJ4JZXZELZD737NVFORH4PSSQDWFDZTKW3AIDKHYQG23ZXBPDGGQBJK',
      depositMemo: '12345',
      depositAddressAndMemo: 'GDJ4JZXZELZD737NVFORH4PSSQDWFDZTKW3AIDKHYQG23ZXBPDGGQBJK_12345',
      recipient: 'somebody.near',
      status: 'SUCCESS',
      createdAt: '2025-12-31T12:00:00.000Z',
      createdAtTimestamp: 1767182400,
      intentHashes: 'GnGk38hvi92tTWDYMMS8CWYnVT4fixmfBrnqSErCDMTu',
      referral: 'some-referral',
      amountInFormatted: '22.130108',
      amountOutFormatted: '22.113697',
      appFees: [
        { fee: 50, recipient: 'some.near' },
        { fee: 5, recipient: 'somebody.near' },
      ],
      nearTxHashes: ['6XqqDwoaopgg39QsEiFGs9HfwP2Vum9tCCyqHDYXWBBH'],
      originChainTxHashes: ['0x9bcff372aee89b648c922b850573b22387c31d693079f5e37cd255814e2d615a'],
      destinationChainTxHashes: ['0x9bcff372aee89b648c922b850573b22387c31d693079f5e37cd255814e2d615a'],
      amountIn: '22130108',
      amountInUsd: '22.1272',
      amountOut: '22113697',
      amountOutUsd: '22.1108',
      refundTo: 'somebody.near',
      senders: ['0x1234567890abcdef1234567890abcdef12345678'],
      refundReason: 'AMOUNT_MORE_THAN_BALANCE',
      refundFee: '1000',
      refundFeeFormatted: '0.001',
      depositType: 'ORIGIN_CHAIN',
      recipientType: 'DESTINATION_CHAIN',
      refundType: 'ORIGIN_CHAIN',
    };
    expect(ExplorerTransactionDocumented.safeParse(example).success).toBe(true);
    expect(ExplorerTransactionCore.safeParse(example).success).toBe(true);
    // A documented required field that is missing is a deviation from the documented shape.
    const { recipient: _recipient, ...withoutRecipient } = example;
    expect(ExplorerTransactionDocumented.safeParse(withoutRecipient).success).toBe(false);
    // The importer itself needs only status, creation time and the pagination identity.
    expect(ExplorerTransactionCore.safeParse(withoutRecipient).success).toBe(true);
    expect(ExplorerTransactionCore.safeParse({ ...example, status: 'SETTLED' }).success).toBe(false);
    expect(ExplorerTransactionCore.safeParse({ ...example, createdAtTimestamp: '1767182400' }).success).toBe(
      false,
    );
  });

  it('the hand-authored fixture is the documented shape in both observations', () => {
    const doc = fixtureDoc();
    expect(doc.recordingKind).toBe('DOCUMENTED_SHAPE_FIXTURE');
    expect(doc.apiSpecDigest).toBe(EXPLORER_API_SPEC.sha256);
    expect(doc.observations).toHaveLength(2);
    for (const obs of doc.observations) {
      expect(obs.transactions.length).toBe(14);
      for (const t of obs.transactions) {
        const parsed = ExplorerTransactionDocumented.safeParse(t);
        expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
      }
    }
  });

  it('builds only documented query parameters', () => {
    const q = buildTransactionsQuery({
      statuses: ['FAILED', 'REFUNDED'],
      startTimestamp: '2026-11-01T00:00:00.000Z',
      endTimestamp: '2026-11-14T00:00:00.000Z',
      numberOfTransactions: 1000,
      cursor: { depositAddress: 'addr-1', depositMemo: '7' },
    });
    expect(Object.fromEntries(q)).toEqual({
      numberOfTransactions: '1000',
      statuses: 'FAILED,REFUNDED',
      startTimestamp: '2026-11-01T00:00:00.000Z',
      endTimestamp: '2026-11-14T00:00:00.000Z',
      direction: 'next',
      lastDepositAddress: 'addr-1',
      lastDepositMemo: '7',
    });
    const first = buildTransactionsQuery({
      statuses: ['PROCESSING'],
      startTimestamp: null,
      endTimestamp: null,
      numberOfTransactions: 50,
      cursor: null,
    });
    expect(Object.fromEntries(first)).toEqual({
      numberOfTransactions: '50',
      statuses: 'PROCESSING',
      direction: 'next',
    });
    expect(() =>
      buildTransactionsQuery({
        statuses: ['PROCESSING'],
        startTimestamp: null,
        endTimestamp: null,
        numberOfTransactions: 1001,
        cursor: null,
      }),
    ).toThrow();
  });
});
