/**
 * Versioned contract registry. `parseContract` fails closed on an unknown kind, a missing or
 * malformed `schemaVersion`, an unknown major version, a newer minor version than this build
 * understands, or any unknown field (all object schemas are strict).
 */
import { RouteSpecError } from '../errors.ts';
import { SCHEMA_VERSION_PATTERN, type z } from './common.ts';
import {
  AttemptRecord,
  AttesterPrincipalRecord,
  BuildRevisionRecord,
  CaseRunRecord,
  CaseTokenRecord,
  CompatibilityProbeRecord,
  EffectBoundaryObservationRecord,
  EffectCoveragePolicyRecord,
  EffectManifestRecord,
  EvidenceItemRecord,
  GateEvaluationRecord,
  GateRunRecord,
  IntegrationRevisionRecord,
  InvariantResultRecord,
  LauncherChallengeRecord,
  LogicalJobRecord,
  ProjectRecord,
  RunOperationLineageRecord,
  RunOperationRecord,
  ScenarioRevisionRef,
  SessionRecord,
  SubjectAttestationRecord,
} from './records.ts';
import { CanonicalCaseResult, RunEnvelope } from './result.ts';

interface ContractEntry {
  readonly version: string;
  readonly schema: z.ZodTypeAny;
}

export const CONTRACTS = Object.freeze({
  project: { version: '1.0', schema: ProjectRecord },
  'integration-revision': { version: '1.0', schema: IntegrationRevisionRecord },
  'build-revision': { version: '1.0', schema: BuildRevisionRecord },
  'attester-principal': { version: '1.0', schema: AttesterPrincipalRecord },
  'launcher-challenge': { version: '1.0', schema: LauncherChallengeRecord },
  'subject-attestation': { version: '1.0', schema: SubjectAttestationRecord },
  'effect-manifest': { version: '1.0', schema: EffectManifestRecord },
  'effect-coverage-policy': { version: '1.0', schema: EffectCoveragePolicyRecord },
  'effect-boundary-observation': { version: '1.0', schema: EffectBoundaryObservationRecord },
  'gate-run': { version: '1.0', schema: GateRunRecord },
  'case-run': { version: '1.0', schema: CaseRunRecord },
  session: { version: '1.0', schema: SessionRecord },
  'case-token': { version: '1.0', schema: CaseTokenRecord },
  'logical-job': { version: '1.0', schema: LogicalJobRecord },
  'run-operation': { version: '1.0', schema: RunOperationRecord },
  'run-operation-lineage': { version: '1.0', schema: RunOperationLineageRecord },
  attempt: { version: '1.0', schema: AttemptRecord },
  'evidence-item': { version: '1.0', schema: EvidenceItemRecord },
  'invariant-result': { version: '1.0', schema: InvariantResultRecord },
  'gate-evaluation': { version: '1.0', schema: GateEvaluationRecord },
  'compatibility-probe': { version: '1.0', schema: CompatibilityProbeRecord },
  'scenario-revision-ref': { version: '1.0', schema: ScenarioRevisionRef },
  'canonical-case-result': { version: '1.0', schema: CanonicalCaseResult },
  'run-envelope': { version: '1.0', schema: RunEnvelope },
} satisfies Record<string, ContractEntry>);

export type ContractKind = keyof typeof CONTRACTS;
export type ContractOf<K extends ContractKind> = z.infer<(typeof CONTRACTS)[K]['schema']>;

function parseVersion(v: string): { major: number; minor: number } {
  const m = SCHEMA_VERSION_PATTERN.exec(v);
  if (!m) throw new RouteSpecError('RS_SCHEMA_VERSION_UNSUPPORTED', 'Malformed schema version.');
  return { major: Number(m[1]), minor: Number(m[2]) };
}

export function parseContract<K extends ContractKind>(kind: K, input: unknown): ContractOf<K> {
  const entry = (CONTRACTS as Record<string, ContractEntry | undefined>)[kind];
  if (!entry) {
    throw new RouteSpecError('RS_UNKNOWN_CONTRACT_KIND', 'Unknown contract kind.', { details: { kind } });
  }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new RouteSpecError('RS_SCHEMA_INVALID', 'Contract payload must be an object.', {
      details: { kind },
    });
  }
  const declared = (input as Record<string, unknown>)['schemaVersion'];
  if (typeof declared !== 'string') {
    throw new RouteSpecError('RS_SCHEMA_VERSION_UNSUPPORTED', 'Contract payload has no schemaVersion.', {
      details: { kind },
    });
  }
  const want = parseVersion(entry.version);
  const got = parseVersion(declared);
  if (got.major !== want.major || got.minor > want.minor) {
    throw new RouteSpecError('RS_SCHEMA_VERSION_UNSUPPORTED', 'Unsupported contract schema version.', {
      details: { kind, declared, supported: entry.version },
    });
  }
  const parsed = entry.schema.safeParse(input);
  if (!parsed.success) {
    throw new RouteSpecError('RS_SCHEMA_INVALID', 'Contract payload failed closed-schema validation.', {
      details: {
        kind,
        issues: parsed.error.issues.slice(0, 8).map((i) => `${i.path.join('.')}: ${i.message}`),
      },
    });
  }
  return parsed.data as ContractOf<K>;
}
