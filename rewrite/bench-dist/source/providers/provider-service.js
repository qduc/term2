import { KNOWN_CUSTOM_PROVIDER_TYPES } from '../services/settings/settings-schema.js';
import { getAllProviders, upsertProvider, unregisterProvider } from './index.js';
import { createOpenAICompatibleProviderDefinition } from './openai-compatible-lazy.js';
import { hasProviderCredentials, isProviderDisabled } from '../utils/ai/provider-credentials.js';
import { decodeStoredCustomProviderConfigs, normalizeProviderIdentifier, resolveProviderId, } from '../services/settings/custom-provider-normalization.js';
export const PROVIDER_TYPES = [...KNOWN_CUSTOM_PROVIDER_TYPES];
export const PROVIDER_NAME_REGEX = /^[a-zA-Z0-9][-a-zA-Z0-9_.]*$/;
const getCustomProviderConfigs = (settingsService) => {
    const raw = settingsService?.getDynamic('providers');
    return decodeStoredCustomProviderConfigs(raw);
};
export const getConfiguredProviderNames = (settingsService) => {
    const names = new Set();
    for (const provider of getAllProviders()) {
        names.add(provider.id);
    }
    for (const provider of getCustomProviderConfigs(settingsService)) {
        names.add(provider.id);
    }
    return names;
};
export const hasProviderNameConflict = (settingsService, candidate, currentName) => {
    if (!candidate)
        return false;
    const normalizedCandidate = candidate.trim();
    if (!normalizedCandidate)
        return false;
    for (const name of getConfiguredProviderNames(settingsService)) {
        if (name === normalizedCandidate && name !== currentName) {
            return true;
        }
    }
    return false;
};
export const loadProviderItems = (settingsService) => {
    const all = getAllProviders();
    const customList = getCustomProviderConfigs(settingsService);
    const activeProvider = settingsService.get('agent.modelSelection').provider || 'openai';
    const providerItems = all
        .filter((p) => !p.isRuntimeDefined && hasProviderCredentials(settingsService, p.id))
        .map((p) => ({
        id: p.id,
        label: p.label,
        isCustom: false,
        isActive: p.id === activeProvider,
        hasCredentials: hasProviderCredentials(settingsService, p.id),
        isDisabled: isProviderDisabled(settingsService, p.id),
    }));
    for (const c of customList) {
        if (!providerItems.some((p) => p.id === c.id)) {
            providerItems.push({
                id: c.id,
                label: c.name,
                isCustom: true,
                isActive: c.id === activeProvider,
                hasCredentials: hasProviderCredentials(settingsService, c.id),
                isDisabled: isProviderDisabled(settingsService, c.id),
            });
        }
    }
    return providerItems.sort((a, b) => a.label.localeCompare(b.label, 'en'));
};
export const saveProvider = (settingsService, draft, editingOriginalName) => {
    if (!draft)
        return { success: false };
    const providerDef = editingOriginalName ? getAllProviders().find((p) => p.id === editingOriginalName) : null;
    const isEditingBuiltIn = providerDef ? !providerDef.isRuntimeDefined : false;
    if (isEditingBuiltIn && editingOriginalName) {
        try {
            const apiKeyKey = `agent.${editingOriginalName}.apiKey`;
            settingsService?.setPersistentDynamic(apiKeyKey, draft.apiKey || undefined);
            return { success: true };
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { success: false, errorMessage: message || 'Failed to save provider API key.' };
        }
    }
    if (!draft.name.trim()) {
        return { success: false, fieldErrors: { name: 'Name cannot be empty.' } };
    }
    const providerIdentifier = normalizeProviderIdentifier(draft.name);
    if (!PROVIDER_NAME_REGEX.test(providerIdentifier)) {
        return {
            success: false,
            fieldErrors: {
                name: 'Name must start with a letter or number and contain only letters, numbers, hyphens, underscores, and dots.',
            },
        };
    }
    const originalName = editingOriginalName;
    if (hasProviderNameConflict(settingsService, providerIdentifier, originalName ?? undefined)) {
        return { success: false, fieldErrors: { name: `Provider with name '${providerIdentifier}' already exists.` } };
    }
    const type = draft.type;
    const baseUrlRequired = type === 'openai' || type === 'openai-compatible' || type === 'llama.cpp';
    if (baseUrlRequired && !draft.baseUrl) {
        return { success: false, fieldErrors: { baseUrl: `Base URL is required for provider type '${type}'.` } };
    }
    try {
        const rawList = settingsService?.getDynamic('providers');
        const list = Array.isArray(rawList) ? rawList : [];
        const isEdit = originalName !== null;
        let updatedList;
        if (isEdit && originalName) {
            updatedList = list.filter((p) => resolveProviderId(p) !== originalName);
            if (originalName !== providerIdentifier) {
                unregisterProvider(originalName);
            }
        }
        else {
            updatedList = [...list];
        }
        const newEntry = {
            id: providerIdentifier,
            name: draft.name.trim(),
            type: draft.type,
        };
        if (draft.baseUrl)
            newEntry.baseUrl = draft.baseUrl;
        if (draft.apiKey)
            newEntry.apiKey = draft.apiKey;
        updatedList.push(newEntry);
        settingsService?.setPersistentDynamic('providers', updatedList);
        const def = createOpenAICompatibleProviderDefinition({
            name: providerIdentifier,
            label: draft.name.trim(),
            type: draft.type,
            baseUrl: draft.baseUrl,
            apiKey: draft.apiKey,
        });
        upsertProvider(def);
        if (isEdit && originalName && originalName === settingsService.get('agent.modelSelection').provider) {
            settingsService.set('agent.modelSelection', {
                ...settingsService.get('agent.modelSelection'),
                provider: providerIdentifier,
            });
        }
        return { success: true };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, errorMessage: message || 'Failed to save provider.' };
    }
};
export const deleteCustomProvider = (settingsService, name) => {
    const rawList = settingsService?.getDynamic('providers');
    const list = Array.isArray(rawList) ? rawList : [];
    const updated = list.filter((p) => resolveProviderId(p) !== name);
    settingsService?.setPersistentDynamic('providers', updated);
    unregisterProvider(name);
};
export const validateWizardName = (value, settingsService, isEditingField, editingOriginalName) => {
    const val = value.trim();
    if (!val) {
        return { valid: false, errorMessage: 'Name cannot be empty.' };
    }
    const candidateIdentifier = normalizeProviderIdentifier(val);
    if (!PROVIDER_NAME_REGEX.test(candidateIdentifier)) {
        return {
            valid: false,
            errorMessage: 'Name must start with a letter or number and contain only letters, numbers, hyphens, underscores, and dots.',
        };
    }
    const originalName = isEditingField ? editingOriginalName : undefined;
    if (hasProviderNameConflict(settingsService, candidateIdentifier, originalName)) {
        return { valid: false, errorMessage: `Provider with name '${candidateIdentifier}' already exists.` };
    }
    return { valid: true };
};
export const validateWizardUrl = (value, type) => {
    const val = value.trim();
    const baseUrlRequired = type === 'openai' || type === 'openai-compatible' || type === 'llama.cpp';
    if (baseUrlRequired && !val) {
        return { valid: false, errorMessage: `Base URL is required for provider type '${type}'.` };
    }
    if (val) {
        try {
            new URL(val);
        }
        catch {
            return { valid: false, errorMessage: 'Invalid URL format. Make sure it starts with http:// or https://' };
        }
    }
    return { valid: true };
};
export const isProviderBuiltIn = (id) => {
    const def = getAllProviders().find((p) => p.id === id);
    return def ? !def.isRuntimeDefined : false;
};
export const getProviderLabel = (id) => {
    return getAllProviders().find((p) => p.id === id)?.label;
};
//# sourceMappingURL=provider-service.js.map