/** Account/catalog subcommands, independent of conversation launch and signal ownership. */
import { stdin, stdout, stderr } from 'node:process';
import { SessionContextService } from '../../../source/services/session/session-context-service.js';
import { buildEnvOverrides } from '../../../source/services/settings/settings-service.js';
import { createAppSettings } from './settings.js';

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
    const { loginToGrok } = await import('../../../source/providers/grok-auth.js');
    try {
      const tokens = await loginToGrok(oauthLoginIo('Grok'));
      console.log(`Logged in to Grok${tokens.email ? ` as ${tokens.email}` : ''}.`);
      return 0;
    } catch (error) {
      console.error(`Grok login failed: ${errorMessage(error)}`);
      return 1;
    }
  }
  const { loginToCodex } = await import('../../../source/providers/codex-auth.js');
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
  const { runListModels } = await import('../../../source/services/models/model-listing.js');
  const { service: listingSettings } = createAppSettings({
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
