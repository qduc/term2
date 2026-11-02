/**
 * The slash commands no wire command covers by itself. Each one is either a real
 * host or wire operation here, or it fails visibly. The TUI sends `/compact`, `/retry-*`,
 * `/queue`, `/answer`, `/steer`, `/followup`, `/cancel`, `/clear`, `/rollover` and
 * `/rewind` itself, and calls `switchSession` or `bridge` here for the app's part.
 *
 * A replacement always attaches fresh, so there is no retained cursor: this host's
 * connections cannot drop, and a fresh snapshot needs no reasoning about what
 * transient state a cursor covers.
 */
import { randomUUID } from 'node:crypto';
import { createDurableGoal, formatGoalStatus } from '../../../source/services/conversation/durable-goal.js';
import { composeHandoffMessage } from '../../../source/services/handoff/handoff-flow-reducer.js';
import { formatMcpStatus } from '../../../source/services/mcp/mcp-status.js';
import type { DirectMcp } from './direct-mcp.js';
import { injectSkillIntoTurn } from '../../../source/types/user-turn.js';
import { copyToClipboard } from '../../../source/utils/clipboard.js';
import { isControlSocketName } from '../clients/control/index.js';
import type { DirectConnection } from '../host/in-process-direct-types.js';
import { previewConfirmation, receiptNotice, sendNativeCommand, submitText } from '../clients/tui/commands.js';
import type { BridgeStatus, TuiConnection, TuiIntegration } from '../clients/tui/integration.js';
import type { WireCommand, WireSnapshot } from '../protocol/direct-wire.js';
import type { DirectApplication } from './direct-application.js';
import type { DirectSessionTarget } from './direct-application-target.js';
import type { DirectControlBridge } from './direct-launch-control.js';
import { prepareRestart, type DirectRestartPlan } from './direct-launch-tui-restart.js';
import { createDirectTuiSettings } from './direct-launch-tui-settings.js';

type CommandResult = Awaited<ReturnType<TuiIntegration['command']>>;

export type DirectTuiCommandOptions = {
  readonly app: DirectApplication;
  readonly root: string;
  readonly mcp?: DirectMcp;
  readonly onMcpAuthorizationUrl?: (url: string) => void;
  readonly bridge: DirectControlBridge;
  readonly remote?: DirectSessionTarget['restart'];
  /** The current session as this client last folded it. */
  readonly latest: () => WireSnapshot;
  /** Shows this connection. Control has already moved or closed, so the two never disagree. */
  readonly publish: (connection: DirectConnection) => void;
  /** The app closes the host, then runs this plan. */
  readonly restart: (plan: DirectRestartPlan) => void;
};

type Configuration = Extract<WireCommand, { type: 'configure' }>['configuration'];

/**
 * One typed command, one id, sent once. The notice names the id, because a pending
 * or lost reply is read back with `/command-status`, never by sending it again.
 */
async function configure(connection: TuiConnection, configuration: Configuration): Promise<CommandResult> {
  const command = { type: 'configure', commandId: randomUUID(), configuration } as const;
  return { message: receiptNotice(await sendNativeCommand(connection, command)) };
}

function parseModel(reference: string | undefined): { provider: string; model: string } {
  const separator = reference?.indexOf('/') ?? -1;
  if (!reference || separator <= 0) throw new Error('Use <provider>/<model>.');
  return { provider: reference.slice(0, separator), model: reference.slice(separator + 1) };
}

function assistantTexts(snapshot: WireSnapshot): readonly string[] {
  return snapshot.messages
    .filter((message) => message.role === 'assistant')
    .map((message) => message.text)
    .filter((text) => text.length > 0);
}

