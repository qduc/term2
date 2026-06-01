import { useCallback, useEffect, useState } from 'react';
import { useInputContext } from '../context/InputContext.js';
import type { SettingsService } from '../services/settings-service.js';
import { getAllProviders, upsertProvider, unregisterProvider } from '../providers/index.js';
import { createOpenAICompatibleProviderDefinition } from '../providers/openai-compatible-lazy.js';

export type ProviderSelectionPhase =
  | 'list'
  | 'provider_actions'
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
  const [selectedProvider, setSelectedProvider] = useState<ProviderSelectionItem | null>(null);
  const [draft, setDraft] = useState<CustomProviderDraft | null>(null);
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
      setSelectedProvider(null);
      setDraft(null);
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
      case 'provider_actions':
        return selectedProvider?.isCustom ? 3 : 1; // custom: edit, delete, back. built-in: back.
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
          ...items.map((i) => ({ kind: 'provider' as const, id: i.id, label: i.label, isActive: i.isActive })),
          { kind: 'add-provider' as const, label: 'Add Custom Provider' },
        ];
      case 'provider_actions':
        return selectedProvider?.isCustom
          ? [
              { kind: 'action' as const, label: 'Edit Provider Details' },
              { kind: 'action' as const, label: 'Delete Provider', tone: 'destructive' as const },
              { kind: 'action' as const, label: 'Go Back' },
            ]
          : [{ kind: 'action' as const, label: 'Go Back' }];
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
          setSelectedProvider(provider);
          setPhase('provider_actions');
          setSelectedIndex(0);
        } else {
          setSelectedIndex(index);
        }
      }
    } else if (phase === 'provider_actions') {
      const isCustom = selectedProvider?.isCustom;
      if (isCustom && index === 0) {
        // "Edit Provider"
        if (selectedProvider) {
          const list = settingsService.get<any[]>('providers') || [];
          const found = list.find((p: any) => p && p.name === selectedProvider.id);
          if (found) {
            setDraft({
              name: found.name,
              type: found.type || 'openai-compatible',
              baseUrl: found.baseUrl || '',
              apiKey: found.apiKey || '',
            });
          } else {
            setDraft({
              name: selectedProvider.id,
              type: 'openai-compatible',
              baseUrl: '',
              apiKey: '',
            });
          }
          setPhase('edit_fields');
          setSelectedIndex(0);
        }
      } else if (isCustom && index === 1) {
        // "Delete Provider"
        setPhase('confirm_delete');
        setSelectedIndex(DELETE_CONFIRM_DEFAULT_INDEX); // default to 'No' for safety
      } else {
        // Go Back (index 2 for custom, index 0 for built-in)
        setPhase('list');
        setSelectedIndex(0);
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
        if (selectedProvider) {
          const list = settingsService.get<any[]>('providers') || [];
          const updated = list.filter((p: any) => p && p.name !== selectedProvider.id);
          settingsService.setPersistent('providers', updated);
          unregisterProvider(selectedProvider.id);

          // If active provider was deleted, fallback
          const activeProvider = settingsService.get<string>('agent.provider');
          if (activeProvider === selectedProvider.id) {
            settingsService.set('agent.provider', 'openai');
          }
          loadProviders();
        }
        setPhase('list');
        setSelectedIndex(0);
      } else {
        // No, keep
        setPhase('provider_actions');
        setSelectedIndex(0);
      }
    }
  }, [phase, selectedIndex, items, selectedProvider, draft, editingField, settingsService, loadProviders]);

  const goBack = useCallback(() => {
    setErrorMessage(null);
    if (phase === 'list') {
      close();
    } else if (phase === 'provider_actions') {
      setPhase('list');
      setSelectedIndex(0);
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
    } else if (phase === 'confirm_delete') {
      setPhase('provider_actions');
      setSelectedIndex(0);
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
        const originalName = selectedProvider?.id;
        if (hasProviderNameConflict(settingsService, val, isRename ? originalName : undefined)) {
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
    [phase, draft, editingField, selectedProvider, settingsService],
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

    const originalName = selectedProvider?.id;
    if (hasProviderNameConflict(settingsService, draft.name, selectedProvider ? originalName : undefined)) {
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
      const isEdit = selectedProvider !== null;
      let updatedList;

      if (isEdit && selectedProvider) {
        // If name changed, delete old provider
        updatedList = list.filter((p: any) => p && p.name !== selectedProvider.id);
        if (selectedProvider.id !== draft.name) {
          unregisterProvider(selectedProvider.id);
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
      if (isEdit && selectedProvider && selectedProvider.id === settingsService.get('agent.provider')) {
        settingsService.set('agent.provider', draft.name);
      }

      loadProviders();
      setPhase('list');
      setSelectedIndex(0);
      setDraft(null);
      setSelectedProvider(null);
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to save provider.');
    }
  };

  return {
    isOpen,
    phase,
    items,
    selectedIndex,
    scrollOffset,
    selectedProvider,
    draft,
    errorMessage,
    open,
    close,
    moveUp,
    moveDown,
    selectItem,
    goBack,
    getActiveItems,
    handleTextInputSubmit,
  };
};
