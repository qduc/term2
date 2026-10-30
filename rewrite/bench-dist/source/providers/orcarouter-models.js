import { getModelListItems, mapModelListItem } from './openai-compatible-models.js';
/** Identify the OrcaRouter API by its exact hostname, independent of its configured label. */
export function isOrcaRouterBaseUrl(baseUrl) {
    try {
        return new URL(baseUrl).hostname === 'api.orcarouter.ai';
    }
    catch {
        return false;
    }
}
/**
 * Normalize OrcaRouter's catalog to text-generation models usable by the
 * configured protocol. Null/empty advertised endpoints are ineligible;
 * minimal model records without capability metadata retain compatibility.
 */
export function parseOrcaRouterModels(providerType, body) {
    const endpointType = providerType === 'anthropic' ? 'anthropic' : providerType === 'google' ? 'gemini' : 'openai';
    const items = getModelListItems(providerType, body);
    if (!items) {
        return [];
    }
    return items.flatMap((item) => {
        // Output modalities describe generation, not vision/video input support.
        const outputs = item?.architecture?.output_modalities;
        if (Array.isArray(outputs) && (outputs.length !== 1 || outputs[0] !== 'text')) {
            return [];
        }
        if (item &&
            typeof item === 'object' &&
            'supported_endpoint_types' in item &&
            (!Array.isArray(item.supported_endpoint_types) || !item.supported_endpoint_types.includes(endpointType))) {
            return [];
        }
        const model = mapModelListItem(providerType, item);
        return model ? [model] : [];
    });
}
//# sourceMappingURL=orcarouter-models.js.map