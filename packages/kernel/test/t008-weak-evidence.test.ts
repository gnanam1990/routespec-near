/**
 * T-008 — Weak or missing evidence never upgrades to proven. Covers FR-10, INV-08.
 *
 * Exhaustive over every evidence class x scope x (no reason | each single reason) against a
 * predicate requiring PROVEN in an accepted scope, compared with an independently written truth
 * table. Then through the whole kernel: replacing the proven destination credit with each weak
 * combination makes INV-08 and the case REVIEW, never PASS; a journal fact that claims proof
 * without proof is FAIL. Journal-backed: the same combinations recorded through the real store
 * classify identically after the snapshot round trip.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  EVIDENCE_CLASSES,
  EVIDENCE_REASONS,
  EVIDENCE_SCOPES,
  type EvidenceClass,
  type EvidenceReason,
  type EvidenceScope,
} from '@routespec/contracts';
import {
  PROOF_SCOPES,
  deriveProviderFacts,
  evaluateCase,
  evaluatePredicate,
  proofPredicate,
  snapshotFromJournal,
} from '../src/index.ts';
import { baseInput, evidence, mutate, IDS, ASSETS } from './support/pure.ts';
import { Harness, compileCore, createGate, openStore, tempDir } from './support/journal.ts';

/** Independent truth table: only PROVEN, in an independent proof scope, with no disqualifying reason. */
function shouldSatisfy(c: EvidenceClass, s: EvidenceScope, reasons: readonly EvidenceReason[]): boolean {
  return (
    c === 'PROVEN' &&
    (s === 'SIMULATED_GROUND_TRUTH' || s === 'PUBLIC_CHAIN_OBSERVATION') &&
    reasons.every((r) => r === 'NONCANONICAL_TIMER')
  );
}

const REASON_SETS: ReadonlyArray<readonly EvidenceReason[]> = [[], ...EVIDENCE_REASONS.map((r) => [r])];

