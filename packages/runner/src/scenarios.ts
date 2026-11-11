/**
 * Rehydrate an immutable compiled scenario from its journal revision. The revision digest is
 * recomputed from the stored compiled plan, seed, budget, provenance, and compiler revision; a
 * stored row that does not reproduce its own digest fails closed.
 */
import { RouteSpecError, canonicalJson } from '@routespec/contracts';
import {
  scenarioRevisionDigest,
  type CompiledPlan,
  type CompiledScenario,
  type ResourceBudget,
} from '@routespec/scenario';

type Row = Readonly<Record<string, unknown>>;

function str(row: Row, key: string): string {
  const v = row[key];
  if (typeof v !== 'string') {
    throw new RouteSpecError('RS_INTERNAL', 'Scenario revision row has an unexpected shape.', {
      details: { key },
    });
  }
  return v;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

export function compiledFromRevision(row: Row): CompiledScenario {
  const plan = JSON.parse(str(row, 'compiled_json')) as CompiledPlan;
  const revisionInput = {
    scenarioStableId: str(row, 'scenario_stable_id'),
    schemaVersion: str(row, 'schema_version'),
    compiled: plan,
    seed: str(row, 'seed'),
    resourceBudget: JSON.parse(str(row, 'resource_budget_json')) as ResourceBudget,
    provenanceClass: str(row, 'provenance_class') as CompiledScenario['revisionInput']['provenanceClass'],
    compilerRevision: str(row, 'compiler_revision'),
  };
  const revisionDigest = scenarioRevisionDigest(revisionInput);
  if (revisionDigest !== str(row, 'revision_digest')) {
    throw new RouteSpecError(
      'RS_IDENTITY_MISMATCH',
      'Stored scenario revision does not reproduce its digest.',
      {
        details: { scenarioRevisionId: str(row, 'scenario_revision_id') },
      },
    );
  }
  return deepFreeze({ plan, canonicalJson: canonicalJson(plan), revisionDigest, revisionInput });
}
