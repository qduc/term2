import { type ProviderDefinition, type ProviderDeps, type ProviderFetch } from './registry.js';
import type { CustomProviderConfig } from './openai-compatible.provider.js';
import { neuralwattDefaultReasoningLevel } from './neuralwatt.provider.js';
import { resolveProviderCredentialValue } from '../provider-credentials.js';
import { CACHE_SAFE_EFFORT_LEVELS, endpointInScope, supportsPerMessageEffort } from '../effort-updates.js';

export function createOpenAICompatibleProviderDefinition(config: CustomProviderConfig): ProviderDefinition {
  const providerId = config.name;
  const label = config.label ?? config.name;

  return {
    id: providerId,
    label,
    isRuntimeDefined: true,
    defaultReasoningLevel: neuralwattDefaultReasoningLevel(providerId),
    effortUpdateLevels: (model, scope) =>
      config.type === 'anthropic' &&
      endpointInScope(config.baseUrl, 'api.anthropic.com', scope) &&
      supportsPerMessageEffort(model)
        ? CACHE_SAFE_EFFORT_LEVELS
        : undefined,
    createStreamedModel: async (model, { settingsService, loggingService, sessionContextService, onDispatched }) => {
      const { createCustomProviderModelProvider } = await import('./openai-compatible.provider.js');
      const list = settingsService.getDynamic('providers');
      const entry = Array.isArray(list)
        ? list.find((p: any) => p && (p.id === providerId || p.name === providerId))
        : null;
      if (!entry) throw new Error(`Custom provider '${providerId}' is not configured.`);
      const resolvedConfig: CustomProviderConfig = {
        name: entry.id ? String(entry.id) : String(entry.name),
        label: entry.name ? String(entry.name) : providerId,
        type: entry.type ? String(entry.type) : 'openai-compatible',
        baseUrl: entry.baseUrl ? String(entry.baseUrl) : undefined,
        apiKey: resolveProviderCredentialValue(settingsService, providerId),
      };
      const provider = createCustomProviderModelProvider(resolvedConfig, {
        defaultModel: model || settingsService.get('agent.modelSelection').model || '',
        loggingService,
        sessionContextService,
        settingsService,
        onDispatched,
      });
      if (!('getStreamedModel' in provider) || typeof provider.getStreamedModel !== 'function') {
        throw new Error(`Custom provider '${providerId}' has no application-owned streamed model`);
      }
      return provider.getStreamedModel(model);
    },
    fetchModels: async (deps: ProviderDeps, fetchImpl: ProviderFetch = fetch) => {
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
    },
  };
}
