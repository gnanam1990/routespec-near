/**
 * Journal gate snapshot -> aggregator input (pure mapping). Unexpected shapes fail closed.
 *
 * Stored case results are re-validated here: the canonical JSON is parsed through the closed
 * contract schema and its digest recomputed, so a tampered or unreadable result can never be
 * counted as PASS.
 */
import {
  CANONICAL_RESULT_SCHEMA_VERSION,
  RouteSpecError,
  computeCanonicalResultDigest,
  normalizeCanonicalResult,
  type CanonicalCaseResult,
  type EnforcementMode,
  type ExecutionLifecycle,
  type SubjectAttestationClass,
  type Verdict,
} from '@routespec/contracts';
import type { GateSnapshotRows } from '@routespec/store';
import type { GateCaseInput, GateIdentity, GateInput } from './aggregate.ts';

type Row = Readonly<Record<string, unknown>>;

function bad(field: string): never {
  throw new RouteSpecError('RS_INTERNAL', 'Gate snapshot row has an unexpected shape.', {
    details: { field },
  });
}
function s(row: Row, key: string): string {
  const v = row[key];
  return typeof v === 'string' ? v : bad(key);
}
function sn(row: Row, key: string): string | null {
  const v = row[key];
  return v === null || v === undefined ? null : typeof v === 'string' ? v : bad(key);
}
function n(row: Row, key: string): number {
  const v = row[key];
  return typeof v === 'number' && Number.isSafeInteger(v) ? v : bad(key);
}

export interface RuntimeRevisions {
  readonly evaluatorRevision: string;
  readonly proxyRevision: string;
}

function readResult(row: Row): GateCaseInput['result'] {
  let canonical: CanonicalCaseResult | null = null;
  let recomputedDigest: string | null = null;
  try {
    const parsed = JSON.parse(s(row, 'canonical_json')) as unknown;
    canonical = normalizeCanonicalResult(parsed);
    recomputedDigest = computeCanonicalResultDigest(canonical);
  } catch {
    canonical = null;
    recomputedDigest = null;
  }
  return {
    storedDigest: s(row, 'result_digest'),
    recomputedDigest,
    canonical,
    verdict: s(row, 'verdict') as Verdict,
    evaluatorRevision: s(row, 'evaluator_revision'),
    fencingEpoch: n(row, 'fencing_epoch'),
    sessionId: s(row, 'session_id'),
  };
}

