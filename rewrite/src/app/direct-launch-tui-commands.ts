/**
 * The slash commands no wire command covers by itself. Each one is either a real
 * host or wire operation here, or it fails visibly. `/compact`, `/retry-*`, `/queue`,
 * `/answer`, `/steer`, `/followup` and `/cancel` never arrive here: the TUI sends
 * those itself. A replacement always attaches fresh: this host's connections cannot
 * drop, and a fresh snapshot needs no reasoning about transient state at a cursor.
 */
import { createBridgeCommand } from '../../../source/commands/bridge-command.js';
import { copyToClipboard } from '../../../source/utils/clipboard.js';
import type { DirectConnection } from '../host/in-process-direct-types.js';
import type { TuiConnection, TuiIntegration } from '../clients/tui/integration.js';
import type { WireCommand, WireCommandResult, WireSnapshot } from '../protocol/direct-wire.js';
import type { DirectApplication } from './direct-application.js';
import type { DirectControlBridge } from './direct-launch-control.js';
import { prepareRestart, type DirectRestartPlan } from './direct-launch-tui-restart.js';

type CommandResult = Awaited<ReturnType<TuiIntegration['command']>>;

export type DirectTuiCommandOptions = {
  readonly app: DirectApplication;
  readonly root: string;
  readonly bridge: DirectControlBridge;
  /** The current session as this client last folded it. */
  readonly latest: () => WireSnapshot;
  readonly replace: (connection: DirectConnection) => void | Promise<void>;
  /** The app closes the host, then runs this plan. */
  readonly restart: (plan: DirectRestartPlan) => void;
};

const APPROVAL_MODES = ['off', 'advisory', 'auto', 'always'];

async function send(connection: TuiConnection, command: WireCommand): Promise<Exclude<WireCommandResult, { ok: false }>> {
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
  const { app, root, bridge, latest, replace, restart } = options;
  const { host, principal } = app;

  const settingsOf = (sessionId: string) => {
    const { settings } = app.sessionDetails(sessionId);
    if (!settings) throw new Error('This session has no live runtime.');
    return settings;
  };

  const clear = async (connection: TuiConnection): Promise<CommandResult> => {
    const result = await send(connection, { type: 'reset' });
    if (result.kind !== 'session_changed') throw new Error(`Unexpected reset response: ${result.kind}`);
    await replace(await host.connect(principal, result.sessionId));
    return {};
  };

  const resume = async (sessionId: string | undefined): Promise<CommandResult> => {
    if (sessionId) {
      await replace(await host.connect(principal, sessionId));
      return {};
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

  const rewind = async (connection: TuiConnection, target: string | undefined): Promise<CommandResult> => {
    if (target) {
      await send(connection, { type: 'rewind', targetId: target });
      return {};
    }
    const result = await send(connection, { type: 'list_rewind_targets' });
    if (result.kind !== 'rewind_targets') throw new Error(`Unexpected rewind response: ${result.kind}`);
    const lines = result.targets.map(({ id, label }) => `${id}  ${label}`);
    return { message: lines.length ? lines.join('\n') : 'Nothing to rewind to.' };
  };

  // The bridge command answers exactly once on each path, including its async ones.
  const runBridge = (sessionId: string, args: string): Promise<CommandResult> =>
    new Promise((resolve) => {
      createBridgeCommand({
        getServer: () => bridge.server as never,
        isStartup: bridge.isStartup,
        connect: async (name) => (await bridge.connect(sessionId, name)) as never,
        disconnect: () => bridge.disconnect(),
        getSessionId: () => sessionId,
        addSystemMessage: (message) => resolve({ message }),
      }).action(args);
    });

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
        case 'clear':
          return clear(connection);
        case 'resume':
          return resume(argument);
        case 'model':
          return model(connection, argument);
        case 'effort':
          return effort(connection, argument);
        case 'rewind':
          return rewind(connection, argument);
        case 'bridge':
          return runBridge(connection.sessionId, rest.join(' '));
        case 'copy':
          return copy(argument);
        case 'usage':
          return usage();
        case 'sandbox':
          return sandbox(connection.sessionId);
        case 'auto-approve':
          return autoApprove(connection.sessionId, argument);
        case 'restart':
          if (argument === 'stop') throw new Error('/restart stop needs direct task cancel, which is not available yet.');
          if (argument) throw new Error('Usage: /restart');
          restart(await prepareRestart(latest, app, bridge));
          return { exit: true };
        default:
          throw new Error(`/${name} is not available in the direct executable yet.`);
      }
    },
  };
}
