import crypto from 'node:crypto';
import type { ISettingsService } from '../services/service-interfaces.js';
import { loadProviderItems } from '../providers/provider-service.js';
import { resolveProviderCredentials, type ProviderCredentialResolution } from '../utils/ai/provider-credentials.js';
import { listOAuthAccounts } from '../providers/oauth-accounts.js';

export const SAFE_SETTINGS_KEYS = [
  'agent.model',
  'agent.provider',
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
  'memory.enabled',
  'logging.logLevel',
  'shell.timeout',
  'shell.maxOutputLines',
  'shell.maxOutputChars',
] as const;

/**
 * The browser may inspect the full safe-default projection, but it may only
 * persist this deliberately tiny global surface.  Session policy belongs to
 * session_update; it must never be smuggled through the launcher-wide
 * settings authority.
 */
export const PERSISTENT_SETTINGS_KEYS = ['logging.logLevel'] as const;

export type SafeSettingsKey = (typeof SAFE_SETTINGS_KEYS)[number];
export type CredentialSource = 'setting' | 'stored' | 'environment' | 'token-file' | 'local' | 'external' | 'missing';
export type SecretFreeCredential = {
  configured: boolean;
  required: boolean;
  source: CredentialSource;
  writable: boolean;
};
export type SettingsProjection = {
  schemaVersion: 1;
  revision: string;
  defaultsRevision: string;
  settings: {
    safeDefaults: Record<
      string,
      {
        value?: string | number | boolean | string[] | null;
        source: string;
        scope: 'global' | 'session';
        confirmRequired: boolean;
        /** Whether the browser may persist this key (PERSISTENT_SETTINGS_KEYS). */
        persistable: boolean;
      }
    >;
    credentials: Record<string, SecretFreeCredential>;
    providers: Array<{
      id: string;
      label: string;
      isCustom: boolean;
      active: boolean;
      credential: SecretFreeCredential;
    }>;
    oauthAccounts: Record<string, Array<{ id: string; label: string; isSelected: boolean; isInUse: boolean }>>;
    safety: {
      sandbox: 'enabled' | 'disabled' | 'unavailable';
      approval: 'off' | 'advisory' | 'auto' | 'unsafe-active' | 'hidden';
      backgroundShell: 'disabled-by-gateway';
      workspaceAccess: 'read' | 'read_write';
      network: 'denied' | 'configured' | 'confirmation-required';
    };
  };
};

export type SettingsAuthority = ISettingsService & {
  getSource?: (key: string) => string;
  setPersistentDynamic?: (key: string, value: unknown) => unknown;
  setPersistentDynamicTransaction?: (
    changes: readonly { key: string; value: unknown }[],
  ) => { status?: string } | undefined;
  reset?: (key?: string) => unknown;
};

export class SettingsRpcError extends Error {
  readonly code: 'settings_unavailable' | 'settings_conflict' | 'settings_not_allowed' | 'not_persisted';
  readonly details?: { currentRevision?: string; projection?: SettingsProjection };
  constructor(code: SettingsRpcError['code'], details?: SettingsRpcError['details']) {
    super('settings RPC rejected the request');
    this.name = 'SettingsRpcError';
    this.code = code;
    this.details = details;
  }
}

const CREDENTIALS: Record<string, { settingKey: string; providerId: string; required: boolean }> = {
  openai: { settingKey: 'agent.openai.apiKey', providerId: 'openai', required: true },
  openrouter: { settingKey: 'agent.openrouter.apiKey', providerId: 'openrouter', required: true },
  tavily: { settingKey: 'webSearch.tavily.apiKey', providerId: 'tavily', required: true },
  exa: { settingKey: 'webSearch.exa.apiKey', providerId: 'exa', required: true },
};

export function isSafeSettingsKey(key: string): key is SafeSettingsKey {
  return (SAFE_SETTINGS_KEYS as readonly string[]).includes(key);
}

export function isPersistentSettingsKey(key: string): boolean {
  return (PERSISTENT_SETTINGS_KEYS as readonly string[]).includes(key);
}

export function buildSettingsProjection(
  settings: SettingsAuthority,
  workspaceAccess: 'read' | 'read_write' = 'read',
): SettingsProjection {
  const safeDefaults: SettingsProjection['settings']['safeDefaults'] = {};
  for (const key of SAFE_SETTINGS_KEYS) {
    const actualKey = key === 'agent.contextCompaction.threshold' ? 'agent.contextCompaction.compactThreshold' : key;
    const value = settings.getDynamic(actualKey);
    const safeValue = asSafeSettingValue(value);
    const source = settings.getSource?.(actualKey) ?? 'default';
    safeDefaults[key] = {
      ...(safeValue === undefined ? {} : { value: safeValue }),
      source,
      scope: sessionScopedKey(key) ? 'session' : 'global',
      confirmRequired: key.startsWith('shell.') || key === 'agent.maxParallelToolCalls',
      persistable: isPersistentSettingsKey(key),
    };
  }

  const credentials: Record<string, SecretFreeCredential> = {};
  for (const [id, definition] of Object.entries(CREDENTIALS)) {
    credentials[id] = credentialStatus(settings, definition);
  }

  let providers: SettingsProjection['settings']['providers'] = [];
  try {
    providers = loadProviderItems(settings).map((provider) => ({
      id: provider.id,
      label: provider.label,
      isCustom: provider.isCustom,
      active: provider.isActive,
      credential: providerCredentialStatus(settings, provider.id),
    }));
  } catch {
    providers = [];
  }

  const oauthAccounts: SettingsProjection['settings']['oauthAccounts'] = {};
  for (const provider of ['codex', 'grok'] as const) {
    try {
      oauthAccounts[provider] = listOAuthAccounts(provider);
    } catch {
      oauthAccounts[provider] = [];
    }
  }

  const approval = settings.getDynamic('shell.autoApproveMode');
  const sandboxEnabled = settings.getDynamic('sandbox.enabled') === true;
  const allowNetworking = settings.getDynamic('sandbox.allowNetworking') === true;
  const settingsOnly = {
    safeDefaults,
    credentials,
    providers,
    oauthAccounts,
    safety: {
      sandbox: sandboxEnabled ? 'enabled' : 'disabled',
      approval:
        approval === 'always'
          ? 'unsafe-active'
          : approval === 'auto' || approval === 'advisory' || approval === 'off'
          ? approval
          : 'hidden',
      backgroundShell: 'disabled-by-gateway',
      workspaceAccess,
      network: allowNetworking ? 'confirmation-required' : 'denied',
    },
  } as SettingsProjection['settings'];
  const revision = crypto.createHash('sha256').update(JSON.stringify(settingsOnly)).digest('hex');
  return { schemaVersion: 1, revision, defaultsRevision: revision, settings: settingsOnly };
}

