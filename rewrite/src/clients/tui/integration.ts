import type { ReactNode } from 'react';
import type { WireEvent, WireSnapshot } from '../../protocol/direct-wire.js';
import type { DirectConnection, DirectReplayConnection } from '../../host/in-process-direct-types.js';

import type { WireContent } from '../../protocol/direct-wire.js';
import type { CopySelection } from './menus/menu-types.js';

export type TuiConnection = DirectConnection | DirectReplayConnection;

/**
 * App-owned local slash commands and host/config capabilities. This must not
 * send raw slash text as a wire RPC or access Session/Engine. Unsupported
 * commands must throw; session replacement and exit belong to the app.
 */
export type BridgeStatus = {
  readonly sessionId: string;
  readonly startup: boolean;
  readonly attachment: null | {
    readonly name: string;
    readonly socketPath: string;
    readonly discordInputEnabled: boolean;
  };
};
export type TuiStatusInfo = {
  /** Display name of the active profile, e.g. `Bare`. */
  readonly profile: string;
  readonly contextWindow?: number;
  readonly effort: string | undefined;
  readonly approval: 'off' | 'advisory' | 'auto' | 'always';
  /** The active provider's id and the registry label legacy's status bar shows for it (`openai` → `OpenAI`). */
  readonly provider?: { readonly id: string; readonly label: string };
};

/** Legacy `PathEntry` (source/services/file-service.ts). */
export type MenuPathEntry = { readonly path: string; readonly type: 'file' | 'directory' };
export type MenuLogger = {
  warn(message: string, details?: Record<string, unknown>): void;
  error(message: string, details?: Record<string, unknown>): void;
};
/** Legacy `WorkspaceEntriesMeta` (source/services/file-service.ts). */
export type MenuWorkspaceEntriesMeta = {
  lastLoadedAt: number | null;
  totalEntries: number;
  truncated: boolean;
  truncatedByTotalLimit: boolean;
  limit: number;
};
/** Legacy `ModelInfo` (source/services/model-service.ts). */
export type MenuModelInfo = {
  id: string;
  name?: string;
  provider: string;
  unavailableReason?: 'missing-credentials' | 'missing-codex-login' | 'missing-grok-login';
  default_reasoning_level?: string;
  contextWindow?: number;
};
/** Legacy `ProfileOption` (source/hooks/use-profile-selection.ts). */
export type MenuProfileOption = {
  /** Canonical id, e.g. `builtin:bare`. */
  id: string;
  /** Short id accepted by `/profile`, e.g. `bare`. */
  shortId: string;
  displayName: string;
  detail: string;
};
/** The fields of legacy `SkillInfo` the skills menu reads. */
export type MenuSkillInfo = { name: string; description: string; isProjectLevel: boolean };

/**
 * Pure lookups over the legacy settings schema (settings-ui-metadata.ts,
 * subagent-pool-config.ts). Called during render and trigger parsing, so they
 * must not touch disk or the session log.
 */
export interface TuiSettingsSchema {
  isKnownSettingKey(key: string): boolean;
  label(key: string): string;
  isSecret(key: string): boolean;
  subagentPool(key: string): { readonly roleLabel: string; readonly entryShape: 'entries' | 'models' } | undefined;
}

/** Legacy ProviderSelectionItem (source/providers/provider-service.ts). */
export interface MenuProviderSelectionItem {
  id: string;
  label: string;
  isCustom: boolean;
  isActive: boolean;
  hasCredentials: boolean;
  isDisabled: boolean;
}

/** A legacy ModelCatalogSession (source/services/models/model-catalog-session.ts). */
export interface MenuModelCatalog {
  getCached(provider: string): MenuModelInfo[] | undefined;
  load(provider: string): Promise<{ kind: 'loaded' | 'cached' | 'stale'; models: MenuModelInfo[] }>;
  begin(): void;
  refresh(provider: string): void;
  invalidate(provider: string): void;
  clear(): void;
}
export type MenuNicknameTarget = { provider: string; modelId: string; reasoningEffort?: string };
export type MenuNicknameEntry = { nickname: string } & MenuNicknameTarget;
export type MenuNicknameConflict = { nickname: string; provider: string; modelId: string };

/**
 * One session's live settings and the legacy model services bound to them
 * (model-favorites, model-nicknames, provider-credentials, providers/index,
 * model-service). In-memory reads only; `createCatalog().load` fetches and is
 * called when a picker opens, never during render. Favorite and nickname writes
 * also save to the settings file, as legacy's setPersistent did.
 */
