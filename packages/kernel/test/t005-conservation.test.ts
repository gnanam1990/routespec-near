/**
 * T-005 — Observable value conserves in base units. Covers INV-05.
 *
 * Property-based (fast-check) over arbitrary-precision base-unit integers up to 78 digits:
 * origin-asset debit/refund/fee/locked partitions and destination-asset quote obligations.
 * Valid per-asset partitions pass; unlike-asset addition, one-unit drift, wrong destination
 * asset, quote shortfall, and positive unexplained loss fail; missing or private legs review.
 * Display (USD) values are not part of the kernel input and cannot change the verdict.
 *
 * Journal-backed: the incomplete-deposit-refund and happy-path scenarios run through the real
 * proxy/supervisor/journal and conserve.
 */
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluateInv05, type EvidenceRecord, type KernelInput } from '../src/index.ts';
import { ASSETS, baseInput, evidence, mutate } from './support/pure.ts';
import {
  Harness,
  compileCore,
  createGate,
  evaluateFromJournal,
  openStore,
  pollStatus,
  quoteAndCommit,
  tempDir,
} from './support/journal.ts';

// Legs and their sums stay within the 78-digit base-unit bound the journal enforces.
const MAX = 10n ** 76n;
const big = (max = MAX) => fc.bigInt({ min: 0n, max });

interface Ledger {
  amountIn: bigint;
  refund: bigint;
  fee: bigint;
  locked: bigint;
  delivered: boolean;
  minOut: bigint;
  credit: bigint;
}

/** Build a kernel input for one operation from a ledger description. */
function ledgerInput(l: Ledger, extra: (EvidenceRecord | null)[] = [], debitOverride?: bigint): KernelInput {
  const debit = debitOverride ?? (l.delivered ? l.amountIn : 0n) + l.refund + l.fee + l.locked;
  return mutate(baseInput(), (dr) => {
    const op = dr.runOperations[0]!;
    op.quote.amountIn = l.amountIn.toString();
    op.quote.minAmountOut = l.minOut.toString();
    op.quote.amountOut = l.minOut.toString();
    op.acceptedTerminalStatus = l.delivered ? 'SUCCESS' : 'REFUNDED';
    const legs: EvidenceRecord[] = [
      evidence({ subject: 'origin_debit', sequence: 40, assetId: ASSETS.origin, amount: debit.toString() }),
    ];
    if (l.refund > 0n || !l.delivered) {
      legs.push(
        evidence({
          subject: 'refund_settlement',
          sequence: 41,
          assetId: ASSETS.origin,
          amount: l.refund.toString(),
        }),
      );
    }
    if (l.fee > 0n)
      legs.push(
        evidence({ subject: 'origin_fee', sequence: 42, assetId: ASSETS.origin, amount: l.fee.toString() }),
      );
    if (l.locked > 0n) {
      legs.push(
        evidence({
          subject: 'locked_value',
          sequence: 43,
          assetId: ASSETS.origin,
          amount: l.locked.toString(),
        }),
      );
    }
    if (l.delivered) {
      legs.push(
        evidence({
          subject: 'destination_credit',
          sequence: 44,
          assetId: ASSETS.destination,
          amount: l.credit.toString(),
        }),
      );
    }
    for (const e of extra) if (e) legs.push(e);
    dr.evidence = legs as typeof dr.evidence;
  });
}

const ledger = fc
  .record({
    amountIn: big(),
    refund: big(),
    fee: big(),
    locked: big(),
    delivered: fc.boolean(),
    minOut: big(),
    surplus: big(10n ** 30n),
  })
  .map(({ surplus, ...l }) => ({ ...l, credit: l.minOut + surplus }));

const verdictOf = (input: KernelInput) => evaluateInv05(input)[0]!;