export function gateInputFromSnapshot(rows: GateSnapshotRows, runtime: RuntimeRevisions): GateInput {
  const g = rows.gateRun;
  const definition = rows.definition;
  const resultsByCase = new Map(rows.caseResults.map((r) => [s(r, 'case_run_id'), r]));
  const interrupted = new Set(rows.interruptions.map((i) => s(i, 'case_run_id')));
  const caseByOrdinal = new Map(rows.caseRuns.map((c) => [n(c, 'case_ordinal'), c]));
  const corpusByOrdinal = new Map(rows.corpusCases.map((c) => [n(c, 'case_ordinal'), c]));
  const casePolicy = new Map(
    (rows.casePolicies ?? []).map((p) => [s(p, 'case_run_id'), s(p, 'effect_coverage_policy_digest')]),
  );
  const ordinals = [...new Set([...caseByOrdinal.keys(), ...corpusByOrdinal.keys()])].sort((a, b) => a - b);
  const cases: GateCaseInput[] = ordinals.map((ordinal) => {
    const c = caseByOrdinal.get(ordinal) ?? null;
    const k = corpusByOrdinal.get(ordinal) ?? null;
    const result = c ? resultsByCase.get(s(c, 'case_run_id')) : undefined;
    return {
      ordinal,
      corpusCase: k
        ? {
            scenarioRevisionId: s(k, 'scenario_revision_id'),
            requiredInvariants: JSON.parse(s(k, 'required_invariants_json')) as string[],
            gatePolicy: s(k, 'gate_policy'),
          }
        : null,
      caseRun: c
        ? {
            caseRunId: s(c, 'case_run_id'),
            gateRunId: s(c, 'gate_run_id'),
            scenarioRevisionId: s(c, 'scenario_revision_id'),
            requiredInvariants: JSON.parse(s(c, 'required_invariants_json')) as string[],
            adapterRevision: s(c, 'adapter_revision'),
            lifecycle: s(c, 'execution_lifecycle') as ExecutionLifecycle,
            verdict: sn(c, 'verdict') as Verdict | null,
            fencingEpoch: n(c, 'fencing_epoch'),
            sessionId: sn(c, 'session_id'),
            clientInstanceDigest: sn(c, 'client_instance_digest'),
            teardownRecorded: typeof c['teardown_recorded_at_ms'] === 'number',
            terminalResultDigest: sn(c, 'terminal_result_digest'),
            effectCoveragePolicyDigest: casePolicy.get(s(c, 'case_run_id')) ?? null,
          }
        : null,
      result: result ? readResult(result) : null,
      interrupted: c ? interrupted.has(s(c, 'case_run_id')) : false,
    };
  });
  const identity: GateIdentity = {
    gateRunId: s(g, 'gate_run_id'),
    gateRunIdentityDigest: s(g, 'identity_digest'),
    gateDefinitionRevisionId: sn(g, 'gate_definition_revision_id'),
    projectId: s(g, 'project_id'),
    integrationRevisionId: s(g, 'integration_revision_id'),
    buildRevisionId: s(g, 'build_revision_id'),
    artifactDigest: s(g, 'artifact_digest'),
    buildAttestationClass: s(g, 'build_attestation_class') as SubjectAttestationClass,
    buildAttestationId: sn(g, 'build_attestation_id'),
    corpusRevisionId: s(g, 'corpus_revision_id'),
    protocolProfileId: s(g, 'protocol_profile_id'),
    adapterRevision: s(g, 'adapter_revision'),
    evaluatorRevision: s(g, 'evaluator_revision'),
    proxyRevision: s(g, 'proxy_revision'),
    configurationDigest: s(g, 'configuration_digest'),
    effectManifestDigest: s(g, 'effect_manifest_digest'),
    effectCoveragePolicyDigest: s(g, 'effect_coverage_policy_digest'),
    callsiteInventoryDigest: sn(g, 'callsite_inventory_digest'),
    interceptorProfileDigest: sn(g, 'interceptor_profile_digest'),
    maxParallelCases: n(g, 'max_parallel_cases'),
    journalSchemaVersion: rows.schemaVersion,
    canonicalResultSchemaVersion: CANONICAL_RESULT_SCHEMA_VERSION,
    buildAttestationPolicy: definition?.buildAttestationPolicy ?? 'ALLOW_USER_ASSERTED',
    cases: cases.map((c) => ({
      ordinal: c.ordinal,
      caseRunId: c.caseRun?.caseRunId ?? null,
      scenarioRevisionId: c.caseRun?.scenarioRevisionId ?? c.corpusCase?.scenarioRevisionId ?? 'missing',
      sessionId: c.caseRun?.sessionId ?? null,
      fencingEpoch: c.caseRun?.fencingEpoch ?? null,
      ...(c.caseRun?.effectCoveragePolicyDigest
        ? { effectCoveragePolicyDigest: c.caseRun.effectCoveragePolicyDigest }
        : {}),
    })),
  };
  const enforcementMode: EnforcementMode = definition?.enforcementMode ?? 'LOCAL_ADVISORY';
  return {
    identity,
    gateLifecycle: s(g, 'execution_lifecycle') as ExecutionLifecycle,
    enforcementMode,
    cases,
    runtime,
  };
}

/** The exact case states the decision was computed from (re-checked inside the write). */
export function expectedStates(rows: GateSnapshotRows): {
  gateLifecycle: string;
  caseStates: Array<{
    caseRunId: string;
    lifecycle: string;
    fencingEpoch: number;
    terminalResultDigest: string | null;
  }>;
} {
  return {
    gateLifecycle: s(rows.gateRun, 'execution_lifecycle'),
    caseStates: rows.caseRuns.map((c) => ({
      caseRunId: s(c, 'case_run_id'),
      lifecycle: s(c, 'execution_lifecycle'),
      fencingEpoch: n(c, 'fencing_epoch'),
      terminalResultDigest: sn(c, 'terminal_result_digest'),
    })),
  };
}
