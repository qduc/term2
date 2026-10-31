#!/usr/bin/env node
import '../../../source/env-setup.js';

import { readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout, stderr } from 'node:process';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import envPaths from 'env-paths';
import { LoggingService } from '../../../source/services/logging/logging-service.js';
import { resolveProfile } from '../../../source/services/profiles/resolver.js';
import { BARE_PROFILE_ID, canonicalProfileId } from '../../../source/services/profiles/legacy-adapter.js';
import { SessionContextService } from '../../../source/services/session/session-context-service.js';
import {
  confirmHomeDirectoryStart,
  HOME_DIRECTORY_START_WARNING,
  shouldWarnOnHomeDirectoryStart,
} from '../../../source/utils/home-directory-start-guard.js';
import { createAppSettings } from './settings.js';
import { run } from './run.js';
import type { HeadlessIo } from '../clients/headless/index.js';

const HELP = `Usage: term2 [options] [prompt...]

Options:
  --auto-approve    Allow automatic tool approval in a non-interactive run (M1 does not execute tool calls).
  --help            Show this help.
  --version         Show the installed version.
  --profile <name>  Select a profile (full, bare, plan, pair, mentor, orchestrator; lite = bare).
  --lite            Start in the Bare profile (alias kept from Lite).

The M1 direct CLI supports one text-only prompt. Interactive mode, resume, and tools are not available yet.
`;

const REJECTED_SUBCOMMANDS = new Set(['acp', 'control', 'discord', 'serve']);
const HOME_DIRECTORY_REFUSAL =
  'Headless startup refused from the home or root directory. Start in a project directory.';
const NO_PROMPT_MESSAGE = 'term2 needs an interactive terminal; for one-shot use: term2 "<prompt>"';

type CliOptions = {
  readonly prompt: string | null;
  readonly autoApprove: boolean;
  readonly lite: boolean;
  readonly profile: string | null;
  readonly help: boolean;
  readonly version: boolean;
};

function parseArgs(argv: readonly string[]): CliOptions {
  const positional: string[] = [];
  const unknownFlags: string[] = [];
  let autoApprove = false;
  let lite = false;
  let profile: string | null = null;
  let help = false;
  let version = false;
  let endOfOptions = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!endOfOptions && token === '--') {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && token === '--auto-approve') {
      autoApprove = true;
    } else if (!endOfOptions && token === '--lite') {
      lite = true;
    } else if (!endOfOptions && token === '--help') {
      help = true;
    } else if (!endOfOptions && token === '--version') {
      version = true;
    } else if (!endOfOptions && (token === '--profile' || token.startsWith('--profile='))) {
      const value = token === '--profile' ? argv[++index] : token.slice('--profile='.length);
      if (value === undefined || value.length === 0 || value.startsWith('--')) {
        throw new Error('--profile requires a value');
      }
      profile = value;
    } else if (!endOfOptions && token.startsWith('-')) {
      unknownFlags.push(token);
    } else {
      positional.push(token);
    }
  }

  const unsupportedCommand = positional[0] && REJECTED_SUBCOMMANDS.has(positional[0]) ? positional[0] : undefined;
  if (unsupportedCommand) throw new Error(`Unsupported subcommand: ${unsupportedCommand}`);
  if (unknownFlags.length > 0) throw new Error(`Unknown option: ${unknownFlags[0]}`);

  return {
    prompt: positional.length > 0 ? positional.join(' ').trim() : null,
    autoApprove,
    lite,
    profile,
    help,
    version,
  };
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

function chooseProfile(options: CliOptions, settings: ReturnType<typeof createAppSettings>['service']): string {
  const currentProfile = String(settings.get('app.activeProfileId'));
  let profileId: string;
  if (options.profile !== null) {
    const name = options.profile === 'full' ? 'standard' : options.profile;
    profileId = canonicalProfileId(name.includes(':') ? name : `builtin:${name}`);
    resolveProfile(profileId);
  } else if (options.lite) {
    profileId = BARE_PROFILE_ID;
  } else {
    const implicitLite = Boolean(options.prompt && !options.autoApprove);
    profileId =
      implicitLite && !['builtin:orchestrator', 'builtin:mentor'].includes(currentProfile)
        ? BARE_PROFILE_ID
        : currentProfile;
  }

  settings.set('app.activeProfileId', profileId, { persist: false });
  return String(settings.get('app.activeProfileId'));
}

