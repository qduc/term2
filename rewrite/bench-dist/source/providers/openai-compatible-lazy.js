import { neuralwattDefaultReasoningLevel } from './neuralwatt.provider.js';
import { resolveProviderCredentialValue } from '../utils/ai/provider-credentials.js';
export function createOpenAICompatibleProviderDefinition(config) {
    const providerId = config.name;
    const label = config.label ?? config.name;
    return {
        id: providerId,
        label,
        isRuntimeDefined: true,
        defaultReasoningLevel: neuralwattDefaultReasoningLevel(providerId),
        createStreamedModel: async (model, { settingsService, loggingService, sessionContextService }) => {
            const { createCustomProviderModelProvider } = await import('./openai-compatible.provider.js');
            const list = settingsService.getDynamic('providers');
            const entry = Array.isArray(list)
                ? list.find((p) => p && (p.id === providerId || p.name === providerId))
                : null;
            if (!entry)
                throw new Error(`Custom provider '${providerId}' is not configured.`);
            const resolvedConfig = {
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
            });
            if (!('getStreamedModel' in provider) || typeof provider.getStreamedModel !== 'function') {
                throw new Error(`Custom provider '${providerId}' has no application-owned streamed model`);
            }
            return provider.getStreamedModel(model);
        },
        fetchModels: async (deps, fetchImpl = fetch) => {
            const { createOpenAICompatibleProviderDefinition: getRealDefinition } = await import('./openai-compatible.provider.js');
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
//# sourceMappingURL=openai-compatible-lazy.js.map