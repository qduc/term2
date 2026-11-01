/**
 * Argument parsing and help text for the direct executable. Pure: no I/O, no
 * settings, no providers. `cli.ts` runs the parsed command. Option wording and
 * validation messages follow the current CLI (source/cli.tsx).
 */
import { parseServeArgs, type ServeArgs } from '../../../source/gateway/serve-args.js';
import { parseAcpArgs, type AcpArgs } from '../../../source/acp-v2/serve-args.js';
import { createDurableGoal } from '../../../source/services/conversation/durable-goal.js';
import type { DurableGoal } from '../../../source/services/logging/conversation-log-events.js';

export type OutputOptions = { readonly json: boolean; readonly quiet: boolean; readonly showReasoning: boolean };
/**
 * `port` is null when --ssh-port was absent, so the resolver can read ~/.ssh/config.
 * An explicit 22 is a number, which is a real override and not the default.
 */
export type SshTarget = { readonly target: string; readonly remoteDir: string | null; readonly port: number | null };

/**
 * Session-level options, typed for the app owner. Every field is parsed and
 * validated here; `refused` on the command says which ones the app does not
 * consume yet. `model` keeps the old CLI's distinction: null is absent, '' is
 * the bare `-m` that only opens the picker on a TTY.
 */
export type SessionOptions = {
  readonly autoApprove: boolean;
  readonly lite: boolean;
  readonly profile: string | null;
  readonly resumeId: string | null;
  readonly fork: boolean;
  readonly model: string | null;
  readonly provider: string | null;
  readonly reasoning: string | null;
  readonly goal: DurableGoal | null;
  readonly output: OutputOptions;
  readonly ssh: SshTarget | null;
  readonly controlSocket: { readonly name: string | null } | null;
  readonly discordInput: boolean;
};

/** A parsed option the direct app does not consume yet. Its reason names the owner or milestone. */
export type Refusal = { readonly flag: string; readonly reason: string };

export type Command =
  | { readonly kind: 'help' }
  | { readonly kind: 'version' }
  | { readonly kind: 'discord-help' }
  | { readonly kind: 'login'; readonly provider: 'grok' | 'codex' }
  | { readonly kind: 'list-models'; readonly search: string | null; readonly refresh: boolean }
  | { readonly kind: 'list-conversations'; readonly options: SessionOptions }
  | {
      readonly kind: 'headless';
      readonly prompt: string;
      readonly options: SessionOptions;
      readonly refused: Refusal | null;
    }
  | { readonly kind: 'interactive'; readonly options: SessionOptions; readonly refused: Refusal | null }
  | { readonly kind: 'serve'; readonly args: ServeArgs }
  | { readonly kind: 'acp'; readonly args: AcpArgs }
  | { readonly kind: 'control'; readonly valid: boolean; readonly argv: readonly string[] }
  | { readonly kind: 'discord'; readonly argv: readonly string[] };

/**
 * How a flag takes its value. 'required' needs the next token (or `--x=v`).
 * 'next-or-empty' takes the next token unless it starts with `-`, and is ''
 * when none follows: the old CLI's bare `-m`. 'optional' takes only `--x=v`.
 */
type Flag = {
  readonly names: readonly string[];
  readonly label: string;
  readonly help: string;
  readonly value?: 'required' | 'next-or-empty' | 'optional';
  /** Set while the app does not consume this option; the reason names its owner. */
  readonly refusal?: string;
  /** The TUI ignores this option, as the current CLI does, so interactive mode accepts it without refusing. */
  readonly interactiveNoOp?: boolean;
};

/** Builds one flag. `suffix` is its help placeholder: ' <x>' takes a value, '[=<x>]' takes only an inline one. */
const opt = (names: string[], suffix: string, help: string, refusal?: string, value?: Flag['value']): Flag => {
  const kind: Flag['value'] =
    value ?? (suffix.startsWith(' <') ? 'next-or-empty' : suffix.startsWith('[=') ? 'optional' : undefined);
  return { names, label: names.join(', ') + suffix, help, value: kind, refusal };
};

