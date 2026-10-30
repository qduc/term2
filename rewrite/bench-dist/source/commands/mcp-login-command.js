import { runMcpOAuthLogin } from '../services/mcp/mcp-oauth-login.js';
/** Names the user can pass, so a typo gets a list instead of a bare failure. */
const loginableServers = (manager) => manager
    .snapshot()
    .map((server) => server.name)
    .filter((name) => manager.oauthTarget(name) !== undefined);
export function createMcpLoginCommand({ manager, store, addSystemMessage, login = runMcpOAuthLogin, }) {
    return {
        name: 'mcp-login',
        description: 'Authenticate with an OAuth-protected MCP server',
        expectsArgs: true,
        action: (args) => {
            const name = (args ?? '').trim();
            if (!manager || !store) {
                addSystemMessage('No MCP servers are configured in this session.');
                return true;
            }
            const available = loginableServers(manager);
            if (!name) {
                addSystemMessage(available.length
                    ? `Usage: /mcp-login <server>. Servers that can use OAuth: ${available.join(', ')}`
                    : 'Usage: /mcp-login <server>. No configured server can use OAuth.');
                return true;
            }
            const target = manager.oauthTarget(name);
            if (!target) {
                // A project server that has not been opted in also lands here (D2); its
                // snapshot error already spells out the config line to add.
                addSystemMessage(available.length
                    ? `"${name}" cannot use OAuth in this session. Servers that can: ${available.join(', ')}`
                    : `"${name}" cannot use OAuth in this session.`);
                return true;
            }
            addSystemMessage(`Starting OAuth login for MCP server "${name}"…`);
            // Deliberately not awaited: the browser round trip can take minutes and
            // must not block the input loop. Every outcome reports back as a message.
            void (async () => {
                try {
                    const result = await login({
                        serverName: target.serverName,
                        serverUrl: target.serverUrl,
                        store,
                        ...(target.clientMetadataUrl !== undefined ? { clientMetadataUrl: target.clientMetadataUrl } : {}),
                        ...(target.clientId !== undefined ? { clientId: target.clientId } : {}),
                        ...(target.redirectPorts !== undefined ? { redirectPorts: target.redirectPorts } : {}),
                        onAuthorizationUrl: (url) => addSystemMessage(`Open this URL to authorize "${name}":\n${url}`),
                    });
                    addSystemMessage(result.interactive
                        ? `MCP server "${name}" authenticated. Reconnecting…`
                        : `MCP server "${name}" already had a working credential. Reconnecting…`);
                    await manager.reconnect(name);
                    const state = manager.snapshot().find((server) => server.name === name)?.state;
                    addSystemMessage(state === 'ready'
                        ? `MCP server "${name}" is ready.`
                        : `MCP server "${name}" is ${state ?? 'unknown'} after login.`);
                }
                catch (error) {
                    addSystemMessage(`OAuth login for "${name}" failed: ${error instanceof Error ? error.message : String(error)}`);
                }
            })();
            return true;
        },
    };
}
//# sourceMappingURL=mcp-login-command.js.map