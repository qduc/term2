/**
 * The data the ported legacy menus (clients/tui/menus/) read, served from the
 * same legacy services their source counterparts called. Session settings are
 * the attached session's live settings, never launch defaults.
 */
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
} from '../../../source/services/settings/settings-ui-metadata.js';
import { SETTING_KEYS } from '../../../source/services/settings/settings-schema.js';
import { SETTING_ENV_VARIABLES } from '../../../source/services/settings/settings-env.js';
import { SETTINGS_CATEGORIES } from '../../../source/hooks/settings-completion-config.js';
import {
  buildSettingsList,
  filterSettingsByCategory,
  filterSettingsByQuery,
  getSettingCategory,
} from '../../../source/hooks/settings-completion-logic.js';
import {
  buildSettingValueSuggestions,
  fetchLiveSettingValueSuggestions,
  filterSettingValueSuggestionsByQuery,
  mergeSettingValueSuggestions,
} from '../../../source/utils/value-suggestions.js';
import { parseSettingValueForKey } from '../../../source/utils/settings-command.js';
import { isDeepStrictEqual } from 'node:util';
import {
  SUBAGENT_POOL_SETTING_KEYS,
  getSubagentPoolEntryShape,
  getSubagentPoolRoleLabel,
} from '../../../source/services/subagents/subagent-pool-config.js';
import {
  getWorkspaceEntries,
  getWorkspaceEntriesMeta,
  refreshWorkspaceEntries,
} from '../../../source/services/file-service.js';
import { copyToClipboard } from '../../../source/utils/clipboard.js';
import type { LoggingService } from '../../../source/services/logging/logging-service.js';

import type { ISettingsService } from '../../../source/services/service-interfaces.js';
import {
  PROVIDER_TYPES,
  getProviderLabel,
  isProviderBuiltIn,
  validateWizardName,
  validateWizardUrl,
  loadProviderItems,
  type CustomProviderDraft,
} from '../../../source/providers/provider-service.js';
import { ProviderManagementSession } from '../../../source/services/providers/provider-management-session.js';
import {
  resolveProviderId,
  resolveProviderName,
} from '../../../source/services/settings/custom-provider-normalization.js';
import {
  isOAuthAccountProvider,
  listOAuthAccounts,
  oauthLoginCommand,
  removeOAuthAccount,
  setActiveOAuthAccount,
} from '../../../source/providers/oauth-accounts.js';
import { getSessionAccount } from '../../../source/providers/oauth-session-account.js';
import { PROVIDER_PRESETS } from '../../../source/providers/provider-presets.js';
import { getAllProviders, getProvider, getProviderIds } from '../../../source/providers/index.js';
import { filterModels } from '../../../source/services/model-service.js';
import { getFavoriteModelInfos, toggleFavoriteModel } from '../../../source/services/models/model-favorites.js';
import { ModelCatalogSession, orderedProviderIds } from '../../../source/services/models/model-catalog-session.js';
import {
  commitNicknameEdit,
  getNicknameEntries,
  getNicknameLabels,
  getNicknameModelInfos,
  removeNicknameTarget,
} from '../../../source/services/models/model-nicknames.js';
import { RUNTIME_MODIFIABLE_SETTINGS } from '../../../source/services/settings/settings-schema.js';
import {
  getAvailableProviderIds,
  getProviderCredentialSettingKey,
  getProviderIdForCredentialSettingKey,
  hasProviderCredentials,
  isProviderDisabled,
  resolveProviderCredentials,
  setProviderDisabled,
} from '../../../source/utils/ai/provider-credentials.js';
import type {
  MenuConversationEntry,
  MenuSettingsService,
  TuiMenus,
  TuiModelSettings,
  TuiProviderMenu,
} from '../clients/tui/integration.js';
import type { DirectApplication } from './direct-application.js';

import { canonicalProfileId, profileIdFromLegacyMode } from '../../../source/services/profiles/legacy-adapter.js';
import { builtinProfiles } from '../../../source/services/profiles/registry.js';
import { resolveActiveProfile } from '../../../source/services/profiles/active-profile.js';
import { getProfileLabel } from '../../../source/services/profiles/labels.js';

/** Legacy listRecentConversations' limit (source/app.tsx listSavedConversations). */
const RECENT_CONVERSATIONS = 10;

/** Legacy use-profile-selection.ts PROFILE_DETAILS, less the dropped profiles. */
const PROFILE_DETAILS: Record<string, string> = {
  bare: 'Default: shell-only, short prompt; other tools via run_code',
};
const DROPPED_PROFILES = new Set(['plan', 'pair', 'mentor', 'orchestrator']);

/** Legacy PROFILE_OPTIONS without the profiles next dropped. */
const PROFILE_OPTIONS = builtinProfiles
  .map((profile) => {
    const shortId = profile.id.includes(':') ? profile.id.split(':').at(-1)! : profile.id;
    return { id: `builtin:${shortId}`, shortId, displayName: profile.name, detail: PROFILE_DETAILS[shortId] ?? '' };
  })
  .filter((option) => !DROPPED_PROFILES.has(option.shortId));

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
    setPersistentDynamic: (key, value) => persistent.setPersistentDynamic(key, value),
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
      // Legacy lists saved conversations, never the one in use; the hook drops zero-message entries.
      async list(sessionId) {
        const { sessions } = await app.listWorkspaceSessions(root);
        return sessions
          .filter((session) => session.id !== sessionId)
          .map(
            (session): MenuConversationEntry => ({
              id: session.id,
              updatedAt: session.updatedAt ?? '',
              ...(session.title ? { firstUserMessage: session.title } : {}),
              ...(session.messageCount !== undefined ? { messageCount: session.messageCount } : {}),
              model: session.model.model,
              provider: session.model.provider,
            }),
          )
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .slice(0, RECENT_CONVERSATIONS);
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
          // A session pins its start facts (model, effort, profile) as unsaved values, which legacy's
          // service reports as 'cli'. Where the pinned value is the saved one, report the saved source.
          getSource: (key) => {
            const source = settings.getSource(key);
            if (source !== 'cli') return source;
            const saved = persistentSettings.getSource?.(key) ?? 'cli';
            return saved !== 'cli' && isDeepStrictEqual(settings.getDynamic(key), persistentSettings.getDynamic(key))
              ? saved
              : source;
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
