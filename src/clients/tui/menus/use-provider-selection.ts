import { useCallback, useEffect, useMemo, useState } from 'react';
import { useInputContext } from './input-context.js';
import { useSelection } from './use-selection.js';
import type {
  MenuOAuthAccount as OAuthAccountSummary,
  MenuProviderDraft as CustomProviderDraft,
  MenuProviderItem as ProviderSelectionItem,
} from '../integration.js';
import {
  buildProviderMenuItems,
  type ProviderSelectionMenuItem,
  type ProviderSelectionPhase,
} from './provider-menu-model.js';
import { providerEditor, useProviderDraft } from './use-provider-editor.js';

type OAuthAccountProviderId = string;
/** The menu's handle on legacy settings: only the session it reads, through `menus.providers`. */
type SettingsService = { readonly sessionId: string };

export type { CustomProviderDraft, ProviderSelectionItem, ProviderSelectionMenuItem, ProviderSelectionPhase };

/**
 * The /providers manager: phase, selection, the provider list and OAuth
 * accounts. The draft phases (presets, wizard, fields, confirmations) belong
 * to providerEditor; this hook routes their keys there.
 */
export const useProviderSelection = (
  settingsService: SettingsService,
  options?: {
    onProviderSelected?: (provider: string) => void;
    allowCodexSelection?: boolean;
    onSystemMessage?: (message: string) => void;
  },
) => {
  const { mode, input, controller, setInput, menus } = useInputContext();
  // Legacy service calls, bound to the app's adapter (data access is the only change to this hook).
  const api = menus.providers!;
  const { sessionId } = settingsService;
  const providerSession = useMemo(() => ({ list: () => api.list(sessionId) }), [api, sessionId]);
  const getProviderLabel = api.label;
  const isOAuthAccountProvider = api.isOAuthAccountProvider;
  const listOAuthAccounts = api.listAccounts;
  const removeOAuthAccount = api.removeAccount;
  const setActiveOAuthAccount = api.setActiveAccount;
  const getSessionAccount = api.sessionAccount;

  const [phase, setPhase] = useState<ProviderSelectionPhase>('list');
  const [items, setItems] = useState<ProviderSelectionItem[]>([]);
  const draftState = useProviderDraft();
  const { draft, editingOriginalName, fieldErrors, draftModified, discardFromPhase, resetDraft } = draftState;
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [accountProviderId, setAccountProviderId] = useState<OAuthAccountProviderId | null>(null);
  const [accounts, setAccounts] = useState<OAuthAccountSummary[]>([]);

  const activeItems = useMemo(
    (): ProviderSelectionMenuItem[] =>
      buildProviderMenuItems(
        { phase, input, items, draft, editingOriginalName, accounts, accountProviderId },
        api,
        sessionId,
      ),
    [phase, input, items, draft, editingOriginalName, accounts, accountProviderId, api, sessionId],
  );

  const checkIsInactive = useCallback(
    (item: ProviderSelectionMenuItem) => {
      if (item.kind === 'note') return true;
      return item.kind === 'provider' && item.id === 'codex' && !options?.allowCodexSelection;
    },
    [options?.allowCodexSelection],
  );

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

  useEffect(() => {
    if (phase === 'presets') setSelectedIndex(0);
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
      setErrorMessage(null);
      resetDraft();
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [isOpen, loadProviderList, setSelectedIndex, resetDraft]);

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

  const editor = providerEditor(
    draftState,
    api,
    sessionId,
    {
      phase,
      setPhase,
      setSelectedIndex,
      setInput,
      setErrorMessage,
      loadProviderList,
      openAccounts: (providerId) => {
        setAccountProviderId(providerId);
        setAccounts(listOAuthAccounts(providerId));
        setPhase('accounts');
      },
    },
    options,
  );

  const selectItem = useCallback(() => {
    const listCount = activeItems.length;
    if (listCount === 0) return;
    const index = Math.min(selectedIndex, listCount - 1);

    if (phase === 'list') {
      if (index === items.length) {
        editor.startNewProvider();
      } else {
        // Provider selected
        const provider = items[index]!;
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
        editor.editProvider(provider);
      }
    } else if (phase === 'accounts') {
      const item = activeItems[index];
      if (!item || item.kind !== 'account' || !accountProviderId) return;
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
      options?.onSystemMessage?.(
        `Selected ${item.label} for ${label}. This session keeps using the current account; the change takes effect in your next term2 session.`,
      );
      setAccounts(listOAuthAccounts(accountProviderId));
    } else {
      editor.select(index, activeItems);
    }
  }, [phase, selectedIndex, items, activeItems, accountProviderId, close, options, setSelectedIndex, editor]);

  const goBack = useCallback(() => {
    setErrorMessage(null);
    setInput('');
    if (phase === 'list') {
      close();
    } else if (phase === 'accounts') {
      setErrorMessage(null);
      setPhase('list');
      setSelectedIndex(0);
      setAccountProviderId(null);
      setAccounts([]);
    } else {
      editor.goBack();
    }
  }, [phase, close, setInput, setSelectedIndex, editor]);

  const handleTextInputSubmit = editor.submit;

  const requestDelete = useCallback(() => {
    if (phase === 'accounts') {
      const item = activeItems[selectedIndex];
      if (!item || item.kind !== 'account' || !accountProviderId) return;
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
        options?.onSystemMessage?.(
          `Signed out of ${item.label} (this session was using it — next request will use ${
            remaining[0]?.label ?? 'the selected account'
          }).`,
        );
      } else if (wasInUse) {
        options?.onSystemMessage?.(`Signed out of ${item.label} (this session was using it — no accounts remain).`);
      } else {
        options?.onSystemMessage?.(`Signed out of ${item.label}.`);
      }
      return;
    }
    if (phase !== 'list') return;
    const index = Math.min(selectedIndex, items.length - 1);
    if (index < 0 || index >= items.length) return;
    const provider = items[index]!;
    if (!provider.isCustom) return; // only custom providers can be deleted
    editor.requestDelete(provider.id);
  }, [phase, selectedIndex, items, setSelectedIndex, activeItems, accountProviderId, options, editor]);

  const getActiveItems = useCallback(() => activeItems, [activeItems]);

  const selectedProviderName =
    phase === 'accounts' && accountProviderId
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
