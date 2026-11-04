import type { ReactNode } from 'react';
import type { WireEvent, WireSnapshot } from '../../protocol/direct-wire.js';
import type { DirectConnection, DirectReplayConnection } from '../../host/in-process-direct-types.js';

import type { WireContent } from '../../protocol/direct-wire.js';

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
};
export type PickerModel = { readonly provider: string; readonly id: string; readonly name?: string };

export type SettingsPickerItem = {
  readonly key: string;
  readonly label: string;
  readonly description: string;
  readonly current: string;
  readonly defaultValue: string;
  readonly editable: boolean;
  readonly reason?: string;
};
export type SettingsPickerCategory = {
  readonly id: string;
  readonly label: string;
  /** Search-only entries stay out of the curated category tabs. */
  readonly searchOnly?: boolean;
  readonly items: readonly SettingsPickerItem[];
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
  readonly settingsPicker?: { list(sessionId: string): readonly SettingsPickerCategory[] };
  /** Run an explicit user shell command in the selected workspace, without a model turn. */
  shell?(sessionId: string, command: string): Promise<string>;
  readonly resumePicker?: {
    list(): Promise<
      readonly {
        id: string;
        title?: string;
        updatedAt?: string;
        firstUserMessage?: string;
        messageCount?: number;
        model?: string;
      }[]
    >;
  };
  readonly modelPicker?: {
    favorites(sessionId: string): PickerModel[];
    nicknames(sessionId: string): Readonly<Record<string, readonly string[]>>;
    list(sessionId: string): Promise<{ models: PickerModel[]; failedProviders: string[] }>;
    current(sessionId: string): PickerModel;
    toggle(sessionId: string, model: PickerModel): void;
  };
  planNeedsClear?(connection: TuiConnection): boolean;
  clearAndTogglePlan?(connection: TuiConnection): Promise<{ message?: string }>;
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

/** App-owned TUI callbacks cross the unkeyed shell into the keyed session. */
export interface TuiProps {
  readonly connection: TuiConnection;
  readonly header?: ReactNode;
  readonly headerHeight?: number;
  readonly integration: TuiIntegration;
  readonly retainedSnapshot?: WireSnapshot;
  readonly onSnapshot?: (snapshot: WireSnapshot) => void;
  /** New durable events only; snapshot/replay callbacks do not trigger side effects. */
  readonly onLiveEvent?: (event: WireEvent) => void;
  readonly onExit: () => void;
}
