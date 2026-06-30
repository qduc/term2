import { useCallback, useEffect, useMemo, useState } from 'react';
import { useInputContext } from '../context/InputContext.js';
import type { SettingsService } from '../services/settings/settings-service.js';
import { useSelection } from './use-selection.js';
import {
  type ProviderSelectionPhase,
  type CustomProviderDraft,
  type ProviderSelectionItem,
  PROVIDER_TYPES,
  loadProviderItems as loadProviderItemsFromService,
  saveProvider as saveProviderToService,
  deleteCustomProvider as deleteCustomProviderFromService,
  validateWizardName,
  validateWizardUrl,
  isProviderBuiltIn,
  getProviderLabel,
} from '../providers/provider-service.js';
import { resolveProviderId, resolveProviderName } from '../services/settings/custom-provider-normalization.js';

export type { ProviderSelectionPhase, CustomProviderDraft, ProviderSelectionItem };

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
    }
  | {
      kind: 'reorder-item';
      id: string;
      label: string;
    };

const DELETE_CONFIRM_DEFAULT_INDEX = 1;

export const useProviderSelection = (settingsService: SettingsService) => {
  const { mode, setMode, setInput, replaceInput } = useInputContext();

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
  const [reorderList, setReorderList] = useState<string[]>([]);

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
          { kind: 'action' as const, label: 'Reorder Providers' },
        ];
      case 'wizard_type':
        return PROVIDER_TYPES.map((type) => ({ kind: 'type' as const, label: type }));
      case 'edit_fields': {
        if (!draft) return [];
        const isEditingBuiltIn = editingOriginalName ? isProviderBuiltIn(editingOriginalName) : false;
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
      case 'reorder':
        return [
          ...reorderList.map((id) => ({
            kind: 'reorder-item' as const,
            id,
            label: getProviderLabel(id) ?? id,
          })),
        ];
      default:
        return [];
    }
  }, [phase, items, draft, editingOriginalName, reorderList]);

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
    setScrollOffset(0); // eslint-disable-line react-hooks/set-state-in-effect
  }, [phase]);

  // Sync scrollOffset with selectedIndex
  useEffect(() => {
    if (selectedIndex < scrollOffset) {
      setScrollOffset(selectedIndex); // eslint-disable-line react-hooks/set-state-in-effect
    } else if (selectedIndex >= scrollOffset + 10) {
      setScrollOffset(selectedIndex - 10 + 1);
    }
  }, [selectedIndex, scrollOffset]);

  const isOpen = mode === 'provider_selection';

  // Load provider items from service
  const loadProviderList = useCallback(() => {
    setItems(loadProviderItemsFromService(settingsService));
  }, [settingsService]);

  // Sync list of providers on open — resets wizard state when the menu opens.
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    if (isOpen) {
      loadProviderList();
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
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [isOpen, loadProviderList, setSelectedIndex]);

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

  const saveDraft = useCallback(() => {
    if (!draft) return;
    setErrorMessage(null);
    setFieldErrors({});

    const result = saveProviderToService(settingsService, draft, editingOriginalName);
    if (!result.success) {
      if (result.errorMessage) setErrorMessage(result.errorMessage);
      if (result.fieldErrors) setFieldErrors(result.fieldErrors);
      return;
    }

    loadProviderList();
    setPhase('list');
    setSelectedIndex(0);
    setDraft(null);
    setEditingOriginalName(null);
    setFieldErrors({});
  }, [draft, editingOriginalName, settingsService, loadProviderList, setSelectedIndex]);

  const selectItem = useCallback(() => {
    const listCount = activeItems.length;
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
      } else if (index === items.length + 1) {
        // "Reorder Providers" selected
        const providerOrder = settingsService.get<string[]>('providerOrder') ?? [];
        const allIds = items.map((i) => i.id);
        const orderedIds =
          providerOrder.length > 0
            ? (() => {
                const orderIndex = new Map<string, number>();
                providerOrder.forEach((id, idx) => orderIndex.set(id, idx));
                return [...allIds].sort((a, b) => {
                  const aI = orderIndex.get(a);
                  const bI = orderIndex.get(b);
                  if (aI !== undefined && bI !== undefined) return aI - bI;
                  if (aI !== undefined) return -1;
                  if (bI !== undefined) return 1;
                  return 0;
                });
              })()
            : allIds;
        setReorderList(orderedIds);
        setPhase('reorder');
        setSelectedIndex(0);
      } else {
        // Provider selected
        const provider = items[index]!;
        if (provider.isCustom) {
          setFieldErrors({});
          setDiscardFromPhase(null);
          setDraftModified(false);
          // Edit custom provider directly
          const list = settingsService.get<any[]>('providers') || [];
          const found = list.find((p: any) => resolveProviderId(p) === provider.id);
          if (found) {
            const id = resolveProviderId(found) ?? provider.id;
            setDraft({
              name: resolveProviderName(found, id),
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
          setEditingOriginalName(found ? resolveProviderId(found) ?? provider.id : null);
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
      const isEditingBuiltIn = editingOriginalName ? isProviderBuiltIn(editingOriginalName) : false;

      if (isEditingBuiltIn) {
        if (index === 2) {
          // Edit API Key
          setEditingField('apiKey');
          setDraftModified(false);
          setPhase('wizard_key');
          replaceInput(draft.apiKey || '');
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
          replaceInput(draft.name || '');
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
          replaceInput(draft.baseUrl || '');
        } else if (index === 3) {
          // Edit API Key
          setEditingField('apiKey');
          setDraftModified(false);
          setPhase('wizard_key');
          replaceInput(draft.apiKey || '');
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
    } else if (phase === 'reorder') {
      // Enter saves the current order
      settingsService.setPersistent('providerOrder', reorderList);
      setPhase('list');
      setSelectedIndex(0);
      setReorderList([]);
    } else if (phase === 'confirm_discard') {
      if (index === 0) {
        setDraftModified(false);
        const isEditingBuiltIn = editingOriginalName ? isProviderBuiltIn(editingOriginalName) : false;

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
        setPhase(discardFromPhase!);
        setSelectedIndex(0);
        setDiscardFromPhase(null);
      }
    } else if (phase === 'confirm_delete') {
      if (index === 0) {
        // Yes, delete
        if (editingOriginalName) {
          deleteCustomProviderFromService(settingsService, editingOriginalName);
          loadProviderList();
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
    loadProviderList,
    setInput,
    replaceInput,
    reorderList,
    saveDraft,
    activeItems,
    setSelectedIndex,
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
        const isEditingBuiltIn = editingOriginalName ? isProviderBuiltIn(editingOriginalName) : false;
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
    } else if (phase === 'reorder') {
      setPhase('list');
      setSelectedIndex(0);
      setReorderList([]);
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
  }, [phase, editingField, close, draftModified, discardFromPhase, setInput, editingOriginalName, setSelectedIndex]);

  // Handler for text input submissions from app.tsx wizard manager
  const handleTextInputSubmit = useCallback(
    (value: string) => {
      setErrorMessage(null);
      const val = value.trim();

      if (phase === 'wizard_name') {
        const nameValidation = validateWizardName(
          val,
          settingsService,
          editingField !== null,
          editingOriginalName ?? undefined,
        );
        if (!nameValidation.valid) {
          setErrorMessage(nameValidation.errorMessage!);
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
        const urlValidation = validateWizardUrl(val, type);
        if (!urlValidation.valid) {
          setErrorMessage(urlValidation.errorMessage!);
          return false;
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
          const isEditingBuiltIn = editingOriginalName ? isProviderBuiltIn(editingOriginalName) : false;
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
    [phase, draft, editingField, editingOriginalName, settingsService, setInput, setSelectedIndex],
  );

  const requestDelete = useCallback(() => {
    if (phase !== 'list') return;
    const index = Math.min(selectedIndex, items.length - 1);
    if (index < 0 || index >= items.length) return;
    const provider = items[index]!;
    if (!provider.isCustom) return; // only custom providers can be deleted
    setEditingOriginalName(provider.id);
    setPhase('confirm_delete');
    setSelectedIndex(DELETE_CONFIRM_DEFAULT_INDEX); // default to 'No' for safety
  }, [phase, selectedIndex, items, setSelectedIndex]);

  const getActiveItems = useCallback(() => activeItems, [activeItems]);

  const saveProviderOrder = useCallback(() => {
    settingsService.setPersistent('providerOrder', reorderList);
    setPhase('list');
    setSelectedIndex(0);
    setReorderList([]);
  }, [settingsService, reorderList, setSelectedIndex]);

  const moveProviderUp = useCallback(() => {
    if (phase !== 'reorder') return;
    const idx = selectedIndex;
    if (idx <= 0) return;
    setReorderList((prev) => {
      const next = [...prev];
      [next[idx - 1], next[idx]] = [next[idx]!, next[idx - 1]!];
      return next;
    });
    selectionMoveUp();
  }, [phase, selectedIndex, selectionMoveUp]);

  const moveProviderDown = useCallback(() => {
    if (phase !== 'reorder') return;
    const idx = selectedIndex;
    if (idx >= reorderList.length - 1) return;
    setReorderList((prev) => {
      const next = [...prev];
      [next[idx], next[idx + 1]] = [next[idx + 1]!, next[idx]!];
      return next;
    });
    selectionMoveDown();
  }, [phase, selectedIndex, reorderList.length, selectionMoveDown]);

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
    saveProviderOrder,
    moveProviderUp,
    moveProviderDown,
  };
};
