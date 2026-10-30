/** How a state reads to a human, rather than the protocol-facing name. */
const STATE_LABEL = {
    connecting: 'connecting',
    ready: 'ready',
    'needs-auth': 'needs login',
    failed: 'failed',
};
/** States a user can do something about; the ones worth interrupting them for. */
const ACTIONABLE = new Set(['needs-auth', 'failed']);
export const isActionableMcpState = (state) => ACTIONABLE.has(state);
const toolCount = (server) => server.state === 'ready' ? `${server.tools.length} tool${server.tools.length === 1 ? '' : 's'}` : '';
/**
 * One line per server for `/mcp`.
 *
 * The error is kept on its own continuation line: opt-in errors embed a JSON
 * snippet and would otherwise hard-wrap into the middle of the next column.
 */
const formatMcpServerLines = (server) => {
    const head = [
        `  ${server.name}`,
        `[${STATE_LABEL[server.state]}]`,
        toolCount(server),
        `(${server.provenance} ${server.transport})`,
    ]
        .filter(Boolean)
        .join('  ');
    return server.error ? [head, `      ${server.error}`] : [head];
};
/**
 * The whole `/mcp` body.
 *
 * With no servers this is the only place the config file is ever named, so it
 * doubles as the answer to "how do I add one?" — the plan deliberately ships no
 * settings UI for MCP.
 */
export const formatMcpStatus = (view) => {
    if (view.snapshots.length === 0) {
        return [
            'No MCP servers are configured.',
            view.userConfigPath ? `Add them under "mcpServers" in ${view.userConfigPath}` : '',
            'A project can also define them in .mcp.json at the workspace root.',
        ]
            .filter(Boolean)
            .join('\n');
    }
    const lines = [`MCP servers (${view.snapshots.length}):`];
    for (const server of view.snapshots)
        lines.push(...formatMcpServerLines(server));
    const needLogin = view.snapshots.filter((s) => s.state === 'needs-auth').map((s) => s.name);
    if (needLogin.length) {
        lines.push('', `Run /mcp-login <server> to authenticate: ${needLogin.join(', ')}`);
    }
    return lines.join('\n');
};
/**
 * The announcement for a server that has just settled somewhere the user must
 * act, or `undefined` when the state needs no attention.
 *
 * `error` already carries the remedy (the `/mcp-login` instruction, or the exact
 * config line for an opt-in), so it is surfaced verbatim rather than re-worded.
 */
export const formatMcpNotice = (server) => {
    if (!isActionableMcpState(server.state))
        return undefined;
    return server.error
        ? `MCP server "${server.name}" ${STATE_LABEL[server.state]}: ${server.error}`
        : `MCP server "${server.name}" ${STATE_LABEL[server.state]}.`;
};
//# sourceMappingURL=mcp-status.js.map