export interface TuiModelSettings {
  get(key: string): any; // eslint-disable-line @typescript-eslint/no-explicit-any
  getDynamic(key: string): unknown;
  isRuntimeModifiable(key: string): boolean;
  onChange?(listener: (key?: string) => void): () => void;
  providerIds(): string[];
  orderedProviderIds(providerIds: string[]): string[];
  providers(): readonly { readonly id: string; readonly label: string }[];
  providerLabel(providerId: string): string | undefined;
  availableProviderIds(providerIds: string[]): string[];
  hasProviderCredentials(providerId: string): boolean;
  unavailableReason(providerId: string): MenuModelInfo['unavailableReason'];
  credentialSettingKey(providerId: string): string | undefined;
  providerIdForCredentialSettingKey(key: string | undefined): string | undefined;
  createCatalog(): MenuModelCatalog;
  favoriteModelInfos(): MenuModelInfo[];
  toggleFavorite(provider: string, modelId: string): boolean;
  nicknameEntries(): MenuNicknameEntry[];
  nicknameLabels(): Map<string, string>;
  nicknameModelInfos(): MenuModelInfo[];
  commitNickname(
    draft: { text: string; provider: string; modelId: string; pendingReplace?: MenuNicknameConflict | null },
    providerIds?: readonly string[],
  ): { saved: true } | { saved: false; error: string; pendingReplace: MenuNicknameConflict | null };
  removeNickname(target: { provider: string; modelId: string }): boolean;
  /** model-service.ts filterModels. */
  filterModels(models: MenuModelInfo[], query: string): MenuModelInfo[];
  /** provider-service.ts loadProviderItems, for the pool editor's provider step. */
  providerItems(): MenuProviderSelectionItem[];
}

/** Legacy `SettingCompletionItem` (source/hooks/settings-completion-config.ts). */
export type SettingCompletionItem = {
  key: string;
  label: string;
  description?: string;
  currentValue?: unknown;
  source?: 'cli' | 'env' | 'config' | 'default';
  isModified?: boolean;
  startupOverride?: { source: 'env' | 'cli'; name?: string };
  requiresRestart?: boolean;
  isAdvanced?: boolean;
};
export type SettingsCategory = { id: string; label: string };
/** Legacy `SettingValueSuggestion` (source/utils/value-suggestions.ts). */
export type SettingValueSuggestion = { value: string; description?: string };

/**
 * The legacy settings-menu library: schema metadata, list building, filtering,
 * value suggestions and value parsing, from source/services/settings,
 * source/hooks/settings-completion-{config,logic}.ts, source/utils/value-suggestions.ts
 * and source/utils/settings-command.ts. All pure except
 * `fetchLiveSettingValueSuggestions`, which legacy also calls only when a
 * value frame opens, never per render.
 */
export interface TuiSettingsLibrary {
  readonly SETTING_KEYS: Readonly<Record<string, string>>;
  readonly SETTING_ENV_VARIABLES: Readonly<Record<string, string>>;
  readonly SETTINGS_CATEGORIES: SettingsCategory[];
  readonly SETTING_DESCRIPTIONS: Record<string, string>;
  buildSettingsList(
    keys: Readonly<Record<string, string>>,
    descriptions: Record<string, string>,
    excludeSensitive?: boolean,
    getCurrentValue?: (key: string) => unknown,
  ): SettingCompletionItem[];
  filterSettingsByQuery(settings: SettingCompletionItem[], query: string, maxResults?: number): SettingCompletionItem[];
  filterSettingsByCategory<T extends { key: string }>(settings: T[], categoryId: string): T[];
  getSettingCategory(key: string): SettingsCategory | undefined;
  getSettingMetadata(key: string): { readonly type?: string } | undefined;
  getSettingLabel(key: string): string;
  isSecretSetting(key: string): boolean;
  isStringSetting(key: string): boolean;
  isNumberSetting(key: string): boolean;
  isBooleanSetting(key: string): boolean;
  isDurationSetting(key: string): boolean;
  isUsdMicrosSetting(key: string): boolean;
  buildSettingValueSuggestions(key: string): SettingValueSuggestion[];
  fetchLiveSettingValueSuggestions(key: string): Promise<SettingValueSuggestion[] | null>;
  mergeSettingValueSuggestions(
    curated: SettingValueSuggestion[],
    live: SettingValueSuggestion[] | null,
  ): SettingValueSuggestion[];
  filterSettingValueSuggestionsByQuery(
    suggestions: SettingValueSuggestion[],
    query: string,
    maxResults?: number,
    key?: string,
  ): SettingValueSuggestion[];
  parseSettingValueForKey(key: string, raw: string): unknown;
}