export function createDirectTuiCommands(options: DirectTuiCommandOptions): TuiIntegration {
  const { app, root, bridge, remote, latest, publish, restart } = options;
  const { host, principal } = app;

  const configuration = createDirectTuiSettings(app, latest);

  const resume = async (sessionId: string | undefined): Promise<CommandResult> => {
    if (sessionId && sessionId !== 'ls') {
      return { sessionId };
    }
    const { sessions } = await host.listSessions(principal);
    const here = sessions.filter((session) => session.workspace.root === root).map((session) => session.id);
    return { message: here.length ? here.join('\n') : 'No direct sessions in this workspace.' };
  };

  const model = async (connection: TuiConnection, reference: string | undefined): Promise<CommandResult> => {
    if (!reference)
      return {
        message: 'Choose a model: enter <provider>/<model>.',
        draft: { text: '/model ', attachments: [] },
      };
    return configure(connection, { model: parseModel(reference) });
  };

  const effort = async (connection: TuiConnection, value: string | undefined): Promise<CommandResult> => {
    if (!value)
      return {
        message: 'Choose reasoning effort: default, none, minimal, low, medium, high, xhigh.',
        draft: { text: '/effort ', attachments: [] },
      };
    return configure(connection, { reasoning: value as NonNullable<Configuration['reasoning']> });
  };

  /** `/goal`, with the same arguments as today. A failed update is a message, not an error. */
  const goal = async (sessionId: string, input: string): Promise<CommandResult> => {
    const [action, ...parts] = input.trim().split(/\s+/);
    const empty = 'No durable goal is set. Use /goal set <outcome> [--criteria <text>].';
    const write = async (next: Parameters<typeof formatGoalStatus>[0]): Promise<CommandResult> => {
      await app.setGoal(sessionId, next, 'user');
      return { message: formatGoalStatus(next) };
    };
    try {
      if (!action || action === 'show') {
        const current = await app.goal(sessionId);
        return { message: current ? formatGoalStatus(current) : empty };
      }
      if (action === 'set') {
        const text = parts.join(' ');
        const marker = text.indexOf(' --criteria ');
        const outcome = marker < 0 ? text : text.slice(0, marker);
        const criteria = marker < 0 ? undefined : text.slice(marker + ' --criteria '.length);
        return await write(createDurableGoal(outcome, criteria));
      }
      if (action === 'achieved' || action === 'abandon') {
        const current = await app.goal(sessionId);
        if (!current) throw new Error('No durable goal is set. Use /goal set <outcome> first.');
        return await write({ ...current, status: action === 'achieved' ? 'achieved' : 'abandoned' });
      }
      return { message: 'Usage: /goal [show|set <outcome> [--criteria <text>]|achieved|abandon]' };
    } catch (error) {
      return { message: `Goal update failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  };

  const bridgeStatus = (): BridgeStatus => {
    const { server, isStartup } = bridge;
    return {
      sessionId: latest().sessionId,
      startup: isStartup,
      attachment: server
        ? { name: server.name, socketPath: server.socketPath, discordInputEnabled: server.discordInputEnabled }
        : null,
    };
  };

  const copy = async (argument: string | undefined): Promise<CommandResult> => {
    const back = argument === undefined ? 1 : Number(argument);
    if (!Number.isSafeInteger(back) || back < 1) {
      throw new Error('Copy response number must be a positive whole number, e.g. /copy 2.');
    }
    const texts = assistantTexts(latest());
    const text = texts[texts.length - back];
    if (text === undefined) return { message: 'No assistant response to copy.' };
    await copyToClipboard(text);
    return { message: 'Copied to clipboard.' };
  };

  const usage = (): CommandResult => {
    const { inputTokens, outputTokens, cachedInputTokens } = latest().usage;
    return { message: `Input ${inputTokens}, cached ${cachedInputTokens}, output ${outputTokens} tokens.` };
  };

  /** A skill always belongs to a request, so naming one alone hands the line back to finish. */
  const skills = async (connection: TuiConnection, input: string): Promise<CommandResult> => {
    if (remote) return { message: 'Skills are read from this machine, so they are not available over SSH.' };
    const [, name, request] = /^\/skills(?:\s+(\S+)(?:\s+([\s\S]*))?)?$/.exec(input.trim()) ?? [];
    const available = app.skills(root);
    if (!name) {
      const list = available.map((skill) => `${skill.name}: ${skill.description}`);
      return { message: list.length ? list.join('\n') : 'No skills found.' };
    }
    const skill = available.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
    if (!skill) return { message: `Unknown skill: "${name}". Use /skills to list them.` };
    if (!request) {
      return {
        message: `Skill "${skill.name}": type your request after it.`,
        draft: { text: `/skills ${skill.name} `, attachments: [] },
      };
    }
    const { name: skillName, description, body } = skill;
    const turn = { text: request, skill: { name: skillName, description, body } };
    const injected = injectSkillIntoTurn(turn).text;
    // Hand the expanded request back as an ordinary draft; Enter then confirms like any other send.
    // Enter already cleared the typed line: if the preview itself fails, hand it back instead of losing it.
    let held: string | null;
    try {
      held = await previewConfirmation(connection, injected);
    } catch (error) {
      return {
        message: error instanceof Error ? error.message : String(error),
        draft: { text: input.trim(), attachments: [] },
      };
    }
    if (held !== null)
      return {
        message: `${held} Not sent; the request is in the input box.`,
        draft: { text: injected, attachments: [] },
      };
    await submitText(connection, injected);
    return {};
  };

  const handoff = async (connection: TuiConnection, input: string): Promise<CommandResult> => {
    const captured = assistantTexts(latest()).at(-1);
    if (captured === undefined) return { message: 'No assistant response available to hand off.' };
    const args = input.trim().slice('/handoff'.length).trim();
    const [first] = args.split(/\s+/);
    const named = first?.includes('/') ? parseModel(first) : undefined;
    const handoffMessage = (named ? args.slice(first!.length) : args).trim() || undefined;
    const text = composeHandoffMessage({
      capturedText: captured,
      stage: 'selecting_model',
      ...(handoffMessage ? { handoffMessage } : {}),
    });
    return { sessionId: await app.handoff(connection.sessionId, named, text) };
  };

  const requireMcp = (): DirectMcp => {
    if (remote) throw new Error('MCP servers are not available over SSH in this executable.');
    if (!options.mcp) throw new Error('MCP is not enabled for this application.');
    return options.mcp;
  };

  return {
    async command(connection, input) {
      const [name, ...rest] = input.trim().slice(1).split(/\s+/);
      const argument = rest[0];
      switch (name) {
        case 'help':
          return {
            message: [
              'Commands',
              '/help — Show commands and keyboard shortcuts',
              '/quit, /exit — Exit the application',
              '/restart [stop] — Reload this executable; stop consents to stopping background work',
              '/resume [ls|session], /clear, /rollover — List, open or start a conversation',
              '/model [<provider>/<model>], /effort [<level>], /profile [<name>] — Configure the session; omit the argument to finish it in the composer',
              '/settings, /auto-approve, /sandbox, /usage, /goal, /skills, /handoff, /copy',
              '/compact, /retry-turn, /retry-tool, /rewind — Context and recovery',
              '/queue, /steer, /followup, /cancel, /tasks, /answer, /bridge — Work and input',
              '/command-status <id>, /command-apply <id> — Inspect or apply a command result',
              'Keyboard shortcuts',
              'Enter send/steer · Alt+Enter follow-up · ↑/↓ history · PgUp/PgDn scroll',
              'Ctrl+G approvals · Ctrl+B budget · Ctrl+C clear input/cancel/exit',
            ].join('\n'),
          };
        case 'quit':
        case 'exit':
          return { exit: true };
        case 'resume':
          return resume(argument);
        case 'model':
          return model(connection, argument);
        case 'effort':
          return effort(connection, argument);
        case 'copy':
          return copy(argument);
        case 'usage':
          return usage();
        case 'sandbox':
          return configuration.sandbox(connection);
        case 'auto-approve':
          return configuration.autoApprove(connection, argument);
        case 'settings':
          return configuration.settings(connection, rest.join(' '));
        case 'plan':
        case 'bare':
        case 'mentor':
        case 'orchestrator':
          return configuration.toggle(connection, name);
        case 'profile':
          return configuration.profile(connection, argument);
        case 'skills':
          return skills(connection, input);
        case 'handoff':
          return handoff(connection, input);
        case 'mcp':
          return { message: formatMcpStatus(requireMcp().status()) };
        case 'mcp-login': {
          if (!argument || rest.length !== 1) throw new Error('Usage: /mcp-login <server>');
          const server = await requireMcp().login(argument, options.onMcpAuthorizationUrl);
          return { message: `MCP server "${server.name}" is ${server.state}.` };
        }
        case 'goal':
          return goal(connection.sessionId, input.trim().slice('/goal'.length));
        case 'restart':
          if (argument && argument !== 'stop') throw new Error('Usage: /restart [stop]');
          restart(
            await prepareRestart(
              latest,
              app,
              bridge,
              remote,
              argument === 'stop' ? (sent) => connection.send(sent) : undefined,
            ),
          );
          return { exit: true };
        default:
          throw new Error(`/${name} is not available in the direct executable yet.`);
      }
    },
    async switchSession(sessionId) {
      // Native rollover rotates the backing log, not this attached logical Session.
      if (sessionId === latest().sessionId) return;
      const next = await host.connect(principal, sessionId);
      // The session has really changed by now, so the client follows it even if control cannot.
      const failure = await bridge.rebind(sessionId).then(
        () => undefined,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      publish(next);
      return failure === undefined ? undefined : { message: failure };
    },
    bridge: {
      status: async () => bridgeStatus(),
      async connect(name) {
        if (!isControlSocketName(name))
          throw new Error('Invalid bridge socket name. Use 1–64 letters, digits, _ or -.');
        await bridge.connect(latest().sessionId, name);
        return bridgeStatus();
      },
      async disconnect() {
        if (bridge.isStartup) throw new Error('This startup control socket cannot be disconnected at runtime.');
        await bridge.disconnect();
        return bridgeStatus();
      },
    },
  };
}
