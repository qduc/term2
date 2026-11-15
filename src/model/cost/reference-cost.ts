/** Catalog comparisons for subscription usage, never charges or budget inputs. */
import { computeModelCost, summarizeCost, type ModelRequestCost } from '../../shared/cost/model-cost.js';
import { MODEL_CATALOG } from '../providers/model-catalog/catalog.generated.js';
import { getModelPricing } from './pricing.js';
import { isSubscriptionProvider } from './subscription-providers.js';

const matches = new Map<string, { provider: string; id: string } | null>();

/** Reprice recorded subscription usage using today's exact catalog model rates, separately from spend. */
export function subscriptionReferenceCost(records: readonly ModelRequestCost[]) {
  const catalog = MODEL_CATALOG as Record<
    string,
    Record<string, { inputPricePerMTok?: number; outputPricePerMTok?: number }>
  >;
  const references = records
    .filter((record) => isSubscriptionProvider(record.provider))
    .map((record) => {
      const model = record.model.trim().toLowerCase();
      if (!matches.has(model)) {
        const candidates = Object.entries(catalog).flatMap(([provider, models]) =>
          Object.entries(models)
            .filter(
              ([id, price]) =>
                (id === model || (model.indexOf('/') === -1 && id.endsWith(`/${model}`))) &&
                price.inputPricePerMTok !== undefined &&
                price.outputPricePerMTok !== undefined,
            )
            .map(([id]) => ({ provider, id })),
        );
        // A bare model name shared by different vendors is not enough to pick a price.
        matches.set(model, new Set(candidates.map(({ id }) => id)).size === 1 ? candidates[0]! : null);
      }
      const match = matches.get(model);
      return computeModelCost({
        requestId: record.requestId,
        provider: record.provider,
        model: record.model,
        serviceTier: record.serviceTier,
        outcome: record.outcome,
        usage: record.usage,
        getPrice: () => {
          const price = match
            ? getModelPricing(match.provider, match.id, record.serviceTier)
            : ({ found: false, reason: 'unknown_model' } as const);
          if (
            price.found &&
            (record.usage?.cache_read_tokens ?? 0) > 0 &&
            (price.price.cacheReadPerMTok === undefined ||
              price.price.tiers?.some((tier) => tier.cacheReadPerMTok === undefined))
          )
            return { found: false, reason: 'unknown_model' };
          return price;
        },
      });
    });
  return references.length ? summarizeCost(references) : undefined;
}
