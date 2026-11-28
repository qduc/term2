/**
 * Daemon-backed `/providers` menu adapter (`TuiProviderMenu`) for TUI over Client API v1.1.
 * Reads provider/credential/OAuth projections from `DaemonTuiSettingsStore` (never secrets
 * or local files) and mutates through daemon RPCs (`providers.upsert`, `providers.delete`,
 * `credentials.set`/`delete`, `oauth.select`/`delete`).
 */
import type {
  MenuOAuthAccount,
  MenuProviderDraft,
  MenuProviderItem,
  MenuProviderPreset,
  TuiProviderMenu,
} from '../../clients/tui/integration.js';
import { resolveProviderId, resolveProviderName } from '../../config/settings/custom-provider-normalization.js';
import type { RemoteDirectHost } from '../../host/daemon/remote-direct-host.js';
import { getProviderCredentialSettingKey } from '../../model/provider-credentials.js';
import { getProvider } from '../../model/providers/index.js';
import { isOAuthAccountProvider, oauthLoginCommand } from '../../model/providers/oauth-accounts.js';
import { PROVIDER_PRESETS } from '../../model/providers/provider-presets.js';
import {
  PROVIDER_TYPES,
  getProviderLabel,
  isProviderBuiltIn,
  validateWizardUrl,
} from '../../model/providers/provider-service.js';
import type { DaemonTuiSettingsStore } from './daemon-tui-settings-store.js';

function validateDaemonProviderName(
  store: DaemonTuiSettingsStore,
  sessionId: string,
  value: string,
  editingOriginalName?: string,
): { valid: boolean; errorMessage?: string } {
  const trimmed = value.trim();
  if (!trimmed) return { valid: false, errorMessage: 'Provider name is required.' };
  const normalized = trimmed.toLowerCase();
  if (isProviderBuiltIn(normalized) && normalized !== editingOriginalName?.toLowerCase()) {
    return { valid: false, errorMessage: `'${trimmed}' is reserved for a built-in provider.` };
  }
  const existing = store.projection(sessionId).providers;
  const conflict = existing.find(
    (entry) => entry.id.toLowerCase() === normalized && entry.id.toLowerCase() !== editingOriginalName?.toLowerCase(),
  );
  if (conflict) return { valid: false, errorMessage: `Provider '${trimmed}' already exists.` };
  return { valid: true };
}

