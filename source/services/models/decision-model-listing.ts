import { SETTING_KEYS } from '../settings/settings-schema.js';

/**
 * Listing of OpenRouter models served by the alpha Decisions endpoint
 * (`output_modalities` contains `decisions`). Chat models on
 * `/api/v1/chat/completions` are NOT valid here: the Decisions endpoint only
 * answers typed questions about a state, so the catalog filter — not the
 * chat-model catalog — defines what `agent.autoApproveDecisionShadowModel`
 * may be set to. The endpoint is public and needs no API key.
 */

export type DecisionModelInfo = {
  id: string;
  name?: string;
};

const DECISION_MODELS_URL = 'https://openrouter.ai/api/v1/models?output_modalities=decisions';
const DEFAULT_TTL_MS = 60 * 60 * 1000;

let cache: { models: DecisionModelInfo[]; timestamp: number } | undefined;

export function clearDecisionModelListCache(): void {
  cache = undefined;
}

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

/**
 * Fetch the decisions-capable model list. Returns the cached list within the
 * TTL; returns null on fetch, HTTP, or payload failure without caching the
 * failure, so a later open of the picker retries.
 */
export async function fetchDecisionModels(opts?: {
  fetchImpl?: typeof fetch;
  ttlMs?: number;
  now?: () => number;
}): Promise<DecisionModelInfo[] | null> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts?.now ?? Date.now;

  if (cache) {
    const age = now() - cache.timestamp;
    if (age >= 0 && age < ttlMs) {
      return cache.models;
    }
    cache = undefined;
  }

  let payload: unknown;
  try {
    const response = await fetchImpl(DECISION_MODELS_URL);
    if (!response.ok) return null;
    payload = await response.json();
  } catch {
    return null;
  }

  const models = parseDecisionModels(payload);
  if (models === null) return null;

  cache = { models, timestamp: now() };
  return models;
}

/** The one setting whose picker is populated from the decisions catalog. */
export function isDecisionShadowModelKey(key: string): boolean {
  return key === SETTING_KEYS.AGENT_AUTO_APPROVE_DECISION_SHADOW_MODEL;
}
