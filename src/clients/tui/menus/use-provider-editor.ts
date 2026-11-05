import { useCallback, useState } from 'react';
import type { MenuProviderDraft as CustomProviderDraft, TuiProviderMenu } from '../integration.js';
import {
  storedProviderDraft,
  type ProviderSelectionMenuItem,
  type ProviderSelectionPhase,
} from './provider-menu-model.js';

const DELETE_CONFIRM_DEFAULT_INDEX = 1;

/** The manager's phase and selection, owned by useProviderSelection and driven here for the draft phases. */
export type ProviderEditorNavigation = {
  phase: ProviderSelectionPhase;
  setPhase: (phase: ProviderSelectionPhase) => void;
  setSelectedIndex: (index: number) => void;
  setInput: (text: string) => void;
  setErrorMessage: (message: string | null) => void;
  loadProviderList: () => void;
  /** Leave the add flow for a built-in OAuth provider's account list. */
  openAccounts: (providerId: string) => void;
};

/** The /providers draft state; its only writer is providerEditor. */
export function useProviderDraft() {
  const [draft, setDraft] = useState<CustomProviderDraft | null>(null);
  const [editingOriginalName, setEditingOriginalName] = useState<string | null>(null);
  const [editingField, setEditingField] = useState<'name' | 'type' | 'baseUrl' | 'apiKey' | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [discardFromPhase, setDiscardFromPhase] = useState<ProviderSelectionPhase | null>(null);
  const [draftModified, setDraftModified] = useState(false);
  // Stable, so the manager's open effect does not re-run when it is called.
  const resetDraft = useCallback(() => {
    setDraft(null);
    setEditingOriginalName(null);
    setEditingField(null);
    setFieldErrors({});
    setDiscardFromPhase(null);
    setDraftModified(false);
  }, []);
  return {
    draft,
    editingOriginalName,
    editingField,
    fieldErrors,
    discardFromPhase,
    draftModified,
    resetDraft,
    setters: {
      setDraft,
      setEditingOriginalName,
      setEditingField,
      setFieldErrors,
      setDiscardFromPhase,
      setDraftModified,
    },
  };
}

/**
 * The /providers draft transitions: the add flow from presets through the
 * wizard, the fields editor, save, disable, delete and discard confirmation.
 * List and account phases stay with useProviderSelection, which hands over
 * through startNewProvider, editProvider and requestDelete and routes the
 * draft phases' select, Escape and text submissions here. Built per render,
 * after the manager's selection exists.
 */
