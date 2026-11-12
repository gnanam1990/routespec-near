/**
 * T-034 — Release aggregation follows fail-closed precedence. Covers FR-13.
 *
 * Part 1 enumerates explicit GateRun/CaseRun states through the production aggregator: every
 * ordered pair and a broad set of triples of the 22 distinct case states, plus gate-level gaps.
 * The expected decision comes from an independent oracle of the documented precedence: zero
 * started required cases is NOT_RUN; FAIL dominates; otherwise anything incomplete, cancelled,
 * aborted, crashed, recovery-pending, private, REVIEW, unsupported, stale, missing, tampered,
 * identity-mismatched, interrupted, or teardown-incomplete is REVIEW; PASS requires every exact
 * required case complete PASS. NOT_VISIBLE stays an evidence reason.
 *
 * Part 2 drives the same precedence end to end through the real CLI, journal, proxy, kernel,
 * and separately launched official-SDK subjects: cancelled and failed-client cases, a FAIL
 * among them, and a plan-only gate that starts nothing.
 */
import { describe, expect, it } from 'vitest';
import { EVALUATOR_REVISION } from '@routespec/kernel';
import { aggregateGate } from '@routespec/runner';
import { CASE_KINDS, UNSTARTED, expectedDecision, gateInput, type CaseKind } from './support/gate-fixture.ts';
import { runCliProcess, runGateWithSubjects, setupJournal, tempDir, gateRunArgs } from './support/product.ts';

const DECISIONS = new Set(['PASS', 'FAIL', 'REVIEW', 'NOT_RUN']);

