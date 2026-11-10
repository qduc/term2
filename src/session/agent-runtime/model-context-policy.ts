import type { CatalogModelInfo } from '../../model/providers/model-catalog/catalog.js';

/** Default-output usability allocation, not a provider capacity or optimality claim. */
export function resolveOutputAllocation(
  catalog: CatalogModelInfo | undefined,
  selected: number | undefined,
  inherited: boolean,
): number | undefined {
  if (selected === undefined) return undefined;
  return Math.min(
    selected,
    catalog?.maxTokens ?? Infinity,
    inherited && catalog ? Math.max(1, Math.floor(catalog.contextWindow / 4)) : Infinity,
  );
}

export { resolveModelContextPolicy } from '@qduc/agent-core';

/** Same inherited output selection for direct agents and prepared dispatches. */
export function resolveRequestOutput(
  catalog: CatalogModelInfo | undefined,
  selected: number | undefined,
): number | undefined {
  return selected ?? (catalog ? resolveOutputAllocation(catalog, 32000, true) : undefined);
}
