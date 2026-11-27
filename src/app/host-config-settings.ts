import { createHash } from 'node:crypto';
import type {
  ModelCatalogEntry,
  ServerCapabilities,
  SettingsProjection,
  ShellSandboxNotice,
} from '../host/server-contracts.js';
import { catalogDetails } from '../model/providers/model-catalog/catalog-details.js';
import { getDefaultShellSandboxRunner } from '../tools/shell/sandbox/shell-sandbox-runner.js';
import { ModelSelectionSchema, type ModelSelection } from '../config/settings/model-selection.js';
import { DirectHostConfigError } from './host-config-error.js';
import { CREDENTIAL_SETTINGS } from './credential-settings.js';
import { WEB_SETTINGS, onlyRevokes, webSettingValue } from '../config/settings/web-settings-policy.js';

export type CredentialSource = 'setting' | 'stored' | 'environment' | 'token-file' | 'local' | 'external' | 'missing';
export type SecretFreeCredential = {
  configured: boolean;
  required: boolean;
  source: CredentialSource;
  writable: boolean;
};
/** Public projection is the host contract; safeValue is its redaction boundary. */
export type { SettingsProjection } from '../host/server-contracts.js';

export type DirectSettingsBackend = {
  get(key: string): unknown;
  getSource(key: string): string | undefined;
  setPersistent(key: string, value: unknown): { status?: string } | undefined;
  setPersistentTransaction(changes: readonly { key: string; value: unknown }[]): { status?: string } | undefined;
  reset(key: string): { status?: string } | undefined;
  /** The value in the settings file right now; undefined when absent or unreadable. */
  getStored?(key: string): unknown;
};
export type CredentialDescription = { configured: boolean; required: boolean; source: CredentialSource };
export type DirectCredentialBackend = { describe(providerId: string): CredentialDescription };
export type DirectProviderBackend = {
  list(): readonly { id: string; label: string; isCustom: boolean; active: boolean; disabled: boolean }[];
  presets?(): {
    presets: readonly import('../host/server-contracts.js').ProviderPresetEntry[];
    types: readonly string[];
  };
  write?(input: import('../host/server-contracts.js').ProviderWriteInput): {
    ok: boolean;
    error?: string;
    fieldErrors?: Record<string, string>;
  };
  remove?(id: string): boolean;
};
export type OAuthAccount = { id: string; label: string; isSelected: boolean; isInUse: boolean };
export type DirectOAuthBackend = {
  list(provider: 'codex' | 'grok'): readonly OAuthAccount[];
  login(provider: 'codex' | 'grok'): Promise<void>;
  select(provider: 'codex' | 'grok', accountId: string): boolean;
  remove(provider: 'codex' | 'grok', accountId: string): boolean;
};
export type CatalogModel = { id: string; name?: string; default_reasoning_level?: string; contextWindow?: number };
export type DirectModelBackend = {
  providerIds(): readonly string[] | Promise<readonly string[]>;
  load(providerId: string): Promise<{ models: readonly CatalogModel[] }>;
};

const SOURCES = new Set<CredentialSource>([
  'setting',
  'stored',
  'environment',
  'token-file',
  'local',
  'external',
  'missing',
]);

/** Global settings, credentials, OAuth and model catalog. Nothing here writes a Session. */
export class DirectGlobalConfiguration {
  constructor(
    private readonly settings: DirectSettingsBackend,
    private readonly credentials: DirectCredentialBackend,
    private readonly providers: DirectProviderBackend,
    private readonly oauth: DirectOAuthBackend,
    private readonly models: DirectModelBackend,
    private readonly allowWrite: boolean,
    private readonly capabilities?: ServerCapabilities,
  ) {
    this.#sandboxNotice = this.#probeSandbox();
  }

  /** Cached machine probe. It is not consulted by approval. */
  readonly #sandboxNotice: Promise<ShellSandboxNotice | undefined>;

