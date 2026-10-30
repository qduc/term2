import { MODEL_CATALOG } from './catalog.generated.js';
function normalizeId(id) {
    return id.trim().toLowerCase();
}
/**
 * Drop a leading `vendor/` segment. Catalog ids under aggregator providers are
 * vendor-qualified (`deepseek/deepseek-v4-flash` under openrouter) while the
 * same model reached through a gateway is usually configured bare
 * (`deepseek-v4-flash`), and vice versa; stripping makes the two comparable.
 */
function stripVendor(id) {
    const slash = id.indexOf('/');
    return slash === -1 ? id : id.slice(slash + 1);
}
/** `wanted` extends `catalogId` on a `-` boundary, so `gpt-4` never matches `gpt-4o`. */
function isDashBoundedPrefix(wanted, catalogId) {
    return wanted.length > catalogId.length && wanted.startsWith(catalogId) && wanted[catalogId.length] === '-';
}
/**
 * Match quality tiers, best first. Exactness outranks vendor-prefix agreement:
 * an id that matches exactly once a `vendor/` segment is dropped names the
 * model more precisely than a truncated prefix of the full id does. Within a
 * tier, longer matches win. Encoded as `tier * TIER_WEIGHT + matchedLength` so
 * a single numeric score orders matches across providers; the weight exceeds
 * any plausible model-id length, keeping tiers strictly separated.
 */
const TIER_WEIGHT = 1000;
const TIER_EXACT = 3;
const TIER_BARE_EXACT = 2;
const TIER_PREFIX = 1;
const TIER_BARE_PREFIX = 0;
/**
 * Score of the best match for `wanted` inside one provider's models, or
 * undefined when nothing matches. Scores are comparable across providers.
 */
function matchInModels(models, wanted) {
    const exact = models[wanted];
    if (exact)
        return { info: exact, score: TIER_EXACT * TIER_WEIGHT + wanted.length };
    const wantedBare = stripVendor(wanted);
    let best;
    const consider = (info, tier, matchedLength) => {
        const score = tier * TIER_WEIGHT + matchedLength;
        if (best === undefined || score > best.score)
            best = { info, score };
    };
    for (const [catalogId, info] of Object.entries(models)) {
        if (isDashBoundedPrefix(wanted, catalogId)) {
            consider(info, TIER_PREFIX, catalogId.length);
            continue;
        }
        // Comparing bare forms is a no-op when neither id carries a vendor prefix:
        // it can only re-derive the match just rejected, at a strictly lower tier.
        const catalogBare = stripVendor(catalogId);
        if (catalogBare === wantedBare) {
            consider(info, TIER_BARE_EXACT, catalogBare.length);
        }
        else if (isDashBoundedPrefix(wantedBare, catalogBare)) {
            consider(info, TIER_BARE_PREFIX, catalogBare.length);
        }
    }
    return best;
}
/**
 * Pure catalog lookup against an explicit catalog; exported so the matching
 * rules are unit-testable with synthetic data. Production callers should use
 * getCatalogModel/getModelContextWindow over the vendored catalog.
 *
 * Matching: exact model id first; otherwise the longest catalog id that is a
 * dash-bounded prefix of the requested id (so dated aliases like
 * `claude-sonnet-4-6-20251120` resolve to `claude-sonnet-4-6`). A prefix must
 * end on a `-` boundary so `gpt-4` never matches `gpt-4o`. Both rules are then
 * retried with any leading `vendor/` segment dropped from either side, so a
 * gateway's bare `deepseek-v4-flash` reaches `deepseek/deepseek-v4-flash`.
 */
export function lookupModel(catalog, providerId, modelId) {
    const provider = catalog[normalizeId(providerId)];
    if (!provider)
        return undefined;
    return matchInModels(provider, normalizeId(modelId))?.info;
}
/**
 * Every provider's best entry for a model id, best match first, using the same
 * exact/dash-bounded-prefix rules as the provider-scoped lookup. Callers that
 * need more than the first hit (pricing skips entries with no vendored price)
 * walk the list; callers that just want metadata take `[0]`.
 *
 * Ordering is by match quality, not catalog order: an exact hit under one
 * provider outranks a prefix hit under another, and among prefix hits the
 * longer prefix wins. Ties keep catalog order.
 */
export function findModelMatches(catalog, modelId) {
    const wanted = normalizeId(modelId);
    const matches = [];
    for (const [providerId, models] of Object.entries(catalog)) {
        const match = matchInModels(models, wanted);
        if (match)
            matches.push({ providerId, info: match.info, score: match.score });
    }
    return matches.sort((a, b) => b.score - a.score).map(({ providerId, info }) => ({ providerId, info }));
}
/**
 * Lookup by model id across every provider in the catalog. Used as a fallback
 * when the provider-scoped lookup misses, because a model id is a more
 * reliable key than the provider id: term2 users may run a catalog model
 * through a custom or unregistered provider (e.g. Claude via a proxy, or any
 * OpenAI-compatible gateway, where the settings layer falls back to the
 * default provider). Cross-provider duplicates in the vendored catalog agree
 * on the model's shape, so any hit is authoritative.
 */
export function lookupModelAnyProvider(catalog, modelId) {
    return findModelMatches(catalog, modelId)[0]?.info;
}
/**
 * Look up vendored metadata for a model. The provider id is only a preference:
 * it picks which entry wins when several providers list the same model, and a
 * miss there falls back to matching the model id alone.
 */
export function getCatalogModel(providerId, modelId) {
    return lookupModel(MODEL_CATALOG, providerId, modelId) ?? lookupModelAnyProvider(MODEL_CATALOG, modelId);
}
/** Context window in tokens for a provider/model pair, when the catalog knows it. */
export function getModelContextWindow(providerId, modelId) {
    return getCatalogModel(providerId, modelId)?.contextWindow;
}
//# sourceMappingURL=catalog.js.map