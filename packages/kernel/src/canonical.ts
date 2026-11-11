/**
 * Kernel evaluation to the closed canonical case result (contracts `CanonicalCaseResult`) and the
 * per-operation invariant rows the journal persists. Pure mapping.
 *
 * Canonical facts are the provider raw observations (class REPORTED / UNKNOWN, scope
 * PROVIDER_REPORTED, keyed by their journal event) and the independently proven derived facts
 * (keyed by the proving evidence item). They stay separate records with separate class/scope.
 */
import {
  digestValue,
  normalizeCanonicalResult,
  type CanonicalCaseResult,
  type EvidenceReason,
  type Verdict,
} from '@routespec/contracts';
import type { CaseEvaluation } from './evaluate.ts';
import { deriveProviderFacts } from './provider-facts.ts';
import type { KernelInput } from './types.ts';
import { combineVerdicts } from './verdict.ts';

export interface PersistableEvaluation {
  readonly verdict: Verdict;
  readonly evaluatorRevision: string;
  readonly invariantResults: ReadonlyArray<{
    invariantId: string;
    verdict: Verdict;
    runOperationId: string | null;
    evidenceIds: readonly string[];
    missingPredicates: readonly string[];
    reasons: readonly EvidenceReason[];
  }>;
  readonly canonical: CanonicalCaseResult;
}

function sortedUnique<T extends string>(values: Iterable<T>): T[] {
  return [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function toCanonicalCaseResult(input: KernelInput, evaluation: CaseEvaluation): CanonicalCaseResult {
  const id = input.identity;
  const facts: CanonicalCaseResult['facts'] = [];
  const view = deriveProviderFacts(input);
  const evidenceById = new Map(input.evidence.map((e) => [e.evidenceId, e]));
  for (const op of view.operations) {
    for (const r of op.rawObservations) {
      facts.push({
        sequence: r.sequence,
        factKind: r.mappedFact,
        evidenceId: r.eventId,
        evidenceClass: r.evidenceClass,
        evidenceScope: 'PROVIDER_REPORTED',
        reasons: r.known ? [] : ['UNSUPPORTED'],
        payloadDigest: digestValue('routespec.status-observation/1', { rawStatus: r.rawStatus }),
      });
    }
    for (const d of op.derivedFacts) {
      if (d.basis !== 'INDEPENDENT_PROOF') continue;
      const e = d.evidenceIds.map((x) => evidenceById.get(x)).find((x) => x !== undefined);
      if (!e) continue;
      facts.push({
        sequence: e.sequence,
        factKind: d.fact,
        evidenceId: e.evidenceId,
        evidenceClass: e.evidenceClass,
        evidenceScope: e.evidenceScope,
        reasons: [...e.reasons],
        payloadDigest: e.payloadDigest,
      });
    }
  }
  const invariantIds = sortedUnique(evaluation.invariantResults.map((r) => r.invariantId));
  return normalizeCanonicalResult({
    schemaVersion: '1.0',
    projectId: id.projectId,
    integrationRevisionId: id.integrationRevisionId,
    buildRevisionId: id.buildRevisionId,
    artifactDigest: id.artifactDigest,
    buildAttestationClass: id.buildAttestationClass,
    buildAttestationId: id.buildAttestationId,
    caseLaunchAttestationId: id.caseLaunchAttestationId,
    gateRunId: id.gateRunId,
    caseRunId: id.caseRunId,
    sessionId: id.sessionId,
    corpusRevisionId: id.corpusRevisionId,
    scenarioRevisionId: id.scenarioRevisionId,
    seed: id.seed,
    protocolProfileId: id.protocolProfileId,
    adapterRevision: id.adapterRevision,
    evaluatorRevision: evaluation.evaluatorRevision,
    configurationDigest: id.configurationDigest,
    effectCoveragePolicyDigest: id.effectCoveragePolicyDigest,
    effectManifestDigest: id.effectManifestDigest,
    callsiteInventoryDigest: id.callsiteInventoryDigest,
    interceptorInstanceId: id.interceptorInstanceId,
    fencingEpoch: id.fencingEpoch,
    runOperations: input.runOperations.map((op) => ({
      runOperationId: op.runOperationId,
      logicalJobId: op.logicalJobId,
      quoteRequestDigest: op.quoteRequestDigest,
      quoteFinalizationDigest: op.quoteFinalizationDigest,
      commitBindingDigest: op.commitBindingDigest,
      lineage: input.lineage
        .filter((l) => l.fromRunOperationId === op.runOperationId)
        .map((l) => ({ relation: l.relation, runOperationId: l.toRunOperationId })),
    })),
    exchanges: input.exchanges.map((x) => ({
      sequence: x.sequence,
      transportRequestId: x.transportRequestId,
      phase: x.phase,
      method: x.method,
      routeTemplate: x.routeTemplate,
      requestDigest: x.requestDigest,
      responseDigest: x.responseDigest,
      runOperationId: x.runOperationId,
    })),
    facts,
    invariantResults: invariantIds.map((invariantId) => {
      const rs = evaluation.invariantResults.filter((r) => r.invariantId === invariantId);
      return {
        invariantId,
        verdict: combineVerdicts(rs.map((r) => r.verdict)),
        evidenceIds: sortedUnique(rs.flatMap((r) => r.evidenceIds)),
        missingPredicates: sortedUnique(rs.flatMap((r) => r.missingPredicates)).slice(0, 256),
        reasons: sortedUnique(rs.flatMap((r) => r.reasons)),
      };
    }),
    verdict: evaluation.verdict,
  });
}

/** Everything `RouteSpecStore.persistCaseEvaluation` needs except the run envelope. */
export function toPersistableEvaluation(
  input: KernelInput,
  evaluation: CaseEvaluation,
): PersistableEvaluation {
  return {
    verdict: evaluation.verdict,
    evaluatorRevision: evaluation.evaluatorRevision,
    invariantResults: evaluation.invariantResults.map((r) => ({
      invariantId: r.invariantId,
      verdict: r.verdict,
      runOperationId: r.runOperationId,
      evidenceIds: r.evidenceIds,
      missingPredicates: r.missingPredicates,
      reasons: r.reasons,
    })),
    canonical: toCanonicalCaseResult(input, evaluation),
  };
}
