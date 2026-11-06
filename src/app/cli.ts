#!/usr/bin/env node
import '../config/env-setup.js';

import { readlinkSync, realpathSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { stdin, stdout, stderr } from 'node:process';
import { homedir } from 'node:os';
import path from 'node:path';
import envPaths from 'env-paths';
import { getAllProviders, getProviderIds } from '../model/providers/index.js';
import { installationVersion } from '../model/providers/fetch/logging-middleware.js';
import { LoggingService } from '../session/logging/logging-service.js';
import { VALID_REASONING_EFFORTS, type ModelSettingsReasoningEffort } from '../model/models/reasoning-effort.js';
import { resolveProfile } from '../config/profiles/resolver.js';
import { BARE_PROFILE_ID, canonicalProfileId } from '../shared/profiles/legacy-adapter.js';
import { SessionContextService } from '../session/session/session-context-service.js';
import { buildEnvOverrides } from '../config/settings/settings-service.js';
import {
  HOME_DIRECTORY_START_WARNING,
  shouldWarnOnHomeDirectoryStart,
} from '../shared/utils/home-directory-start-guard.js';
import type { AcpArgs } from '../clients/acp-v2/serve-args.js';
import type { ServeArgs } from '../host/gateway/serve-args.js';
import type { DirectLaunchBase } from './launch-types.js';
import type { InteractivePickerRequest } from '../model/models/model-resolution.js';
import { HARNESS_IDLE_ENV } from '../shared/lib/harness-input-idle.js';
import { formatResumeList } from '../shared/utils/resume-list.js';
import { isControlSocketName } from '../clients/control-socket/control-socket.js';
import { createSettingsService, type SettingsService } from './settings.js';
import { runLogin, runListModelsCommand } from './cli-account-commands.js';
import { listNativeConversations, resolveNativeResume, ResumeRefusal } from './cli-conversations.js';
import {
  launchDirect,
  INTERACTIVE_TERMINAL_REQUIRED,
  runDirectHeadlessOnHost,
  type DirectHeadlessRequest,
  type DirectLaunchRequest,
} from './launch.js';
import type { HeadlessIo } from '../clients/headless/index.js';
import {
  CONTROL_USAGE,
  DISCORD_HELP,
  helpText,
  parseCommandLine,
  UsageError,
  type Command,
  type Refusal,
  type SessionOptions,
} from './cli-args.js';

const HOME_DIRECTORY_REFUSAL =
  'Headless startup refused from the home or root directory. Start in a project directory.';

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function refused(refusal: Refusal): Error {
  return new Error(`${refusal.flag} is not available in the direct executable yet: ${refusal.reason}.`);
}

/**
 * When the home-directory guard applies, as in the current CLI: non-lite, not a
 * resume, not SSH, and (without a prompt, or with --auto-approve for a prompt).
 */
function homeGuardApplies(options: SessionOptions, hasPrompt: boolean): boolean {
  return !options.lite && options.resumeId === null && options.ssh === null && (!hasPrompt || options.autoApprove);
}

/** Resolves aliases even when the store or a symlink's target does not exist yet. */
function resolvedStorePath(filename: string): string {
  // Keep `..` until filesystem resolution: it may follow a symlinked component.
  const supplied = path.isAbsolute(filename) ? filename : `${process.cwd()}${path.sep}${filename}`;
  const root = path.parse(supplied).root;
  const absolute = root + supplied.slice(root.length).replace(process.platform === 'win32' ? /[\\/]+$/ : /\/+$/, '');
  try {
    return realpathSync.native(absolute);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    let link: string | undefined;
    try {
      link = readlinkSync(absolute);
    } catch (linkError) {
      if (!(linkError instanceof Error && 'code' in linkError && ['ENOENT', 'EINVAL'].includes(String(linkError.code))))
        throw linkError;
    }
    if (link !== undefined) {
      return resolvedStorePath(path.isAbsolute(link) ? link : `${path.dirname(absolute)}${path.sep}${link}`);
    }
    const parent = path.dirname(absolute);
    if (parent === absolute) throw error;
    return path.join(resolvedStorePath(parent), path.basename(absolute));
  }
}

function conversationsDirectory(): string {
  const data = envPaths('term2').data;
  const directory = resolvedStorePath(process.env['TERM2_CONVERSATIONS_DIR'] ?? path.join(data, 'conversations-next'));
  // Missing paths have no canonical spelling yet. Protect case aliases on the
  // platforms whose usual filesystems are case-insensitive, conservatively even on sensitive volumes.
  const comparable = (filename: string) =>
    process.platform === 'darwin' || process.platform === 'win32' ? filename.toLowerCase() : filename;
  if (comparable(directory) === comparable(resolvedStorePath(path.join(data, 'conversations')))) {
    throw new Error('The legacy conversations directory is read-only; use a separate native conversations directory');
  }
  // All consumers must use the same identity that was checked above.
  return directory;
}

/**
 * Refuses any existing filename outside the `conv_` namespace. It enumerates
 * names only: no old file is opened or parsed. A missing directory is allowed;
 * the session store creates it when it writes the first conversation.
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

function chooseProfile(options: Pick<SessionOptions, 'profile' | 'lite'>, settings: SettingsService): string {
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

async function runWithSignals(request: DirectHeadlessRequest): Promise<{
  readonly kind: 'completed' | 'cancelled' | 'failed' | 'context_paused' | 'blocked' | 'budget_paused';
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

/**
 * Applies --model, --provider and --reasoning to the session settings, in the
 * current CLI's order and with its messages. Returns the error to print, or null.
 * `pickerEligible` is the current CLI's picker gate (TTY, no prompt, no --json,
 * no harness marker). Only the interactive path sets it; headless is always unattended.
 */
async function applyModelOverrides(
  options: SessionOptions,
  settings: SettingsService,
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

  const picker = pickerEligible ? await import('../model/models/model-picker-host.js') : undefined;

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
  const { resolveModelFlag } = await import('../model/models/model-resolution.js');
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
  settings.set(
    'agent.modelSelection',
    { model: resolution.modelId, provider: resolution.provider },
    { persist: false },
  );
  if (resolution.reasoningEffort && validReasoning === undefined) {
    settings.set('agent.reasoningEffort', resolution.reasoningEffort, { persist: false });
  }
  return null;
}

async function runHeadless(prompt: string, options: SessionOptions): Promise<number> {
  const cwd = path.resolve(process.cwd());
  const home = path.resolve(homedir());
  if (shouldWarnOnHomeDirectoryStart({ cwd, homeDir: home, isNonLiteStart: homeGuardApplies(options, true) })) {
    stderr.write(`${HOME_DIRECTORY_REFUSAL}\n`);
    return 1;
  }

  const directory = conversationsDirectory();
  await checkConversationsDirectory(directory);

  const sessionContext = new SessionContextService();
  const settings = createSettingsService({
    env: buildEnvOverrides(),
    disableFilePersistence: true,
    loggingServiceOptions: { sessionContextService: sessionContext },
  });
  const logger = settings.getLoggingService();
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
    ...(options.fork ? { fork: true } : {}),
    ...(options.goal === null ? {} : { goal: options.goal }),
    profileExplicit: options.profile !== null || options.lite,
    modelExplicit: options.model !== null || options.provider !== null,
    output: options.output.json ? 'json' : 'plain',
    showReasoning: options.output.showReasoning,
    quiet: options.output.quiet,
    lite: options.lite,
    ...(options.ssh === null ? {} : { ssh: options.ssh }),
  });
  if (result.kind === 'completed') return 0;
  // A resumable context pause exits 2, as the current CLI does; the recovery text was already printed.
  if (result.kind === 'context_paused') return 2;
  // A blocked turn (goal check unresolved, completion verification blocked) exits 2 with the notice already printed.
  // A pending run-budget check-in parks the run; the CLI never answers it, and the app keeps it for interactive resume.
  if (result.kind === 'blocked' || result.kind === 'budget_paused') return 2;
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
  const settings = createSettingsService({
    env: buildEnvOverrides(),
    loggingServiceOptions: { sessionContextService: sessionContext },
  });
  const logger = settings.getLoggingService();
  // The picker gate of src/model/models/model-picker-host.tsx: TTY on both ends, no --json, no harness marker.
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
    modelExplicit: options.model !== null || options.provider !== null,
    lite: options.lite,
    ...(options.resumeId === null ? {} : { resumeId: options.resumeId }),
    ...(controlSocket === undefined ? {} : { controlSocket }),
    ...(options.ssh === null ? {} : { ssh: options.ssh }),
    ...(options.fork ? { fork: true } : {}),
    ...(options.goal === null ? {} : { goal: options.goal }),
  };
  return launchDirect(request);
}

