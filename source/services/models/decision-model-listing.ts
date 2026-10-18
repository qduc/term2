import { SETTING_KEYS } from '../settings/settings-schema.js';

import { fetchOpenRouterDecisionModels, type DecisionModelInfo } from '../../providers/openrouter-decision-models.js';
export type { DecisionModelInfo } from '../../providers/openrouter-decision-models.js';

const DEFAULT_TTL_MS = 60 * 60 * 1000;

let cache: { models: DecisionModelInfo[]; timestamp: number } | undefined;

export function clearDecisionModelListCache(): void {
  cache = undefined;
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

  const models = await fetchOpenRouterDecisionModels(fetchImpl);
  if (models === null) return null;

  cache = { models, timestamp: now() };
  return models;
}

/** Whether a setting's picker is populated from the Decisions catalog. */
export function isDecisionModelKey(key: string): boolean {
  return key === SETTING_KEYS.AGENT_DECISION_MODEL;
}