export function createDaemonProviderMenu(
  store: DaemonTuiSettingsStore,
  getHost: () => RemoteDirectHost,
): TuiProviderMenu {
  const refreshLater = (sessionId: string) =>
    Promise.all([store.refresh(sessionId), store.refresh()]).catch(() => undefined);
  const track = (sessionId: string, op: Promise<unknown>) => {
    store.trackPending(
      op.then(
        () => refreshLater(sessionId),
        () => refreshLater(sessionId),
      ),
    );
  };

  return {
    types: PROVIDER_TYPES,
    presets(): readonly MenuProviderPreset[] {
      return PROVIDER_PRESETS.filter((preset) => !preset.builtinProviderId || getProvider(preset.builtinProviderId));
    },
    list(sessionId): MenuProviderItem[] {
      return store.projection(sessionId).providers.map((entry) => ({
        id: entry.id,
        label: entry.label,
        isCustom: entry.isCustom,
        isActive: entry.isActive,
        hasCredentials: entry.hasCredentials,
        isDisabled: entry.isDisabled,
      }));
    },
    save(sessionId, draft: MenuProviderDraft, editingOriginalName: string | null): ReturnType<TuiProviderMenu['save']> {
      if (editingOriginalName && isProviderBuiltIn(editingOriginalName)) {
        const key = draft.apiKey?.trim() ?? '';
        const op = key
          ? getHost().setCredential(editingOriginalName, key)
          : getHost().deleteCredential(editingOriginalName);
        track(sessionId, op);
        return { success: true };
      }

      const nameCheck = validateDaemonProviderName(store, sessionId, draft.name, editingOriginalName ?? undefined);
      if (!nameCheck.valid) {
        return { success: false, fieldErrors: { name: nameCheck.errorMessage ?? 'Invalid provider name.' } };
      }
      const existing = editingOriginalName
        ? store.projection(sessionId).providers.find((entry) => entry.id === editingOriginalName)
        : undefined;
      const keepBaseUrl = Boolean(editingOriginalName && !draft.baseUrl?.trim() && existing?.hasBaseUrl);
      if (!keepBaseUrl) {
        const urlCheck = validateWizardUrl(draft.baseUrl ?? '', draft.type);
        if (!urlCheck.valid) {
          return { success: false, fieldErrors: { baseUrl: urlCheck.errorMessage ?? 'Invalid Base URL.' } };
        }
      }

      const apiKey = draft.apiKey?.trim();
      const baseUrl = draft.baseUrl?.trim();
      track(
        sessionId,
        getHost().upsertProvider({
          action: 'save',
          ...(editingOriginalName ? { originalId: editingOriginalName } : {}),
          name: draft.name.trim(),
          type: draft.type,
          ...(baseUrl ? { baseUrl } : keepBaseUrl ? { keepBaseUrl: true } : {}),
          ...(apiKey ? { apiKey } : editingOriginalName ? { keepApiKey: true } : {}),
        }),
      );
      return { success: true };
    },
    delete(sessionId, providerId) {
      track(sessionId, getHost().deleteProvider(providerId));
    },
    validateName(sessionId, value, _isEditingField, editingOriginalName) {
      return validateDaemonProviderName(store, sessionId, value, editingOriginalName);
    },
    validateUrl: validateWizardUrl,
    isBuiltIn: isProviderBuiltIn,
    label(id) {
      return store.projection().providers.find((entry) => entry.id === id)?.label ?? getProviderLabel(id);
    },
    getDynamic(sessionId, key) {
      if (key === 'providers') {
        // Safe non-secret custom provider descriptors for `storedProviderDraft`; never exposes API keys.
        return store
          .projection(sessionId)
          .providers.filter((entry) => entry.isCustom)
          .map((entry) => ({
            id: entry.id,
            name: entry.label,
            type: entry.type ?? 'openai-compatible',
            ...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
          }));
      }
      return store.liveSettings(sessionId)?.getDynamic(key) ?? store.globalSettings.getDynamic(key);
    },
    resolveProviderId,
    resolveProviderName,
    credentialSettingKey: getProviderCredentialSettingKey,
    hasCredentials(sessionId, id) {
      return store.projection(sessionId).providers.find((entry) => entry.id === id)?.hasCredentials ?? false;
    },
    isDisabled(sessionId, id) {
      return store.projection(sessionId).providers.find((entry) => entry.id === id)?.isDisabled ?? false;
    },
    setDisabled(sessionId, id, disabled) {
      track(sessionId, getHost().upsertProvider({ action: 'toggle', providerId: id, disabled }));
    },
    isOAuthAccountProvider,
    listAccounts(sessionId, id): MenuOAuthAccount[] {
      const projection = store.projection(sessionId);
      const inUse = id === 'codex' || id === 'grok' ? projection.sessionAccounts?.[id] ?? null : null;
      return (projection.oauthAccounts[id] ?? []).map((account) => ({
        id: account.id,
        label: account.label,
        isSelected: account.isSelected,
        isInUse: inUse !== null ? inUse === account.id : account.isInUse === true,
      }));
    },
    loginCommand: (id) => (isOAuthAccountProvider(id) ? oauthLoginCommand(id) : ''),
    removeAccount(id, account) {
      if (id !== 'codex' && id !== 'grok') return false;
      store.trackPending(
        getHost()
          .oauthDelete(id, account)
          .then(() => store.refresh().catch(() => undefined))
          .catch(() => undefined),
      );
      return true;
    },
    setActiveAccount(id, account) {
      if (id !== 'codex' && id !== 'grok') return false;
      store.trackPending(
        getHost()
          .oauthSelect(id, account)
          .then(() => store.refresh().catch(() => undefined))
          .catch(() => undefined),
      );
      return true;
    },
    sessionAccount(sessionId, providerId) {
      if (providerId !== 'codex' && providerId !== 'grok') return null;
      return store.sessionMeta(sessionId).sessionAccounts[providerId];
    },
  };
}
