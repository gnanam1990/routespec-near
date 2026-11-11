/** Shared M05 product flows built only from real product APIs (see product.ts). */
import type { CaseEvaluation } from '@routespec/kernel';
import type { CompiledScenario } from '@routespec/scenario';
import { compileIncident } from '../../src/index.ts';
import { LIVE_INVARIANTS, Subject, type Build, type Product } from './product.ts';

export interface BaselineRun {
  readonly build: Build;
  readonly compiled: CompiledScenario;
  readonly scenarioRevisionId: string;
  readonly corpusRevisionId: string;
  readonly gateRunId: string;
  readonly caseRunIds: string[];
  readonly evaluations: CaseEvaluation[];
  readonly outcomes: Array<Record<string, unknown>>;
}

/**
 * The installed baseline client runs the issue-383-derived scenario from the release corpus.
 * Its cases are evaluated by the kernel from the journal; nothing about the result is assumed.
 */
export async function runBaselineIncident(
  p: Product,
  options: { cases?: number; label?: string; compiled?: CompiledScenario } = {},
): Promise<BaselineRun> {
  const compiled = options.compiled ?? compileIncident('issue-383-lost-commit-refund');
  const { scenarioRevisionId } = p.store.createScenarioRevision({
    ...compiled.revisionInput,
    reviewStatus: 'REVIEWED',
  });
  const { corpusRevisionId } = p.store.createCorpusRevision({
    label: options.label ?? 'release-corpus',
    cases: [
      { scenarioRevisionId, requiredInvariants: LIVE_INVARIANTS, severity: 'HIGH', gatePolicy: 'REQUIRED' },
    ],
  });
  const build = p.registerBuild('baseline-client');
  const count = options.cases ?? 1;
  const gate = p.createGateRun(
    build,
    corpusRevisionId,
    Array.from({ length: count }, () => ({
      compiled,
      scenarioRevisionId,
      lineageRole: 'BASELINE' as const,
      requiredInvariants: LIVE_INVARIANTS,
    })),
  );
  const subject = await Subject.launch('baseline-client');
  const evaluations: CaseEvaluation[] = [];
  const outcomes: Array<Record<string, unknown>> = [];
  try {
    for (let i = 0; i < gate.caseRunIds.length; i++) {
      const caseRunId = gate.caseRunIds[i] as string;
      outcomes.push(
        await p.runCase(
          subject,
          caseRunId,
          compiled,
          { logicalJob: `order-${i + 1}`, txHash: `sim-tx-baseline-${i + 1}` },
          i === 0 ? 'attach' : 'reset',
        ),
      );
      evaluations.push(p.evaluate(caseRunId).evaluation);
    }
  } finally {
    await subject.close();
  }
  return {
    build,
    compiled,
    scenarioRevisionId,
    corpusRevisionId,
    gateRunId: gate.gateRunId,
    caseRunIds: gate.caseRunIds,
    evaluations,
    outcomes,
  };
}
