import { useCallback, useEffect, useMemo, useState } from 'react';
import { useInputContext } from '../context/InputContext.js';
import type { SettingsService } from '../services/settings-service.js';
import { getAllProviders, upsertProvider, unregisterProvider } from '../providers/index.js';
import { createOpenAICompatibleProviderDefinition } from '../providers/openai-compatible-lazy.js';
import { useSelection } from './use-selection.js';

export type ProviderSelectionPhase =
  | 'list'
  | 'edit_fields'
  | 'wizard_name'
  | 'wizard_type'
  | 'wizard_url'
  | 'wizard_key'
  | 'confirm_delete'
  | 'confirm_discard';

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

const PROVIDER_NAME_REGEX = /^[a-zA-Z0-9][-a-zA-Z0-9_.]*$/;

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
      fieldKey?: 'name' | 'type' | 'baseUrl' | 'apiKey';
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
  const { mode, setMode, setInput } = useInputContext();

  const [phase, setPhase] = useState<ProviderSelectionPhase>('list');
  const [items, setItems] = useState<ProviderSelectionItem[]>([]);
  const [draft, setDraft] = useState<CustomProviderDraft | null>(null);
  const [editingOriginalName, setEditingOriginalName] = useState<string | null>(null);
  const [editingField, setEditingField] = useState<'name' | 'type' | 'baseUrl' | 'apiKey' | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [discardFromPhase, setDiscardFromPhase] = useState<ProviderSelectionPhase | null>(null);
  const [draftModified, setDraftModified] = useState(false);
  const [scrollOffset, setScrollOffset] = useState(0);

  const activeItems = useMemo((): ProviderSelectionMenuItem[] => {
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
      case 'edit_fields': {
        if (!draft) return [];
        const providerDef = editingOriginalName ? getAllProviders().find((p) => p.id === editingOriginalName) : null;
        const isEditingBuiltIn = providerDef ? !providerDef.isRuntimeDefined : false;
        if (isEditingBuiltIn) {
          return [
            { kind: 'field' as const, label: `Name: ${draft.name || '<empty>'} (Built-in)`, fieldKey: 'name' },
            { kind: 'field' as const, label: `Type: ${draft.type || '<empty>'} (Built-in)`, fieldKey: 'type' },
            {
              kind: 'field' as const,
              label: 'API Key',
              detail: draft.apiKey ? '********' : '<empty>',
              fieldKey: 'apiKey',
            },
            { kind: 'action' as const, label: 'Save Changes' },
            { kind: 'action' as const, label: 'Cancel' },
          ];
        }
        return [
          { kind: 'field' as const, label: `Name: ${draft.name || '<empty>'}`, fieldKey: 'name' },
          { kind: 'field' as const, label: `Type: ${draft.type || '<empty>'}`, fieldKey: 'type' },
          {
            kind: 'field' as const,
            label: 'Base URL',
            detail: draft.baseUrl || '<empty>',
            fieldKey: 'baseUrl',
          },
          {
            kind: 'field' as const,
            label: 'API Key',
            detail: draft.apiKey ? '********' : '<empty>',
            fieldKey: 'apiKey',
          },
          { kind: 'action' as const, label: 'Save Changes' },
          { kind: 'action' as const, label: 'Cancel' },
        ];
      }
      case 'confirm_discard':
        return [
          { kind: 'action' as const, label: 'Yes, discard changes', tone: 'destructive' as const },
          { kind: 'action' as const, label: 'No, keep editing' },
        ];
      case 'confirm_delete':
        return [
          { kind: 'action' as const, label: 'Yes, delete this provider', tone: 'destructive' as const },
          { kind: 'action' as const, label: 'No, keep it' },
        ];
      default:
        return [];
    }
  }, [phase, items, draft, editingOriginalName]);

  const checkIsInactive = useCallback((item: ProviderSelectionMenuItem) => {
    return item.kind === 'provider' && item.id === 'codex';
  }, []);

  const {
    selectedIndex,
    setSelectedIndex,
    moveUp: selectionMoveUp,
    moveDown: selectionMoveDown,
  } = useSelection(activeItems, {
    isInactive: checkIsInactive,
  });

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
      setFieldErrors({});
      setDiscardFromPhase(null);
      setDraftModified(false);
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
    selectionMoveUp();
  }, [selectionMoveUp]);

  const moveDown = useCallback(() => {
    selectionMoveDown();
  }, [selectionMoveDown]);

  const getListCount = (): number => {
    return activeItems.length;
  };

  const selectItem = useCallback(() => {
    const listCount = getListCount();
    if (listCount === 0) return;
    const index = Math.min(selectedIndex, listCount - 1);

    if (phase === 'list') {
      if (index === items.length) {
        // "Add Custom Provider" selected
        setFieldErrors({});
        setDiscardFromPhase(null);
        setDraftModified(false);
        setDraft({
          name: '',
          type: 'openai-compatible',
          baseUrl: '',
          apiKey: '',
        });
        setPhase('wizard_name');
        setSelectedIndex(0);
        setInput('');
      } else {
        // Provider selected
        const provider = items[index]!;
        if (provider.isCustom) {
          setFieldErrors({});
          setDiscardFromPhase(null);
          setDraftModified(false);
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
          setFieldErrors({});
          setPhase('edit_fields');
          setSelectedIndex(0);
          setInput('');
        } else if (provider.id !== 'codex') {
          // Allow editing apiKey for built-in providers (except Codex)
          setFieldErrors({});
          setDiscardFromPhase(null);
          setDraftModified(false);
          const storedKey = settingsService.get<string>(`agent.${provider.id}.apiKey`) || '';
          setDraft({
            name: provider.label,
            type: provider.id as any,
            apiKey: storedKey,
          });
          setEditingOriginalName(provider.id);
          setPhase('edit_fields');
          setSelectedIndex(2);
          setInput('');
        }
      }
    } else if (phase === 'wizard_type') {
      const selectedType = PROVIDER_TYPES[index]!;
      if (draft) {
        setDraft({ ...draft, type: selectedType });
        setDraftModified(true);
        if (editingField) {
          // We were editing from edit_fields
          setFieldErrors({});
          setDraftModified(false);
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
      const providerDef = editingOriginalName ? getAllProviders().find((p) => p.id === editingOriginalName) : null;
      const isEditingBuiltIn = providerDef ? !providerDef.isRuntimeDefined : false;

      if (isEditingBuiltIn) {
        if (index === 2) {
          // Edit API Key
          setEditingField('apiKey');
          setDraftModified(false);
          setPhase('wizard_key');
          setInput(draft.apiKey || '');
        } else if (index === 3) {
          // Save Changes
          saveDraft();
        } else if (index === 4) {
          // Cancel
          setPhase('list');
          setSelectedIndex(0);
          setDraft(null);
          setEditingOriginalName(null);
          setFieldErrors({});
          setInput('');
        }
      } else {
        if (index === 0) {
          // Edit Name
          setEditingField('name');
          setDraftModified(false);
          setPhase('wizard_name');
          setInput(draft.name || '');
        } else if (index === 1) {
          // Edit Type
          setEditingField('type');
          setDraftModified(false);
          setPhase('wizard_type');
          setSelectedIndex(PROVIDER_TYPES.indexOf(draft.type));
          setInput('');
        } else if (index === 2) {
          // Edit Base URL
          setEditingField('baseUrl');
          setDraftModified(false);
          setPhase('wizard_url');
          setInput(draft.baseUrl || '');
        } else if (index === 3) {
          // Edit API Key
          setEditingField('apiKey');
          setDraftModified(false);
          setPhase('wizard_key');
          setInput(draft.apiKey || '');
        } else if (index === 4) {
          // Save Changes
          saveDraft();
        } else {
          // Cancel
          setPhase('list');
          setSelectedIndex(0);
          setDraft(null);
          setFieldErrors({});
          setInput('');
        }
      }
    } else if (phase === 'confirm_discard') {
      if (!discardFromPhase) return;
      if (index === 0) {
        setDraftModified(false);
        const providerDef = editingOriginalName ? getAllProviders().find((p) => p.id === editingOriginalName) : null;
        const isEditingBuiltIn = providerDef ? !providerDef.isRuntimeDefined : false;

        if (discardFromPhase === 'wizard_name') {
          if (editingField !== null) {
            setPhase('edit_fields');
            setSelectedIndex(0);
            setEditingField(null);
          } else {
            setPhase('list');
            setSelectedIndex(0);
            setDraft(null);
            setEditingOriginalName(null);
          }
        } else if (discardFromPhase === 'wizard_type') {
          if (editingField !== null) {
            setPhase('edit_fields');
            setSelectedIndex(1);
            setEditingField(null);
          } else {
            setPhase('wizard_name');
            setSelectedIndex(0);
          }
        } else if (discardFromPhase === 'wizard_url') {
          if (editingField !== null) {
            setPhase('edit_fields');
            setSelectedIndex(2);
            setEditingField(null);
          } else {
            setPhase('wizard_type');
            setSelectedIndex(0);
          }
        } else if (discardFromPhase === 'wizard_key') {
          if (editingField !== null) {
            setPhase('edit_fields');
            setSelectedIndex(isEditingBuiltIn ? 2 : 3);
            setEditingField(null);
          } else {
            setPhase('wizard_url');
            setSelectedIndex(0);
          }
        }
        setDiscardFromPhase(null);
        setFieldErrors({});
      } else {
        setPhase(discardFromPhase);
        setSelectedIndex(0);
        setDiscardFromPhase(null);
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
  }, [
    phase,
    selectedIndex,
    items,
    editingOriginalName,
    draft,
    editingField,
    discardFromPhase,
    settingsService,
    loadProviders,
    setInput,
  ]);

  const goBack = useCallback(() => {
    setErrorMessage(null);
    setInput('');
    if (phase === 'list') {
      close();
    } else if (
      (phase === 'wizard_name' || phase === 'wizard_type' || phase === 'wizard_url' || phase === 'wizard_key') &&
      draftModified
    ) {
      setDiscardFromPhase(phase);
      setPhase('confirm_discard');
      setSelectedIndex(DELETE_CONFIRM_DEFAULT_INDEX);
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
        const providerDef = editingOriginalName ? getAllProviders().find((p) => p.id === editingOriginalName) : null;
        const isEditingBuiltIn = providerDef ? !providerDef.isRuntimeDefined : false;
        setSelectedIndex(isEditingBuiltIn ? 2 : 3);
        setEditingField(null);
      } else {
        setPhase('wizard_url');
        setSelectedIndex(0);
      }
    } else if (phase === 'edit_fields') {
      setFieldErrors({});
      setPhase('list');
      setSelectedIndex(0);
      setDraft(null);
      setEditingOriginalName(null);
    } else if (phase === 'confirm_delete') {
      setPhase('list');
      setSelectedIndex(0);
      setEditingOriginalName(null);
    } else if (phase === 'confirm_discard') {
      if (discardFromPhase) {
        setPhase(discardFromPhase);
        setSelectedIndex(0);
      }
      setDiscardFromPhase(null);
    }
  }, [phase, editingField, close, draftModified, discardFromPhase, draft, setInput]);

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
        if (!PROVIDER_NAME_REGEX.test(val)) {
          setErrorMessage(
            'Name must start with a letter or number and contain only letters, numbers, hyphens, underscores, and dots.',
          );
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
          setDraftModified(true);
          if (editingField) {
            setFieldErrors({});
            setDraftModified(false);
            setPhase('edit_fields');
            setSelectedIndex(0);
            setEditingField(null);
          } else {
            setPhase('wizard_type');
            setSelectedIndex(0);
          }
        }
        setInput('');
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
          setDraftModified(true);
          if (editingField) {
            setFieldErrors({});
            setDraftModified(false);
            setPhase('edit_fields');
            setSelectedIndex(2);
            setEditingField(null);
          } else {
            setPhase('wizard_key');
            setSelectedIndex(0);
          }
        }
        setInput('');
        return true;
      }

      if (phase === 'wizard_key') {
        if (draft) {
          const updatedDraft = { ...draft, apiKey: val || undefined };
          setDraft(updatedDraft);
          setDraftModified(true);
          const providerDef = editingOriginalName ? getAllProviders().find((p) => p.id === editingOriginalName) : null;
          const isEditingBuiltIn = providerDef ? !providerDef.isRuntimeDefined : false;
          if (editingField) {
            setFieldErrors({});
            setDraftModified(false);
            setPhase('edit_fields');
            setSelectedIndex(isEditingBuiltIn ? 2 : 3);
            setEditingField(null);
          } else {
            // Wizard complete, go to fields overview before saving
            setPhase('edit_fields');
            setSelectedIndex(isEditingBuiltIn ? 3 : 4); // focus Save changes button
            setFieldErrors({});
            setDraftModified(false);
          }
        }
        setInput('');
        return true;
      }

      return false;
    },
    [phase, draft, editingField, editingOriginalName, settingsService, setInput],
  );

  const saveDraft = () => {
    if (!draft) return;
    setErrorMessage(null);
    setFieldErrors({});

    const providerDef = editingOriginalName ? getAllProviders().find((p) => p.id === editingOriginalName) : null;
    const isEditingBuiltIn = providerDef ? !providerDef.isRuntimeDefined : false;

    if (isEditingBuiltIn && editingOriginalName) {
      try {
        settingsService.setPersistent(`agent.${editingOriginalName}.apiKey`, draft.apiKey || undefined);
        loadProviders();
        setPhase('list');
        setSelectedIndex(0);
        setDraft(null);
        setEditingOriginalName(null);
        setFieldErrors({});
      } catch (err: any) {
        setErrorMessage(err.message || 'Failed to save provider API key.');
      }
      return;
    }

    // Final checks
    if (!draft.name.trim()) {
      setFieldErrors({ name: 'Name cannot be empty.' });
      return;
    }

    if (!PROVIDER_NAME_REGEX.test(draft.name.trim())) {
      setFieldErrors({
        name: 'Name must start with a letter or number and contain only letters, numbers, hyphens, underscores, and dots.',
      });
      return;
    }

    const originalName = editingOriginalName;
    if (hasProviderNameConflict(settingsService, draft.name, originalName ?? undefined)) {
      setFieldErrors({ name: `Provider with name '${draft.name}' already exists.` });
      return;
    }

    const type = draft.type;
    const baseUrlRequired = type === 'openai' || type === 'openai-compatible' || type === 'llama.cpp';
    if (baseUrlRequired && !draft.baseUrl) {
      setFieldErrors({ baseUrl: `Base URL is required for provider type '${type}'.` });
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
      setFieldErrors({});
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

  const getActiveItems = useCallback(() => activeItems, [activeItems]);

  const selectedProviderName = editingOriginalName ?? undefined;

  return {
    isOpen,
    phase,
    items,
    selectedIndex,
    scrollOffset,
    draft,
    errorMessage,
    fieldErrors,
    draftModified,
    discardFromPhase,
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
