/** Explicit outbound root capability bound to the current opted-in socket.
 * Uses only the bridge transport; never posts ordinary final answers automatically.
 */
import {
  sendDiscord,
  type DiscordSend,
  type DiscordSendInput,
  type DiscordSendResult,
} from '../discord/discord-outbound.js';
import type { ControlSocketServer } from './transport.js';

type SendBinding = Pick<ControlSocketServer, 'binding' | 'discordSendEnabled'>;

/** Resolve current binding at invocation, so rebind/detach cannot reuse stale authority. */
export function createFailClosedDiscordSend(
  getServer: () => SendBinding | null,
  runtimeDir: string,
  send: (
    directory: string,
    binding: SendBinding['binding'],
    input: DiscordSendInput,
  ) => Promise<DiscordSendResult> = sendDiscord,
): DiscordSend {
  return async (input) => {
    const server = getServer();
    if (!server || !server.discordSendEnabled) return { requestId: input.requestId, delivery: 'unavailable' };
    return send(runtimeDir, server.binding, input);
  };
}

/** A Session's root/background tools may send only through that Session's live
 * binding. A successor Session never lends its Discord authority to its predecessor.
 */
export function createSessionDiscordSend(
  getServer: () => SendBinding | null,
  runtimeDir: string,
  sessionId: string,
): DiscordSend {
  return createFailClosedDiscordSend(() => {
    const server = getServer();
    return server?.binding.sessionId === sessionId ? server : null;
  }, runtimeDir);
}
