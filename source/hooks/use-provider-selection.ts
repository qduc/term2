import { useCallback, useEffect, useState } from 'react';
import { useInputContext } from '../context/InputContext.js';
import type { SettingsService } from '../services/settings-service.js';
import { getAllProviders, upsertProvider, unregisterProvider } from '../providers/index.js';
import { createOpenAICompatibleProviderDefinition } from '../providers/openai-compatible-lazy.js';

export type ProviderSelectionPhase =
  | 'list'
  | 'edit_fields'
  | 'wizard_name'
  | 'wizard_type'
  | 'wizard_url'
  | 'wizard_key'
  | 'confirm_delete';

export interface CustomProviderDraft {
  name: string;
  type: 'openai-compatible' | 'openai' | 'llama.cpp' | 'anthropic' | 'google' | 'opencode';
  baseUrl?: string;
  apiKey?: string;
}

const PROVIDER_TYPES: CustomProviderDraft['type'][] = [
  'openai-compatible',
  'openai',
  'llama.cpp',
  'anthropic',
  'google',
  'opencode',
];

interface ProviderSelectionItem {
  id: string;
  label: string;
  isCustom: boolean;
  isActive: boolean;
}

export type ProviderSelectionMenuItem =
  | {
      kind: 'provider';
      id: string;
      label: string;
      isActive: boolean;
      isCustom: boolean;
    }
  | {
      kind: 'add-provider';
      label: string;
    }
  | {
      kind: 'action';
      label: string;
      tone?: 'default' | 'destructive';
    }
  | {
      kind: 'field';
      label: string;
      detail?: string;
    }
  | {
      kind: 'type';
      label: string;
    };

const DELETE_CONFIRM_DEFAULT_INDEX = 1;

