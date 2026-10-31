/**
 * The control socket on an interactive session, and the two standalone control
 * clients. Discord talks only to a control socket, so it needs no host here.
 */
import path from 'node:path';
import { stderr, stdout } from 'node:process';
import { installationVersion } from '../../../source/providers/fetch/logging-middleware.js';
import { runControlCommand, runDiscordBridge, startDirectControlSocket } from '../clients/control/index.js';
import { reduceWireEvent } from '../protocol/direct-reducer.js';
import type { DirectApplication } from './direct-application.js';
import type { DirectControlSocketRequest } from './direct-launch-types.js';

export type DirectControlAttachment = {
  rebind(sessionId: string): Promise<void>;
  close(): Promise<void>;
};

type ControlTarget = DirectControlSocketRequest & {
  readonly conversationsDir: string;
  readonly root: string;
  readonly sessionId: string;
};

/**
 * A control socket is optional on an interactive session, so failing to open one
 * is reported and the session carries on, as it does today.
 */
export async function attachControlSocket(
  app: DirectApplication,
  target: ControlTarget,
): Promise<{ readonly attachment: DirectControlAttachment | null; readonly notice: string }> {
  const { conversationsDir, root, sessionId, name, discordInput } = target;
  const createdAt = new Date().toISOString();
  try {
    const attachment = await startDirectControlSocket({
      host: app.host,
      principal: app.principal,
      sessionId,
      name,
      discordInput,
      reduceEvent: reduceWireEvent,
      metadata: (snapshot) => ({
        workspaceRoot: root,
        version: installationVersion,
        createdAt,
        logPath: path.join(conversationsDir, `${snapshot.sessionId}.jsonl`),
      }),
      sendSteer: (connection, submission) =>
        connection.send({ type: 'submit', ...submission, delivery: 'steer' }),
    });
    return { attachment, notice: `Control socket on: ${name} (pid ${process.pid})` };
  } catch (error) {
    return {
      attachment: null,
      notice: `Control socket off: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function launchControl(argv: readonly string[]): Promise<number> {
  return runControlCommand([...argv], stdout, stderr);
}

/** The bridge owns and awaits its own signal lifecycle, so this installs none. */
export async function launchDiscord(argv: readonly string[]): Promise<number> {
  await runDiscordBridge([...argv]);
  return 0;
}