describe('T-005 — Observable value conserves in base units', () => {
  it('valid per-asset partitions pass for arbitrary-precision amounts', () => {
    fc.assert(
      fc.property(ledger, (l) => {
        const r = verdictOf(ledgerInput(l));
        expect(r.explanationCode).toBe('INV05_CONSERVED');
        expect(r.verdict).toBe('PASS');
      }),
      { numRuns: 300 },
    );
  });

  it('one-unit drift either way fails (unexplained loss or base-unit drift)', () => {
    fc.assert(
      fc.property(ledger, fc.boolean(), (l, up) => {
        const debit = (l.delivered ? l.amountIn : 0n) + l.refund + l.fee + l.locked;
        if (!up && debit === 0n) return;
        const r = verdictOf(ledgerInput(l, [], up ? debit + 1n : debit - 1n));
        expect(r.verdict).toBe('FAIL');
        expect(r.explanationCode).toBe(up ? 'INV05_UNEXPLAINED_LOSS' : 'INV05_BASE_UNIT_DRIFT');
      }),
      { numRuns: 300 },
    );
  });

  it('unlike assets are never added: a fee leg in a third asset cannot explain an origin loss', () => {
    fc.assert(
      fc.property(ledger, fc.bigInt({ min: 1n, max: MAX }), (l, fee) => {
        const debit = (l.delivered ? l.amountIn : 0n) + l.refund + l.fee + l.locked + fee;
        const thirdAssetFee = evidence({
          subject: 'origin_fee',
          sequence: 45,
          assetId: 'nep141:third.sim',
          amount: fee.toString(),
        });
        const r = verdictOf(ledgerInput(l, [thirdAssetFee], debit));
        expect(r.verdict).toBe('FAIL');
        expect(r.explanationCode).toBe('INV05_UNEXPLAINED_LOSS');
        expect(r.findings).toContain('SEPARATE_ASSET_LEDGER:nep141:third.sim');
      }),
      { numRuns: 200 },
    );
    // An origin debit recorded in the destination asset is not added to the origin ledger.
    const l: Ledger = {
      amountIn: 5n,
      refund: 0n,
      fee: 0n,
      locked: 0n,
      delivered: true,
      minOut: 4n,
      credit: 4n,
    };
    const wrongAssetDebit = mutate(
      ledgerInput(l),
      (dr) => void (dr.evidence[0]!.assetId = ASSETS.destination),
    );
    expect(verdictOf(wrongAssetDebit).explanationCode).toBe('INV05_BASE_UNIT_DRIFT');
  });

  it('wrong destination asset, wrong recipient, and quote shortfall fail', () => {
    fc.assert(
      fc.property(
        ledger.filter((l) => l.delivered && l.minOut > 0n),
        (l) => {
          const wrongAsset = mutate(ledgerInput(l), (dr) => {
            dr.evidence.find((e) => e.subject === 'destination_credit')!.assetId = 'nep141:other.sim';
          });
          expect(verdictOf(wrongAsset).explanationCode).toBe('INV05_WRONG_DESTINATION_ASSET');
          const shortfall = ledgerInput({ ...l, credit: l.minOut - 1n });
          expect(verdictOf(shortfall).explanationCode).toBe('INV05_QUOTE_SHORTFALL');
          const wrongRecipient = mutate(ledgerInput(l), (dr) => {
            dr.evidence.find((e) => e.subject === 'destination_credit')!.recipientDigest =
              'sha256:' + 'e'.repeat(64);
          });
          expect(verdictOf(wrongRecipient).explanationCode).toBe('INV05_WRONG_RECIPIENT');
        },
      ),
      { numRuns: 200 },
    );
    // EXACT_OUTPUT requires the exact quoted output.
    const l: Ledger = {
      amountIn: 10n,
      refund: 0n,
      fee: 0n,
      locked: 0n,
      delivered: true,
      minOut: 7n,
      credit: 8n,
    };
    const exact = mutate(ledgerInput(l), (dr) => void (dr.runOperations[0]!.quote.swapType = 'EXACT_OUTPUT'));
    expect(verdictOf(exact).explanationCode).toBe('INV05_QUOTE_SHORTFALL');
  });

  it('missing or private legs review, never pass, and wrong-asset proof still fails over a private leg', () => {
    fc.assert(
      fc.property(
        ledger.filter((l) => l.delivered),
        fc.constantFrom('missing', 'private', 'reported', 'stale'),
        (l, kind) => {
          const input = mutate(ledgerInput(l), (dr) => {
            const i = dr.evidence.findIndex((e) => e.subject === 'destination_credit');
            if (kind === 'missing') dr.evidence.splice(i, 1);
            else if (kind === 'private') {
              Object.assign(dr.evidence[i]!, {
                evidenceClass: 'UNKNOWN',
                evidenceScope: 'PRIVATE_NOT_VISIBLE',
                reasons: ['NOT_VISIBLE'],
                amount: null,
                assetId: null,
              });
            } else if (kind === 'reported')
              Object.assign(dr.evidence[i]!, {
                evidenceClass: 'REPORTED',
                evidenceScope: 'PROVIDER_REPORTED',
              });
            else Object.assign(dr.evidence[i]!, { evidenceClass: 'STALE' });
          });
          const r = verdictOf(input);
          expect(r.verdict).toBe('REVIEW');
          if (kind === 'private') {
            expect(r.explanationCode).toBe('INV05_LEG_NOT_VISIBLE');
            expect(r.reasons).toContain('NOT_VISIBLE');
          }
        },
      ),
      { numRuns: 200 },
    );
    const l: Ledger = {
      amountIn: 10n,
      refund: 0n,
      fee: 0n,
      locked: 0n,
      delivered: true,
      minOut: 7n,
      credit: 8n,
    };
    const mixed = mutate(ledgerInput(l), (dr) => {
      dr.evidence.find((e) => e.subject === 'destination_credit')!.assetId = 'nep141:other.sim';
      dr.evidence.push({
        ...dr.evidence[0]!,
        evidenceId: '00000000-0000-4000-8000-000000000777',
        sequence: 77,
        subject: 'origin_fee',
        evidenceClass: 'UNKNOWN',
        evidenceScope: 'PRIVATE_NOT_VISIBLE',
        reasons: ['NOT_VISIBLE'],
      });
    });
    expect(verdictOf(mixed).explanationCode).toBe('INV05_WRONG_DESTINATION_ASSET');
  });

  it('display USD never substitutes for proof: the kernel input carries no display values', () => {
    const input = baseInput();
    expect(JSON.stringify(input)).not.toMatch(/Usd|usd|Formatted/);
  });
});