// Order follows the current CLI's Options section (source/cli.tsx).
const FLAGS: readonly Flag[] = [
  opt(['-m', '--model'], ' <model>', 'Model pattern or ID, supports provider/id and optional :<thinking>'),
  opt(['-p', '--provider'], ' <provider>', 'Override the configured provider (e.g. openai, openrouter)'),
  opt(['-r', '--reasoning'], ' <effort>', 'Set reasoning effort (default, none, minimal, low, medium, high, xhigh)'),
  opt(['--goal'], ' <text>', 'Persist a user-authored session outcome (max 2,000 characters)'),
  opt(['--goal-criteria'], ' <text>', 'Optional success criteria (max 2,000 characters; requires --goal)'),
  opt(
    ['--profile'],
    ' <name>',
    'Select a profile (full, bare, plan, pair, mentor, orchestrator; lite = bare)',
    undefined,
    'required',
  ),
  opt(['-l', '--lite'], '', 'Start in the Bare profile (alias kept from Lite)'),
  opt(['--auto-approve'], '', 'Allow tool execution for a non-interactive prompt'),
  // Quiet only changes the non-interactive runner; the TUI ignores it, as the current CLI does.
  opt(['-q', '--quiet'], '', 'Suppress non-error diagnostics on stderr in non-interactive mode'),
  opt(['--show-reasoning'], '', 'Stream reasoning deltas to stderr in non-interactive mode'),
  // The TUI ignores --json (it only affects model-picker eligibility), as the current CLI does.
  {
    names: ['--json'],
    label: '--json',
    help: 'Emit newline-delimited JSON (NDJSON) events in non-interactive mode',
    interactiveNoOp: true,
  },
  opt(['--ssh'], ' <user@host>', 'Enable SSH mode for a remote host'),
  opt(['--discord-input'], '', 'Allow Discord input and explicit root notifications on this control socket'),
  opt(['--remote-dir'], ' <path>', 'Remote working directory (required for non-lite SSH sessions)'),
  opt(['--ssh-port'], ' <port>', 'SSH port (default: 22)'),
  opt(['--control-socket'], '[=<name>]', 'Enable a local socket for the interactive TUI'),
  opt(['--grok-login'], '', 'Log in to Grok in a browser (OAuth) and exit'),
  opt(['--codex-login'], '', 'Log in to Codex/ChatGPT in a browser (OAuth) and exit'),
  opt(
    ['--list-models'],
    ' [search]',
    'Print available models grouped by provider, filtered by an optional search term',
  ),
  opt(['--refresh'], '', 'With --list-models, bypass the model catalog cache and re-fetch before listing'),
  opt(
    ['-R', '--resume'],
    ' [conversation-id|ls]',
    'Resume a native conversation (default: last), or list recent conversations.',
    undefined,
    'next-or-empty',
  ),
  opt(['--fork'], '', 'Fork the resumed conversation into a new session (requires --resume)'),
  opt(['-h', '--help'], '', 'Show help'),
  opt(['-v', '--version'], '', 'Show version'),
];

const FLAG_BY_NAME = new Map(FLAGS.flatMap((flag) => flag.names.map((name) => [name, flag] as const)));
const longName = (flag: Flag): string => flag.names.find((name) => name.startsWith('--')) ?? flag.names[0]!;

const SUBCOMMANDS = new Set(['serve', 'acp', 'control', 'discord']);
const CONTROL_COMMANDS = new Set(['list', 'status', 'get', 'submit', 'steer', 'interrupt', 'wait-turn']);

export const CONTROL_USAGE =
  'Usage: term2 control list [--status] | status <name> [--json] | get <name> <topic> [--json] | submit|steer <name> --id <id> | interrupt <name> | wait-turn <name> --message-id <id>\n';

// Copied from source/services/discord/discord-command.ts, whose module pulls in the old bridge runtime.
export const DISCORD_HELP = `Discord bridge (candidate) — attach existing opted-in terminal sessions.

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

const optionLines = FLAGS.map((flag) => `  ${flag.label.padEnd(38)}${flag.help}${flag.refusal ? ' *' : ''}`).join('\n');

export const HELP = `Usage: term2 [options] [prompt...]
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