const getConfiguredProviderNames = (settingsService: SettingsService): Set<string> => {
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

const hasProviderNameConflict = (
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

export const useProviderSelection = (settingsService: SettingsService) => {
  const { mode, setMode } = useInputContext();

  const [phase, setPhase] = useState<ProviderSelectionPhase>('list');
  const [items, setItems] = useState<ProviderSelectionItem[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [draft, setDraft] = useState<CustomProviderDraft | null>(null);
  const [editingOriginalName, setEditingOriginalName] = useState<string | null>(null);
  const [editingField, setEditingField] = useState<'name' | 'type' | 'baseUrl' | 'apiKey' | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [scrollOffset, setScrollOffset] = useState(0);

  // Reset scrollOffset when phase changes
  useEffect(() => {
    setScrollOffset(0);
  }, [phase]);

  // Sync scrollOffset with selectedIndex
  useEffect(() => {
    if (selectedIndex < scrollOffset) {
      setScrollOffset(selectedIndex);
    } else if (selectedIndex >= scrollOffset + 10) {
      setScrollOffset(selectedIndex - 10 + 1);
    }
  }, [selectedIndex, scrollOffset]);

  const isOpen = mode === 'provider_selection';

  // Load registered providers
  const loadProviders = useCallback(() => {
    const all = getAllProviders();
    const customList = settingsService.get<any[]>('providers') || [];
    const activeProvider = settingsService.get<string>('agent.provider') || 'openai';

    // Start with built-ins from registry
    const providerItems: ProviderSelectionItem[] = all
      .filter((p: any) => !p.isRuntimeDefined) // filter out custom ones from all to avoid duplicates
      .map((p) => ({
        id: p.id,
        label: p.label,
        isCustom: false,
        isActive: p.id === activeProvider,
      }));

    // Add custom providers from settings
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

    // Make sure active provider is marked correctly even if not in all list
    if (!providerItems.some((p) => p.id === activeProvider)) {
      providerItems.push({
        id: activeProvider,
        label: activeProvider,
        isCustom: customList.some((c: any) => c && c.name === activeProvider),
        isActive: true,
      });
    }

    setItems(providerItems);
  }, [settingsService]);

  // Sync list of providers on open
  useEffect(() => {
    if (isOpen) {
      loadProviders();
      setPhase('list');
      setSelectedIndex(0);
      setDraft(null);
      setEditingOriginalName(null);
      setEditingField(null);
      setErrorMessage(null);
    }
  }, [isOpen, loadProviders]);

  const open = useCallback(() => {
    setMode('provider_selection');
  }, [setMode]);

  const close = useCallback(() => {
    if (mode === 'provider_selection') {
      setMode('text');
    }
  }, [mode, setMode]);

  // Key navigation handlers
  const moveUp = useCallback(() => {
    setSelectedIndex((prev) => {
      const count = getListCount();
      if (count === 0) return 0;
      return (prev - 1 + count) % count;
    });
  }, [phase, items, draft]);

  const moveDown = useCallback(() => {
    setSelectedIndex((prev) => {
      const count = getListCount();
      if (count === 0) return 0;
      return (prev + 1) % count;
    });
  }, [phase, items, draft]);

  const getListCount = (): number => {
    switch (phase) {
      case 'list':
        return items.length + 1; // plus "Add Custom Provider"
      case 'wizard_type':
        return PROVIDER_TYPES.length;
      case 'edit_fields':
        return 6; // Name, Type, Base URL, API Key, Save, Cancel
      case 'confirm_delete':
        return 2; // Yes, No
      default:
        return 0;
    }
  };

  const getActiveItems = (): ProviderSelectionMenuItem[] => {
    switch (phase) {
      case 'list':
        return [
          ...items.map((i) => ({
            kind: 'provider' as const,
            id: i.id,
            label: i.label,
            isActive: i.isActive,
            isCustom: i.isCustom,
          })),
          { kind: 'add-provider' as const, label: 'Add Custom Provider' },
        ];
      case 'wizard_type':
        return PROVIDER_TYPES.map((type) => ({ kind: 'type' as const, label: type }));
      case 'edit_fields':
        if (!draft) return [];
        return [
          { kind: 'field' as const, label: `Name: ${draft.name || '<empty>'}` },
          { kind: 'field' as const, label: `Type: ${draft.type || '<empty>'}` },
          {
            kind: 'field' as const,
            label: 'Base URL',
            detail: draft.baseUrl || '<empty>',
          },
          {
            kind: 'field' as const,
            label: 'API Key',
            detail: draft.apiKey ? '********' : '<empty>',
          },
          { kind: 'action' as const, label: 'Save Changes' },
          { kind: 'action' as const, label: 'Cancel' },
        ];
      case 'confirm_delete':
        return [
          { kind: 'action' as const, label: 'Yes, delete this provider', tone: 'destructive' as const },
          { kind: 'action' as const, label: 'No, keep it' },
        ];
      default:
        return [];
    }
  };

  const selectItem = useCallback(() => {
    const listCount = getListCount();
    if (listCount === 0) return;
    const index = Math.min(selectedIndex, listCount - 1);

    if (phase === 'list') {
      if (index === items.length) {
        // "Add Custom Provider" selected
        setDraft({
          name: '',
          type: 'openai-compatible',
          baseUrl: '',
          apiKey: '',
        });
        setPhase('wizard_name');
        setSelectedIndex(0);
      } else {
        // Provider selected
        const provider = items[index]!;
        if (provider.isCustom) {
          // Edit custom provider directly
          const list = settingsService.get<any[]>('providers') || [];
          const found = list.find((p: any) => p && p.name === provider.id);
          if (found) {
            setDraft({
              name: found.name,
              type: found.type || 'openai-compatible',
              baseUrl: found.baseUrl || '',
              apiKey: found.apiKey || '',
            });
          } else {
            setDraft({
              name: provider.id,
              type: 'openai-compatible',
              baseUrl: '',
              apiKey: '',
            });
          }
          setEditingOriginalName(found ? found.name : null);
          setPhase('edit_fields');
          setSelectedIndex(0);
        }
        // Built-in providers: no-op (activation lives in the model menu).
      }
    } else if (phase === 'wizard_type') {
      const selectedType = PROVIDER_TYPES[index]!;
      if (draft) {
        setDraft({ ...draft, type: selectedType });
        if (editingField) {
          // We were editing from edit_fields
          setPhase('edit_fields');
          setSelectedIndex(1); // select the Type row
          setEditingField(null);
        } else {
          // Normal add wizard flow: type -> url
          setPhase('wizard_url');
          setSelectedIndex(0);
        }
      }
    } else if (phase === 'edit_fields') {
      if (!draft) return;
      if (index === 0) {
        // Edit Name
        setEditingField('name');
        setPhase('wizard_name');
      } else if (index === 1) {
        // Edit Type
        setEditingField('type');
        setPhase('wizard_type');
        setSelectedIndex(PROVIDER_TYPES.indexOf(draft.type));
      } else if (index === 2) {
        // Edit Base URL
        setEditingField('baseUrl');
        setPhase('wizard_url');
      } else if (index === 3) {
        // Edit API Key
        setEditingField('apiKey');
        setPhase('wizard_key');
      } else if (index === 4) {
        // Save Changes
        saveDraft();
      } else {
        // Cancel
        setPhase('list');
        setSelectedIndex(0);
        setDraft(null);
      }
    } else if (phase === 'confirm_delete') {
      if (index === 0) {
        // Yes, delete
        if (editingOriginalName) {
          const list = settingsService.get<any[]>('providers') || [];
          const updated = list.filter((p: any) => p && p.name !== editingOriginalName);
          settingsService.setPersistent('providers', updated);
          unregisterProvider(editingOriginalName);

          // If active provider was deleted, fallback
          const activeProvider = settingsService.get<string>('agent.provider');
          if (activeProvider === editingOriginalName) {
            settingsService.set('agent.provider', 'openai');
          }
          loadProviders();
        }
        setPhase('list');
        setSelectedIndex(0);
        setEditingOriginalName(null);
      } else {
        // No, keep
        setPhase('list');
        setSelectedIndex(0);
        setEditingOriginalName(null);
      }
    }
  }, [phase, selectedIndex, items, editingOriginalName, draft, editingField, settingsService, loadProviders]);

  const goBack = useCallback(() => {
    setErrorMessage(null);
    if (phase === 'list') {
      close();
    } else if (phase === 'wizard_name') {
      if (editingField) {
        setPhase('edit_fields');
        setSelectedIndex(0);
        setEditingField(null);
      } else {
        setPhase('list');
        setSelectedIndex(0);
      }
    } else if (phase === 'wizard_type') {
      if (editingField) {
        setPhase('edit_fields');
        setSelectedIndex(1);
        setEditingField(null);
      } else {
        setPhase('wizard_name');
        setSelectedIndex(0);
      }
    } else if (phase === 'wizard_url') {
      if (editingField) {
        setPhase('edit_fields');
        setSelectedIndex(2);
        setEditingField(null);
      } else {
        setPhase('wizard_type');
        setSelectedIndex(0);
      }
    } else if (phase === 'wizard_key') {
      if (editingField) {
        setPhase('edit_fields');
        setSelectedIndex(3);
        setEditingField(null);
      } else {
        setPhase('wizard_url');
        setSelectedIndex(0);
      }
    } else if (phase === 'edit_fields') {
      setPhase('list');
      setSelectedIndex(0);
      setDraft(null);
      setEditingOriginalName(null);
    } else if (phase === 'confirm_delete') {
      setPhase('list');
      setSelectedIndex(0);
      setEditingOriginalName(null);
    }
  }, [phase, editingField, close]);

  // Handler for text input submissions from app.tsx wizard manager
  const handleTextInputSubmit = useCallback(
    (value: string) => {
      setErrorMessage(null);
      const val = value.trim();

      if (phase === 'wizard_name') {
        if (!val) {
          setErrorMessage('Name cannot be empty.');
          return false;
        }
        // Check for name conflict
        const isRename = editingField !== null;
        const originalName = isRename ? editingOriginalName ?? undefined : undefined;
        if (hasProviderNameConflict(settingsService, val, originalName)) {
          setErrorMessage(`Provider with name '${val}' already exists.`);
          return false;
        }

        if (draft) {
          const updatedDraft = { ...draft, name: val };
          setDraft(updatedDraft);
          if (editingField) {
            setPhase('edit_fields');
            setSelectedIndex(0);
            setEditingField(null);
          } else {
            setPhase('wizard_type');
            setSelectedIndex(0);
          }
        }
        return true;
      }

      if (phase === 'wizard_url') {
        const type = draft?.type || 'openai-compatible';
        const baseUrlRequired = type === 'openai' || type === 'openai-compatible' || type === 'llama.cpp';

        if (baseUrlRequired && !val) {
          setErrorMessage(`Base URL is required for provider type '${type}'.`);
          return false;
        }

        if (val) {
          try {
            new URL(val);
          } catch {
            setErrorMessage('Invalid URL format. Make sure it starts with http:// or https://');
            return false;
          }
        }

        if (draft) {
          const updatedDraft = { ...draft, baseUrl: val || undefined };
          setDraft(updatedDraft);
          if (editingField) {
            setPhase('edit_fields');
            setSelectedIndex(2);
            setEditingField(null);
          } else {
            setPhase('wizard_key');
            setSelectedIndex(0);
          }
        }
        return true;
      }

      if (phase === 'wizard_key') {
        if (draft) {
          const updatedDraft = { ...draft, apiKey: val || undefined };
          setDraft(updatedDraft);
          if (editingField) {
            setPhase('edit_fields');
            setSelectedIndex(3);
            setEditingField(null);
          } else {
            // Wizard complete, go to fields overview before saving
            setPhase('edit_fields');
            setSelectedIndex(4); // focus Save changes button
          }
        }
        return true;
      }

      return false;
    },
    [phase, draft, editingField, editingOriginalName, settingsService],
  );

  const saveDraft = () => {
    if (!draft) return;
    setErrorMessage(null);

    // Final checks
    if (!draft.name.trim()) {
      setPhase('wizard_name');
      setErrorMessage('Name cannot be empty.');
      return;
    }

    const originalName = editingOriginalName;
    if (hasProviderNameConflict(settingsService, draft.name, originalName ?? undefined)) {
      setPhase('edit_fields');
      setSelectedIndex(0);
      setErrorMessage(`Provider with name '${draft.name}' already exists.`);
      return;
    }

    const type = draft.type;
    const baseUrlRequired = type === 'openai' || type === 'openai-compatible' || type === 'llama.cpp';
    if (baseUrlRequired && !draft.baseUrl) {
      setPhase('edit_fields');
      setSelectedIndex(2);
      setErrorMessage(`Base URL is required for provider type '${type}'.`);
      return;
    }

    try {
      const list = settingsService.get<any[]>('providers') || [];
      const isEdit = originalName !== null;
      let updatedList;

      if (isEdit && originalName) {
        // If name changed, delete old provider
        updatedList = list.filter((p: any) => p && p.name !== originalName);
        if (originalName !== draft.name) {
          unregisterProvider(originalName);
        }
      } else {
        updatedList = [...list];
      }

      const newEntry: any = {
        name: draft.name,
        type: draft.type,
      };
      if (draft.baseUrl) newEntry.baseUrl = draft.baseUrl;
      if (draft.apiKey) newEntry.apiKey = draft.apiKey;

      updatedList.push(newEntry);
      settingsService.setPersistent('providers', updatedList);

      // Instantly register or update at runtime
      const def = createOpenAICompatibleProviderDefinition({
        name: draft.name,
        type: draft.type,
        baseUrl: draft.baseUrl,
        apiKey: draft.apiKey,
      });
      upsertProvider(def);

      // If active provider was edited and its name changed, update the active setting
      if (isEdit && originalName && originalName === settingsService.get('agent.provider')) {
        settingsService.set('agent.provider', draft.name);
      }

      loadProviders();
      setPhase('list');
      setSelectedIndex(0);
      setDraft(null);
      setEditingOriginalName(null);
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to save provider.');
    }
  };

  const requestDelete = useCallback(() => {
    if (phase !== 'list') return;
    const index = Math.min(selectedIndex, items.length - 1);
    if (index < 0 || index >= items.length) return;
    const provider = items[index]!;
    if (!provider.isCustom) return; // only custom providers can be deleted
    setEditingOriginalName(provider.id);
    setPhase('confirm_delete');
    setSelectedIndex(DELETE_CONFIRM_DEFAULT_INDEX); // default to 'No' for safety
  }, [phase, selectedIndex, items]);

  const selectedProviderName = editingOriginalName ?? undefined;

  return {
    isOpen,
    phase,
    items,
    selectedIndex,
    scrollOffset,
    draft,
    errorMessage,
    selectedProviderName,
    open,
    close,
    moveUp,
    moveDown,
    selectItem,
    goBack,
    requestDelete,
    getActiveItems,
    handleTextInputSubmit,
  };
};
