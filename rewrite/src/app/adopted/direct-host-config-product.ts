import type { ILoggingService } from '../../../../source/services/service-interfaces.js';
import { createAppSettings } from '../settings.js';
import { getProviderIds } from '../../../../source/providers/index.js';
import { loadProviderItems } from '../../../../source/providers/provider-service.js';
import {
  listOAuthAccounts,
  removeOAuthAccount,
  setActiveOAuthAccount,
} from '../../../../source/providers/oauth-accounts.js';
import { loginToCodex } from '../../../../source/providers/codex-auth.js';
import { loginToGrok } from '../../../../source/providers/grok-auth.js';
import { ModelCatalogSession } from '../../../../source/services/models/model-catalog-session.js';
import {
  getAvailableProviderIds,
  resolveProviderCredentials,
} from '../../../../source/utils/ai/provider-credentials.js';
import { defaultServeStateDir, parseServeArgs } from '../../../../source/gateway/serve-args.js';
import type {
  CredentialDescription,
  DirectCredentialBackend,
  DirectModelBackend,
  DirectOAuthBackend,
  DirectProviderBackend,
  DirectSettingsBackend,
} from '../direct-host-config-settings.js';

const CREDENTIALS: Record<string, { settingKey: string; required: boolean }> = {
  openai: { settingKey: 'agent.openai.apiKey', required: true },
  openrouter: { settingKey: 'agent.openrouter.apiKey', required: true },
  tavily: { settingKey: 'webSearch.tavily.apiKey', required: true },
  exa: { settingKey: 'webSearch.exa.apiKey', required: true },
  firecrawl: { settingKey: 'webSearch.firecrawl.apiKey', required: true },
};

const silentLog: ILoggingService = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  security() {},
  setCorrelationId() {},
  getCorrelationId() {
    return undefined;
  },
  clearCorrelationId() {},
};

export type DirectProductPorts = {
  readonly settings: DirectSettingsBackend;
  readonly credentials: DirectCredentialBackend;
  readonly providers: DirectProviderBackend;
  readonly oauth: DirectOAuthBackend;
  readonly models: DirectModelBackend;
};

/** Real settings, credential, OAuth and catalog leaves. Does not open conversation logs. */
export function createDirectProductPorts(options: { settingsDir?: string } = {}): DirectProductPorts {
  const { service } = createAppSettings(options.settingsDir ? { settingsDir: options.settingsDir } : {});
  const catalog = new ModelCatalogSession({ settingsService: service, loggingService: silentLog });
  return {
    settings: settingsBackend(service),
    credentials: { describe: (providerId) => describeCredential(service, providerId) },
    providers: {
      list: () =>
        loadProviderItems(service).map((provider) => ({
          id: provider.id,
          label: provider.label,
          isCustom: provider.isCustom,
          active: provider.isActive,
          disabled: provider.isDisabled,
        })),
    },
    oauth: {
      list: (provider) =>
        listOAuthAccounts(provider).map((account) => ({
          id: account.id,
          label: account.label,
          isSelected: account.isSelected,
          isInUse: account.isInUse,
        })),
      login: async (provider) => {
        if (provider === 'codex') await loginToCodex();
        else await loginToGrok();
      },
      select: (provider, accountId) => setActiveOAuthAccount(provider, accountId),
      remove: (provider, accountId) => removeOAuthAccount(provider, accountId),
    },
    models: {
      providerIds: () => getAvailableProviderIds(service, getProviderIds()),
      load: (providerId) => catalog.load(providerId),
    },
  };
}

type ProductSettings = ReturnType<typeof createAppSettings>['service'];

function settingsBackend(service: ProductSettings): DirectSettingsBackend {
  return {
    get: (key) => service.getDynamic(key),
    getSource: (key) => service.getSource(key),
    setPersistent: (key, value) => service.setPersistentDynamic(key, value),
    setPersistentTransaction: (changes) => service.setPersistentDynamicTransaction(changes),
    reset: (key) => service.reset(key),
  };
}

function describeCredential(service: ProductSettings, providerId: string): CredentialDescription {
  const definition = CREDENTIALS[providerId];
  const source = definition ? service.getSource(definition.settingKey) : undefined;
  if (source === 'env' || String(source) === 'environment')
    return { configured: true, required: definition?.required ?? false, source: 'environment' };
  if (definition && (providerId === 'tavily' || providerId === 'exa' || providerId === 'firecrawl')) {
    const value = service.getDynamic(definition.settingKey);
    const configured = typeof value === 'string' && value.trim().length > 0;
    return { configured, required: true, source: configured ? 'setting' : 'missing' };
  }
  const resolution = resolveProviderCredentials(service, providerId);
  return { configured: resolution.configured, required: resolution.required, source: resolution.source };
}

export { defaultServeStateDir, parseServeArgs };
