import { useCallback, useEffect, useMemo, useState } from 'react';
import { useInputContext } from '../context/InputContext.js';
import { useSelection } from './use-selection.js';
import { PROVIDER_TYPES, validateWizardName, validateWizardUrl, isProviderBuiltIn, getProviderLabel, } from '../providers/provider-service.js';
import { resolveProviderId, resolveProviderName } from '../services/settings/custom-provider-normalization.js';
import { ProviderManagementSession } from '../services/providers/provider-management-session.js';
import { getProviderCredentialSettingKey, isProviderDisabled, setProviderDisabled, } from '../utils/ai/provider-credentials.js';
import { isOAuthAccountProvider, listOAuthAccounts, oauthLoginCommand, removeOAuthAccount, setActiveOAuthAccount, } from '../providers/oauth-accounts.js';
import { getSessionAccount } from '../providers/oauth-session-account.js';
import { PROVIDER_PRESETS } from '../providers/provider-presets.js';
import { getProvider } from '../providers/registry.js';
const DELETE_CONFIRM_DEFAULT_INDEX = 1;
export const useProviderSelection = (settingsService, options) => {
    const { mode, input, controller, setInput, replaceInput } = useInputContext();
    const providerSession = useMemo(() => new ProviderManagementSession(settingsService), [settingsService]);
    const [phase, setPhase] = useState('list');
    const [items, setItems] = useState([]);
    const [draft, setDraft] = useState(null);
    const [editingOriginalName, setEditingOriginalName] = useState(null);
    const [editingField, setEditingField] = useState(null);
    const [errorMessage, setErrorMessage] = useState(null);
    const [fieldErrors, setFieldErrors] = useState({});
    const [discardFromPhase, setDiscardFromPhase] = useState(null);
    const [draftModified, setDraftModified] = useState(false);
    const [scrollOffset, setScrollOffset] = useState(0);
    const [accountProviderId, setAccountProviderId] = useState(null);
    const [accounts, setAccounts] = useState([]);
    const activeItems = useMemo(() => {
        switch (phase) {
            case 'list':
                return [
                    ...items.map((i) => ({
                        kind: 'provider',
                        id: i.id,
                        label: i.label,
                        isActive: i.isActive,
                        isCustom: i.isCustom,
                        hasCredentials: i.hasCredentials,
                        isDisabled: i.isDisabled,
                    })),
                    { kind: 'add-provider', label: 'Add Provider' },
                ];
            case 'presets':
                return [
                    ...PROVIDER_PRESETS.filter((preset) => !preset.builtinProviderId || getProvider(preset.builtinProviderId))
                        .filter((preset) => `${preset.id} ${preset.name} ${preset.category}`.toLowerCase().includes(input.trim().toLowerCase()))
                        .map((preset) => ({ kind: 'preset', id: preset.id, label: preset.name, docsUrl: preset.docsUrl })),
                    { kind: 'action', label: 'Custom endpoint' },
                ];
            case 'accounts': {
                if (accounts.length === 0) {
                    return [
                        {
                            kind: 'note',
                            label: accountProviderId
                                ? `No accounts stored. Run \`${oauthLoginCommand(accountProviderId)}\` to add one.`
                                : 'No accounts stored.',
                        },
                    ];
                }
                return [
                    ...accounts.map((account) => ({
                        kind: 'account',
                        id: account.id,
                        label: account.label,
                        isSelected: account.isSelected,
                        isInUse: account.isInUse,
                    })),
                    {
                        kind: 'note',
                        label: accountProviderId
                            ? `Add another with \`${oauthLoginCommand(accountProviderId)}\``
                            : 'Add another by logging in again',
                    },
                ];
            }
            case 'wizard_type':
                return PROVIDER_TYPES.map((type) => ({ kind: 'type', label: type }));
            case 'edit_fields': {
                if (!draft)
                    return [];
                const isEditingBuiltIn = editingOriginalName ? isProviderBuiltIn(editingOriginalName) : false;
                const editingDisabled = editingOriginalName ? isProviderDisabled(settingsService, editingOriginalName) : false;
                const toggleLabel = editingDisabled ? 'Enable Provider' : 'Disable Provider';
                if (isEditingBuiltIn) {
                    return [
                        { kind: 'field', label: `Name: ${draft.name || '<empty>'} (Built-in)`, fieldKey: 'name' },
                        { kind: 'field', label: `Type: ${draft.type || '<empty>'} (Built-in)`, fieldKey: 'type' },
                        {
                            kind: 'field',
                            label: 'API Key',
                            detail: draft.apiKey ? '********' : '<empty>',
                            fieldKey: 'apiKey',
                        },
                        { kind: 'action', label: toggleLabel },
                        { kind: 'action', label: 'Save Changes' },
                        { kind: 'action', label: 'Cancel' },
                    ];
                }
                return [
                    { kind: 'field', label: `Name: ${draft.name || '<empty>'}`, fieldKey: 'name' },
                    { kind: 'field', label: `Type: ${draft.type || '<empty>'}`, fieldKey: 'type' },
                    {
                        kind: 'field',
                        label: 'Base URL',
                        detail: draft.baseUrl || '<empty>',
                        fieldKey: 'baseUrl',
                    },
                    {
                        kind: 'field',
                        label: 'API Key',
                        detail: draft.apiKey ? '********' : '<empty>',
                        fieldKey: 'apiKey',
                    },
                    ...(editingOriginalName ? [{ kind: 'action', label: toggleLabel }] : []),
                    { kind: 'action', label: 'Save Changes' },
                    { kind: 'action', label: 'Cancel' },
                ];
            }
            case 'confirm_discard':
                return [
                    { kind: 'action', label: 'Yes, discard changes', tone: 'destructive' },
                    { kind: 'action', label: 'No, keep editing' },
                ];
            case 'confirm_delete':
                return [
                    { kind: 'action', label: 'Yes, delete this provider', tone: 'destructive' },
                    { kind: 'action', label: 'No, keep it' },
                ];
            default:
                return [];
        }
    }, [phase, input, items, draft, editingOriginalName, accounts, accountProviderId, settingsService]);
    const checkIsInactive = useCallback((item) => {
        if (item.kind === 'note')
            return true;
        return item.kind === 'provider' && item.id === 'codex' && !options?.allowCodexSelection;
    }, [options?.allowCodexSelection]);
    const { selectedIndex, setSelectedIndex, moveUp: selectionMoveUp, moveDown: selectionMoveDown, } = useSelection(activeItems, {
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
        }
        else if (selectedIndex >= scrollOffset + 10) {
            setScrollOffset(selectedIndex - 10 + 1);
        }
    }, [selectedIndex, scrollOffset]);
    useEffect(() => {
        if (phase === 'presets')
            setSelectedIndex(0);
    }, [phase, input, setSelectedIndex]);
    const isOpen = mode === 'provider_selection';
    // Load provider items from service
    const loadProviderList = useCallback(() => {
        setItems(providerSession.list());
    }, [providerSession]);
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
        controller.open({ kind: 'providers' });
    }, [controller]);
    const close = useCallback(() => {
        if (mode === 'provider_selection') {
            controller.closeAll();
        }
    }, [controller, mode]);
    // Key navigation handlers
    const moveUp = useCallback(() => {
        selectionMoveUp();
    }, [selectionMoveUp]);
    const moveDown = useCallback(() => {
        selectionMoveDown();
    }, [selectionMoveDown]);
    const saveDraft = useCallback(() => {
        if (!draft)
            return;
        setErrorMessage(null);
        setFieldErrors({});
        const result = providerSession.save(draft, editingOriginalName);
        if (!result.success) {
            if (result.errorMessage)
                setErrorMessage(result.errorMessage);
            if (result.fieldErrors)
                setFieldErrors(result.fieldErrors);
            return;
        }
        loadProviderList();
        setPhase('list');
        setSelectedIndex(0);
        setDraft(null);
        setEditingOriginalName(null);
        setFieldErrors({});
    }, [draft, editingOriginalName, providerSession, loadProviderList, setSelectedIndex]);
    // Persisted immediately: disabling is a picker-visibility change, not part
    // of the draft, so it must not wait for Save Changes.
    const toggleEditingProviderDisabled = useCallback(() => {
        if (!editingOriginalName)
            return;
        const disabled = !isProviderDisabled(settingsService, editingOriginalName);
        setProviderDisabled(settingsService, editingOriginalName, disabled);
        options?.onSystemMessage?.(disabled
            ? `Disabled ${editingOriginalName}. It is hidden from model pickers until re-enabled.`
            : `Enabled ${editingOriginalName}.`);
        loadProviderList();
        setPhase('list');
        setSelectedIndex(0);
        setDraft(null);
        setEditingOriginalName(null);
        setFieldErrors({});
        setInput('');
    }, [editingOriginalName, settingsService, options, loadProviderList, setSelectedIndex]);
    const selectItem = useCallback(() => {
        const listCount = activeItems.length;
        if (listCount === 0)
            return;
        const index = Math.min(selectedIndex, listCount - 1);
        if (phase === 'list') {
            if (index === items.length) {
                // Presets are setup templates, not registered connections.
                setFieldErrors({});
                setDiscardFromPhase(null);
                setDraftModified(false);
                setDraft({
                    name: '',
                    type: 'openai-compatible',
                    baseUrl: '',
                    apiKey: '',
                });
                setPhase('presets');
                setSelectedIndex(0);
                setInput('');
            }
            else {
                // Provider selected
                const provider = items[index];
                options?.onProviderSelected?.(provider.id);
                if (isOAuthAccountProvider(provider.id)) {
                    // OAuth providers hold several logins rather than one key, so this is
                    // the slot where key-based providers open their key editor.
                    setErrorMessage(null);
                    setAccountProviderId(provider.id);
                    setAccounts(listOAuthAccounts(provider.id));
                    setPhase('accounts');
                    setSelectedIndex(0);
                    setInput('');
                    return;
                }
                if (provider.isCustom) {
                    setFieldErrors({});
                    setDiscardFromPhase(null);
                    setDraftModified(false);
                    // Edit custom provider directly
                    const list = settingsService.getDynamic('providers') || [];
                    const found = list.find((p) => resolveProviderId(p) === provider.id);
                    const storedKey = found?.apiKey || '';
                    if (found) {
                        const id = resolveProviderId(found) ?? provider.id;
                        setDraft({
                            name: resolveProviderName(found, id),
                            type: found.type || 'openai-compatible',
                            baseUrl: found.baseUrl || '',
                            apiKey: storedKey,
                        });
                    }
                    else {
                        setDraft({
                            name: provider.id,
                            type: 'openai-compatible',
                            baseUrl: '',
                            apiKey: '',
                        });
                    }
                    setEditingOriginalName(found ? resolveProviderId(found) ?? provider.id : null);
                    setFieldErrors({});
                    if (!provider.hasCredentials) {
                        setPhase('wizard_key');
                        setSelectedIndex(0);
                        replaceInput('');
                    }
                    else {
                        setPhase('edit_fields');
                        setSelectedIndex(0);
                        setInput('');
                    }
                }
                else if (provider.id !== 'codex') {
                    // Allow editing apiKey for built-in providers (except Codex)
                    setFieldErrors({});
                    setDiscardFromPhase(null);
                    setDraftModified(false);
                    const credentialSettingKey = getProviderCredentialSettingKey(provider.id);
                    const storedKey = credentialSettingKey
                        ? settingsService.getDynamic(credentialSettingKey) || ''
                        : '';
                    setDraft({
                        name: provider.label,
                        type: provider.id,
                        apiKey: storedKey,
                    });
                    setEditingOriginalName(provider.id);
                    if (!provider.hasCredentials) {
                        setPhase('wizard_key');
                        setSelectedIndex(0);
                        replaceInput('');
                    }
                    else {
                        setPhase('edit_fields');
                        setSelectedIndex(2);
                        setInput('');
                    }
                }
            }
        }
        else if (phase === 'presets') {
            const item = activeItems[index];
            const preset = item?.kind === 'preset' ? PROVIDER_PRESETS.find((entry) => entry.id === item.id) : undefined;
            setErrorMessage(null);
            setEditingField(null);
            setEditingOriginalName(null);
            if (preset?.builtinProviderId) {
                const providerId = preset.builtinProviderId;
                if (isOAuthAccountProvider(providerId)) {
                    setAccountProviderId(providerId);
                    setAccounts(listOAuthAccounts(providerId));
                    setPhase('accounts');
                }
                else {
                    const key = getProviderCredentialSettingKey(providerId);
                    setDraft({
                        name: preset.name,
                        type: providerId,
                        apiKey: key ? String(settingsService.getDynamic(key) || '') : '',
                    });
                    setEditingOriginalName(providerId);
                    setEditingField('apiKey');
                    setPhase('wizard_key');
                }
            }
            else if (preset?.type) {
                let name = preset.id;
                let suffix = 2;
                while (!validateWizardName(name, settingsService, false).valid)
                    name = `${preset.id}-${suffix++}`;
                setDraft({ name, type: preset.type, baseUrl: preset.baseUrl, apiKey: '' });
                setPhase('edit_fields');
            }
            else {
                setDraft({ name: '', type: 'openai-compatible', baseUrl: '', apiKey: '' });
                setPhase('wizard_name');
            }
            setSelectedIndex(preset?.type ? 3 : 0);
            setDraftModified(false);
            setInput('');
        }
        else if (phase === 'accounts') {
            const item = activeItems[index];
            if (!item || item.kind !== 'account' || !accountProviderId)
                return;
            if (item.isSelected) {
                close();
                return;
            }
            if (!setActiveOAuthAccount(accountProviderId, item.id)) {
                setErrorMessage('That account is no longer stored.');
                setAccounts(listOAuthAccounts(accountProviderId));
                return;
            }
            const label = getProviderLabel(accountProviderId) ?? accountProviderId;
            // The running session stays pinned to the account it started with, so
            // this selection is reported as pending rather than applied: provider
            // response chaining is bound to the identity that opened the chain.
            options?.onSystemMessage?.(`Selected ${item.label} for ${label}. This session keeps using the current account; the change takes effect in your next term2 session.`);
            setAccounts(listOAuthAccounts(accountProviderId));
        }
        else if (phase === 'wizard_type') {
            const selectedType = PROVIDER_TYPES[index];
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
                }
                else {
                    // Normal add wizard flow: type -> url
                    setPhase('wizard_url');
                    setSelectedIndex(0);
                }
            }
        }
        else if (phase === 'edit_fields') {
            if (!draft)
                return;
            const isEditingBuiltIn = editingOriginalName ? isProviderBuiltIn(editingOriginalName) : false;
            if (isEditingBuiltIn) {
                if (index === 2) {
                    // Edit API Key
                    setEditingField('apiKey');
                    setDraftModified(false);
                    setPhase('wizard_key');
                    replaceInput('');
                }
                else if (index === 3) {
                    toggleEditingProviderDisabled();
                }
                else if (index === 4) {
                    // Save Changes
                    saveDraft();
                }
                else if (index === 5) {
                    // Cancel
                    setPhase('list');
                    setSelectedIndex(0);
                    setDraft(null);
                    setEditingOriginalName(null);
                    setFieldErrors({});
                    setInput('');
                }
            }
            else {
                if (index === 0) {
                    // Edit Name
                    setEditingField('name');
                    setDraftModified(false);
                    setPhase('wizard_name');
                    replaceInput(draft.name || '');
                }
                else if (index === 1) {
                    // Edit Type
                    setEditingField('type');
                    setDraftModified(false);
                    setPhase('wizard_type');
                    setSelectedIndex(PROVIDER_TYPES.indexOf(draft.type));
                    setInput('');
                }
                else if (index === 2) {
                    // Edit Base URL
                    setEditingField('baseUrl');
                    setDraftModified(false);
                    setPhase('wizard_url');
                    replaceInput(draft.baseUrl || '');
                }
                else if (index === 3) {
                    // Edit API Key
                    setEditingField('apiKey');
                    setDraftModified(false);
                    setPhase('wizard_key');
                    replaceInput('');
                }
                else if (index === 4 && editingOriginalName) {
                    toggleEditingProviderDisabled();
                }
                else if (index === (editingOriginalName ? 5 : 4)) {
                    // Save Changes
                    saveDraft();
                }
                else {
                    // Cancel
                    setPhase('list');
                    setSelectedIndex(0);
                    setDraft(null);
                    setFieldErrors({});
                    setInput('');
                }
            }
        }
        else if (phase === 'confirm_discard') {
            if (index === 0) {
                setDraftModified(false);
                const isEditingBuiltIn = editingOriginalName ? isProviderBuiltIn(editingOriginalName) : false;
                if (discardFromPhase === 'wizard_name') {
                    if (editingField !== null) {
                        setPhase('edit_fields');
                        setSelectedIndex(0);
                        setEditingField(null);
                    }
                    else {
                        setPhase('list');
                        setSelectedIndex(0);
                        setDraft(null);
                        setEditingOriginalName(null);
                    }
                }
                else if (discardFromPhase === 'wizard_type') {
                    if (editingField !== null) {
                        setPhase('edit_fields');
                        setSelectedIndex(1);
                        setEditingField(null);
                    }
                    else {
                        setPhase('wizard_name');
                        setSelectedIndex(0);
                    }
                }
                else if (discardFromPhase === 'wizard_url') {
                    if (editingField !== null) {
                        setPhase('edit_fields');
                        setSelectedIndex(2);
                        setEditingField(null);
                    }
                    else {
                        setPhase('wizard_type');
                        setSelectedIndex(0);
                    }
                }
                else if (discardFromPhase === 'wizard_key') {
                    if (editingField !== null) {
                        setPhase('edit_fields');
                        setSelectedIndex(isEditingBuiltIn ? 2 : 3);
                        setEditingField(null);
                    }
                    else {
                        setPhase('wizard_url');
                        setSelectedIndex(0);
                    }
                }
                setDiscardFromPhase(null);
                setFieldErrors({});
            }
            else {
                setPhase(discardFromPhase);
                setSelectedIndex(0);
                setDiscardFromPhase(null);
            }
        }
        else if (phase === 'confirm_delete') {
            if (index === 0) {
                // Yes, delete
                if (editingOriginalName) {
                    providerSession.delete(editingOriginalName);
                    loadProviderList();
                }
                setPhase('list');
                setSelectedIndex(0);
                setEditingOriginalName(null);
            }
            else {
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
        providerSession,
        loadProviderList,
        toggleEditingProviderDisabled,
        setInput,
        replaceInput,
        saveDraft,
        activeItems,
        accountProviderId,
        close,
        options,
        setSelectedIndex,
    ]);
    const goBack = useCallback(() => {
        setErrorMessage(null);
        setInput('');
        if (phase === 'list') {
            close();
        }
        else if (phase === 'presets') {
            setPhase('list');
            setSelectedIndex(0);
        }
        else if ((phase === 'wizard_name' || phase === 'wizard_type' || phase === 'wizard_url' || phase === 'wizard_key') &&
            draftModified) {
            setDiscardFromPhase(phase);
            setPhase('confirm_discard');
            setSelectedIndex(DELETE_CONFIRM_DEFAULT_INDEX);
        }
        else if (phase === 'wizard_name') {
            if (editingField) {
                setPhase('edit_fields');
                setSelectedIndex(0);
                setEditingField(null);
            }
            else {
                setPhase('list');
                setSelectedIndex(0);
            }
        }
        else if (phase === 'wizard_type') {
            if (editingField) {
                setPhase('edit_fields');
                setSelectedIndex(1);
                setEditingField(null);
            }
            else {
                setPhase('wizard_name');
                setSelectedIndex(0);
            }
        }
        else if (phase === 'wizard_url') {
            if (editingField) {
                setPhase('edit_fields');
                setSelectedIndex(2);
                setEditingField(null);
            }
            else {
                setPhase('wizard_type');
                setSelectedIndex(0);
            }
        }
        else if (phase === 'wizard_key') {
            if (editingField) {
                setPhase('edit_fields');
                const isEditingBuiltIn = editingOriginalName ? isProviderBuiltIn(editingOriginalName) : false;
                setSelectedIndex(isEditingBuiltIn ? 2 : 3);
                setEditingField(null);
            }
            else {
                setPhase('wizard_url');
                setSelectedIndex(0);
            }
        }
        else if (phase === 'edit_fields') {
            setFieldErrors({});
            setPhase('list');
            setSelectedIndex(0);
            setDraft(null);
            setEditingOriginalName(null);
        }
        else if (phase === 'accounts') {
            setErrorMessage(null);
            setPhase('list');
            setSelectedIndex(0);
            setAccountProviderId(null);
            setAccounts([]);
        }
        else if (phase === 'confirm_delete') {
            setPhase('list');
            setSelectedIndex(0);
            setEditingOriginalName(null);
        }
        else if (phase === 'confirm_discard') {
            if (discardFromPhase) {
                setPhase(discardFromPhase);
                setSelectedIndex(0);
            }
            setDiscardFromPhase(null);
        }
    }, [phase, editingField, close, draftModified, discardFromPhase, setInput, editingOriginalName, setSelectedIndex]);
    // Handler for text input submissions from app.tsx wizard manager
    const handleTextInputSubmit = useCallback((value) => {
        setErrorMessage(null);
        const val = value.trim();
        if (phase === 'wizard_name') {
            const nameValidation = validateWizardName(val, settingsService, editingField !== null, editingOriginalName ?? undefined);
            if (!nameValidation.valid) {
                setErrorMessage(nameValidation.errorMessage);
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
                }
                else {
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
                setErrorMessage(urlValidation.errorMessage);
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
                }
                else {
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
                const isEditingBuiltIn = editingOriginalName ? isProviderBuiltIn(editingOriginalName) : false;
                if (editingField) {
                    setFieldErrors({});
                    setDraftModified(false);
                    setPhase('edit_fields');
                    setSelectedIndex(isEditingBuiltIn ? 2 : 3);
                    setEditingField(null);
                }
                else {
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
    }, [phase, draft, editingField, editingOriginalName, settingsService, setInput, setSelectedIndex]);
    const requestDelete = useCallback(() => {
        if (phase === 'accounts') {
            const item = activeItems[selectedIndex];
            if (!item || item.kind !== 'account' || !accountProviderId)
                return;
            // Forgetting a credential is local and re-doable with another login, so
            // it does not get a confirmation step the way deleting a provider does.
            const wasInUse = getSessionAccount(accountProviderId) === item.id;
            const ok = removeOAuthAccount(accountProviderId, item.id);
            const remaining = listOAuthAccounts(accountProviderId);
            setAccounts(remaining);
            // Clamp to remaining accounts; when none remain, 0 points to the note row.
            setSelectedIndex(Math.max(0, Math.min(selectedIndex, Math.max(0, remaining.length - 1))));
            if (!ok) {
                setErrorMessage('That account is no longer stored.');
                return;
            }
            if (wasInUse && remaining.length > 0) {
                options?.onSystemMessage?.(`Signed out of ${item.label} (this session was using it — next request will use ${remaining[0]?.label ?? 'the selected account'}).`);
            }
            else if (wasInUse) {
                options?.onSystemMessage?.(`Signed out of ${item.label} (this session was using it — no accounts remain).`);
            }
            else {
                options?.onSystemMessage?.(`Signed out of ${item.label}.`);
            }
            return;
        }
        if (phase !== 'list')
            return;
        const index = Math.min(selectedIndex, items.length - 1);
        if (index < 0 || index >= items.length)
            return;
        const provider = items[index];
        if (!provider.isCustom)
            return; // only custom providers can be deleted
        setEditingOriginalName(provider.id);
        setPhase('confirm_delete');
        setSelectedIndex(DELETE_CONFIRM_DEFAULT_INDEX); // default to 'No' for safety
    }, [phase, selectedIndex, items, setSelectedIndex, activeItems, accountProviderId, options]);
    const getActiveItems = useCallback(() => activeItems, [activeItems]);
    const selectedProviderName = phase === 'accounts' && accountProviderId
        ? getProviderLabel(accountProviderId) ?? accountProviderId
        : editingOriginalName ?? undefined;
    return {
        isOpen,
        phase,
        items,
        selectedIndex,
        scrollOffset,
        presetQuery: phase === 'presets' ? input : '',
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
//# sourceMappingURL=use-provider-selection.js.map