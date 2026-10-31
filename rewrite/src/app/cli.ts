#!/usr/bin/env node
import '../../../source/env-setup.js';

import { readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { stdin, stdout, stderr } from 'node:process';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import envPaths from 'env-paths';
import { getAllProviders, getProviderIds } from '../../../source/providers/index.js';
import { LoggingService } from '../../../source/services/logging/logging-service.js';
import { VALID_REASONING_EFFORTS, type ModelSettingsReasoningEffort } from '../../../source/services/models/reasoning-effort.js';
import { resolveProfile } from '../../../source/services/profiles/resolver.js';
import { BARE_PROFILE_ID, canonicalProfileId } from '../../../source/services/profiles/legacy-adapter.js';
import { SessionContextService } from '../../../source/services/session/session-context-service.js';
import { buildEnvOverrides } from '../../../source/services/settings/settings-service.js';
import { shouldWarnOnHomeDirectoryStart } from '../../../source/utils/home-directory-start-guard.js';
import type { AcpArgs } from '../../../source/acp-v2/serve-args.js';
import type { InteractivePickerRequest } from '../../../source/services/models/model-resolution.js';
import { HARNESS_IDLE_ENV } from '../../../source/lib/harness-input-idle.js';
import { isControlSocketName } from '../../../source/services/control-socket/control-socket.js';
import { createAppSettings } from './settings.js';
import {
  launchDirect,
  runDirectHeadlessOnHost,
  type DirectHeadlessRequest,
  type DirectLaunchRequest,
} from './direct-launch.js';
import type { HeadlessIo } from '../clients/headless/index.js';
import {
  CONTROL_USAGE,
  DISCORD_HELP,
  HELP,
  parseCommandLine,
  type Command,
  type Refusal,
  type SessionOptions,
} from './cli-args.js';

const NO_PROMPT_MESSAGE = 'term2 needs an interactive terminal; for one-shot use: term2 "<prompt>"';
const HOME_DIRECTORY_REFUSAL =
  'Headless startup refused from the home or root directory. Start in a project directory.';

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function notAvailable(what: string, milestone: string): Error {
  return new Error(`${what} is not available in the direct executable yet (${milestone}).`);
}

function refused(refusal: Refusal): Error {
  return new Error(`${refusal.flag} is not available in the direct executable yet: ${refusal.reason}.`);
}

function packageVersion(): string {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    try {
      const manifest = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8')) as {
        name?: unknown;
        version?: unknown;
      };
      if (manifest.name === '@qduc/term2' && typeof manifest.version === 'string') return manifest.version;
    } catch {
      // Keep searching parent directories; the built CLI is nested under rewrite/dist.
    }
    const parent = path.dirname(directory);
    if (parent === directory) return 'unknown';
    directory = parent;
  }
}

function conversationsDirectory(): string {
  return (
    process.env['TERM2_CONVERSATIONS_DIR'] ??
    path.join(path.dirname(path.join(envPaths('term2').data, 'conversations')), 'conversations-next')
  );
}

/**
 * Refuses any existing filename outside the `conv_` namespace. It enumerates
 * names only: no old file is opened or parsed. A missing directory is allowed;
 * `run()` creates it after this check.
 */
async function checkConversationsDirectory(directory: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  const incompatible = entries.find((name) => !name.startsWith('conv_'));
  if (incompatible !== undefined) {
    throw new Error(`Refusing conversations directory containing a non-M1 entry: ${JSON.stringify(incompatible)}`);
  }
}

function chooseProfile(
  options: Pick<SessionOptions, 'profile' | 'lite'>,
  settings: ReturnType<typeof createAppSettings>['service'],
): string {
  const currentProfile = String(settings.get('app.activeProfileId'));
  let profileId: string;
  if (options.profile !== null) {
    const name = options.profile === 'full' ? 'standard' : options.profile;
    profileId = canonicalProfileId(name.includes(':') ? name : `builtin:${name}`);
    resolveProfile(profileId);
  } else if (options.lite) {
    profileId = BARE_PROFILE_ID;
  } else {
    // Auto-approval does not select a workflow; honor the saved profile.
    profileId = currentProfile;
  }

  settings.set('app.activeProfileId', profileId, { persist: false });
  return String(settings.get('app.activeProfileId'));
}