describe('T-008 — Weak or missing evidence never upgrades to proven', () => {
  it('exhaustive class x scope x reason combinations: only acceptable combinations satisfy', () => {
    const id = baseInput().identity;
    let combos = 0;
    let satisfied = 0;
    for (const c of EVIDENCE_CLASSES) {
      for (const s of EVIDENCE_SCOPES) {
        for (const reasons of REASON_SETS) {
          combos++;
          const e = evidence({
            subject: 'destination_credit',
            sequence: 50,
            evidenceClass: c,
            evidenceScope: s,
            reasons: [...reasons],
          });
          const out = evaluatePredicate(
            proofPredicate('DESTINATION_CREDIT', 'destination_credit', IDS.op),
            [e],
            id,
          );
          const expected = shouldSatisfy(c, s, reasons);
          expect(out.status === 'SATISFIED', `${c}/${s}/${reasons.join(',')}`).toBe(expected);
          if (!expected) {
            expect(out.status).toBe('WEAK');
            expect(out.satisfiedBy).toEqual([]);
          }
          if (s === 'PRIVATE_NOT_VISIBLE' || reasons.includes('NOT_VISIBLE'))
            expect(out.reasons).toContain('NOT_VISIBLE');
          if (expected) satisfied++;
        }
      }
    }
    expect(combos).toBe(EVIDENCE_CLASSES.length * EVIDENCE_SCOPES.length * (EVIDENCE_REASONS.length + 1));
    expect(satisfied).toBe(PROOF_SCOPES.length * 2); // no reason, or only NONCANONICAL_TIMER
    expect(
      evaluatePredicate(proofPredicate('DESTINATION_CREDIT', 'destination_credit', IDS.op), [], id).status,
    ).toBe('MISSING');
  });

  it('a declared weaker predicate accepts only its declared class/scope, never private or not-visible', () => {
    const id = baseInput().identity;
    const reportedPredicate = {
      predicateId: 'STATUS_REPORTED',
      subject: 'provider_status',
      runOperationId: IDS.op,
      acceptClasses: ['REPORTED'] as EvidenceClass[],
      acceptScopes: ['PROVIDER_REPORTED'] as EvidenceScope[],
    };
    const ok = evidence({
      subject: 'provider_status',
      sequence: 51,
      evidenceClass: 'REPORTED',
      evidenceScope: 'PROVIDER_REPORTED',
    });
    expect(evaluatePredicate(reportedPredicate, [ok], id).status).toBe('SATISFIED');
    const privateScope = { ...ok, evidenceScope: 'PRIVATE_NOT_VISIBLE' as const };
    expect(
      evaluatePredicate({ ...reportedPredicate, acceptScopes: ['PRIVATE_NOT_VISIBLE'] }, [privateScope], id)
        .status,
    ).toBe('WEAK');
    expect(evaluatePredicate(reportedPredicate, [{ ...ok, reasons: ['NOT_VISIBLE'] }], id).status).toBe(
      'WEAK',
    );
    // A subject self-report can never be proof, even if a predicate (wrongly) declares it acceptable.
    const selfProof = evidence({
      subject: 'destination_credit',
      sequence: 52,
      evidenceClass: 'PROVEN',
      evidenceScope: 'SUBJECT_REPORTED',
    });
    const permissive = {
      ...proofPredicate('X', 'destination_credit', IDS.op),
      acceptScopes: ['SUBJECT_REPORTED'] as EvidenceScope[],
    };
    expect(evaluatePredicate(permissive, [selfProof], id).status).toBe('WEAK');
  });

  it('identity-mismatched or unbound proof does not satisfy', () => {
    const id = baseInput().identity;
    const p = proofPredicate('DESTINATION_CREDIT', 'destination_credit', IDS.op);
    for (const field of [
      'buildRevisionId',
      'caseRunId',
      'sessionId',
      'effectManifestDigest',
      'scenarioRevisionId',
    ] as const) {
      const e = evidence({
        subject: 'destination_credit',
        sequence: 53,
        [field]: '00000000-0000-4000-8000-0000000000aa',
      });
      const out = evaluatePredicate(p, [e], id);
      expect(out.status, field).toBe('WEAK');
      expect(out.reasons).toContain('IDENTITY_MISMATCH');
    }
    const unbound = evidence({ subject: 'destination_credit', sequence: 54, runOperationId: null });
    expect(evaluatePredicate(p, [unbound], id).status).toBe('WEAK');
  });

  it('through the kernel: every weak replacement of the delivery proof is REVIEW, never PASS', () => {
    let cases = 0;
    for (const c of EVIDENCE_CLASSES) {
      for (const s of EVIDENCE_SCOPES) {
        for (const reasons of REASON_SETS) {
          if (shouldSatisfy(c, s, reasons)) continue;
          cases++;
          const input = mutate(baseInput(), (dr) => {
            const credit = dr.evidence.find((e) => e.subject === 'destination_credit')!;
            Object.assign(credit, { evidenceClass: c, evidenceScope: s, reasons: [...reasons] });
          });
          const e = evaluateCase(input);
          const label = `${c}/${s}/${reasons.join(',')}`;
          expect(e.summaries.find((x) => x.invariantId === 'INV-08')?.verdict, label).toBe('REVIEW');
          expect(e.verdict, label).not.toBe('PASS');
          expect(
            deriveProviderFacts(input).operations[0]!.derivedFacts.map((f) => f.fact),
            label,
          ).not.toContain('SUCCESS_PROVEN');
        }
      }
    }
    expect(cases).toBeGreaterThan(300);
    const missing = evaluateCase(
      mutate(
        baseInput(),
        (dr) => void (dr.evidence = dr.evidence.filter((e) => e.subject !== 'destination_credit')),
      ),
    );
    expect(missing.invariantResults.find((r) => r.invariantId === 'INV-08')?.explanationCode).toBe(
      'INV08_REQUIRED_EVIDENCE_MISSING',
    );
    // The baseline released a protected effect citing that delivery proof: without it the
    // independently observed release is forbidden, so the case FAILs rather than passing.
    expect(missing.invariantResults.find((r) => r.invariantId === 'INV-04')?.explanationCode).toBe(
      'INV04_FORBIDDEN_RELEASE_OBSERVED',
    );
    expect(missing.verdict).toBe('FAIL');
    const noEffects = evaluateCase(
      mutate(baseInput(), (dr) => {
        dr.evidence = dr.evidence.filter((e) => e.subject !== 'destination_credit');
        dr.caseState.requiredInvariants = dr.caseState.requiredInvariants.filter((i) => i !== 'INV-04');
      }),
    );
    expect(noEffects.verdict).toBe('REVIEW');
  });

  it('a journal fact that claims proof without proof is an upgrade and FAILs', () => {
    const upgraded = mutate(baseInput(), (dr) => {
      dr.events[3]!.normalizedFact = 'SUCCESS_PROVEN';
      const credit = dr.evidence.find((e) => e.subject === 'destination_credit')!;
      Object.assign(credit, { evidenceClass: 'REPORTED', evidenceScope: 'PROVIDER_REPORTED' });
    });
    const r = evaluateCase(upgraded).invariantResults.find((x) => x.invariantId === 'INV-08')!;
    expect(r).toMatchObject({ verdict: 'FAIL', explanationCode: 'INV08_FACT_UPGRADED_WITHOUT_PROOF' });
  });
});