describe('T-005 — journal-backed conservation through the real proxy', () => {
  let tmp: ReturnType<typeof tempDir>;
  afterEach(() => tmp.cleanup());

  it('a refunded incomplete deposit and a delivered swap both conserve in base units', async () => {
    tmp = tempDir();
    const store = openStore(tmp.dir);
    const h = await Harness.start(store);
    try {
      for (const scenario of ['incomplete-deposit-refund', 'happy-path']) {
        const compiled = compileCore(scenario);
        const gate = createGate(store, compiled, { label: `t005-${scenario}` });
        const caseRunId = gate.caseRunIds[0] as string;
        h.startCase(caseRunId, compiled);
        const op = await quoteAndCommit(h, caseRunId, `t005-${scenario}`);
        expect(op.commit.status).toBe(200);
        for (let i = 1; i <= 3; i++) {
          const s = await pollStatus(h, caseRunId, op, `t005-${scenario}-s${i}`);
          if (s.status !== 200) break;
          const raw = (s.body as { status: string }).status;
          if (raw === 'SUCCESS' || raw === 'REFUNDED') break;
        }
        h.supervisor.teardown(caseRunId);
        const { evaluation } = evaluateFromJournal(store, caseRunId);
        const inv05 = evaluation.invariantResults.filter((r) => r.invariantId === 'INV-05');
        expect(
          inv05.map((r) => r.explanationCode),
          scenario,
        ).toEqual(['INV05_CONSERVED']);
      }
    } finally {
      await h.close();
      store.close();
    }
  });
});
