import { sendDiscord } from './discord-outbound.js';
/** Creates a root-session sender that has no effect unless a live, opted-in control socket exists. */
export function createFailClosedDiscordSend(getServer, runtimeDir, send = (directory, binding, input) => sendDiscord(directory, binding, input)) {
    return async (input) => {
        const server = getServer();
        if (!server || !server.discordInputEnabled)
            return { requestId: input.requestId, delivery: 'unavailable' };
        return send(runtimeDir, server.binding, input);
    };
}
//# sourceMappingURL=discord-send-capability.js.map