import type { ISettingsService } from '../services/service-interfaces.js';
import { getAllProviders, upsertProvider, unregisterProvider } from './index.js';
import { createOpenAICompatibleProviderDefinition } from './openai-compatible-lazy.js';
import {
  decodeStoredCustomProviderConfigs,
  normalizeProviderIdentifier,
  resolveProviderId,
  type StoredCustomProviderConfig,
} from '../services/settings/custom-provider-normalization.js';

export type ProviderSelectionPhase =
  | 'list'
  | 'edit_fields'
  | 'wizard_name'
  | 'wizard_type'
  | 'wizard_url'
  | 'wizard_key'
  | 'confirm_delete'
  | 'confirm_discard'
  | 'reorder';

export interface CustomProviderDraft {
  name: string;
  type: 'openai-compatible' | 'openai' | 'llama.cpp' | 'anthropic' | 'google' | 'opencode';
  baseUrl?: string;
  apiKey?: string;
}

export interface ProviderSelectionItem {
  id: string;
  label: string;
  isCustom: boolean;
  isActive: boolean;
}

export const PROVIDER_TYPES: CustomProviderDraft['type'][] = [
  'openai-compatible',
  'openai',
  'llama.cpp',
  'anthropic',
  'google',
  'opencode',
];

export const PROVIDER_NAME_REGEX = /^[a-zA-Z0-9][-a-zA-Z0-9_.]*$/;

export const getCustomProviderConfigs = (settingsService: ISettingsService): StoredCustomProviderConfig[] => {
  const raw: unknown = settingsService?.getDynamic('providers');
  return decodeStoredCustomProviderConfigs(raw);
};

export const getConfiguredProviderNames = (settingsService: ISettingsService): Set<string> => {
  const names = new Set<string>();

  for (const provider of getAllProviders()) {
    names.add(provider.id);
  }

  for (const provider of getCustomProviderConfigs(settingsService)) {
    names.add(provider.id);
  }

  return names;
};

export const hasProviderNameConflict = (
  settingsService: ISettingsService,
  candidate: string,
  currentName?: string,
): boolean => {
  if (!candidate) return false;

  const normalizedCandidate = candidate.trim();
  if (!normalizedCandidate) return false;

  for (const name of getConfiguredProviderNames(settingsService)) {
    if (name === normalizedCandidate && name !== currentName) {
      return true;
    }
  }

  return false;
};

export const loadProviderItems = (settingsService: ISettingsService): ProviderSelectionItem[] => {
  const all = getAllProviders();
  const customList = getCustomProviderConfigs(settingsService);
  const activeProvider = settingsService.get('agent.provider') || 'openai';

  const providerItems: ProviderSelectionItem[] = all
    .filter((p) => !p.isRuntimeDefined)
    .map((p) => ({
      id: p.id,
      label: p.label,
      isCustom: false,
      isActive: p.id === activeProvider,
    }));

  for (const c of customList) {
    if (!providerItems.some((p) => p.id === c.id)) {
      providerItems.push({
        id: c.id,
        label: c.name,
        isCustom: true,
        isActive: c.id === activeProvider,
      });
    }
  }

  if (!providerItems.some((p) => p.id === activeProvider)) {
    providerItems.push({
      id: activeProvider,
      label: activeProvider,
      isCustom: customList.some((c) => c.id === activeProvider),
      isActive: true,
    });
  }

  return providerItems;
};

export interface SaveProviderResult {
  success: boolean;
  errorMessage?: string;
  fieldErrors?: Record<string, string>;
}

export const saveProvider = (
  settingsService: ISettingsService,
  draft: CustomProviderDraft,
  editingOriginalName: string | null,
): SaveProviderResult => {
  if (!draft) return { success: false };

  const providerDef = editingOriginalName ? getAllProviders().find((p) => p.id === editingOriginalName) : null;
  const isEditingBuiltIn = providerDef ? !providerDef.isRuntimeDefined : false;

  if (isEditingBuiltIn && editingOriginalName) {
    try {
      const apiKeyKey = `agent.${editingOriginalName}.apiKey`;
      settingsService?.setPersistentDynamic(apiKeyKey, draft.apiKey || undefined);
      return { success: true };
    } catch (err: unknown) {
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
    const rawList: unknown = settingsService?.getDynamic('providers');
    const list = Array.isArray(rawList) ? rawList : [];
    const isEdit = originalName !== null;
    let updatedList: unknown[];

    if (isEdit && originalName) {
      updatedList = list.filter((p: unknown) => resolveProviderId(p) !== originalName);
      if (originalName !== providerIdentifier) {
        unregisterProvider(originalName);
      }
    } else {
      updatedList = [...list];
    }

    const newEntry: Record<string, unknown> = {
      id: providerIdentifier,
      name: draft.name.trim(),
      type: draft.type,
    };
    if (draft.baseUrl) newEntry.baseUrl = draft.baseUrl;
    if (draft.apiKey) newEntry.apiKey = draft.apiKey;

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

    if (isEdit && originalName && originalName === settingsService.get('agent.provider')) {
      settingsService.set('agent.provider', providerIdentifier);
    }

    return { success: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, errorMessage: message || 'Failed to save provider.' };
  }
};

export const deleteCustomProvider = (settingsService: ISettingsService, name: string): void => {
  const rawList: unknown = settingsService?.getDynamic('providers');
  const list = Array.isArray(rawList) ? rawList : [];
  const updated = list.filter((p: unknown) => resolveProviderId(p) !== name);

  settingsService?.setPersistentDynamic('providers', updated);
  unregisterProvider(name);

  const activeProvider = settingsService.get('agent.provider');
  if (activeProvider === name) {
    settingsService.set('agent.provider', 'openai');
  }
};

export const validateWizardName = (
  value: string,
  settingsService: ISettingsService,
  isEditingField: boolean,
  editingOriginalName?: string,
): { valid: boolean; errorMessage?: string } => {
  const val = value.trim();
  if (!val) {
    return { valid: false, errorMessage: 'Name cannot be empty.' };
  }
  const candidateIdentifier = normalizeProviderIdentifier(val);
  if (!PROVIDER_NAME_REGEX.test(candidateIdentifier)) {
    return {
      valid: false,
      errorMessage:
        'Name must start with a letter or number and contain only letters, numbers, hyphens, underscores, and dots.',
    };
  }
  const originalName = isEditingField ? editingOriginalName : undefined;
  if (hasProviderNameConflict(settingsService, candidateIdentifier, originalName)) {
    return { valid: false, errorMessage: `Provider with name '${candidateIdentifier}' already exists.` };
  }
  return { valid: true };
};

export const validateWizardUrl = (value: string, type: string): { valid: boolean; errorMessage?: string } => {
  const val = value.trim();
  const baseUrlRequired = type === 'openai' || type === 'openai-compatible' || type === 'llama.cpp';
  if (baseUrlRequired && !val) {
    return { valid: false, errorMessage: `Base URL is required for provider type '${type}'.` };
  }
  if (val) {
    try {
      new URL(val);
    } catch {
      return { valid: false, errorMessage: 'Invalid URL format. Make sure it starts with http:// or https://' };
    }
  }
  return { valid: true };
};

export const isProviderBuiltIn = (id: string): boolean => {
  const def = getAllProviders().find((p) => p.id === id);
  return def ? !def.isRuntimeDefined : false;
};

export const getProviderLabel = (id: string): string | undefined => {
  return getAllProviders().find((p) => p.id === id)?.label;
};
