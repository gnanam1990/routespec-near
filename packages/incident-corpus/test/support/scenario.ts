/** Parse rendered scenario source with the product's own bounded parser and strict schema. */
import { DEFAULT_BUDGET, ScenarioSource, parseScenarioSource } from '@routespec/scenario';

export function parseSource(source: string): ScenarioSource {
  return ScenarioSource.parse(
    parseScenarioSource(source, 'yaml', {
      maxSourceBytes: DEFAULT_BUDGET.maxSourceBytes,
      maxDepth: DEFAULT_BUDGET.maxDepth,
      maxAliases: DEFAULT_BUDGET.maxAliases,
      maxStringLength: DEFAULT_BUDGET.maxStringLength,
    }),
  );
}
