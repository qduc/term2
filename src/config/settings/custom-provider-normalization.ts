import { isKnownCustomProviderType, type KnownCustomProviderType } from './settings-schema.js';

export interface StoredCustomProviderConfig {
  id: string;
  name: string;
  type: KnownCustomProviderType;
  baseUrl?: string;
  apiKey?: string;
  /**
   * Anthropic-format endpoints only: whether the endpoint accepts per-message effort
   * (beta `mid-conversation-output-config-2026-07-01`). Unset means only the first-party
   * API (no base URL, or host api.anthropic.com); a gateway must opt in.
   */
  perMessageEffort?: boolean;
}

export const normalizeProviderIdentifier = (value: string): string => value.trim().replace(/\s+/g, '_');

export const resolveProviderId = (entry: unknown): string | undefined => {
  if (!entry || typeof entry !== 'object' || entry === null) return undefined;

  const record = entry as Record<string, unknown>;
  const raw =
    (typeof record.id === 'string' && record.id) ||
    (typeof record.identifier === 'string' && record.identifier) ||
    (typeof record.name === 'string' && record.name) ||
    (typeof record.displayName === 'string' && record.displayName) ||
    undefined;

  if (!raw) return undefined;
  const normalized = normalizeProviderIdentifier(raw);
  return normalized.length > 0 ? normalized : undefined;
};

export const resolveProviderName = (entry: unknown, fallbackId: string): string => {
  if (!entry || typeof entry !== 'object' || entry === null) return fallbackId;

  const record = entry as Record<string, unknown>;
  const raw =
    (typeof record.name === 'string' && record.name) ||
    (typeof record.displayName === 'string' && record.displayName) ||
    fallbackId;

  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : fallbackId;
};

const decodeStoredCustomProviderConfig = (entry: unknown): StoredCustomProviderConfig | null => {
  if (!entry || typeof entry !== 'object' || entry === null) return null;

  const id = resolveProviderId(entry);
  if (!id) return null;

  const record = entry as Record<string, unknown>;
  const name = resolveProviderName(entry, id);

  const rawType = typeof record.type === 'string' ? record.type : 'openai-compatible';
  const type: KnownCustomProviderType = isKnownCustomProviderType(rawType) ? rawType : 'openai-compatible';

  const baseUrl =
    typeof record.baseUrl === 'string' && record.baseUrl.trim().length > 0 ? record.baseUrl.trim() : undefined;
  const apiKey =
    typeof record.apiKey === 'string' && record.apiKey.trim().length > 0 ? record.apiKey.trim() : undefined;

  return {
    id,
    name,
    type,
    baseUrl,
    apiKey,
    ...(typeof record.perMessageEffort === 'boolean' ? { perMessageEffort: record.perMessageEffort } : {}),
  };
};

export const decodeStoredCustomProviderConfigs = (raw: unknown): StoredCustomProviderConfig[] => {
  if (!Array.isArray(raw)) return [];

  const results: StoredCustomProviderConfig[] = [];
  for (const item of raw) {
    const decoded = decodeStoredCustomProviderConfig(item);
    if (decoded) {
      results.push(decoded);
    }
  }

  return results;
};
