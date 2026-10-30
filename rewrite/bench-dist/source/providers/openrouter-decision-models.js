const DECISION_MODELS_URL = 'https://openrouter.ai/api/v1/models?output_modalities=decisions';
function parseDecisionModels(payload) {
    if (typeof payload !== 'object' || payload === null)
        return null;
    const data = payload.data;
    if (!Array.isArray(data))
        return null;
    const models = [];
    for (const entry of data) {
        if (typeof entry !== 'object' || entry === null)
            continue;
        const { id, name } = entry;
        if (typeof id !== 'string' || id.length === 0)
            continue;
        models.push({ id, ...(typeof name === 'string' && name.length > 0 ? { name } : {}) });
    }
    return models;
}
/** Fetch and validate OpenRouter's public Decisions catalog; cache ownership stays with the caller. */
export async function fetchOpenRouterDecisionModels(fetchImpl = fetch) {
    try {
        const response = await fetchImpl(DECISION_MODELS_URL);
        if (!response.ok)
            return null;
        return parseDecisionModels(await response.json());
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=openrouter-decision-models.js.map