/** The conversations directory and a non-persisting settings selection, shared by the launcher modes that take no CLI overrides. */
async function launcherBase(): Promise<Pick<DirectLaunchBase, 'conversationsDir' | 'selection'>> {
  const directory = conversationsDirectory();
  await checkConversationsDirectory(directory);

  const sessionContext = new SessionContextService();
  const settings = createSettingsService({
    env: buildEnvOverrides(),
    disableFilePersistence: true,
    loggingServiceOptions: { sessionContextService: sessionContext },
  });
  const logger = settings.getLoggingService();
  return { conversationsDir: directory, selection: { settings, logger, sessionContext } };
}

async function runAcp(args: AcpArgs): Promise<number> {
  // The launcher resolves --provider, --model and --effort itself, so no overrides are applied here.
  return launchDirect({ kind: 'acp', ...(await launcherBase()), args });
}

async function runServe(args: ServeArgs): Promise<number> {
  // The serve launcher runs until SIGINT/SIGTERM and owns those signals; this does not install handlers.
  return launchDirect({ kind: 'serve', ...(await launcherBase()), args });
}

async function main(argv: readonly string[]): Promise<number> {
  const command: Command = parseCommandLine(argv);
  switch (command.kind) {
    case 'help':
      stdout.write(helpText());
      return 0;
    case 'version':
      stdout.write(`${installationVersion}\n`);
      return 0;
    case 'discord-help':
      stdout.write(DISCORD_HELP);
      return 0;
    case 'login':
      return runLogin(command.provider);
    case 'list-models':
      return runListModelsCommand(command.search, command.refresh);
    case 'list-conversations':
      stdout.write(`${formatResumeList(await listNativeConversations(conversationsDirectory(), command.options))}\n`);
      return 0;
    case 'interactive': {
      if (command.refused) throw refused(command.refused);
      const options = await resolveNativeResume(conversationsDirectory(), command.options);
      if (!(stdin.isTTY && stdout.isTTY)) {
        // A non-lite start from the home directory is refused with the warning first, as the current CLI does.
        if (
          shouldWarnOnHomeDirectoryStart({
            cwd: path.resolve(process.cwd()),
            homeDir: path.resolve(homedir()),
            isNonLiteStart: homeGuardApplies(options, false),
          })
        ) {
          stderr.write(`${HOME_DIRECTORY_START_WARNING.trimEnd()}\nCancelled.\n`);
          return 1;
        }
        // A resume opens its session first so the refusal follows the resume and profile lines, as the current CLI does.
        if (options.goal === null && options.resumeId === null) {
          // The current CLI announces the profile it would have started with before refusing.
          const settings = createSettingsService({ env: buildEnvOverrides(), disableFilePersistence: true });
          stderr.write(`Profile: ${chooseProfile(options, settings).replace(/^builtin:/, '')}\n`);
          stderr.write(`${INTERACTIVE_TERMINAL_REQUIRED}\n`);
          return 1;
        }
        // Preserve an admitted user goal through the native launcher before terminal refusal.
      }
      return runInteractive(options);
    }
    case 'headless':
      if (command.refused) throw refused(command.refused);
      return runHeadless(command.prompt, await resolveNativeResume(conversationsDirectory(), command.options));
    case 'serve':
      return runServe(command.args);
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
      return Number(process.exitCode ?? 0);
  }
}

// Exit explicitly. Draining naturally would hand signals back to their default
// action during shutdown, so a late signal could override a durable result.
void main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    stderr.write(error instanceof ResumeRefusal ? `${error.message}\n` : `error ${errorMessage(error)}\n`);
    process.exit(error instanceof UsageError ? error.exitCode : 1);
  },
);
