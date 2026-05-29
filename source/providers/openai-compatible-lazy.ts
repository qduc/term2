import { Runner } from '@openai/agents';
import type { ProviderDefinition, ProviderDeps, ProviderFetch } from './registry.js';
import type { CustomProviderConfig } from './openai-compatible.provider.js';

export function createOpenAICompatibleProviderDefinition(config: CustomProviderConfig): ProviderDefinition {
  const providerId = config.name;
  const label = config.name;

  return {
    id: providerId,
    label,
    isRuntimeDefined: true,
    createRunner: ({ settingsService, loggingService }) => {
      return new Runner({
        tracingDisabled: true,
        modelProvider: {
          getModel: async (modelName?: string) => {
            const { createCustomProviderModelProvider } = await import('./openai-compatible.provider.js');
            const list = settingsService.get('providers');
            const entry = Array.isArray(list) ? list.find((p: any) => p && p.name === providerId) : null;
            if (!entry) {
              throw new Error(
                `Custom provider '${providerId}' is not configured. ` +
                  `Please add it to settings.json under "providers".`,
              );
            }
            const resolvedConfig: CustomProviderConfig = {
              name: String(entry.name),
              type: entry.type ? String(entry.type) : 'openai-compatible',
              baseUrl: entry.baseUrl ? String(entry.baseUrl) : undefined,
              apiKey: entry.apiKey ? String(entry.apiKey) : undefined,
            };
            const realProvider = createCustomProviderModelProvider(resolvedConfig, {
              defaultModel: settingsService.get('agent.model') || '',
              loggingService,
            });
            return realProvider.getModel(modelName);
          },
        },
      });
    },
    fetchModels: async (deps: ProviderDeps, fetchImpl: ProviderFetch = fetch as any) => {
      const { createOpenAICompatibleProviderDefinition: getRealDefinition } = await import(
        './openai-compatible.provider.js'
      );
      const realDef = getRealDefinition(config);
      if (!realDef.fetchModels) {
        throw new Error(`fetchModels is not implemented for custom provider ${providerId}`);
      }
      return realDef.fetchModels(deps, fetchImpl);
    },
    sensitiveSettingKeys: [],
    capabilities: {
      supportsConversationChaining: false,
      supportsTracingControl: false,
    },
  };
}
