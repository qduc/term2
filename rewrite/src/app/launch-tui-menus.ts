/**
 * The data the ported legacy menus (clients/tui/menus/) read, served from the
 * same legacy services their source counterparts called. Session settings are
 * the attached session's live settings, never launch defaults.
 */
import { isDroppedProfile } from './dropped-profiles.js';
import {
  getAllSettingDescriptions,
  getSettingLabel,
  getSettingMetadata,
  isBooleanSetting,
  isDurationSetting,
  isKnownSettingKey,
  isNumberSetting,
  isSecretSetting,
  isStringSetting,
  isUsdMicrosSetting,
} from '../config/settings/settings-ui-metadata.js';
import { SETTING_KEYS } from '../config/settings/settings-schema.js';
import { SETTING_ENV_VARIABLES } from '../config/settings/settings-env.js';
import { SETTINGS_CATEGORIES } from '../clients/hooks/settings-completion-config.js';
import {
  buildSettingsList,
  filterSettingsByCategory,
  filterSettingsByQuery,
  getSettingCategory,
} from '../clients/hooks/settings-completion-logic.js';
import {
  buildSettingValueSuggestions,
  fetchLiveSettingValueSuggestions,
  filterSettingValueSuggestionsByQuery,
  mergeSettingValueSuggestions,
} from '../shared/utils/value-suggestions.js';
import { parseSettingValueForKey } from '../shared/utils/settings-command.js';
import { isDeepStrictEqual } from 'node:util';
import {
  SUBAGENT_POOL_SETTING_KEYS,
  getSubagentPoolEntryShape,
  getSubagentPoolRoleLabel,
} from '../tools/subagents/subagent-pool-config.js';
import { getWorkspaceEntries, getWorkspaceEntriesMeta, refreshWorkspaceEntries } from './file-service.js';
import { copyToClipboard } from '../shared/utils/clipboard.js';
import type { LoggingService } from '../session/logging/logging-service.js';

import type { ISettingsService } from '../shared/service-interfaces.js';
import {
  PROVIDER_TYPES,
  getProviderLabel,
  isProviderBuiltIn,
  validateWizardName,
  validateWizardUrl,
  loadProviderItems,
  type CustomProviderDraft,
} from '../model/providers/provider-service.js';
import { ProviderManagementSession } from '../model/providers/provider-management-session.js';
import { resolveProviderId, resolveProviderName } from '../config/settings/custom-provider-normalization.js';
import {
  isOAuthAccountProvider,
  listOAuthAccounts,
  oauthLoginCommand,
  removeOAuthAccount,
  setActiveOAuthAccount,
} from '../model/providers/oauth-accounts.js';
import { getSessionAccount } from '../model/providers/oauth-session-account.js';
import { PROVIDER_PRESETS } from '../model/providers/provider-presets.js';
import { getAllProviders, getProvider, getProviderIds } from '../model/providers/index.js';
import { filterModels } from '../model/model-service.js';
import { getFavoriteModelInfos, toggleFavoriteModel } from '../model/models/model-favorites.js';
import { ModelCatalogSession, orderedProviderIds } from '../model/models/model-catalog-session.js';
import {
  commitNicknameEdit,
  getNicknameEntries,
  getNicknameLabels,
  getNicknameModelInfos,
  removeNicknameTarget,
} from '../model/models/model-nicknames.js';
import { RUNTIME_MODIFIABLE_SETTINGS } from '../config/settings/settings-schema.js';
import {
  getAvailableProviderIds,
  getProviderCredentialSettingKey,
  getProviderIdForCredentialSettingKey,
  hasProviderCredentials,
  isProviderDisabled,
  resolveProviderCredentials,
  setProviderDisabled,
} from '../shared/utils/ai/provider-credentials.js';
import type {
  MenuConversationEntry,
  MenuSettingsService,
  TuiMenus,
  TuiModelSettings,
  TuiProviderMenu,
} from '../clients/tui/integration.js';
import type { DirectApplication } from './application.js';