/** The SettingsService reads the legacy settings menus make, on the attached session's live settings. */
export interface MenuSettingsService {
  getDynamic(key: string): unknown;
  getDefault(key: string): unknown;
  getSource(key: string): SettingCompletionItem['source'];
  getStartupOverride(key: string): 'env' | 'cli' | undefined;
  isRuntimeModifiable(key: string): boolean;
  onChange(listener: () => void): () => void;
}

/** Legacy `ConversationListEntry` (source/services/conversation/conversation-persistence.ts). */
export type MenuConversationEntry = {
  id: string;
  shortRef?: string;
  updatedAt: string;
  projectPath?: string;
  sshHost?: string;
  firstUserMessage?: string;
  activeProfileId?: string;
  /** Legacy SavedAppMode flags. */
  appMode?: Readonly<Record<string, boolean | undefined>>;
  model?: string;
  provider?: string;
  messageCount?: number;
};

/**
 * Data the legacy menu stack (`menus/`) reads through the app instead of
 * legacy services. Each group replaces the service calls of one ported menu.
 */
export interface TuiMenus {
  readonly schema: TuiSettingsSchema;
  /** The app's logging service, for the warnings legacy menus log instead of printing. */
  readonly logger: MenuLogger;
  /** Legacy file-service.ts workspace listing for `@` completion; loaded asynchronously, never during render. */
  readonly paths: {
    entries(): Promise<MenuPathEntry[]>;
    refresh(): Promise<MenuPathEntry[]>;
    meta(): MenuWorkspaceEntriesMeta;
  };
  /** The model and subagent-pool menus. Memoise per session: it is not a render-path read. */
  readonly models: { settings(sessionId: string): TuiModelSettings };
  /** `/settings`, `/settings reset`, setting values, `/effort` and `/auto-approve`. */
  readonly settings: {
    readonly lib: TuiSettingsLibrary;
    /** The same object for a session across calls; reading it touches no disk. */
    service(sessionId: string): MenuSettingsService;
  };
  /** Legacy PROFILE_OPTIONS less the dropped profiles; `activeId` reads the session's live settings. */
  readonly profile: {
    readonly options: readonly MenuProfileOption[];
    canonicalId(id: string): string;
    activeId(sessionId: string): string | null;
  };
  /** Legacy app.tsx handleCopySelection's clipboard write. */
  copy(text: string): Promise<void>;
  /** Legacy skillsService.getAvailableSkills(): this workspace's skills, read from disk once per mount. */
  readonly skills: { list(): MenuSkillInfo[] };
  /** Legacy listConversations for the resume menu: this workspace's other saved conversations, newest first. */
  readonly resume?: {
    list(sessionId: string): Promise<MenuConversationEntry[]>;
    /** Legacy getProfileLabel(activeProfileId ?? profileIdFromLegacyMode(appMode)); pure. */
    profileLabel(activeProfileId?: string, appMode?: MenuConversationEntry['appMode']): string;
  };
  /** `/providers` manager; absent means `/providers` has no menu. */
  readonly providers?: TuiProviderMenu;
}

/** Legacy `CustomProviderDraft` (source/providers/provider-service.ts). */
export type MenuProviderDraft = { name: string; type: string; baseUrl?: string; apiKey?: string };
/** Legacy `ProviderSelectionItem`. */
export type MenuProviderItem = {
  id: string;
  label: string;
  isCustom: boolean;
  isActive: boolean;
  hasCredentials: boolean;
  isDisabled: boolean;
};
/** Legacy `ProviderPreset`, the fields the manager reads. */
export type MenuProviderPreset = {
  id: string;
  name: string;
  category: string;
  docsUrl: string;
  builtinProviderId?: string;
  type?: string;
  baseUrl?: string;
};
/** Legacy `OAuthAccountSummary` (source/providers/oauth-accounts.ts). */
export type MenuOAuthAccount = { id: string; label: string; isSelected: boolean; isInUse: boolean };

/**
 * The legacy provider services the `/providers` manager calls (provider-service,
 * provider-management-session, provider-credentials, oauth-accounts). Writes go
 * where legacy writes them, the persistent settings file. Lookups read settings
 * already in memory; `listAccounts` reads the account store and is called only on
 * selection, never during render.
 */
