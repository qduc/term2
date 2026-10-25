import type { ControlSocketServer } from '../control-socket/control-socket.js';
import { sendDiscord, type DiscordSend, type DiscordSendInput, type DiscordSendResult } from './discord-outbound.js';

/** Creates a root-session sender that has no effect unless a live, opted-in control socket exists. */
export function createFailClosedDiscordSend(
  getServer: () => ControlSocketServer | null,
  runtimeDir: string,
  send: (
    directory: string,
    binding: ControlSocketServer['binding'],
    input: DiscordSendInput,
  ) => Promise<DiscordSendResult> = (directory, binding, input) => sendDiscord(directory, binding, input),
): DiscordSend {
  return async (input: DiscordSendInput) => {
    const server = getServer();
    if (!server || !server.discordInputEnabled) return { requestId: input.requestId, delivery: 'unavailable' };
    return send(runtimeDir, server.binding, input);
  };
}