  async #probeSandbox(): Promise<ShellSandboxNotice | undefined> {
    try {
      const availability = await getDefaultShellSandboxRunner().availability();
      if (availability.type === 'available') return undefined;
      const code = availability.type;
      const detail = 'reason' in availability ? noticeDetail(availability.reason) : '';
      return { code, detail };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { code: 'probe_failed', detail: noticeDetail(reason) };
    }
  }

  async read(): Promise<SettingsProjection> {
    return this.#withSandboxNotice(this.#projection());
  }

  /**
   * The global default a new session starts from. This is the same owner the
   * browser settings API writes, not the selection captured at gateway launch.
   */
  currentModelSelection(): ModelSelection {
    return ModelSelectionSchema.parse(this.settings.get('agent.modelSelection'));
  }

  /** The notice is attached after the revision hash. It never changes a write. */
  async #withSandboxNotice(projection: SettingsProjection): Promise<SettingsProjection> {
    const shellSandboxNotice = await this.#sandboxNotice;
    return shellSandboxNotice ? { ...projection, shellSandboxNotice } : projection;
  }

  async write(
    expectedRevision: string,
    changes: readonly { key: string; value: unknown }[],
  ): Promise<SettingsProjection> {
    if (!Array.isArray(changes) || changes.length > 100) throw new DirectHostConfigError('validation_error', 'config');
    const current = this.#projection();
    if (current.revision !== expectedRevision) {
      throw new DirectHostConfigError('settings_conflict', 'config', {
        currentRevision: current.revision,
        projection: await this.#withSandboxNotice(current),
      });
    }
    const finalByKey = new Map<string, unknown>();
    for (const change of changes) {
      const rule = Object.hasOwn(WEB_SETTINGS, change.key) ? WEB_SETTINGS[change.key] : undefined;
      if (!rule || rule.readOnly) throw new DirectHostConfigError('settings_not_allowed', 'config');
      if (webSettingValue(change.value) === undefined) throw new DirectHostConfigError('validation_error', 'config');
      const actualKey = rule.storedAs ?? change.key;
      // A revoke-only grant list can lose entries from the web, never gain one or be reset.
      // Check against the file too: this copy may still hold a grant revoked elsewhere since.
      if (
        rule.revokeOnly &&
        !(
          onlyRevokes(this.settings.get(actualKey), change.value) &&
          (!this.settings.getStored || onlyRevokes(this.settings.getStored(actualKey) ?? [], change.value))
        )
      )
        throw new DirectHostConfigError('settings_not_allowed', 'config');
      finalByKey.set(actualKey, change.value);
    }
    const toPersist: { key: string; value: unknown }[] = [];
    const toReset: string[] = [];
    for (const [actualKey, value] of finalByKey) {
      if (value === null) toReset.push(actualKey);
      else toPersist.push({ key: actualKey, value });
    }
    try {
      if (toPersist.length > 0) {
        const result = this.settings.setPersistentTransaction(toPersist);
        if (result?.status !== 'saved') throw new DirectHostConfigError('not_persisted', 'config');
      }
      for (const key of toReset) {
        const result = this.settings.reset(key);
        if (result?.status !== 'saved') throw new DirectHostConfigError('not_persisted', 'config');
      }
    } catch (error) {
      if (error instanceof DirectHostConfigError) throw error;
      if (error instanceof Error && error.name === 'ZodError') {
        throw new DirectHostConfigError('validation_error', 'config');
      }
      throw error;
    }
    return this.#withSandboxNotice(this.#projection());
  }

  listProviderPresets() {
    return this.providers.presets ? this.providers.presets() : { presets: [], types: [] };
  }

  async writeProvider(input: import('../host/server-contracts.js').ProviderWriteInput) {
    if (!this.providers.write) throw new DirectHostConfigError('settings_unavailable', 'config');
    return this.providers.write(input);
  }

  async deleteProvider(id: string) {
    if (!this.providers.remove) throw new DirectHostConfigError('settings_unavailable', 'config');
    return { ok: this.providers.remove(id) };
  }

  async setCredential(id: string, value: string): Promise<{ status: 'saved'; configured: boolean; source: string }> {
    const definition = CREDENTIAL_SETTINGS[id];
    if (!definition || typeof value !== 'string' || value.length === 0)
      throw new DirectHostConfigError('settings_not_allowed', 'config');
    const before = this.#credential(id, definition.required);
    if (before.source === 'environment') throw new DirectHostConfigError('settings_not_allowed', 'config');
    const result = this.settings.setPersistent(definition.settingKey, value);
    if (result?.status !== 'saved') throw new DirectHostConfigError('not_persisted', 'config');
    const after = this.#credential(id, definition.required);
    return { status: 'saved', configured: after.configured, source: after.source };
  }

  async deleteCredential(
    id: string,
  ): Promise<{ status: 'deleted' | 'unchanged'; configured: boolean; source?: 'environment' }> {
    const definition = CREDENTIAL_SETTINGS[id];
    if (!definition) throw new DirectHostConfigError('settings_not_allowed', 'config');
    const before = this.#credential(id, definition.required);
    if (before.source === 'environment') return { status: 'unchanged', configured: true, source: 'environment' };
    const result = this.settings.reset(definition.settingKey);
    if (result?.status !== 'saved') throw new DirectHostConfigError('not_persisted', 'config');
    const after = this.#credential(id, definition.required);
    return {
      status: 'deleted',
      configured: after.configured,
      ...(after.source === 'environment' ? { source: 'environment' as const } : {}),
    };
  }

  async oauthLogin(
    provider: 'codex' | 'grok',
  ): Promise<{ status: 'completed'; configured: boolean } | { status: 'not_completed' }> {
    try {
      await this.oauth.login(provider);
      return { status: 'completed', configured: this.#accounts(provider).length > 0 };
    } catch {
      return { status: 'not_completed' };
    }
  }

  async oauthSelect(
    provider: 'codex' | 'grok',
    accountId: string,
  ): Promise<{ ok: boolean; isSelected: boolean; isInUse: boolean }> {
    const ok = this.oauth.select(provider, accountId) === true;
    const account = this.#accounts(provider).find((item) => item.id === accountId);
    return { ok, isSelected: account?.isSelected === true, isInUse: account?.isInUse === true };
  }

  async oauthDelete(provider: 'codex' | 'grok', accountId: string): Promise<{ ok: boolean }> {
    return { ok: this.oauth.remove(provider, accountId) === true };
  }

  async listModels(): Promise<ModelCatalogEntry[]> {
    const ids = await this.models.providerIds();
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || id.length === 0)) {
      throw new DirectHostConfigError('model_catalog_unavailable', 'config');
    }
    const models: ModelCatalogEntry[] = [];
    const seen = new Set<string>();
    for (const provider of ids) {
      if (seen.has(provider)) continue;
      seen.add(provider);
      try {
        const loaded = await this.models.load(provider);
        if (!loaded || !Array.isArray(loaded.models)) continue;
        for (const model of loaded.models) {
          if (!model || typeof model.id !== 'string' || model.id.length === 0) continue;
          models.push({
            provider,
            id: model.id,
            ...(typeof model.name === 'string' ? { name: model.name } : {}),
            ...(typeof model.default_reasoning_level === 'string'
              ? { default_reasoning_level: model.default_reasoning_level }
              : {}),
            ...(typeof model.contextWindow === 'number' && Number.isFinite(model.contextWindow)
              ? { contextWindow: model.contextWindow }
              : {}),
            ...catalogDetails(provider, model.id),
          });
        }
      } catch {
        /* Omit the provider. Do not return its error text; it can contain request material. */
      }
    }
    return models;
  }

  async assertModel(provider: string, modelId: string): Promise<void> {
    const ids = await this.models.providerIds();
    if (!ids.includes(provider)) throw new DirectHostConfigError('model_unavailable', 'config');
    let loaded: { models: readonly CatalogModel[] };
    try {
      loaded = await this.models.load(provider);
    } catch {
      throw new DirectHostConfigError('model_catalog_unavailable', 'config');
    }
    if (!loaded.models.some((model) => model.id === modelId))
      throw new DirectHostConfigError('model_unavailable', 'config');
  }

  #projection(): SettingsProjection {
    const safeDefaults: SettingsProjection['settings']['safeDefaults'] = {};
    for (const [key, rule] of Object.entries(WEB_SETTINGS)) {
      const actual = rule.storedAs ?? key;
      const safe = webSettingValue(this.settings.get(actual));
      const rawSource = this.settings.getSource(actual) ?? 'default';
      safeDefaults[key] = {
        ...(safe === undefined ? {} : { value: safe }),
        source: rawSource === 'env' ? 'environment' : rawSource,
        scope: rule.session ? 'session' : 'global',
        confirmRequired: rule.confirm === true,
        persistable: !rule.readOnly,
      };
    }
    const credentials: Record<string, SecretFreeCredential> = {};
    for (const [id, definition] of Object.entries(CREDENTIAL_SETTINGS))
      credentials[id] = this.#credential(id, definition.required);
    let providers: SettingsProjection['settings']['providers'];
    try {
      providers = this.providers.list().map((provider) => ({
        id: provider.id,
        label: provider.label,
        isCustom: provider.isCustom === true,
        active: provider.active === true,
        disabled: provider.disabled === true,
        credential: this.#credential(provider.id, false),
      }));
    } catch (error) {
      if (error instanceof DirectHostConfigError) throw error;
      throw new DirectHostConfigError('settings_unavailable', 'config');
    }
    const oauthAccounts = { codex: this.#accounts('codex'), grok: this.#accounts('grok') };
    const approval = this.settings.get('shell.autoApproveMode');
    const settingsOnly: SettingsProjection['settings'] = {
      safeDefaults,
      credentials,
      providers,
      oauthAccounts,
      safety: {
        showReview: this.settings.get('shell.showReview') === true,
        sandbox: this.settings.get('sandbox.enabled') === true ? ('enabled' as const) : ('disabled' as const),
        approval:
          approval === 'always'
            ? ('unsafe-active' as const)
            : approval === 'auto' || approval === 'unattended' || approval === 'off'
            ? approval
            : ('hidden' as const),
        backgroundShell: this.capabilities?.backgroundShell ? ('enabled' as const) : ('disabled-by-gateway' as const),
        workspaceAccess: this.allowWrite ? ('read_write' as const) : ('read' as const),
        network:
          this.settings.get('sandbox.allowNetworking') === true
            ? ('confirmation-required' as const)
            : ('denied' as const),
      },
    };
    const revision = createHash('sha256').update(JSON.stringify(settingsOnly)).digest('hex');
    return {
      schemaVersion: 1,
      revision,
      defaultsRevision: revision,
      settings: settingsOnly,
      ...(this.capabilities ? { capabilities: this.capabilities } : {}),
    };
  }

  #credential(providerId: string, required: boolean): SecretFreeCredential {
    let described: CredentialDescription;
    try {
      described = this.credentials.describe(providerId);
    } catch (error) {
      if (error instanceof DirectHostConfigError) throw error;
      throw new DirectHostConfigError('settings_unavailable', 'config');
    }
    if (!described || typeof described.configured !== 'boolean' || !SOURCES.has(described.source)) {
      throw new DirectHostConfigError('settings_unavailable', 'config');
    }
    return {
      configured: described.configured,
      required: described.required === true || required,
      source: described.source,
      writable: described.source !== 'environment',
    };
  }

  #accounts(provider: 'codex' | 'grok'): OAuthAccount[] {
    let accounts: readonly OAuthAccount[];
    try {
      accounts = this.oauth.list(provider);
    } catch (error) {
      if (error instanceof DirectHostConfigError) throw error;
      throw new DirectHostConfigError('settings_unavailable', 'config');
    }
    if (!Array.isArray(accounts)) throw new DirectHostConfigError('settings_unavailable', 'config');
    return accounts.map((account) => {
      if (!account || typeof account.id !== 'string' || typeof account.label !== 'string') {
        throw new DirectHostConfigError('settings_unavailable', 'config');
      }
      return {
        id: account.id,
        label: account.label,
        isSelected: account.isSelected === true,
        isInUse: account.isInUse === true,
      };
    });
  }
}

/** Detail only. The refusal sentence stays out of this projection. */
function noticeDetail(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}