export function applySettingsChanges(
  settings: SettingsAuthority,
  expectedRevision: string,
  changes: readonly { key: string; value: unknown }[],
): SettingsProjection {
  const current = buildSettingsProjection(settings);
  if (current.revision !== expectedRevision)
    throw new SettingsRpcError('settings_conflict', { currentRevision: current.revision, projection: current });
  const normalized = changes.map((change) => {
    if (!isSafeSettingsKey(change.key) || !isPersistentSettingsKey(change.key))
      throw new SettingsRpcError('settings_not_allowed');
    return {
      key: change.key === 'agent.contextCompaction.threshold' ? 'agent.contextCompaction.compactThreshold' : change.key,
      value: change.value,
    };
  });
  const setter = settings.setPersistentDynamicTransaction;
  if (!setter) throw new SettingsRpcError('settings_unavailable');
  const result = setter.call(settings, normalized);
  if (result?.status !== 'saved') throw new SettingsRpcError('not_persisted');
  return buildSettingsProjection(settings);
}

export function setCredential(
  settings: SettingsAuthority,
  credentialId: string,
  value: string,
): { status: 'saved'; configured: boolean; source: CredentialSource } {
  const definition = CREDENTIALS[credentialId];
  if (!definition || !value) throw new SettingsRpcError('settings_not_allowed');
  const status = credentialStatus(settings, definition);
  if (status.source === 'environment') throw new SettingsRpcError('settings_not_allowed');
  if (!settings.setPersistentDynamic) throw new SettingsRpcError('settings_unavailable');
  const result = settings.setPersistentDynamic(definition.settingKey, value) as { status?: string } | undefined;
  if (result?.status !== 'saved') throw new SettingsRpcError('not_persisted');
  const next = credentialStatus(settings, definition);
  return { status: 'saved', configured: next.configured, source: next.source };
}

export function deleteCredential(
  settings: SettingsAuthority,
  credentialId: string,
): { status: 'deleted' | 'unchanged'; configured: boolean; source?: 'environment' } {
  const definition = CREDENTIALS[credentialId];
  if (!definition || !settings.reset) throw new SettingsRpcError('settings_not_allowed');
  const before = credentialStatus(settings, definition);
  if (before.source === 'environment') return { status: 'unchanged', configured: true, source: 'environment' };
  const result = settings.reset(definition.settingKey) as { status?: string } | undefined;
  if (result?.status !== 'saved') throw new SettingsRpcError('not_persisted');
  return { status: 'deleted', configured: false };
}

export function credentialStatus(
  settings: SettingsAuthority,
  definition: { settingKey: string; providerId: string; required: boolean },
): SecretFreeCredential {
  if (isEnvironmentSource(settings.getSource?.(definition.settingKey))) {
    return { configured: true, required: definition.required, source: 'environment', writable: false };
  }
  if (definition.providerId === 'tavily' || definition.providerId === 'exa') {
    const value = settings.getDynamic(definition.settingKey);
    const configured = typeof value === 'string' && value.trim().length > 0;
    const source = isEnvironmentSource(settings.getSource?.(definition.settingKey))
      ? 'environment'
      : configured
      ? 'setting'
      : 'missing';
    return { configured, required: definition.required, source, writable: source !== 'environment' };
  }
  const resolution = resolveProviderCredentials(settings, definition.providerId);
  return {
    configured: resolution.configured,
    required: definition.required,
    source: safeSource(resolution.source),
    writable: resolution.source !== 'environment',
  };
}

function providerCredentialStatus(settings: SettingsAuthority, providerId: string): SecretFreeCredential {
  try {
    const resolution = resolveProviderCredentials(settings, providerId);
    return {
      configured: resolution.configured,
      required: resolution.required,
      source: safeSource(resolution.source),
      writable: resolution.source !== 'environment',
    };
  } catch {
    return { configured: false, required: false, source: 'missing', writable: false };
  }
}

function safeSource(source: ProviderCredentialResolution['source']): CredentialSource {
  return source;
}

function isEnvironmentSource(source: string | undefined): boolean {
  return source === 'env' || source === 'environment';
}

function sessionScopedKey(key: SafeSettingsKey): boolean {
  return (
    key === 'agent.model' ||
    key === 'agent.provider' ||
    key === 'agent.reasoningEffort' ||
    key === 'app.activeProfileId' ||
    key === 'app.mentorMode' ||
    key === 'app.liteMode' ||
    key === 'app.planMode' ||
    key === 'app.orchestratorMode'
  );
}

function asSafeSettingValue(value: unknown): string | number | boolean | string[] | null | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return value;
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value;
  return undefined;
}
