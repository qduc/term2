import type { ISettingsService } from '../../services/service-interfaces.js';
import {
  decodeStoredCustomProviderConfigs,
  normalizeProviderIdentifier,
  type StoredCustomProviderConfig,
} from '../../services/settings/custom-provider-normalization.js';
import { getProvider } from '../../providers/registry.js';
import { resolveCodexTokenPath } from '../../providers/codex-auth.js';
import { hasGrokLogin } from '../../providers/grok-auth.js';

const hasConfiguredCredential = (value: unknown): boolean => typeof value === 'string' && value.trim().length > 0;

export const PROVIDER_CREDENTIAL_SETTING_KEYS = {
  openai: 'agent.openai.apiKey',
  openrouter: 'agent.openrouter.apiKey',
} as const;

export const getProviderCredentialSettingKey = (providerId: string): string | undefined =>
  PROVIDER_CREDENTIAL_SETTING_KEYS[providerId as keyof typeof PROVIDER_CREDENTIAL_SETTING_KEYS];

export const getProviderIdForCredentialSettingKey = (settingKey: string | undefined): string | undefined => {
  if (!settingKey) return undefined;
  return Object.entries(PROVIDER_CREDENTIAL_SETTING_KEYS).find(([, key]) => key === settingKey)?.[0] as
    | keyof typeof PROVIDER_CREDENTIAL_SETTING_KEYS
    | undefined;
};

const CUSTOM_PROVIDER_ENV_KEYS: Partial<Record<StoredCustomProviderConfig['type'], string>> = {
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  opencode: 'OPENCODE_API_KEY',
};

export type ProviderCredentialResolution = {
  required: boolean;
  configured: boolean;
  source: 'setting' | 'environment' | 'stored' | 'token-file' | 'local' | 'external' | 'missing';
  unavailableReason?: 'missing-credentials' | 'missing-codex-login' | 'missing-grok-login';
  settingKey?: string;
  environmentKey?: string;
  credentialPath?: string | null;
};

const isConfigured = hasConfiguredCredential;

const isLoopbackBaseUrl = (baseUrl: string | undefined): boolean => {
  if (!baseUrl) return false;
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
  } catch {
    return false;
  }
};

const getStoredCustomProvider = (settingsService: ISettingsService, providerId: string) => {
  const raw = settingsService.getDynamic('providers');
  const normalizedProviderId = normalizeProviderIdentifier(providerId);
  return decodeStoredCustomProviderConfigs(raw).find(
    (provider) =>
      provider.id === providerId ||
      provider.name === providerId ||
      provider.id === normalizedProviderId ||
      provider.name === normalizedProviderId,
  );
};

const resolveCredentialSources = (
  settingsService: ISettingsService,
  settingKey: string | undefined,
  storedKey: string | undefined,
  environmentKey: string | undefined,
): ProviderCredentialResolution => {
  if (settingKey && isConfigured(settingsService.getDynamic(settingKey))) {
    return { required: true, configured: true, source: 'setting', settingKey, environmentKey };
  }
  if (isConfigured(storedKey)) {
    return { required: true, configured: true, source: 'stored', settingKey, environmentKey };
  }
  if (environmentKey && isConfigured(process.env[environmentKey])) {
    return { required: true, configured: true, source: 'environment', settingKey, environmentKey };
  }
  return {
    required: true,
    configured: false,
    source: 'missing',
    unavailableReason: 'missing-credentials',
    settingKey,
    environmentKey,
  };
};

/**
 * Resolve provider readiness from the same credential sources the provider
 * runtime consumes. Local loopback custom providers and llama.cpp are
 * explicitly no-auth; remote custom providers require a stored or type-level
 * environment credential. Codex uses its local auth file as a presence-only
 * credential. Unknown registered providers retain their external auth contract
 * and are not blocked by this API-key predicate.
 */
export const resolveProviderCredentials = (
  settingsService: ISettingsService,
  providerId: string,
): ProviderCredentialResolution => {
  if (providerId === 'codex') {
    const credentialPath = resolveCodexTokenPath();
    return {
      required: true,
      configured: credentialPath !== null,
      source: credentialPath ? 'token-file' : 'missing',
      unavailableReason: credentialPath ? undefined : 'missing-codex-login',
      credentialPath,
    };
  }

  if (providerId === 'grok') {
    // Grok authenticates with an OAuth token file this app writes at login, so
    // presence of that credential is the readiness signal — there is no key to
    // paste into settings.
    const configured = hasGrokLogin();
    return {
      required: true,
      configured,
      source: configured ? 'token-file' : 'missing',
      unavailableReason: configured ? undefined : 'missing-grok-login',
    };
  }

  const settingKey = getProviderCredentialSettingKey(providerId);
  if (settingKey) {
    const environmentKey = providerId === 'openai' ? 'OPENAI_API_KEY' : 'OPENROUTER_API_KEY';
    return resolveCredentialSources(settingsService, settingKey, undefined, environmentKey);
  }

  const custom = getStoredCustomProvider(settingsService, providerId);
  if (!custom) {
    const definition = getProvider(providerId);
    return definition?.isRuntimeDefined
      ? { required: true, configured: false, source: 'missing', unavailableReason: 'missing-credentials' }
      : { required: false, configured: true, source: 'external' };
  }

  if (custom.type === 'llama.cpp' || isLoopbackBaseUrl(custom.baseUrl)) {
    return { required: false, configured: true, source: 'local' };
  }

  return resolveCredentialSources(settingsService, undefined, custom.apiKey, CUSTOM_PROVIDER_ENV_KEYS[custom.type]);
};

/** Resolve the actual credential value for runtime-compatible provider setup. */
export const resolveProviderCredentialValue = (
  settingsService: ISettingsService,
  providerId: string,
): string | undefined => {
  const custom = getStoredCustomProvider(settingsService, providerId);
  const resolution = resolveProviderCredentials(settingsService, providerId);
  if (custom?.apiKey && resolution.source === 'local') {
    return custom.apiKey;
  }

  if (resolution.source === 'setting' && resolution.settingKey) {
    const value = settingsService.getDynamic(resolution.settingKey);
    return typeof value === 'string' ? value : undefined;
  }
  if (resolution.source === 'environment' && resolution.environmentKey) {
    return process.env[resolution.environmentKey];
  }
  if (resolution.source === 'stored') {
    return custom?.apiKey;
  }
  return undefined;
};

/**
 * Check credential presence only. This deliberately does not contact a
 * provider or validate the credential; invalid credentials fail at request
 * time where the provider can report the real error.
 */
export const hasProviderCredentials = (settingsService: ISettingsService, providerId: string): boolean => {
  const resolution = resolveProviderCredentials(settingsService, providerId);
  return !resolution.required || resolution.configured;
};

/**
 * Get provider IDs that are locally runnable according to credential
 * presence. The name is retained for compatibility with existing callers.
 */
export const getAvailableProviderIds = (settingsService: ISettingsService, allProviderIds: string[]): string[] => {
  return allProviderIds.filter((id) => hasProviderCredentials(settingsService, id));
};