The direct CLI supports one prompt per invocation. --resume [conversation-id|last] selects a native conversation;
bare --resume selects the last one for this workspace. Use --resume ls (or list) to browse.
A non-interactive resume requires a follow-up prompt.
* Not available in the direct executable yet. These fail with an error; they never start the current CLI.
`;

/** A usage error the current CLI reports with exit 2 (its argument parser's convention). Other parse errors stay exit 1. */
export class UsageError extends Error {
  readonly exitCode = 2;
}

type RawValue = string | true;

function parseResumeId(value: string): string {
  // References are data, never paths. Unknown safe references get the normal
  // not-found diagnostic; only exact native IDs are opened by discovery.
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error('--resume requires a conversation ID or last');
  return value;
}

function parsePort(value: string | null): number | null {
  if (value === null) return null;
  const port = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('--ssh-port requires a port number in [1, 65535]');
  }
  return port;
}

/** A flag counts as used when it has a value; a bare `--ssh` or `--goal` with no text is not set. */
const isSet = (raw: ReadonlyMap<string, RawValue>, name: string): boolean => raw.has(name) && raw.get(name) !== '';
const textOf = (raw: ReadonlyMap<string, RawValue>, name: string): string | null => {
  const value = raw.get(name);
  return typeof value === 'string' ? value : null;
};

function buildSessionOptions(raw: ReadonlyMap<string, RawValue>): SessionOptions {
  const goalText = textOf(raw, '--goal');
  const criteria = textOf(raw, '--goal-criteria');
  if (criteria !== null && goalText === null) throw new Error('--goal-criteria requires --goal.');
  const resume = textOf(raw, '--resume');
  if (raw.has('--fork') && resume === null) throw new Error('--fork can only be used with --resume.');

  const sshTarget = textOf(raw, '--ssh') || null;
  const remoteDir = textOf(raw, '--remote-dir')?.trim() || null;
  const lite = raw.has('--lite');
  if (sshTarget !== null && remoteDir === null && !lite) throw new Error('--remote-dir is required when using --ssh');

  const control = raw.get('--control-socket');
  return {
    autoApprove: raw.has('--auto-approve'),
    lite,
    profile: textOf(raw, '--profile'),
    resumeId: resume === null || resume === 'ls' || resume === 'list' ? null : parseResumeId(resume || 'last'),
    fork: raw.has('--fork'),
    model: textOf(raw, '--model'),
    provider: textOf(raw, '--provider') || null,
    reasoning: textOf(raw, '--reasoning') || null,
    goal: goalText === null ? null : createDurableGoal(goalText, criteria ?? undefined),
    output: { json: raw.has('--json'), quiet: raw.has('--quiet'), showReasoning: raw.has('--show-reasoning') },
    ssh: sshTarget === null ? null : { target: sshTarget, remoteDir, port: parsePort(textOf(raw, '--ssh-port')) },
    // Bare `--control-socket` leaves the name null, so cli.ts uses the pid. `--control-socket=` is an empty name, which is rejected.
    controlSocket: control === undefined ? null : { name: typeof control === 'string' ? control : null },
    discordInput: raw.has('--discord-input'),
  };
}

/** The first parsed option the app does not consume in this mode. Refusal happens before any side effect. */
function refusalFor(raw: ReadonlyMap<string, RawValue>, mode: 'headless' | 'interactive'): Refusal | null {
  for (const flag of FLAGS) {
    if (!flag.refusal || (mode === 'interactive' && flag.interactiveNoOp)) continue;
    if (isSet(raw, longName(flag))) return { flag: longName(flag), reason: flag.refusal };
  }
  return null;
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

/** Pure: parses argv into one command. Throws on usage errors with the current CLI's messages where they apply. */
export function parseCommandLine(argv: readonly string[]): Command {
  const positional: string[] = [];
  const raw = new Map<string, RawValue>();
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
      if (!flag) throw new UsageError(`Unknown flag: ${token}`);
      if (flag.value === undefined && equals > 0) throw new Error(`${name} does not take a value`);
      let value: RawValue = true;
      if (equals > 0) {
        value = token.slice(equals + 1);
      } else if (flag.value === 'required') {
        const next = argv[index + 1];
        if (next === undefined || next.startsWith('--')) throw new Error(`${name} requires a value`);
        value = next;
        index += 1;
      } else if (flag.value === 'next-or-empty') {
        const next = argv[index + 1];
        if (next !== undefined && !next.startsWith('-')) {
          value = next;
          index += 1;
        } else {
          value = '';
        }
      }
      if (longName(flag) === '--resume' && raw.has('--resume')) throw new Error('--resume may only be specified once');
      raw.set(longName(flag), value);
      continue;
    }
    if (positional.length === 0 && !endOfOptions && SUBCOMMANDS.has(token)) {
      return parseSubcommand(token, argv.slice(index + 1), raw.size > 0);
    }
    positional.push(token);
  }

  if (raw.has('--help')) return { kind: 'help' };
  if (raw.has('--version')) return { kind: 'version' };
  if (raw.has('--grok-login')) return { kind: 'login', provider: 'grok' };
  if (raw.has('--codex-login')) return { kind: 'login', provider: 'codex' };
  if (raw.has('--refresh') && !raw.has('--list-models'))
    throw new Error('--refresh can only be used with --list-models.');
  if (raw.has('--list-models')) {
    if (raw.has('--resume') || raw.has('--fork')) {
      throw new Error('--list-models cannot be combined with --resume or --fork.');
    }
    if (positional.length > 1) throw new Error('--list-models accepts at most one search term.');
    return { kind: 'list-models', search: positional[0]?.trim() || null, refresh: raw.has('--refresh') };
  }

  const prompt = positional.length > 0 ? positional.join(' ').trim() : null;
  // An explicit empty prompt (`term2 ""`) shows help, unless a resume is requested.
  if (prompt === '' && !raw.has('--resume')) return { kind: 'help' };

  const options = buildSessionOptions(raw);
  const resume = textOf(raw, '--resume');
  if (resume === 'ls' || resume === 'list') {
    if (positional.length > 0) throw new Error('--resume ls does not accept a prompt.');
    if (options.fork) throw new Error('--fork cannot be combined with --resume ls.');
    return { kind: 'list-conversations', options };
  }
  if (prompt === null) return { kind: 'interactive', options, refused: refusalFor(raw, 'interactive') };
  return { kind: 'headless', prompt, options, refused: refusalFor(raw, 'headless') };
}
