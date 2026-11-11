/**
 * Canonical replay digest (INV-09, FR-06, NFR-01; owned test T-009).
 *
 * A pure function of the mandatory replay identity, the compiled scenario revision, the seed,
 * and the ordered client exchange sequence. The runtime is re-executed from the start for every
 * evaluation; nothing host-, time-, or process-dependent enters the digest. Wall-clock and host
 * metadata belong only to the separately digested run envelope (contracts `RunEnvelope`).
 */
import {
  DigestString,
  RouteSpecError,
  digestValue,
  z,
  type Digest,
  type ErrorCode,
} from '@routespec/contracts';
import type { CompiledScenario } from './compile.ts';
import {
  RUNTIME_REVISION,
  ScenarioRuntime,
  type Decision,
  type RuntimeSummary,
  type ScenarioRequest,
} from './runtime.ts';

const Id = z.string().min(1).max(128);

/** Every field is mandatory; optional identities are explicit `null`, never omitted. */
export const ReplayIdentity = z
  .object({
    projectRevisionId: Id,
    buildRevisionId: Id,
    artifactDigest: DigestString,
    buildAttestationClass: z.enum(['USER_ASSERTED_LOCAL', 'TRUSTED_LAUNCHER', 'CI_ATTESTED']),
    buildAttestationId: Id.nullable(),
    gateRunId: Id,
    caseRunId: Id,
    runOperationLineage: z
      .array(z.object({ relation: z.string().min(1).max(32), runOperationId: Id }).strict())
      .max(64),
    scenarioRevisionDigest: DigestString,
    seed: z.string().min(1).max(128),
    adapterRevision: Id,
    protocolProfileId: Id,
    evaluatorRevision: Id,
    effectCoveragePolicyDigest: DigestString,
    effectManifestDigest: DigestString,
    callsiteInventoryDigest: DigestString.nullable(),
    interceptorProfileDigest: DigestString.nullable(),
    configurationDigest: DigestString,
    fencingEpoch: z.number().int().min(0),
  })
  .strict();
export type ReplayIdentity = z.infer<typeof ReplayIdentity>;

export interface ReplayExchange {
  readonly request: ScenarioRequest;
  /** When set, the journal refused this request with the given code (it consumes no step). */
  readonly deniedWith?: ErrorCode;
}

export interface ReplayResult {
  readonly digest: Digest;
  readonly decisions: readonly Decision[];
  readonly summary: RuntimeSummary;
}

/** Re-execute a compiled scenario over an ordered client exchange sequence. */
export function replayScenario(
  compiled: CompiledScenario,
  exchanges: readonly ReplayExchange[],
): {
  decisions: Decision[];
  summary: RuntimeSummary;
} {
  const runtime = new ScenarioRuntime(compiled.plan);
  const decisions: Decision[] = [];
  for (const ex of exchanges) {
    if (ex.deniedWith !== undefined) {
      runtime.deny(ex.request, ex.deniedWith);
      continue;
    }
    decisions.push(runtime.commit(runtime.planRequest(ex.request)));
  }
  return { decisions, summary: runtime.finish() };
}

export function canonicalReplayDigest(
  identityInput: unknown,
  compiled: CompiledScenario,
  exchanges: readonly ReplayExchange[],
): ReplayResult {
  const parsed = ReplayIdentity.safeParse(identityInput);
  if (!parsed.success) {
    throw new RouteSpecError('RS_SCHEMA_INVALID', 'Replay identity is incomplete or malformed.', {
      details: { issues: parsed.error.issues.slice(0, 8).map((i) => `${i.path.join('.')}: ${i.code}`) },
    });
  }
  const identity = parsed.data;
  if (identity.scenarioRevisionDigest !== compiled.revisionDigest) {
    throw new RouteSpecError('RS_IDENTITY_MISMATCH', 'Replay identity names a different scenario revision.', {
      details: { field: 'scenarioRevisionDigest' },
    });
  }
  if (identity.seed !== compiled.plan.seed) {
    throw new RouteSpecError(
      'RS_IDENTITY_MISMATCH',
      'Replay identity seed differs from the scenario revision.',
      {
        details: { field: 'seed' },
      },
    );
  }
  const { decisions, summary } = replayScenario(compiled, exchanges);
  const digest = digestValue('routespec.replay-result/1', {
    identity,
    runtimeRevision: RUNTIME_REVISION,
    exchanges: exchanges.map((ex) => ({
      route: ex.request.route,
      material: ex.request.material ?? null,
      logicalJobKey: ex.request.logicalJobKey ?? null,
      deniedWith: ex.deniedWith ?? null,
    })),
    decisions: decisions.map((d) => ({
      kind: d.kind,
      stepId: d.stepId,
      virtualMs: d.virtualMs,
      releasedBarriers: [...d.releasedBarriers],
      rawStatus: d.rawStatus,
      rejectCode: d.rejectCode,
      quoteResponse: d.quoteResponse ?? null,
    })),
    eventLogDigest: summary.eventLogDigest,
    canonicalTimer: summary.canonicalTimer,
  });
  return { digest, decisions, summary };
}