function exitCodeForSignal(signal: NodeJS.Signals): number {
  return signal === 'SIGINT' ? 130 : 143;
}

async function runWithSignals(
  request: DirectHeadlessRequest,
): Promise<{
  readonly kind: 'completed' | 'cancelled' | 'failed' | 'context_paused';
  readonly signal?: NodeJS.Signals;
}> {
  // The handle has no started bit. Latch observed activity so later inactivity
  // waits for its durable result.
  let turnHasStarted = false;
  let receivedSignal: NodeJS.Signals | undefined;

  // Nothing awaits between the durable terminal and `process.exit`, so a handler
  // never runs after the result. An await added there would let a second signal win.
  const onSignal = (signal: NodeJS.Signals): void => {
    if (receivedSignal !== undefined) {
      process.exit(exitCodeForSignal(signal));
    }
    receivedSignal = signal;
    const active = handle.turnActive();
    if (active) turnHasStarted = true;
    if (!active) {
      if (!turnHasStarted) process.exit(exitCodeForSignal(signal));
      return;
    }
    try {
      handle.cancel();
    } catch {
      // The run result is authoritative; signal handlers never write output.
    }
  };
  // Installed first: `run` writes the turn start synchronously, and a signal
  // handled here runs only after it returns, so that turn can still end durably.
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  const handle = runDirectHeadlessOnHost(request);
  turnHasStarted = handle.turnActive();
  const result = await handle.result;
  return { kind: result.kind, ...(receivedSignal === undefined ? {} : { signal: receivedSignal }) };
}

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

