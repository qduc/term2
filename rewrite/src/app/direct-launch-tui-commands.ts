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
import { createDurableGoal, formatGoalStatus } from '../../../source/services/conversation/durable-goal.js';
import { copyToClipboard } from '../../../source/utils/clipboard.js';
import { isControlSocketName } from '../clients/control/index.js';
import type { DirectConnection } from '../host/in-process-direct-types.js';
import type { BridgeStatus, TuiConnection, TuiIntegration } from '../clients/tui/integration.js';
import type { WireCommand, WireCommandResult, WireSnapshot } from '../protocol/direct-wire.js';
import type { DirectApplication } from './direct-application.js';
import type { DirectSessionTarget } from './direct-application-target.js';
import type { DirectControlBridge } from './direct-launch-control.js';
import { prepareRestart, type DirectRestartPlan } from './direct-launch-tui-restart.js';

type CommandResult = Awaited<ReturnType<TuiIntegration['command']>>;

export type DirectTuiCommandOptions = {
  readonly app: DirectApplication;
  readonly root: string;
  readonly bridge: DirectControlBridge;
  readonly remote?: DirectSessionTarget['restart'];
  /** The current session as this client last folded it. */
  readonly latest: () => WireSnapshot;
  /** Shows this connection. Control has already moved or closed, so the two never disagree. */
  readonly publish: (connection: DirectConnection) => void;
  /** The app closes the host, then runs this plan. */
  readonly restart: (plan: DirectRestartPlan) => void;
};

const APPROVAL_MODES = ['off', 'advisory', 'auto', 'always'];

async function send(
  connection: TuiConnection,
  command: WireCommand,
): Promise<Exclude<WireCommandResult, { ok: false }>> {
  const result = await connection.send(command);
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result;
}

function configure(configuration: Extract<WireCommand, { type: 'configure' }>['configuration']): WireCommand {
  return { type: 'configure', configuration };
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

  const settingsOf = (sessionId: string) => {
    const { settings } = app.sessionDetails(sessionId);
    if (!settings) throw new Error('This session has no live runtime.');
    return settings;
  };

  const resume = async (sessionId: string | undefined): Promise<CommandResult> => {
    if (sessionId) {
      return { sessionId };
    }
    const { sessions } = await host.listSessions(principal);
    const here = sessions.filter((session) => session.workspace.root === root).map((session) => session.id);
    return { message: here.length ? here.join('\n') : 'No direct sessions in this workspace.' };
  };

  const model = async (connection: TuiConnection, reference: string | undefined): Promise<CommandResult> => {
    const separator = reference?.indexOf('/') ?? -1;
    if (!reference || separator <= 0) throw new Error('Use /model <provider>/<model>.');
    const selected = { provider: reference.slice(0, separator), model: reference.slice(separator + 1) };
    await send(connection, configure({ model: selected }));
    return {};
  };

  const effort = async (connection: TuiConnection, value: string | undefined): Promise<CommandResult> => {
    if (!value) throw new Error('Use /effort <level>.');
    const reasoning = value as NonNullable<Parameters<typeof configure>[0]['reasoning']>;
    await send(connection, configure({ reasoning }));
    return {};
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

  const sandbox = (sessionId: string): CommandResult => {
    const settings = settingsOf(sessionId);
    const enabled = settings.get('sandbox.enabled') !== true;
    settings.set('sandbox.enabled', enabled, { persist: false });
    return { message: `Shell sandbox ${enabled ? 'enabled' : 'disabled'} for this session.` };
  };

  const autoApprove = (sessionId: string, mode: string | undefined): CommandResult => {
    if (!mode || !APPROVAL_MODES.includes(mode)) throw new Error(`Use /auto-approve ${APPROVAL_MODES.join('|')}.`);
    settingsOf(sessionId).set('shell.autoApproveMode', mode as never, { persist: false });
    return { message: `Tool auto-approval set to ${mode} for this session.` };
  };

  return {
    async command(connection, input) {
      const [name, ...rest] = input.trim().slice(1).split(/\s+/);
      const argument = rest[0];
      switch (name) {
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
          return sandbox(connection.sessionId);
        case 'auto-approve':
          return autoApprove(connection.sessionId, argument);
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