import { canonicalProfileId, profileIdFromLegacyMode } from '../shared/profiles/legacy-adapter.js';
import { builtinProfiles } from '../config/profiles/registry.js';
import { resolveActiveProfile } from '../config/profiles/active-profile.js';
import { getProfileLabel } from '../config/profiles/labels.js';
import { displaySessionId } from '../protocol/session-id.js';

/** Legacy listRecentConversations' limit (source/app.tsx listSavedConversations). */
const RECENT_CONVERSATIONS = 10;

/** Legacy use-profile-selection.ts PROFILE_DETAILS, less the dropped profiles. */
const PROFILE_DETAILS: Record<string, string> = {
  bare: 'Default: shell-only, short prompt; other tools via run_code',
};

/** Legacy PROFILE_OPTIONS without the profiles next dropped. */
const PROFILE_OPTIONS = builtinProfiles
  .map((profile) => {
    const shortId = profile.id.includes(':') ? profile.id.split(':').at(-1)! : profile.id;
    return { id: `builtin:${shortId}`, shortId, displayName: profile.name, detail: PROFILE_DETAILS[shortId] ?? '' };
  })
  .filter((option) => !isDroppedProfile(option.shortId));

type MenuOptions = {
  readonly app: Pick<DirectApplication, 'liveSettings' | 'skills' | 'listWorkspaceSessions'>;
  /** The settings file; favorite, nickname and provider edits are saved there as legacy did. */
  readonly persistentSettings: ISettingsService;
  readonly logger: LoggingService;
  /** The workspace the TUI was launched in: saved conversations and skills are listed for it. */
  readonly root: string;
};

/**
 * Legacy hands the provider manager its one global SettingsService. Here writes go to the persistent service (as
 * legacy's did) and the active model is read from the attached session, which owns its own selection. A rename of
 * the active provider saves the renamed selection for the next session; this session keeps its own until /model.
 */
function providerSettings(persistent: ISettingsService, live: ISettingsService | null): ISettingsService {
  return {
    ...persistent,
    get: ((key: string) =>
      key === 'agent.modelSelection' && live ? live.get(key) : persistent.get(key as never)) as ISettingsService['get'],
    getDynamic: (key) => persistent.getDynamic(key),
    set: (key, value, options) => persistent.set(key, value, options),
    setDynamic: (key, value, options) => persistent.setDynamic(key, value, options),
    setPersistent: (key, value) => persistent.setPersistent(key, value),
    // Legacy has one settings service: a saved provider or key is at once what the session's
    // model picker and credential checks read (the session's copy never writes the file).
    setPersistentDynamic: (key, value) => {
      const result = persistent.setPersistentDynamic(key, value);
      live?.setPersistentDynamic(key, value);
      return result;
    },
  };
}

function createProviderMenu(persistent: ISettingsService, live: (sessionId: string) => ISettingsService | null) {
  const settings = (sessionId: string) => providerSettings(persistent, live(sessionId));
  const menu: TuiProviderMenu = {
    types: PROVIDER_TYPES,
    presets: () =>
      PROVIDER_PRESETS.filter((preset) => !preset.builtinProviderId || getProvider(preset.builtinProviderId)),
    list: (sessionId) => new ProviderManagementSession(settings(sessionId)).list(),
    save: (sessionId, draft, original) =>
      new ProviderManagementSession(settings(sessionId)).save(draft as CustomProviderDraft, original),
    delete: (sessionId, id) => new ProviderManagementSession(settings(sessionId)).delete(id),
    validateName: (sessionId, value, editing, original) =>
      validateWizardName(value, settings(sessionId), editing, original),
    validateUrl: validateWizardUrl,
    isBuiltIn: isProviderBuiltIn,
    label: getProviderLabel,
    getDynamic: (sessionId, key) => settings(sessionId).getDynamic(key),
    resolveProviderId,
    resolveProviderName,
    credentialSettingKey: getProviderCredentialSettingKey,
    hasCredentials: (sessionId, id) => hasProviderCredentials(settings(sessionId), id),
    isDisabled: (sessionId, id) => isProviderDisabled(settings(sessionId), id),
    setDisabled: (sessionId, id, disabled) => setProviderDisabled(settings(sessionId), id, disabled),
    isOAuthAccountProvider,
    listAccounts: (id) => (isOAuthAccountProvider(id) ? listOAuthAccounts(id) : []),
    loginCommand: (id) => (isOAuthAccountProvider(id) ? oauthLoginCommand(id) : ''),
    removeAccount: (id, account) => isOAuthAccountProvider(id) && removeOAuthAccount(id, account),
    setActiveAccount: (id, account) => isOAuthAccountProvider(id) && setActiveOAuthAccount(id, account),
    sessionAccount: (id) => getSessionAccount(id),
  };
  return menu;
}

