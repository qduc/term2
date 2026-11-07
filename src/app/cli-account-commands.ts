/** Account/catalog subcommands, independent of conversation launch and signal ownership. */
import { stdin, stdout, stderr } from 'node:process';
import { SessionContextService } from '../model/traffic-context.js';
import { buildEnvOverrides } from '../config/settings/settings-service.js';
import { createSettingsService, type SettingsService } from './settings.js';

import type { ILoggingService } from '../shared/service-interfaces.js';
import { getProviderIds } from '../model/providers/index.js';
import { loadProviderItems } from '../model/providers/provider-service.js';
import { listOAuthAccounts, removeOAuthAccount, setActiveOAuthAccount } from '../model/providers/oauth-accounts.js';
import { loginToCodex } from '../model/providers/codex-auth.js';
import { loginToGrok } from '../model/providers/grok-auth.js';
import { ModelCatalogSession } from '../model/models/model-catalog-session.js';
import { getAvailableProviderIds, resolveProviderCredentials } from '../model/provider-credentials.js';
import type {
  CredentialDescription,
  DirectCredentialBackend,
  DirectModelBackend,
  DirectOAuthBackend,
  DirectProviderBackend,
} from './host-config-settings.js';
import { CREDENTIAL_SETTINGS } from './credential-settings.js';

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The browser login's prompts, written as the current CLI writes them (source/cli.tsx). */
function oauthLoginIo(providerLabel: string) {
  return {
    pasteInput: stdin.isTTY ? stdin : undefined,
    onPasteRejected: (message: string) => {
      console.error(message);
    },
    onPrompt: (url: string) => {
      console.log(`Opening your browser to log in to ${providerLabel}.`);
      console.log(`If it does not open, visit:\n${url}\n`);
      console.log(
        'If you are remote and the browser cannot reach this machine, copy the redirected localhost URL from the address bar (or just its code), paste it here, and press Enter.',
      );
    },
  };
}

/** Run provider authentication without creating or opening a conversation. */
export async function runLogin(provider: 'grok' | 'codex'): Promise<number> {
  if (provider === 'grok') {
    const { loginToGrok } = await import('../model/providers/grok-auth.js');
    try {
      const tokens = await loginToGrok(oauthLoginIo('Grok'));
      console.log(`Logged in to Grok${tokens.email ? ` as ${tokens.email}` : ''}.`);
      return 0;
    } catch (error) {
      console.error(`Grok login failed: ${errorMessage(error)}`);
      return 1;
    }
  }
  const { loginToCodex } = await import('../model/providers/codex-auth.js');
  try {
    await loginToCodex(oauthLoginIo('Codex'));
    console.log('Logged in to Codex.');
    return 0;
  } catch (error) {
    console.error(`Codex login failed: ${errorMessage(error)}`);
    return 1;
  }
}

/** List the source model catalogue with its persisted app settings and diagnostics. */
export async function runListModelsCommand(search: string | null, refresh: boolean): Promise<number> {
  const { runListModels } = await import('../model/models/model-listing.js');
  const listingSettings = createSettingsService({
    env: buildEnvOverrides(),
    loggingServiceOptions: { sessionContextService: new SessionContextService() },
  });
  const listingLogger = listingSettings.getLoggingService();
  const outcome = await runListModels({
    settingsService: listingSettings,
    loggingService: listingLogger,
    ...(search === null ? {} : { search }),
    refresh,
  });
  for (const warning of outcome.warnings) stderr.write(`${warning}\n`);
  if (outcome.error) stderr.write(`${outcome.error}\n`);
  if (outcome.output) stdout.write(`${outcome.output}\n`);
  return outcome.exitCode;
}

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

/** Global account/catalog leaves over the host's one settings owner; opens no conversation. */
export function createDirectAccountPorts(service: ProductSettings): {
  readonly credentials: DirectCredentialBackend;
  readonly providers: DirectProviderBackend;
  readonly oauth: DirectOAuthBackend;
  readonly models: DirectModelBackend;
} {
  const catalog = new ModelCatalogSession({ settingsService: service, loggingService: silentLog });
  return {
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

type ProductSettings = SettingsService;

function describeCredential(service: ProductSettings, providerId: string): CredentialDescription {
  const definition = CREDENTIAL_SETTINGS[providerId];
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
