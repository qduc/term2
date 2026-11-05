export type DecisionModelInfo = {
  id: string;
  name?: string;
};

const DECISION_MODELS_URL = 'https://openrouter.ai/api/v1/models?output_modalities=decisions';

function parseDecisionModels(payload: unknown): DecisionModelInfo[] | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;
  const models: DecisionModelInfo[] = [];
  for (const entry of data) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { id, name } = entry as { id?: unknown; name?: unknown };
    if (typeof id !== 'string' || id.length === 0) continue;
    models.push({ id, ...(typeof name === 'string' && name.length > 0 ? { name } : {}) });
  }
  return models;
}

/** Fetch and validate OpenRouter's public Decisions catalog; cache ownership stays with the caller. */
export async function fetchOpenRouterDecisionModels(
  fetchImpl: typeof fetch = fetch,
): Promise<DecisionModelInfo[] | null> {
  try {
    const response = await fetchImpl(DECISION_MODELS_URL);
    if (!response.ok) return null;
    return parseDecisionModels(await response.json());
  } catch {
    return null;
  }
}
