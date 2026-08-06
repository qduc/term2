import { MODEL_CATALOG } from './catalog.generated.js';

/** Slim, term2-owned model metadata vendored from the pi-ai catalog. */
export interface CatalogModelInfo {
  contextWindow: number;
  maxTokens?: number;
}

/** provider id -> model id -> model metadata */
export type ModelCatalogData = Record<string, Record<string, CatalogModelInfo>>;

function normalizeId(id: string): string {
  return id.trim().toLowerCase();
}

/**
 * Pure catalog lookup against an explicit catalog; exported so the matching
 * rules are unit-testable with synthetic data. Production callers should use
 * getCatalogModel/getModelContextWindow over the vendored catalog.
 *
 * Matching: exact model id first; otherwise the longest catalog id that is a
 * dash-bounded prefix of the requested id (so dated aliases like
 * `claude-sonnet-4-6-20251120` resolve to `claude-sonnet-4-6`). A prefix must
 * end on a `-` boundary so `gpt-4` never matches `gpt-4o`.
 */
export function lookupModel(
  catalog: ModelCatalogData,
  providerId: string,
  modelId: string,
): CatalogModelInfo | undefined {
  const provider = catalog[normalizeId(providerId)];
  if (!provider) return undefined;

  const wanted = normalizeId(modelId);
  const exact = provider[wanted];
  if (exact) return exact;

  let best: CatalogModelInfo | undefined;
  let bestLength = 0;
  for (const [catalogId, info] of Object.entries(provider)) {
    if (
      catalogId.length > bestLength &&
      wanted.length > catalogId.length &&
      wanted.startsWith(catalogId) &&
      wanted[catalogId.length] === '-'
    ) {
      best = info;
      bestLength = catalogId.length;
    }
  }
  return best;
}

/** Look up vendored metadata for a provider/model pair. */
export function getCatalogModel(providerId: string, modelId: string): CatalogModelInfo | undefined {
  return lookupModel(MODEL_CATALOG, providerId, modelId);
}

/** Context window in tokens for a provider/model pair, when the catalog knows it. */
export function getModelContextWindow(providerId: string, modelId: string): number | undefined {
  return getCatalogModel(providerId, modelId)?.contextWindow;
}