export interface TuiProviderMenu {
  readonly types: readonly string[];
  /** Presets whose built-in provider (if any) is registered. */
  presets(): readonly MenuProviderPreset[];
  list(sessionId: string): MenuProviderItem[];
  save(
    sessionId: string,
    draft: MenuProviderDraft,
    editingOriginalName: string | null,
  ): { success: boolean; errorMessage?: string; fieldErrors?: Record<string, string> };
  delete(sessionId: string, providerId: string): void;
  validateName(
    sessionId: string,
    value: string,
    isEditingField: boolean,
    editingOriginalName?: string,
  ): { valid: boolean; errorMessage?: string };
  validateUrl(value: string, type: string): { valid: boolean; errorMessage?: string };
  isBuiltIn(id: string): boolean;
  label(id: string): string | undefined;
  /** Raw stored value of a setting (legacy `settingsService.getDynamic`). */
  getDynamic(sessionId: string, key: string): unknown;
  resolveProviderId(entry: unknown): string | undefined;
  resolveProviderName(entry: unknown, id: string): string;
  credentialSettingKey(providerId: string): string | undefined;
  hasCredentials(sessionId: string, providerId: string): boolean;
  isDisabled(sessionId: string, providerId: string): boolean;
  setDisabled(sessionId: string, providerId: string, disabled: boolean): void;
  isOAuthAccountProvider(providerId: string): boolean;
  listAccounts(providerId: string): MenuOAuthAccount[];
  loginCommand(providerId: string): string;
  removeAccount(providerId: string, accountId: string): boolean;
  setActiveAccount(providerId: string, accountId: string): boolean;
  sessionAccount(providerId: string): string | null;
}

export interface TuiIntegration {
  /** The legacy menus' data access. Without it the composer opens no menus. */
  readonly menus?: TuiMenus;
  /** Run an explicit user shell command in the selected workspace, without a model turn. */
  shell?(sessionId: string, command: string): Promise<ShellResult>;
  /** A confirmed `confirmClear`: a new session, then the profile switch. */
  clearAndSwitch?(connection: TuiConnection, profileId: string): Promise<{ message?: string }>;
  /** Legacy printUsage: the usage summary written to stdout as a conversation is left for a new one. */
  printUsage?(): void;
  /** Read the attached session's effective preferences on each render, including live /settings changes. */
  preferences?(sessionId: string): { readonly historySize: number; readonly pasteThreshold: number | undefined };
  /** What the attached session's status bar shows, read on each render so live /settings changes appear. */
  status?(sessionId: string): TuiStatusInfo;
  command(
    connection: TuiConnection,
    input: string,
  ): Promise<{
    readonly message?: string;
    readonly transcript?: string;
    readonly exit?: boolean;
    readonly draft?: { readonly text: string; readonly attachments: readonly WireContent[] };
    readonly sessionId?: string;
    /** The change is certainly in effect (a configured receipt or a saved preference); menus apply it silently. */
    readonly applied?: boolean;
    /** A frame for the menu stack to open, as legacy commands called openCopyMenu. */
    readonly menu?: { readonly kind: 'copy'; readonly items: CopySelection[] };
    /** Legacy requestModeSwitchConfirm: the switch needs a new session; `line` follows its welcome. */
    readonly confirmClear?: { readonly profileId: string; readonly enable: boolean; readonly line: string };
  }>;
  /** App owns socket lifecycle and returns the current actual attachment state. */
  readonly bridge?: {
    status(): Promise<BridgeStatus>;
    connect(name: string): Promise<BridgeStatus>;
    disconnect(): Promise<BridgeStatus>;
  };
  /** Attach a returned direct session ID; do not reuse the previous connection. */
  switchSession?(sessionId: string): Promise<void | { readonly message?: string }>;
}

/** A finished `!` command, as legacy's ShellInteractionSession hands it to addShellMessage. */
export type ShellResult = {
  readonly command: string;
  readonly output: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
};

/** App-owned TUI callbacks cross the unkeyed shell into the keyed session. */
export interface TuiProps {
  readonly connection: TuiConnection;
  readonly header?: ReactNode;
  readonly headerHeight?: number;
  /** A change repaints the transcript, as legacy's MessageList does when the display mode changes. */
  readonly redrawKey?: string;
  readonly integration: TuiIntegration;
  readonly retainedSnapshot?: WireSnapshot;
  readonly onSnapshot?: (snapshot: WireSnapshot) => void;
  /** New durable events only; snapshot/replay callbacks do not trigger side effects. */
  readonly onLiveEvent?: (event: WireEvent) => void;
  readonly onExit: () => void;
}

export type CommandResult = Awaited<ReturnType<TuiIntegration['command']>>;
