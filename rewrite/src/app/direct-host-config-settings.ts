import { createHash } from 'node:crypto';
import type { SettingsProjection } from '../host/server-contracts.js';
import { DirectHostConfigError } from './direct-host-config-error.js';
import { CREDENTIAL_SETTINGS } from './credential-settings.js';

const SAFE_KEYS = [
  'agent.modelSelection',
  'agent.reasoningEffort',
  'agent.temperature',
  'agent.maxTurns',
  'agent.maxOutputTokens',
  'agent.maxStreamOutputChars',
  'agent.maxModelRequestDurationMs',
  'agent.retryAttempts',
  'agent.maxParallelToolCalls',
  'agent.contextCompaction.enabled',
  'agent.contextCompaction.threshold',
  'app.activeProfileId',
  'app.mentorMode',
  'app.liteMode',
  'app.planMode',
  'app.orchestratorMode',
  'webSearch.provider',
  'webSearch.firecrawl.baseUrl',
  'webSearch.searxng.baseUrl',
  'memory.enabled',
  'logging.logLevel',
  'shell.timeout',
  'shell.maxOutputLines',
  'shell.maxOutputChars',
] as const;

const PERSISTENT = new Set(['logging.logLevel']);
const SESSION_SCOPED = new Set([
  'agent.modelSelection',
  'agent.reasoningEffort',
  'app.activeProfileId',
  'app.mentorMode',
  'app.liteMode',
  'app.planMode',
  'app.orchestratorMode',
]);

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
};
export type CredentialDescription = { configured: boolean; required: boolean; source: CredentialSource };
export type DirectCredentialBackend = { describe(providerId: string): CredentialDescription };
export type DirectProviderBackend = {
  list(): readonly { id: string; label: string; isCustom: boolean; active: boolean; disabled: boolean }[];
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
  ) {}

  read(): SettingsProjection {
    return this.#projection();
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
        projection: current,
      });
    }
    const normalized = changes.map((change) => {
      if (!PERSISTENT.has(change.key) || !(SAFE_KEYS as readonly string[]).includes(change.key)) {
        throw new DirectHostConfigError('settings_not_allowed', 'config');
      }
      if (!isSafeValue(change.value)) throw new DirectHostConfigError('validation_error', 'config');
      return { key: change.key, value: change.value };
    });
    const result = this.settings.setPersistentTransaction(normalized);
    if (result?.status !== 'saved') throw new DirectHostConfigError('not_persisted', 'config');
    return this.#projection();
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

  async listModels(): Promise<
    { provider: string; id: string; name?: string; default_reasoning_level?: string; contextWindow?: number }[]
  > {
    const ids = await this.models.providerIds();
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || id.length === 0)) {
      throw new DirectHostConfigError('model_catalog_unavailable', 'config');
    }
    const models = [];
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
    for (const key of SAFE_KEYS) {
      const actual = key === 'agent.contextCompaction.threshold' ? 'agent.contextCompaction.compactThreshold' : key;
      const safe = safeValue(this.settings.get(actual));
      safeDefaults[key] = {
        ...(safe === undefined ? {} : { value: safe }),
        source: this.settings.getSource(actual) ?? 'default',
        scope: SESSION_SCOPED.has(key) ? 'session' : 'global',
        confirmRequired: key.startsWith('shell.') || key === 'agent.maxParallelToolCalls',
        persistable: PERSISTENT.has(key),
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
        sandbox: this.settings.get('sandbox.enabled') === true ? ('enabled' as const) : ('disabled' as const),
        approval:
          approval === 'always'
            ? ('unsafe-active' as const)
            : approval === 'auto' || approval === 'advisory' || approval === 'off'
            ? approval
            : ('hidden' as const),
        backgroundShell: 'disabled-by-gateway' as const,
        workspaceAccess: this.allowWrite ? ('read_write' as const) : ('read' as const),
        network:
          this.settings.get('sandbox.allowNetworking') === true
            ? ('confirmation-required' as const)
            : ('denied' as const),
      },
    };
    const revision = createHash('sha256').update(JSON.stringify(settingsOnly)).digest('hex');
    return { schemaVersion: 1, revision, defaultsRevision: revision, settings: settingsOnly };
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

function isSafeValue(value: unknown): boolean {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    (Array.isArray(value) && value.every((item) => typeof item === 'string'))
  );
}

function safeValue(value: unknown): SettingsProjection['settings']['safeDefaults'][string]['value'] {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (
      typeof record.model === 'string' &&
      record.model.trim() &&
      typeof record.provider === 'string' &&
      record.provider.trim()
    ) {
      return { model: record.model.trim(), provider: record.provider.trim() };
    }
    return undefined;
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return [...value];
  return undefined;
}