describe('T-034 — Release aggregation follows fail-closed precedence', () => {
  it('enumerates every ordered pair and many triples of case states against the precedence oracle', () => {
    let checked = 0;
    const combos: CaseKind[][] = [];
    for (const a of CASE_KINDS) for (const b of CASE_KINDS) combos.push([a, b]);
    for (let i = 0; i < CASE_KINDS.length; i++) {
      for (let j = 0; j < CASE_KINDS.length; j += 3) {
        for (let k = 0; k < CASE_KINDS.length; k += 5) {
          combos.push([CASE_KINDS[i] as CaseKind, CASE_KINDS[j] as CaseKind, CASE_KINDS[k] as CaseKind]);
        }
      }
    }
    for (const kinds of combos) {
      const out = aggregateGate(gateInput(kinds));
      expect(out.decision, kinds.join(',')).toBe(expectedDecision(kinds));
      expect(DECISIONS.has(out.decision)).toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThan(CASE_KINDS.length ** 2);
  });

  it('single-case states map to their documented findings and contributions', () => {
    const expectations: Record<CaseKind, { decision: string; finding: string }> = {
      PASS: { decision: 'PASS', finding: '' },
      FAIL: { decision: 'FAIL', finding: 'CASE_FAIL' },
      REVIEW: { decision: 'REVIEW', finding: 'CASE_REVIEW' },
      UNSUPPORTED: { decision: 'REVIEW', finding: 'CASE_UNSUPPORTED' },
      RESULT_NOT_RUN: { decision: 'REVIEW', finding: 'CASE_RESULT_NOT_RUN' },
      PRIVATE_NOT_VISIBLE: { decision: 'REVIEW', finding: 'EVIDENCE_REASON:NOT_VISIBLE' },
      PENDING: { decision: 'NOT_RUN', finding: 'CASE_NOT_STARTED' },
      QUEUED: { decision: 'NOT_RUN', finding: 'CASE_NOT_STARTED' },
      RUNNING: { decision: 'REVIEW', finding: 'CASE_INCOMPLETE' },
      EVALUATING: { decision: 'REVIEW', finding: 'CASE_INCOMPLETE' },
      RECOVERY_REQUIRED: { decision: 'REVIEW', finding: 'CASE_RECOVERY_PENDING' },
      ABORTED_STARTED: { decision: 'REVIEW', finding: 'CASE_ABORTED' },
      CANCELLED_UNSTARTED: { decision: 'NOT_RUN', finding: 'CASE_CANCELLED_BEFORE_START' },
      ERROR: { decision: 'REVIEW', finding: 'CASE_ERROR' },
      MISSING: { decision: 'NOT_RUN', finding: 'CASE_MISSING' },
      INTERRUPTED_PASS: { decision: 'REVIEW', finding: 'CASE_INTERRUPTED' },
      TEARDOWN_MISSING_PASS: { decision: 'REVIEW', finding: 'TEARDOWN_MISSING' },
      IDENTITY_MISMATCH_PASS: { decision: 'REVIEW', finding: 'IDENTITY_MISMATCH:artifactDigest' },
      IDENTITY_MISMATCH_FAIL: { decision: 'REVIEW', finding: 'IDENTITY_MISMATCH:artifactDigest' },
      TAMPERED_PASS: { decision: 'REVIEW', finding: 'RESULT_DIGEST_MISMATCH' },
      STALE_EVALUATOR_PASS: { decision: 'REVIEW', finding: 'EVALUATOR_STALE' },
      RESULT_MISSING: { decision: 'REVIEW', finding: 'CASE_RESULT_MISSING' },
    };
    for (const kind of CASE_KINDS) {
      const out = aggregateGate(gateInput([kind]));
      const e = expectations[kind];
      expect(out.decision, kind).toBe(e.decision);
      if (e.finding) expect(out.cases[0]?.findings, kind).toContain(e.finding);
      // NOT_VISIBLE is never a decision or contribution.
      expect(out.cases.every((c) => (c.contribution as string) !== 'NOT_VISIBLE')).toBe(true);
    }
  });

  it('FAIL dominates every incomplete state, and only all-complete PASS required cases pass', () => {
    for (const other of CASE_KINDS) {
      expect(aggregateGate(gateInput(['FAIL', other])).decision).toBe('FAIL');
      expect(aggregateGate(gateInput([other, 'FAIL'])).decision).toBe('FAIL');
    }
    expect(aggregateGate(gateInput(['PASS', 'PASS', 'PASS'])).decision).toBe('PASS');
    for (const other of CASE_KINDS.filter((k) => k !== 'PASS' && k !== 'FAIL')) {
      expect(aggregateGate(gateInput(['PASS', 'PASS', other])).decision, other).toBe('REVIEW');
    }
    // Zero started required cases is NOT_RUN even with gate-level gaps; started + unstarted is REVIEW.
    for (const u of UNSTARTED) {
      expect(aggregateGate(gateInput([u, u], { lifecycle: 'ABORTED' })).decision).toBe('NOT_RUN');
      expect(aggregateGate(gateInput(['PASS', u])).decision).toBe('REVIEW');
    }
  });

  it('gate-level gaps make an all-PASS case set REVIEW; advisory cases never decide', () => {
    const allPass: CaseKind[] = ['PASS', 'PASS'];
    const unattested = aggregateGate(
      gateInput(allPass, { identity: { buildAttestationPolicy: 'REQUIRE_TRUSTED' } }),
    );
    expect(unattested.decision).toBe('REVIEW');
    expect(unattested.findings).toContain('BUILD_UNATTESTED');
    const allowed = aggregateGate(gateInput(allPass));
    expect(allowed.decision).toBe('PASS');
    expect(allowed.findings).toContain('BUILD_USER_ASSERTED_LOCAL');
    const stale = aggregateGate(
      gateInput(allPass, {
        runtime: { evaluatorRevision: 'routespec-kernel@9.0.0', proxyRevision: 'routespec-proxy@1.0.0' },
      }),
    );
    expect(stale.decision).toBe('REVIEW');
    expect(stale.findings).toContain('GATE_EVALUATOR_STALE');
    const staleProxy = aggregateGate(
      gateInput(allPass, {
        runtime: { evaluatorRevision: EVALUATOR_REVISION, proxyRevision: 'routespec-proxy@2.0.0' },
      }),
    );
    expect(staleProxy.findings).toContain('GATE_PROXY_STALE');
    expect(staleProxy.decision).toBe('REVIEW');
    expect(aggregateGate(gateInput(allPass, { lifecycle: 'RECOVERY_REQUIRED' })).decision).toBe('REVIEW');
    expect(aggregateGate(gateInput(allPass, { lifecycle: 'ERROR' })).decision).toBe('REVIEW');
    expect(aggregateGate(gateInput([])).decision).toBe('NOT_RUN');
    expect(aggregateGate(gateInput([])).findings).toContain('NO_REQUIRED_CASES');
    // An advisory FAIL or incomplete case is reported but does not decide the gate.
    const advisory = aggregateGate(gateInput(allPass, { advisory: ['FAIL', 'RUNNING'] }));
    expect(advisory.decision).toBe('PASS');
    expect(advisory.cases.filter((c) => !c.required).map((c) => c.contribution)).toEqual(['FAIL', 'REVIEW']);
    // A client instance shared between two cases is an isolation failure, never PASS.
    const input = gateInput(allPass);
    const shared = {
      ...input,
      cases: input.cases.map((c) => ({
        ...c,
        caseRun: { ...c.caseRun!, clientInstanceDigest: 'sha256:same' },
      })),
    };
    const reused = aggregateGate(shared);
    expect(reused.decision).toBe('REVIEW');
    expect(reused.cases[0]?.findings).toContain('CLIENT_INSTANCE_REUSED');
  });

  it('a trusted build attestation is re-checked at every evaluation: revoked, disabled, changed, or missing is REVIEW (TB-07)', () => {
    const allPass: CaseKind[] = ['PASS', 'PASS'];
    const trusted = (
      cls: 'TRUSTED_LAUNCHER' | 'CI_ATTESTED',
      policy: 'REQUIRE_TRUSTED' | 'ALLOW_USER_ASSERTED',
    ) =>
      gateInput(allPass, {
        identity: {
          buildAttestationClass: cls,
          buildAttestationId: '10000000-0000-4000-8000-0000000000a1',
          buildAttestationPolicy: policy,
        },
      });
    const usable = {
      attestationId: '10000000-0000-4000-8000-0000000000a1',
      attestationClass: 'TRUSTED_LAUNCHER' as const,
      scope: 'BUILD_REGISTRATION',
      buildRevisionId: '10000000-0000-4000-8000-000000000004',
      principalEnabled: true,
      principalRevocationEpochAtIssue: 0,
      principalCurrentRevocationEpoch: 0,
      principalPolicyDigestAtIssue: 'sha256:p',
      principalCurrentPolicyDigest: 'sha256:p',
    };
    for (const cls of ['TRUSTED_LAUNCHER', 'CI_ATTESTED'] as const) {
      for (const policy of ['REQUIRE_TRUSTED', 'ALLOW_USER_ASSERTED'] as const) {
        const base = trusted(cls, policy);
        const state = { ...usable, attestationClass: cls };
        // Still usable: PASS, no attestation finding.
        const fresh = aggregateGate({ ...base, buildAttestation: state });
        expect(fresh.decision, `${cls}/${policy}`).toBe('PASS');
        expect(fresh.findings.filter((f) => f.startsWith('BUILD_'))).toEqual([]);
        const cases: Array<[Record<string, unknown> | null, string]> = [
          [{ principalEnabled: false, principalCurrentRevocationEpoch: 1 }, 'BUILD_ATTESTER_REVOKED'],
          [{ principalEnabled: false }, 'BUILD_ATTESTER_DISABLED'],
          [{ principalCurrentPolicyDigest: 'sha256:q' }, 'BUILD_ATTESTER_POLICY_CHANGED'],
          [{ buildRevisionId: '10000000-0000-4000-8000-00000000ffff' }, 'BUILD_ATTESTATION_BUILD_MISMATCH'],
          [{ scope: 'CASE_LAUNCH' }, 'BUILD_ATTESTATION_SCOPE_MISMATCH'],
          [{ attestationId: '10000000-0000-4000-8000-0000000000a2' }, 'BUILD_ATTESTATION_NOT_FOUND'],
          [null, 'BUILD_ATTESTATION_NOT_FOUND'],
        ];
        for (const [change, finding] of cases) {
          const out = aggregateGate({
            ...base,
            buildAttestation: change === null ? null : { ...state, ...change },
          });
          expect(out.decision, `${cls}/${policy}/${finding}`).toBe('REVIEW');
          expect(out.findings).toContain(finding);
          expect(out.decisionDigest).not.toBe(fresh.decisionDigest);
        }
        // An input that carries no attestation state at all fails closed too.
        const absent = aggregateGate(base);
        expect(absent.decision).toBe('REVIEW');
        expect(absent.findings).toContain('BUILD_ATTESTATION_NOT_FOUND');
      }
    }
    // FAIL still dominates a revoked attestation.
    const failing = gateInput(['FAIL', 'PASS'], {
      identity: {
        buildAttestationClass: 'TRUSTED_LAUNCHER',
        buildAttestationId: '10000000-0000-4000-8000-0000000000a1',
      },
    });
    expect(
      aggregateGate({ ...failing, buildAttestation: { ...usable, principalEnabled: false } }).decision,
    ).toBe('FAIL');
    // A user-asserted build carries no attestation state and is unchanged.
    expect(aggregateGate(gateInput(allPass)).decision).toBe('PASS');
  });

  it('end to end: cancelled and failed-client cases are REVIEW, FAIL still dominates, and a plan-only gate is NOT_RUN', async () => {
    const t = tempDir();
    try {
      const review = setupJournal(t.dir, {
        scenarios: ['happy-path', 'happy-path', 'happy-path'],
        build: 'reconciling-client',
        label: 'agg-review',
      });
      const r = await runGateWithSubjects(review, { behaviour: { 1: 'cancel', 2: 'client-fails' } });
      expect(r.exitCode).toBe(3);
      const rep = r.json?.['report'] as {
        decision: string;
        cases: Array<{ lifecycle: string; contribution: string; findings: string[] }>;
      };
      expect(rep.decision).toBe('REVIEW');
      expect(rep.cases.map((c) => [c.lifecycle, c.contribution])).toEqual([
        ['COMPLETED', 'PASS'],
        ['ABORTED', 'REVIEW'],
        ['ABORTED', 'REVIEW'],
      ]);
      expect(rep.cases[1]?.findings).toContain('CASE_ABORTED');

      const t2 = tempDir();
      try {
        const fail = setupJournal(t2.dir, {
          scenarios: ['happy-path', 'refund-shortfall', 'happy-path'],
          build: 'reconciling-client',
          label: 'agg-fail',
        });
        const f = await runGateWithSubjects(fail, { behaviour: { 2: 'cancel' } });
        expect(f.exitCode).toBe(2);
        const frep = f.json?.['report'] as { decision: string; cases: Array<{ contribution: string }> };
        expect(frep.decision).toBe('FAIL');
        expect(frep.cases.map((c) => c.contribution)).toEqual(['PASS', 'FAIL', 'REVIEW']);
      } finally {
        t2.cleanup();
      }

      const t3 = tempDir();
      try {
        const plan = setupJournal(t3.dir, {
          scenarios: ['happy-path', 'happy-path'],
          build: 'reconciling-client',
          label: 'agg-plan',
        });
        const p = await runCliProcess(gateRunArgs(plan, ['--plan-only']));
        expect(p.exitCode).toBe(3);
        const prep = p.json?.['report'] as {
          decision: string;
          cases: Array<{ lifecycle: string; findings: string[] }>;
        };
        expect(prep.decision).toBe('NOT_RUN');
        expect(
          prep.cases.every(
            (c) => c.lifecycle === 'ABORTED' && c.findings.includes('CASE_CANCELLED_BEFORE_START'),
          ),
        ).toBe(true);
      } finally {
        t3.cleanup();
      }
    } finally {
      t.cleanup();
    }
  });
});
