/**
 * The slash commands no wire command covers by itself. Each one is either a real
 * host or wire operation here, or it fails visibly. `/compact`, `/retry-*`, `/queue`,
 * `/answer` and `/cancel` never arrive here: the TUI sends those itself.
 */
import type { DirectConnection } from '../host/in-process-direct-types.js';
import type { TuiConnection, TuiIntegration } from '../clients/tui/integration.js';
import type { WireCommand, WireCommandResult } from '../protocol/direct-wire.js';
import type { DirectApplication } from './direct-application.js';

type CommandResult = Awaited<ReturnType<TuiIntegration['command']>>;

export type DirectTuiCommandOptions = {
  readonly app: DirectApplication;
  readonly root: string;
  readonly replace: (connection: DirectConnection) => void | Promise<void>;
};

async function send(connection: TuiConnection, command: WireCommand): Promise<Exclude<WireCommandResult, { ok: false }>> {
  const result = await connection.send(command);
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result;
}

function configure(configuration: Extract<WireCommand, { type: 'configure' }>['configuration']): WireCommand {
  return { type: 'configure', configuration };
}

export function createDirectTuiCommands({ app, root, replace }: DirectTuiCommandOptions): TuiIntegration {
  const { host, principal } = app;

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
        default:
          throw new Error(`/${name} is not available in the direct executable yet.`);
      }
    },
  };
}