/** The legacy model services bound to one session's live settings. */
function modelSettings(live: ISettingsService, options: MenuOptions): TuiModelSettings {
  const save = (key: 'agent.favoriteModels' | 'agent.modelNicknames') =>
    options.persistentSettings.setPersistentDynamic(key, live.get(key));
  return {
    get: (key) => live.get(key as never),
    getDynamic: (key) => live.getDynamic(key),
    isRuntimeModifiable: (key) => RUNTIME_MODIFIABLE_SETTINGS.has(key),
    onChange: live.onChange ? (listener) => live.onChange!(listener) : undefined,
    providerIds: () => getProviderIds(),
    orderedProviderIds: (ids) => orderedProviderIds(live, ids),
    providers: () => getAllProviders(),
    providerLabel: (id) => getProvider(id)?.label,
    availableProviderIds: (ids) => getAvailableProviderIds(live, ids),
    hasProviderCredentials: (id) => hasProviderCredentials(live, id),
    unavailableReason: (id) => resolveProviderCredentials(live, id).unavailableReason,
    credentialSettingKey: getProviderCredentialSettingKey,
    providerIdForCredentialSettingKey: getProviderIdForCredentialSettingKey,
    createCatalog: () => new ModelCatalogSession({ settingsService: live, loggingService: options.logger }),
    favoriteModelInfos: () => getFavoriteModelInfos(live),
    toggleFavorite(provider, modelId) {
      const favorited = toggleFavoriteModel(live, provider, modelId);
      save('agent.favoriteModels');
      return favorited;
    },
    nicknameEntries: () => getNicknameEntries(live),
    nicknameLabels: () => getNicknameLabels(live),
    nicknameModelInfos: () => getNicknameModelInfos(live),
    commitNickname(draft, providerIds) {
      const result = commitNicknameEdit(live, draft, providerIds);
      if (result.saved) save('agent.modelNicknames');
      return result;
    },
    removeNickname(target) {
      const removed = removeNicknameTarget(live, target);
      if (removed) save('agent.modelNicknames');
      return removed;
    },
    filterModels,
    providerItems: () => loadProviderItems(live),
  };
}