function exitCodeForSignal(signal: NodeJS.Signals): number {
  return signal === 'SIGINT' ? 130 : 143;
}

async function runWithSignals(
  request: Parameters<typeof run>[0],
): Promise<{ readonly kind: 'completed' | 'cancelled' | 'failed'; readonly signal?: NodeJS.Signals }> {
  const handle = run(request);
  let settled = false;
  // The handle has no started bit. Latch observed activity so later inactivity
  // waits for its durable result; Task 5 must keep it active through settlement.
  let turnHasStarted = handle.turnActive();
  let receivedSignal: NodeJS.Signals | undefined;
  const resultPromise = handle.result.then(
    (result) => {
      settled = true;
      return result;
    },
    (error: unknown) => {
      settled = true;
      throw error;
    },
  );

  const onSignal = (signal: NodeJS.Signals): void => {
    if (receivedSignal !== undefined) {
      process.exit(exitCodeForSignal(signal));
    }
    receivedSignal = signal;
    if (settled) return;
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
  const onSigint = () => onSignal('SIGINT');
  const onSigterm = () => onSignal('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);

  try {
    const result = await resultPromise;
    return { kind: result.kind, ...(receivedSignal === undefined ? {} : { signal: receivedSignal }) };
  } finally {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  }
}

async function main(argv: readonly string[]): Promise<number> {
  const options = parseArgs(argv);
  if (options.help || options.prompt === '') {
    stdout.write(HELP);
    return 0;
  }
  if (options.version) {
    stdout.write(`${packageVersion()}\n`);
    return 0;
  }

  const cwd = path.resolve(process.cwd());
  const home = path.resolve(homedir());
  const refusedAtHome = shouldWarnOnHomeDirectoryStart({
    cwd,
    homeDir: home,
    isNonLiteStart: !options.lite && (options.prompt === null || options.autoApprove),
  });
  if (refusedAtHome) {
    if (options.prompt !== null) {
      stderr.write(`${HOME_DIRECTORY_REFUSAL}\n`);
      return 1;
    }
    if (!stdin.isTTY || !stdout.isTTY) {
      stderr.write(`${HOME_DIRECTORY_START_WARNING.trimEnd()}\nCancelled.\n`);
      return 1;
    }
    const readline = createInterface({ input: stdin, output: stdout });
    try {
      const confirmed = await confirmHomeDirectoryStart(() => readline.question(HOME_DIRECTORY_START_WARNING));
      if (!confirmed) {
        stderr.write('Cancelled.\n');
        return 1;
      }
    } finally {
      readline.close();
    }
  }

  if (options.prompt === null) {
    stderr.write(`${NO_PROMPT_MESSAGE}\n`);
    return 1;
  }

  const directory = conversationsDirectory();
  await checkConversationsDirectory(directory);

  const sessionContext = new SessionContextService();
  const logger = new LoggingService({ sessionContextService: sessionContext });
  const { service: settings } = createAppSettings({
    disableFilePersistence: true,
    loggingService: logger,
  });
  const profileId = chooseProfile(options, settings);
  stderr.write(`Profile: ${profileId === 'builtin:standard' ? 'full' : profileId.replace(/^builtin:/, '')}\n`);

  const io: HeadlessIo = { stdout, stderr };
  const result = await runWithSignals({
    prompt: options.prompt,
    conversationsDir: directory,
    selection: { settings, logger, sessionContext },
    io,
  });
  if (result.kind === 'completed') return 0;
  if (result.kind === 'cancelled') return result.signal ? exitCodeForSignal(result.signal) : 1;
  return 1;
}

void main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    stderr.write(`error ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