export function providerEditor(
  state: ReturnType<typeof useProviderDraft>,
  api: TuiProviderMenu,
  sessionId: string,
  navigation: ProviderEditorNavigation,
  options?: { onSystemMessage?: (message: string) => void },
) {
  const { phase, setPhase, setSelectedIndex, setInput, setErrorMessage, loadProviderList, openAccounts } = navigation;
  const { draft, editingOriginalName, editingField, discardFromPhase, draftModified } = state;
  const { setDraft, setEditingOriginalName, setEditingField, setFieldErrors, setDiscardFromPhase, setDraftModified } =
    state.setters;
  // Legacy InputContext's replaceInput also reset composer queue state, which lives in the native composer here.
  const replaceInput = setInput;
  const PROVIDER_TYPES = api.types as CustomProviderDraft['type'][];
  const settingsReader = { getDynamic: (key: string) => api.getDynamic(sessionId, key) };

  const saveDraft = () => {
    if (!draft) return;
    setErrorMessage(null);
    setFieldErrors({});

    const result = api.save(sessionId, draft, editingOriginalName);
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
  };

  // Persisted immediately: disabling is a picker-visibility change, not part
  // of the draft, so it must not wait for Save Changes.
  const toggleEditingProviderDisabled = () => {
    if (!editingOriginalName) return;
    const disabled = !api.isDisabled(sessionId, editingOriginalName);
    api.setDisabled(sessionId, editingOriginalName, disabled);
    options?.onSystemMessage?.(
      disabled
        ? `Disabled ${editingOriginalName}. It is hidden from model pickers until re-enabled.`
        : `Enabled ${editingOriginalName}.`,
    );
    loadProviderList();
    setPhase('list');
    setSelectedIndex(0);
    setDraft(null);
    setEditingOriginalName(null);
    setFieldErrors({});
    setInput('');
  };

  // "Add Provider": presets are setup templates, not registered connections.
  const startNewProvider = () => {
    setFieldErrors({});
    setDiscardFromPhase(null);
    setDraftModified(false);
    setDraft({ name: '', type: 'openai-compatible', baseUrl: '', apiKey: '' });
    setPhase('presets');
    setSelectedIndex(0);
    setInput('');
  };

  /** Open a registered provider's editor, or its key prompt when it has no credentials. */
  const editProvider = (provider: { id: string; label: string; isCustom: boolean; hasCredentials: boolean }) => {
    // Codex keeps no API key to edit.
    if (!provider.isCustom && provider.id === 'codex') return;
    const stored = storedProviderDraft(provider, api, sessionId);
    setFieldErrors({});
    setDiscardFromPhase(null);
    setDraftModified(false);
    setDraft(stored.draft);
    setEditingOriginalName(stored.originalName);
    setPhase(provider.hasCredentials ? 'edit_fields' : 'wizard_key');
    // A built-in's editor opens on its API key row.
    setSelectedIndex(provider.hasCredentials && !provider.isCustom ? 2 : 0);
    setInput('');
  };

  /** Select in a draft phase; `index` is already clamped to `activeItems`. */
  const select = (index: number, activeItems: ProviderSelectionMenuItem[]) => {
    if (phase === 'presets') {
      const item = activeItems[index];
      const preset = item?.kind === 'preset' ? api.presets().find((entry) => entry.id === item.id) : undefined;
      setErrorMessage(null);
      setEditingField(null);
      setEditingOriginalName(null);
      if (preset?.builtinProviderId) {
        const providerId = preset.builtinProviderId;
        if (api.isOAuthAccountProvider(providerId)) {
          openAccounts(providerId);
        } else {
          const key = api.credentialSettingKey(providerId);
          setDraft({
            name: preset.name,
            type: providerId as CustomProviderDraft['type'],
            apiKey: key ? String(settingsReader.getDynamic(key) || '') : '',
          });
          setEditingOriginalName(providerId);
          setEditingField('apiKey');
          setPhase('wizard_key');
        }
      } else if (preset?.type) {
        let name = preset.id;
        let suffix = 2;
        while (!api.validateName(sessionId, name, false).valid) name = `${preset.id}-${suffix++}`;
        setDraft({ name, type: preset.type, baseUrl: preset.baseUrl, apiKey: '' });
        setPhase('edit_fields');
      } else {
        setDraft({ name: '', type: 'openai-compatible', baseUrl: '', apiKey: '' });
        setPhase('wizard_name');
      }
      setSelectedIndex(preset?.type ? 3 : 0);
      setDraftModified(false);
      setInput('');
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
      const isEditingBuiltIn = editingOriginalName ? api.isBuiltIn(editingOriginalName) : false;

      if (isEditingBuiltIn) {
        if (index === 2) {
          // Edit API Key
          setEditingField('apiKey');
          setDraftModified(false);
          setPhase('wizard_key');
          replaceInput('');
        } else if (index === 3) {
          toggleEditingProviderDisabled();
        } else if (index === 4) {
          // Save Changes
          saveDraft();
        } else if (index === 5) {
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
          replaceInput('');
        } else if (index === 4 && editingOriginalName) {
          toggleEditingProviderDisabled();
        } else if (index === (editingOriginalName ? 5 : 4)) {
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
      if (index === 0) {
        setDraftModified(false);
        const isEditingBuiltIn = editingOriginalName ? api.isBuiltIn(editingOriginalName) : false;

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
          api.delete(sessionId, editingOriginalName);
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
  };

  const goBack = () => {
    if (phase === 'presets') {
      setPhase('list');
      setSelectedIndex(0);
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
        const isEditingBuiltIn = editingOriginalName ? api.isBuiltIn(editingOriginalName) : false;
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
  };

  // Handler for text input submissions from the wizard prompt.
  const submit = (value: string) => {
    setErrorMessage(null);
    const val = value.trim();

    if (phase === 'wizard_name') {
      const nameValidation = api.validateName(sessionId, val, editingField !== null, editingOriginalName ?? undefined);
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
      const urlValidation = api.validateUrl(val, type);
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
        const updatedDraft = { ...draft, apiKey: val || draft.apiKey };
        setDraft(updatedDraft);
        setDraftModified(true);
        const isEditingBuiltIn = editingOriginalName ? api.isBuiltIn(editingOriginalName) : false;
        if (editingField) {
          setFieldErrors({});
          setDraftModified(false);
          setPhase('edit_fields');
          setSelectedIndex(isEditingBuiltIn ? 2 : 3);
          setEditingField(null);
        } else {
          // Wizard complete, go to fields overview before saving
          setPhase('edit_fields');
          setSelectedIndex(isEditingBuiltIn ? 4 : editingOriginalName ? 5 : 4); // focus Save changes button
          setFieldErrors({});
          setDraftModified(false);
        }
      }
      setInput('');
      return true;
    }

    return false;
  };

  const requestDelete = (providerId: string) => {
    setEditingOriginalName(providerId);
    setPhase('confirm_delete');
    setSelectedIndex(DELETE_CONFIRM_DEFAULT_INDEX); // default to 'No' for safety
  };

  return { startNewProvider, editProvider, select, goBack, submit, requestDelete };
}
