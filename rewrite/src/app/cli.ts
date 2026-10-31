#!/usr/bin/env node
import '../../../source/env-setup.js';

import { readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { stdin, stdout, stderr } from 'node:process';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import envPaths from 'env-paths';
import { LoggingService } from '../../../source/services/logging/logging-service.js';
import { resolveProfile } from '../../../source/services/profiles/resolver.js';
import { BARE_PROFILE_ID, canonicalProfileId } from '../../../source/services/profiles/legacy-adapter.js';
import { SessionContextService } from '../../../source/services/session/session-context-service.js';
import { buildEnvOverrides } from '../../../source/services/settings/settings-service.js';
import { shouldWarnOnHomeDirectoryStart } from '../../../source/utils/home-directory-start-guard.js';
import { parseServeArgs, type ServeArgs } from '../../../source/gateway/serve-args.js';
import { parseAcpArgs, type AcpArgs } from '../../../source/acp-v2/serve-args.js';
import { createAppSettings } from './settings.js';
import { run } from './run.js';
import type { HeadlessIo } from '../clients/headless/index.js';

/**
 * One flag as the direct executable parses it. `pending` marks a flag that
 * parses but cannot run yet; using it fails before any side effect and never
 * starts the current CLI. Its phrase says where the flag lands.
 */
type Flag = {
  readonly names: readonly string[];
  readonly label: string;
  readonly help: string;
  /** 'required' takes the next token or `--x=value`; 'optional' takes only `--x=value`. */
  readonly value?: 'required' | 'optional';
  readonly pending?: string;
};

const TBD = 'no milestone yet';

/** Builds one flag. `suffix` is its help placeholder: ' <x>' takes a required value, '[=<x>]' an optional one. */
const opt = (names: string[], suffix: string, help: string, pending?: string): Flag => {
  const value: Flag['value'] = suffix.startsWith(' <') ? 'required' : suffix.startsWith('[=') ? 'optional' : undefined;
  return { names, label: names.join(', ') + suffix, help, value, pending };
};

// Order and wording follow the current CLI's Options section (source/cli.tsx).
const FLAGS: readonly Flag[] = [
  opt(['-m', '--model'], ' <model>', 'Model pattern or ID, supports provider/id and optional :<thinking>', TBD),
  opt(['-p', '--provider'], ' <provider>', 'Override the configured provider (e.g. openai, openrouter)', TBD),
  opt(
    ['-r', '--reasoning'],
    ' <effort>',
    'Set reasoning effort (default, none, minimal, low, medium, high, xhigh)',
    TBD,
  ),
  opt(['--goal'], ' <text>', 'Persist a user-authored session outcome (max 2,000 characters)', 'lands in M4'),
  opt(
    ['--goal-criteria'],
    ' <text>',
    'Optional success criteria (max 2,000 characters; requires --goal)',
    'lands in M4',
  ),
  opt(['--profile'], ' <name>', 'Select a profile (full, bare, plan, pair, mentor, orchestrator; lite = bare)'),
  opt(['-l', '--lite'], '', 'Start in the Bare profile (alias kept from Lite)'),
  opt(['--auto-approve'], '', 'Allow tool execution for a non-interactive prompt'),
  opt(['-q', '--quiet'], '', 'Suppress non-error diagnostics on stderr in non-interactive mode', 'lands in M4'),
  opt(['--show-reasoning'], '', 'Stream reasoning deltas to stderr in non-interactive mode', 'lands in M4'),
  opt(['--json'], '', 'Emit newline-delimited JSON (NDJSON) events in non-interactive mode', 'lands in M4'),
  opt(['--ssh'], ' <user@host>', 'Enable SSH mode for a remote host', TBD),
  opt(
    ['--discord-input'],
    '',
    'Allow Discord input and explicit root notifications on this control socket',
    'lands in M6',
  ),
  opt(['--remote-dir'], ' <path>', 'Remote working directory (required for non-lite SSH sessions)', TBD),
  opt(['--ssh-port'], ' <port>', 'SSH port (default: 22)', TBD),
  opt(['--control-socket'], '[=<name>]', 'Enable a local socket for the interactive TUI', 'lands in M6'),
  opt(['--grok-login'], '', 'Log in to Grok in a browser (OAuth) and exit', TBD),
  opt(['--codex-login'], '', 'Log in to Codex/ChatGPT in a browser (OAuth) and exit', TBD),
  opt(
    ['--list-models'],
    ' [search]',
    'Print available models grouped by provider, filtered by an optional search term',
    TBD,
  ),
  opt(['--refresh'], '', 'With --list-models, bypass the model catalog cache and re-fetch before listing', TBD),
  opt(['-R', '--resume'], ' <id>', 'Resume an exact direct conversation ID with a follow-up prompt.'),
  opt(['--fork'], '', 'Fork the resumed conversation into a new session (requires --resume)', TBD),
  opt(['-h', '--help'], '', 'Show help'),
  opt(['-v', '--version'], '', 'Show version'),
];

const FLAG_BY_NAME = new Map(FLAGS.flatMap((flag) => flag.names.map((name) => [name, flag] as const)));

const SUBCOMMANDS = new Set(['serve', 'acp', 'control', 'discord']);
const CONTROL_COMMANDS = new Set(['list', 'status', 'get', 'submit', 'steer', 'interrupt', 'wait-turn']);
const CONTROL_USAGE =
  'Usage: term2 control list [--status] | status <name> [--json] | get <name> <topic> [--json] | submit|steer <name> --id <id> | interrupt <name> | wait-turn <name> --message-id <id>\n';

// Copied from source/services/discord/discord-command.ts, whose module pulls in the old bridge runtime.
const DISCORD_HELP = `Discord bridge (candidate) — attach existing opted-in terminal sessions.

Usage:
  term2 discord [ /absolute/path/discord.json ]
  term2 discord --save-token [ /absolute/path/discord.json ]
  term2 discord --help

Default config: $XDG_CONFIG_HOME/term2/discord.json, otherwise ~/.config/term2/discord.json.
Create JSON with channelId, humanUserId, coordinator, stateDir and optional maxHops.
Keep the token out of JSON. --save-token enrolls it with hidden input on a TTY,
stores discord.token beside the config, then exits without starting the bridge.
The config directory must be user-owned/private (0700); token file private (0600).
TERM2_DISCORD_BOT_TOKEN on the bridge process overrides the stored token.

Finish term2 provider setup first and keep an interactive term2 session running.
In that session, opt in locally with /bridge connect [name] (default: coord).
This attaches a local session; it does not verify the standalone bridge can reach Discord.
Only explicit discord_send calls post to Discord; ordinary final answers do not.
Ask: "Reply in Discord using discord_send." Status, approvals and questions stay local.

First-run checklist and reference: docs/reference/discord-bridge.md
https://github.com/qduc/term2/blob/main/docs/reference/discord-bridge.md
Candidate: live Discord/mobile validation is still outstanding.
`;

const optionLines = FLAGS.map((flag) => `  ${flag.label.padEnd(38)}${flag.help}${flag.pending ? ' *' : ''}`).join('\n');

const HELP = `Usage: term2 [options] [prompt...]
       term2 <serve|acp|control|discord> [arguments]

Options:
${optionLines}

Subcommands:
  term2 serve --local-owner <userId> [--state-dir <dir>] [--socket <path>] *
      [--listen <host:port> --tls-cert <pem> --tls-key <pem>] [--allow-remote]
      [--pairing] [--bff-key <kid>=<pem path>]... [--workspace-root <dir>]...
      [--issuer <iss>] [--audience <aud>] [--allow-write]
        Run the local web gateway until SIGINT/SIGTERM.
  term2 acp [--provider <provider>] [--model <model>] [--effort <effort>] *
        Serve the Agent Client Protocol v2 over stdio. Stdout carries protocol traffic only.
  term2 control list [--status] | status <name> [--json] | get <name> <topic> [--json] | *
      submit|steer <name> --id <id> | interrupt <name> | wait-turn <name> --message-id <id>
        Talk to a live control socket.
  term2 discord [config.json] | --save-token [config.json] | --help *
        Run the Discord bridge. --help prints its reference.

The direct CLI supports one prompt per invocation. Resume requires an exact direct conversation ID and a follow-up prompt.
* Not available in the direct executable yet. These fail with an error; they never start the current CLI.
`;

const NO_PROMPT_MESSAGE = 'term2 needs an interactive terminal; for one-shot use: term2 "<prompt>"';
const HOME_DIRECTORY_REFUSAL =
  'Headless startup refused from the home or root directory. Start in a project directory.';

/**
 * What the executable was asked to do. `headless` is the only mode that runs
 * today. `serve`, `acp`, `control`, `discord` and interactive TUI carry their
 * parsed arguments so the app owner can wire dispatch without re-parsing; until
 * then `main` refuses them. Adding a mode means adding its kind here.
 */
type Command =
  | { readonly kind: 'help' }
  | { readonly kind: 'version' }
  | { readonly kind: 'discord-help' }
  | { readonly kind: 'pending'; readonly name: string; readonly pending: string }
  | {
      readonly kind: 'headless';
      readonly prompt: string;
      readonly autoApprove: boolean;
      readonly lite: boolean;
      readonly profile: string | null;
      readonly resumeId: string | null;
    }
  | { readonly kind: 'interactive' }
  | { readonly kind: 'serve'; readonly args: ServeArgs }
  | { readonly kind: 'acp'; readonly args: AcpArgs }
  | { readonly kind: 'control'; readonly valid: boolean; readonly argv: readonly string[] }
  | { readonly kind: 'discord'; readonly argv: readonly string[] };

function notAvailable(what: string, pending: string): Error {
  return new Error(`${what} is not available in the direct executable (${pending}).`);
}

function longName(flag: Flag): string {
  return flag.names.find((name) => name.startsWith('--')) ?? flag.names[0]!;
}

function parseResumeId(value: string): string {
  if (value.startsWith('-')) throw new Error('--resume requires an exact conversation ID');
  if (!/^conv_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error('--resume requires an exact direct conversation ID');
  }
  return value;
}

function parseSubcommand(name: string, rest: readonly string[], globalFlagsSeen: boolean): Command {
  if (globalFlagsSeen) throw new Error(`term2 ${name} must be the first argument`);
  if (name === 'serve') {
    const parsed = parseServeArgs(rest);
    if (!parsed.ok) throw new Error(`term2 serve: ${parsed.error}`);
    return { kind: 'serve', args: parsed.args };
  }
  if (name === 'acp') {
    const parsed = parseAcpArgs(rest);
    if (!parsed.ok) throw new Error(`term2 acp: ${parsed.error}`);
    return { kind: 'acp', args: parsed.args };
  }
  if (name === 'control') return { kind: 'control', valid: CONTROL_COMMANDS.has(rest[0] ?? ''), argv: rest };
  if (rest.length === 1 && (rest[0] === '--help' || rest[0] === '-h')) return { kind: 'discord-help' };
  return { kind: 'discord', argv: rest };
}

/** Pure: parses argv into one command. Throws on usage errors, with the messages the current CLI uses where they apply. */
function parseCommandLine(argv: readonly string[]): Command {
  const positional: string[] = [];
  const seen: Flag[] = [];
  let autoApprove = false;
  let lite = false;
  let profile: string | null = null;
  let resumeId: string | null = null;
  let help = false;
  let version = false;
  let endOfOptions = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!endOfOptions && token === '--') {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && token.startsWith('-') && token !== '-') {
      const equals = token.startsWith('--') ? token.indexOf('=') : -1;
      const name = equals > 0 ? token.slice(0, equals) : token;
      const flag = FLAG_BY_NAME.get(name);
      if (!flag) throw new Error(`Unknown option: ${token}`);
      const inlineValue = equals > 0 ? token.slice(equals + 1) : undefined;
      if (flag.value === undefined && inlineValue !== undefined) throw new Error(`${name} does not take a value`);
      let value: string | undefined;
      if (flag.value === 'required') {
        value = inlineValue ?? argv[++index];
        if (value === undefined || value === '' || (inlineValue === undefined && value.startsWith('--'))) {
          throw new Error(`${name} requires a value`);
        }
      }
      seen.push(flag);
      switch (longName(flag)) {
        case '--auto-approve':
          autoApprove = true;
          break;
        case '--lite':
          lite = true;
          break;
        case '--profile':
          profile = value!;
          break;
        case '--resume':
          if (resumeId !== null) throw new Error('--resume may only be specified once');
          resumeId = parseResumeId(value!);
          break;
        case '--help':
          help = true;
          break;
        case '--version':
          version = true;
          break;
      }
      continue;
    }
    if (positional.length === 0 && !endOfOptions && SUBCOMMANDS.has(token)) {
      return parseSubcommand(token, argv.slice(index + 1), seen.length > 0);
    }
    positional.push(token);
  }

  if (help) return { kind: 'help' };
  if (version) return { kind: 'version' };
  const pendingFlag = seen.find((flag) => flag.pending !== undefined);
  if (pendingFlag) return { kind: 'pending', name: longName(pendingFlag), pending: pendingFlag.pending! };

  const prompt = positional.length > 0 ? positional.join(' ').trim() : null;
  if (prompt === '') return { kind: 'help' };
  if (prompt === null) {
    if (resumeId !== null) throw new Error('--resume requires a follow-up prompt');
    return { kind: 'interactive' };
  }
  return { kind: 'headless', prompt, autoApprove, lite, profile, resumeId };
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
  options: { readonly profile: string | null; readonly lite: boolean },
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
  request: Parameters<typeof run>[0],
): Promise<{ readonly kind: 'completed' | 'cancelled' | 'failed'; readonly signal?: NodeJS.Signals }> {
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

  const handle = run(request);
  turnHasStarted = handle.turnActive();
  const result = await handle.result;
  return { kind: result.kind, ...(receivedSignal === undefined ? {} : { signal: receivedSignal }) };
}

