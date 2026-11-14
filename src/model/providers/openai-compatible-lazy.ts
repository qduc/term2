import { type ProviderDefinition, type ProviderDeps, type ProviderFetch } from './registry.js';
import type { CustomProviderConfig } from './openai-compatible.provider.js';
import { neuralwattDefaultReasoningLevel } from './neuralwatt.provider.js';
import { resolveProviderCredentialValue } from '../provider-credentials.js';
import { CACHE_SAFE_EFFORT_LEVELS, supportsPerMessageEffort } from '../effort-updates.js';

export function createOpenAICompatibleProviderDefinition(config: CustomProviderConfig): ProviderDefinition {
  const providerId = config.name;
  const label = config.label ?? config.name;

  return {
    id: providerId,
    label,
    isRuntimeDefined: true,
    defaultReasoningLevel: neuralwattDefaultReasoningLevel(providerId),
    effortUpdateLevels: (model) =>
      config.type === 'anthropic' && acceptsPerMessageEffort(config) && supportsPerMessageEffort(model)
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

/**
 * Per-message effort is a first-party beta. A gateway may drop the field (OpenRouter's
 * chat endpoint did, measured 2026-11-14) or reject it, so only the first-party API is
 * assumed; any other endpoint opts in with `perMessageEffort: true`.
 */
function acceptsPerMessageEffort(config: CustomProviderConfig): boolean {
  if (config.perMessageEffort !== undefined) return config.perMessageEffort;
  if (!config.baseUrl) return true;
  try {
    return new URL(config.baseUrl).hostname === 'api.anthropic.com';
  } catch {
    return false;
  }
}
