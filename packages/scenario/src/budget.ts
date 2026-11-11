/**
 * Scenario resource budgets (NFR-06, SECURITY.md section 8).
 *
 * `HARD_CAPS` are the absolute ceilings of this compiler revision; a scenario's declared
 * `resourceBudget` may lower any limit but can never raise one above its hard cap. Source-level
 * limits (bytes, depth, aliases) are enforced before the declared budget is known, using the
 * caller's pre-parse limits (defaults below).
 */
import { RouteSpecError } from '@routespec/contracts';

export interface ResourceBudget {
  /** Bytes of authoring source (UTF-8). */
  readonly maxSourceBytes: number;
  /** Maximum nesting depth of the authoring document. */
  readonly maxDepth: number;
  /** Maximum YAML alias dereferences (0 disables aliases). */
  readonly maxAliases: number;
  readonly maxSteps: number;
  readonly maxGroundTruthEvents: number;
  /** Runtime event-log cap per case run. */
  readonly maxEvents: number;
  /** Total declared virtual duration (sum of every delay and late-success offset). */
  readonly maxVirtualDurationMs: number;
  readonly maxStringLength: number;
  /** Largest JSON body the proxy accepts for this scenario. */
  readonly maxBodyBytes: number;
  /** Requests a single case run may send before the runtime refuses further input. */
  readonly maxRequests: number;
}

export const HARD_CAPS: ResourceBudget = Object.freeze({
  maxSourceBytes: 1_048_576,
  maxDepth: 32,
  maxAliases: 64,
  maxSteps: 4096,
  maxGroundTruthEvents: 1024,
  maxEvents: 65_536,
  maxVirtualDurationMs: 30 * 86_400_000,
  maxStringLength: 8192,
  maxBodyBytes: 262_144,
  maxRequests: 8192,
});

export const DEFAULT_BUDGET: ResourceBudget = Object.freeze({
  maxSourceBytes: 65_536,
  maxDepth: 16,
  maxAliases: 0,
  maxSteps: 256,
  maxGroundTruthEvents: 64,
  maxEvents: 4096,
  maxVirtualDurationMs: 86_400_000,
  maxStringLength: 1024,
  maxBodyBytes: 16_384,
  maxRequests: 512,
});

export const BUDGET_KEYS = Object.freeze(Object.keys(DEFAULT_BUDGET) as Array<keyof ResourceBudget>);

export function limitExceeded(limit: keyof ResourceBudget | string, observed: number, cap: number): never {
  throw new RouteSpecError('RS_SCENARIO_LIMIT_EXCEEDED', 'Scenario exceeds a resource limit.', {
    details: { limit, observed, cap },
  });
}

/** Resolve a declared partial budget: explicit defaults, every value capped by HARD_CAPS. */
export function resolveBudget(
  declared: { readonly [K in keyof ResourceBudget]?: number | undefined } | undefined,
): ResourceBudget {
  const out: Record<string, number> = {};
  for (const key of BUDGET_KEYS) {
    const value = declared?.[key] ?? DEFAULT_BUDGET[key];
    if (value > HARD_CAPS[key]) limitExceeded(key, value, HARD_CAPS[key]);
    out[key] = value;
  }
  return Object.freeze(out) as unknown as ResourceBudget;
}