async function runHeadless(command: Extract<Command, { kind: 'headless' }>): Promise<number> {
  const cwd = path.resolve(process.cwd());
  const home = path.resolve(homedir());
  if (shouldWarnOnHomeDirectoryStart({ cwd, homeDir: home, isNonLiteStart: !command.lite && command.autoApprove })) {
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
  // The profile is announced by the app after a resumed selection is restored; announcing here would show the pre-restore value.
  chooseProfile(command, settings);

  const io: HeadlessIo = { stdout, stderr };
  const result = await runWithSignals({
    prompt: command.prompt,
    conversationsDir: directory,
    selection: { settings, logger, sessionContext },
    io,
    autoApprove: command.autoApprove,
    ...(command.resumeId === null ? {} : { resumeId: command.resumeId }),
    profileExplicit: command.profile !== null || command.lite,
  });
  if (result.kind === 'completed') return 0;
  if (result.kind === 'cancelled') return result.signal ? exitCodeForSignal(result.signal) : 1;
  return 1;
}

async function main(argv: readonly string[]): Promise<number> {
  const command = parseCommandLine(argv);
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
    case 'pending':
      throw notAvailable(command.name, command.pending);
    case 'interactive':
      if (stdin.isTTY && stdout.isTTY) throw notAvailable('The interactive terminal UI', 'lands in M5');
      stderr.write(`${NO_PROMPT_MESSAGE}\n`);
      return 1;
    case 'serve':
      throw notAvailable('term2 serve', 'lands in M6');
    case 'acp':
      throw notAvailable('term2 acp', 'lands in M6');
    case 'control':
      if (!command.valid) {
        stderr.write(CONTROL_USAGE);
        return 1;
      }
      throw notAvailable('term2 control', 'lands in M6');
    case 'discord':
      throw notAvailable('term2 discord', 'lands in M6');
    case 'headless':
      return runHeadless(command);
  }
}

// Exit explicitly. Draining naturally would hand signals back to their default
// action during shutdown, so a late signal could override a durable result.
void main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    stderr.write(`error ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
