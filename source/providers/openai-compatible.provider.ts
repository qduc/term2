import { Runner } from '@openai/agents';
import type { ProviderDefinition } from './registry.js';
import { OpenAICompatibleProvider } from './openai-compatible/provider.js';
import { buildOpenAICompatibleUrl, normalizeBaseUrl } from './openai-compatible/utils.js';

export type CustomProviderConfig = {
  name: string;
  baseUrl: string;
  apiKey?: string;
};

function findConfigFromSettings(settingsService: any, providerId: string): CustomProviderConfig | null {
  const list = settingsService?.get?.('providers');
  if (!Array.isArray(list)) return null;
  const entry = list.find((p: any) => p && p.name === providerId);
  if (!entry) return null;

  return {
    name: String(entry.name),
    baseUrl: String(entry.baseUrl),
    apiKey: entry.apiKey ? String(entry.apiKey) : undefined,
  };
}

function toLabel(name: string): string {
  return name;
}

export function createOpenAICompatibleProviderDefinition(config: CustomProviderConfig): ProviderDefinition {
  const providerId = config.name;
  const label = toLabel(config.name);

  return {
    id: providerId,
    label,
    isRuntimeDefined: true,
    createRunner: ({ settingsService, loggingService }) => {
      // baseUrl/apiKey can change only with restart, but we re-resolve from
      // settings at runner creation time to respect precedence.
      return new Runner({
        modelProvider: new OpenAICompatibleProvider({
          settingsService,
          loggingService,
          providerId,
        }),
      });
    },
    fetchModels: async (deps, fetchImpl = fetch as any) => {
      const resolved = findConfigFromSettings(deps.settingsService, providerId);
      if (!resolved) {
        throw new Error(`Custom provider '${providerId}' is not configured in settings.json`);
      }

      const baseUrl = normalizeBaseUrl(resolved.baseUrl);
      const url = buildOpenAICompatibleUrl(baseUrl, '/v1/models');

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (resolved.apiKey) {
        headers.Authorization = `Bearer ${resolved.apiKey}`;
      }

      const response = await fetchImpl(url, { headers });
      if (!response.ok) {
        throw new Error(`${label} models request failed (${response.status})`);
      }

      const body = await response.json();
      const raw = body?.data || [];
      if (!Array.isArray(raw)) return [];

      return raw
        .map((item: any) => {
          const id = item?.id || item?.model || '';
          const name = item?.name || item?.display_name || item?.description;
          return id ? { id, name } : null;
        })
        .filter(Boolean) as Array<{ id: string; name?: string }>;
    },
    // apiKey is optional and may be stored in settings.json for local servers.
    sensitiveSettingKeys: [],
    capabilities: {
      supportsConversationChaining: false,
      supportsTracingControl: false,
    },
  };
}