async function runLogin(provider: 'grok' | 'codex'): Promise<number> {
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

async function runListModelsCommand(search: string | null, refresh: boolean): Promise<number> {
  const { runListModels } = await import('../../../source/services/models/model-listing.js');
  const listingLogger = new LoggingService({ sessionContextService: new SessionContextService() });
  const { service: listingSettings } = createAppSettings({ env: buildEnvOverrides(), loggingService: listingLogger });
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

/**
 * Applies --model, --provider and --reasoning to the session settings, in the
 * current CLI's order and with its messages. Returns the error to print, or null.
 * `pickerEligible` is the current CLI's picker gate (TTY, no prompt, no --json,
 * no harness marker). Only the interactive path sets it; headless is always unattended.
 */
async function applyModelOverrides(
  options: SessionOptions,
  settings: ReturnType<typeof createAppSettings>['service'],
  logger: LoggingService,
  pickerEligible: boolean,
): Promise<string | null> {
  const reasoning = options.reasoning?.trim() || undefined;
  const validReasoning =
    reasoning !== undefined && (VALID_REASONING_EFFORTS as readonly string[]).includes(reasoning)
      ? (reasoning as ModelSettingsReasoningEffort)
      : undefined;
  if (validReasoning !== undefined) settings.set('agent.reasoningEffort', validReasoning, { persist: false });

  // Providers are checked after settings load, so runtime providers from settings.json are known.
  const provider = options.provider?.trim() || undefined;
  if (provider !== undefined && !getProviderIds().includes(provider)) {
    return [
      `Error: Unknown provider "${provider}".`,
      'Available providers:',
      ...getAllProviders().map((entry) => `  - ${entry.id}  (${entry.label})`),
      '',
      'You can configure custom providers in your settings.json file.',
    ].join('\n');
  }
  if (provider !== undefined && options.model === null) {
    return 'Error: --provider requires --model; provider-only selection is not supported.';
  }

  const picker = pickerEligible ? await import('../../../source/services/models/model-picker-host.js') : undefined;

  // A bare -m opens the picker itself (old cli.tsx); Escape keeps the configured model.
  if (options.model === '') {
    if (picker === undefined) return null;
    const picked = await picker.runModelPickerHost({ settingsService: settings, loggingService: logger });
    if (picked.status !== 'cancelled') {
      settings.set(
        'agent.modelSelection',
        { model: picked.selection.modelId, provider: picked.selection.provider },
        { persist: false },
      );
    }
    return null;
  }

  const modelFlag = options.model?.trim();
  if (!modelFlag) return null;
  const { resolveModelFlag } = await import('../../../source/services/models/model-resolution.js');
  // The picker replaces the readline fallback and the hard no_match error, as the current CLI does.
  const interactivePicker =
    picker === undefined
      ? undefined
      : async (request: InteractivePickerRequest) => {
          const picked = await picker.runModelPickerHost({
            settingsService: settings,
            loggingService: logger,
            initialQuery: request.initialQuery,
            initialProvider: request.initialProvider,
            lockProvider: request.lockProvider,
            bannerLines: request.bannerLines,
          });
          return picked.status === 'selected' ? picked.selection : null;
        };
  const resolution = await resolveModelFlag({
    modelFlag,
    providerFlag: provider,
    settingsService: settings,
    loggingService: logger,
    interactivePicker,
    unattended: !pickerEligible,
  });
  if (resolution.status === 'no_match') return resolution.error;
  // Escape returns to the configured default when the picker was offered; otherwise the run stops.
  if (resolution.status === 'cancelled') return pickerEligible ? null : 'Cancelled.';
  for (const warning of resolution.warnings ?? []) stderr.write(`${warning}\n`);
  // --model is a per-session override: persist:false keeps the saved defaults intact.
  settings.set('agent.modelSelection', { model: resolution.modelId, provider: resolution.provider }, { persist: false });
  if (resolution.reasoningEffort && validReasoning === undefined) {
    settings.set('agent.reasoningEffort', resolution.reasoningEffort, { persist: false });
  }
  return null;
}

async function runHeadless(prompt: string, options: SessionOptions): Promise<number> {
  const cwd = path.resolve(process.cwd());
  const home = path.resolve(homedir());
  if (shouldWarnOnHomeDirectoryStart({ cwd, homeDir: home, isNonLiteStart: !options.lite && options.autoApprove })) {
    stderr.write(`${HOME_DIRECTORY_REFUSAL}\n`);
    return 1;
  }

  const directory = conversationsDirectory();
  await checkConversationsDirectory(directory);

  const sessionContext = new SessionContextService();
  const logger = new LoggingService({ sessionContextService: sessionContext });
  const { service: settings } = createAppSettings({
    env: buildEnvOverrides(),
    disableFilePersistence: true,
    loggingService: logger,
  });
  const modelError = await applyModelOverrides(options, settings, logger, false);
  if (modelError !== null) {
    stderr.write(`${modelError}\n`);
    return 1;
  }
  // The profile is announced by the app after a resumed selection is restored; announcing here would show the pre-restore value.
  chooseProfile(options, settings);

  const io: HeadlessIo = { stdout, stderr };
  const result = await runWithSignals({
    prompt,
    conversationsDir: directory,
    selection: { settings, logger, sessionContext },
    io,
    autoApprove: options.autoApprove,
    ...(options.resumeId === null ? {} : { resumeId: options.resumeId }),
    profileExplicit: options.profile !== null || options.lite,
    output: options.output.json ? 'json' : 'plain',
    showReasoning: options.output.showReasoning,
    quiet: options.output.quiet,
  });
  if (result.kind === 'completed') return 0;
  // A resumable context pause exits 2, as the current CLI does; the recovery text was already printed.
  if (result.kind === 'context_paused') return 2;
  if (result.kind === 'cancelled') return result.signal ? exitCodeForSignal(result.signal) : 1;
  return 1;
}

/**
 * Resolves --control-socket: a bare flag uses the pid; a rejected name is
 * reported and the TUI starts without a socket, as the current CLI does.
 */
function resolveControlSocket(options: SessionOptions): { name: string; discordInput: boolean } | undefined {
  if (options.controlSocket === null) return undefined;
  const name = options.controlSocket.name ?? String(process.pid);
  if (!isControlSocketName(name)) {
    stderr.write(`Control socket name rejected: ${name}\n`);
    return undefined;
  }
  return { name, discordInput: options.discordInput };
}

async function runInteractive(options: SessionOptions): Promise<number> {
  const directory = conversationsDirectory();
  await checkConversationsDirectory(directory);

  const sessionContext = new SessionContextService();
  const logger = new LoggingService({ sessionContextService: sessionContext });
  const { service: settings } = createAppSettings({
    env: buildEnvOverrides(),
    disableFilePersistence: true,
    loggingService: logger,
  });
  // The picker gate of source/services/models/model-picker-host.tsx: TTY on both ends, no --json, no harness marker.
  const pickerEligible = Boolean(stdin.isTTY && stdout.isTTY) && !options.output.json && !process.env[HARNESS_IDLE_ENV];
  const modelError = await applyModelOverrides(options, settings, logger, pickerEligible);
  if (modelError !== null) {
    stderr.write(`${modelError}\n`);
    return 1;
  }
  chooseProfile(options, settings);

  // The launcher runs the home-directory confirmation for this mode (`lite` selects it).
  const controlSocket = resolveControlSocket(options);
  const request: DirectLaunchRequest = {
    kind: 'interactive',
    conversationsDir: directory,
    selection: { settings, logger, sessionContext },
    profileExplicit: options.profile !== null || options.lite,
    lite: options.lite,
    ...(options.resumeId === null ? {} : { resumeId: options.resumeId }),
    ...(controlSocket === undefined ? {} : { controlSocket }),
  };
  return launchDirect(request);
}

async function runAcp(args: AcpArgs): Promise<number> {
  const directory = conversationsDirectory();
  await checkConversationsDirectory(directory);

  const sessionContext = new SessionContextService();
  const logger = new LoggingService({ sessionContextService: sessionContext });
  const { service: settings } = createAppSettings({
    env: buildEnvOverrides(),
    disableFilePersistence: true,
    loggingService: logger,
  });
  // The launcher resolves --provider, --model and --effort itself, so no overrides are applied here.
  return launchDirect({
    kind: 'acp',
    conversationsDir: directory,
    selection: { settings, logger, sessionContext },
    args,
  });
}

async function main(argv: readonly string[]): Promise<number> {
  const command: Command = parseCommandLine(argv);
  switch (command.kind) {
    case 'help':
      stdout.write(HELP);
      return 0;
    case 'version':
      stdout.write(`${packageVersion()}\n`);
      return 0;
    case 'discord-help':
      stdout.write(DISCORD_HELP);
      return 0;
    case 'login':
      return runLogin(command.provider);
    case 'list-models':
      return runListModelsCommand(command.search, command.refresh);
    case 'interactive':
      if (command.refused) throw refused(command.refused);
      if (!(stdin.isTTY && stdout.isTTY)) {
        if (command.options.resumeId !== null) throw new Error('--resume requires a follow-up prompt');
        stderr.write(`${NO_PROMPT_MESSAGE}\n`);
        return 1;
      }
      return runInteractive(command.options);
    case 'headless':
      if (command.refused) throw refused(command.refused);
      return runHeadless(command.prompt, command.options);
    case 'serve':
      // Waits for the host config the direct serve launcher needs; never falls back to the current CLI.
      throw notAvailable('term2 serve', 'waits for host config (M6)');
    case 'acp':
      return runAcp(command.args);
    case 'control':
      if (!command.valid) {
        stderr.write(CONTROL_USAGE);
        return 1;
      }
      return launchDirect({ kind: 'control', argv: command.argv });
    case 'discord':
      // The bridge reports SIGINT/SIGTERM through process.exitCode, which the current CLI keeps as the exit status.
      await launchDirect({ kind: 'discord', argv: command.argv });
      return process.exitCode ?? 0;
  }
}

// Exit explicitly. Draining naturally would hand signals back to their default
// action during shutdown, so a late signal could override a durable result.
void main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    stderr.write(`error ${errorMessage(error)}\n`);
    process.exit(1);
  },
);
