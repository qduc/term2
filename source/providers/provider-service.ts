import type { SettingsService } from '../services/settings/settings-service.js';
import { getAllProviders, upsertProvider, unregisterProvider } from './index.js';
import { createOpenAICompatibleProviderDefinition } from './openai-compatible-lazy.js';

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

export const getConfiguredProviderNames = (settingsService: SettingsService): Set<string> => {
  const names = new Set<string>();

  for (const provider of getAllProviders()) {
    names.add(provider.id);
  }

  const configured = settingsService.get<any[]>('providers') || [];
  for (const provider of configured) {
    if (provider && provider.name) {
      names.add(String(provider.name));
    }
  }

  return names;
};

export const hasProviderNameConflict = (
  settingsService: SettingsService,
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

export const loadProviderItems = (settingsService: SettingsService): ProviderSelectionItem[] => {
  const all = getAllProviders();
  const customList = settingsService.get<any[]>('providers') || [];
  const activeProvider = settingsService.get<string>('agent.provider') || 'openai';

  const providerItems: ProviderSelectionItem[] = all
    .filter((p) => !p.isRuntimeDefined)
    .map((p) => ({
      id: p.id,
      label: p.label,
      isCustom: false,
      isActive: p.id === activeProvider,
    }));

  for (const c of customList) {
    if (c && c.name) {
      if (!providerItems.some((p) => p.id === c.name)) {
        providerItems.push({
          id: c.name,
          label: c.name,
          isCustom: true,
          isActive: c.name === activeProvider,
        });
      }
    }
  }

  if (!providerItems.some((p) => p.id === activeProvider)) {
    providerItems.push({
      id: activeProvider,
      label: activeProvider,
      isCustom: customList.some((c: any) => c && c.name === activeProvider),
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
  settingsService: SettingsService,
  draft: CustomProviderDraft,
  editingOriginalName: string | null,
): SaveProviderResult => {
  if (!draft) return { success: false };

  const providerDef = editingOriginalName ? getAllProviders().find((p) => p.id === editingOriginalName) : null;
  const isEditingBuiltIn = providerDef ? !providerDef.isRuntimeDefined : false;

  if (isEditingBuiltIn && editingOriginalName) {
    try {
      settingsService.setPersistent(`agent.${editingOriginalName}.apiKey`, draft.apiKey || undefined);
      return { success: true };
    } catch (err: any) {
      return { success: false, errorMessage: err.message || 'Failed to save provider API key.' };
    }
  }

  if (!draft.name.trim()) {
    return { success: false, fieldErrors: { name: 'Name cannot be empty.' } };
  }

  if (!PROVIDER_NAME_REGEX.test(draft.name.trim())) {
    return {
      success: false,
      fieldErrors: {
        name: 'Name must start with a letter or number and contain only letters, numbers, hyphens, underscores, and dots.',
      },
    };
  }

  const originalName = editingOriginalName;
  if (hasProviderNameConflict(settingsService, draft.name, originalName ?? undefined)) {
    return { success: false, fieldErrors: { name: `Provider with name '${draft.name}' already exists.` } };
  }

  const type = draft.type;
  const baseUrlRequired = type === 'openai' || type === 'openai-compatible' || type === 'llama.cpp';
  if (baseUrlRequired && !draft.baseUrl) {
    return { success: false, fieldErrors: { baseUrl: `Base URL is required for provider type '${type}'.` } };
  }

  try {
    const list = settingsService.get<any[]>('providers') || [];
    const isEdit = originalName !== null;
    let updatedList;

    if (isEdit && originalName) {
      updatedList = list.filter((p: any) => p && p.name !== originalName);
      if (originalName !== draft.name) {
        unregisterProvider(originalName);
      }
    } else {
      updatedList = [...list];
    }

    const newEntry: any = { name: draft.name, type: draft.type };
    if (draft.baseUrl) newEntry.baseUrl = draft.baseUrl;
    if (draft.apiKey) newEntry.apiKey = draft.apiKey;

    updatedList.push(newEntry);
    settingsService.setPersistent('providers', updatedList);

    const def = createOpenAICompatibleProviderDefinition({
      name: draft.name,
      type: draft.type,
      baseUrl: draft.baseUrl,
      apiKey: draft.apiKey,
    });
    upsertProvider(def);

    if (isEdit && originalName && originalName === settingsService.get('agent.provider')) {
      settingsService.set('agent.provider', draft.name);
    }

    return { success: true };
  } catch (err: any) {
    return { success: false, errorMessage: err.message || 'Failed to save provider.' };
  }
};

export const deleteCustomProvider = (settingsService: SettingsService, name: string): void => {
  const list = settingsService.get<any[]>('providers') || [];
  const updated = list.filter((p: any) => p && p.name !== name);
  settingsService.setPersistent('providers', updated);
  unregisterProvider(name);

  const activeProvider = settingsService.get<string>('agent.provider');
  if (activeProvider === name) {
    settingsService.set('agent.provider', 'openai');
  }
};

export const validateWizardName = (
  value: string,
  settingsService: SettingsService,
  isEditingField: boolean,
  editingOriginalName?: string,
): { valid: boolean; errorMessage?: string } => {
  const val = value.trim();
  if (!val) {
    return { valid: false, errorMessage: 'Name cannot be empty.' };
  }
  if (!PROVIDER_NAME_REGEX.test(val)) {
    return {
      valid: false,
      errorMessage:
        'Name must start with a letter or number and contain only letters, numbers, hyphens, underscores, and dots.',
    };
  }
  const originalName = isEditingField ? editingOriginalName : undefined;
  if (hasProviderNameConflict(settingsService, val, originalName)) {
    return { valid: false, errorMessage: `Provider with name '${val}' already exists.` };
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
