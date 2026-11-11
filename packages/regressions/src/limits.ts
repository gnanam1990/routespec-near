/**
 * Import resource limits (NFR-06). Explicit, configurable, with safe defaults; a configured
 * value can lower a limit but never raise it above the hard cap of this scanner revision.
 */
import { RouteSpecError } from '@routespec/contracts';

export interface ImportLimits {
  /** Raw source bytes streamed before the source is rejected. */
  readonly maxBytes: number;
  readonly maxDepth: number;
  readonly maxStringLength: number;
  /** Total trace records (exchanges + events + evidence + reports + observations + denials). */
  readonly maxEvents: number;
  readonly maxKeysPerObject: number;
  readonly maxNodes: number;
}

export const IMPORT_HARD_CAPS: ImportLimits = Object.freeze({
  maxBytes: 16 * 1024 * 1024,
  maxDepth: 64,
  maxStringLength: 65_536,
  maxEvents: 100_000,
  maxKeysPerObject: 1024,
  maxNodes: 2_000_000,
});

export const DEFAULT_IMPORT_LIMITS: ImportLimits = Object.freeze({
  maxBytes: 1024 * 1024,
  maxDepth: 24,
  maxStringLength: 8192,
  maxEvents: 10_000,
  maxKeysPerObject: 128,
  maxNodes: 200_000,
});

export function resolveImportLimits(partial: Partial<ImportLimits> = {}): ImportLimits {
  const out: Record<string, number> = {};
  for (const key of Object.keys(DEFAULT_IMPORT_LIMITS) as Array<keyof ImportLimits>) {
    const value = partial[key] ?? DEFAULT_IMPORT_LIMITS[key];
    if (!Number.isInteger(value) || value < 1 || value > IMPORT_HARD_CAPS[key]) {
      throw new RouteSpecError('RS_IMPORT_LIMIT_EXCEEDED', 'Import limit is outside its hard cap.', {
        details: { limit: key, value, cap: IMPORT_HARD_CAPS[key] },
      });
    }
    out[key] = value;
  }
  return Object.freeze(out) as unknown as ImportLimits;
}