export function createDirectTuiMenus(options: MenuOptions): TuiMenus {
  const { app, logger, persistentSettings, root } = options;
  const bySession = new Map<string, { live: ISettingsService; settings: TuiModelSettings }>();
  const services = new Map<string, MenuSettingsService>();
  return {
    profile: {
      options: PROFILE_OPTIONS,
      canonicalId: canonicalProfileId,
      activeId(sessionId) {
        const settings = app.liveSettings(sessionId);
        return settings ? resolveActiveProfile(settings).identity.id : null;
      },
    },
    copy: copyToClipboard,
    skills: { list: () => [...app.skills(root)] },
    resume: {
      // Legacy takes the 10 most recent session files, the one in use included (newest when it has not
      // been saved yet, as legacy writes it at launch), then hides it; the hook drops zero-message entries.
      async list(sessionId) {
        const { sessions } = await app.listWorkspaceSessions(root);
        const ranked = [...sessions].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
        const recent = ranked.some((session) => session.id === sessionId)
          ? ranked.slice(0, RECENT_CONVERSATIONS)
          : ranked.slice(0, RECENT_CONVERSATIONS - 1);
        return recent
          .filter((session) => session.id !== sessionId)
          .map(
            (session): MenuConversationEntry => ({
              id: displaySessionId(session.id),
              updatedAt: session.updatedAt ?? '',
              ...(session.title ? { firstUserMessage: session.title } : {}),
              ...(session.messageCount !== undefined ? { messageCount: session.messageCount } : {}),
              model: session.model.model,
              provider: session.model.provider,
            }),
          );
      },
      profileLabel: (activeProfileId, appMode) =>
        getProfileLabel(activeProfileId ?? profileIdFromLegacyMode(appMode as never)),
    },
    settings: {
      lib: {
        SETTING_KEYS,
        SETTING_ENV_VARIABLES,
        SETTINGS_CATEGORIES,
        SETTING_DESCRIPTIONS: getAllSettingDescriptions(),
        buildSettingsList,
        filterSettingsByQuery,
        filterSettingsByCategory,
        getSettingCategory,
        getSettingMetadata,
        getSettingLabel,
        isSecretSetting,
        isStringSetting,
        isNumberSetting,
        isBooleanSetting,
        isDurationSetting,
        isUsdMicrosSetting,
        buildSettingValueSuggestions,
        fetchLiveSettingValueSuggestions: (key) => fetchLiveSettingValueSuggestions(key),
        mergeSettingValueSuggestions,
        filterSettingValueSuggestionsByQuery,
        parseSettingValueForKey,
      },
      // Legacy hooks take one SettingsService; this is the attached session's live one (no disk read).
      service(sessionId) {
        const cached = services.get(sessionId);
        if (cached) return cached;
        const settings = app.liveSettings(sessionId);
        if (!settings) throw new Error('The attached session has no live settings.');
        const service: MenuSettingsService = {
          getDynamic: (key) => settings.getDynamic(key),
          getDefault: (key) => settings.getDefault(key),
          // A session keeps its start facts (model, effort, profile) and every in-session change as unsaved
          // values, which legacy's service would report as 'cli'. Only a real launch flag is a command-line
          // flag; otherwise report the saved source where the value is the saved one, else 'config', as
          // legacy reported a change its menu had just saved.
          getSource: (key) => {
            const source = settings.getSource(key);
            if (source !== 'cli') return source;
            const saved = persistentSettings.getSource?.(key) ?? 'default';
            if (saved === 'cli') return 'cli';
            return isDeepStrictEqual(settings.getDynamic(key), persistentSettings.getDynamic(key)) ? saved : 'config';
          },
          getStartupOverride: (key) => settings.getStartupOverride(key),
          isRuntimeModifiable: (key) => settings.isRuntimeModifiable(key),
          onChange: (listener) => settings.onChange(() => listener()),
        };
        services.set(sessionId, service);
        return service;
      },
    },
    providers: createProviderMenu(persistentSettings, (sessionId) => app.liveSettings(sessionId) ?? null),
    models: {
      settings(sessionId) {
        const live = options.app.liveSettings(sessionId);
        if (!live) throw new Error('The attached session has no live settings.');
        const cached = bySession.get(sessionId);
        if (cached?.live === live) return cached.settings;
        const settings = modelSettings(live, options);
        bySession.set(sessionId, { live, settings });
        return settings;
      },
    },
    logger: {
      warn: (message, details) => logger.warn(message, details),
      error: (message, details) => logger.error(message, details),
    },
    paths: {
      entries: getWorkspaceEntries,
      refresh: refreshWorkspaceEntries,
      meta: getWorkspaceEntriesMeta,
    },
    schema: {
      isKnownSettingKey,
      label: getSettingLabel,
      isSecret: isSecretSetting,
      subagentPool: (key) =>
        SUBAGENT_POOL_SETTING_KEYS.has(key)
          ? { roleLabel: getSubagentPoolRoleLabel(key), entryShape: getSubagentPoolEntryShape(key) }
          : undefined,
    },
  };
}