describe('T-008 — journal round trip keeps class, scope, and reasons separate', () => {
  let tmp: ReturnType<typeof tempDir>;
  afterEach(() => tmp.cleanup());

  it('evidence recorded through the real store classifies identically after the snapshot', async () => {
    tmp = tempDir();
    const store = openStore(tmp.dir);
    const h = await Harness.start(store);
    try {
      const compiled = compileCore('happy-path');
      const gate = createGate(store, compiled, { label: 't008' });
      const caseRunId = gate.caseRunIds[0] as string;
      h.startCase(caseRunId, compiled);
      const fence = h.supervisor.fenceFor(caseRunId);
      const combos: Array<[EvidenceClass, EvidenceScope, EvidenceReason[]]> = [
        ['PROVEN', 'SIMULATED_GROUND_TRUTH', []],
        ['PROVEN', 'PUBLIC_CHAIN_OBSERVATION', ['NONCANONICAL_TIMER']],
        ['PROVEN', 'SIMULATED_GROUND_TRUTH', ['NOT_VISIBLE']],
        ['PROVEN', 'SUBJECT_REPORTED', []],
        ['PROVEN', 'PROVIDER_REPORTED', []],
        ['REPORTED', 'PROVIDER_REPORTED', []],
        ['INFERRED', 'SIMULATED_GROUND_TRUTH', []],
        ['UNKNOWN', 'PRIVATE_NOT_VISIBLE', ['NOT_VISIBLE']],
        ['STALE', 'PUBLIC_CHAIN_OBSERVATION', ['STALE']],
        ['UNSUPPORTED', 'SIMULATED_GROUND_TRUTH', ['UNSUPPORTED']],
      ];
      const ids: string[] = [];
      for (const [i, [c, s, reasons]] of combos.entries()) {
        ids.push(
          store.recordEvidence(fence, {
            runOperationId: null,
            evidenceClass: c,
            evidenceScope: s,
            reasons,
            subject: `probe_subject_${i}`,
            sourceKind: 'TEST_CLASSIFICATION',
            assetId: ASSETS.destination,
            amount: '1',
            singleUse: false,
            payload: { combo: i },
          }).evidenceId,
        );
      }
      const input = snapshotFromJournal(store.readEvaluationSnapshot(caseRunId));
      for (const [i, [c, s, reasons]] of combos.entries()) {
        const e = input.evidence.find((x) => x.evidenceId === ids[i])!;
        expect([e.evidenceClass, e.evidenceScope, [...e.reasons]]).toEqual([c, s, [...reasons].sort()]);
        const out = evaluatePredicate(
          proofPredicate('P', `probe_subject_${i}`, null),
          input.evidence,
          input.identity,
        );
        expect(out.status === 'SATISFIED', `${c}/${s}/${reasons.join(',')}`).toBe(
          shouldSatisfy(c, s, reasons),
        );
      }
    } finally {
      await h.close();
      store.close();
    }
  });
});
