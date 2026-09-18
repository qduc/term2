import { describe, expect, it, vi } from 'vitest';
import { createMcpLoginCommand } from './mcp-login-command.js';
import type { McpConnectionManager, McpOAuthTarget } from '../services/mcp/mcp-connection-manager.js';
import type { McpServerSnapshot } from '../services/mcp/mcp-tool-source.js';
import type { McpOAuthStore } from '../services/mcp/mcp-oauth-store.js';

const snapshot = (name: string, state: McpServerSnapshot['state']): McpServerSnapshot => ({
  name,
  provenance: 'user',
  transport: 'streamable-http',
  state,
  tools: [],
});

/** A manager stub: only the three members the command actually reaches for. */
function stubManager(options: {
  servers: McpServerSnapshot[];
  targets: Record<string, McpOAuthTarget>;
  stateAfterReconnect?: McpServerSnapshot['state'];
}): { manager: McpConnectionManager; reconnected: string[] } {
  const reconnected: string[] = [];
  let servers = options.servers;
  const manager = {
    snapshot: () => servers,
    oauthTarget: (name: string) => options.targets[name],
    reconnect: async (name: string) => {
      reconnected.push(name);
      servers = servers.map((server) =>
        server.name === name ? { ...server, state: options.stateAfterReconnect ?? 'ready' } : server,
      );
    },
  } as unknown as McpConnectionManager;
  return { manager, reconnected };
}

const store = {} as McpOAuthStore;

/** The command dispatches its flow without awaiting; let those microtasks run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('/mcp-login', () => {
  it('says so plainly when the session has no MCP servers at all', () => {
    const messages: string[] = [];
    const command = createMcpLoginCommand({ manager: null, store: null, addSystemMessage: (m) => messages.push(m) });

    command.action('anything');

    expect(messages).toEqual(['No MCP servers are configured in this session.']);
  });

  it('lists the servers that can use OAuth when called with no argument', () => {
    const messages: string[] = [];
    const { manager } = stubManager({
      servers: [snapshot('linear', 'needs-auth'), snapshot('local', 'ready')],
      targets: { linear: { serverName: 'linear', serverUrl: 'https://mcp.example/linear' } },
    });
    const command = createMcpLoginCommand({ manager, store, addSystemMessage: (m) => messages.push(m) });

    command.action('');

    expect(messages[0]).toContain('Servers that can use OAuth: linear');
    expect(messages[0]).not.toContain('local');
  });

  it('refuses a server that may not use OAuth rather than starting a flow', () => {
    const messages: string[] = [];
    const login = vi.fn();
    const { manager } = stubManager({
      servers: [snapshot('repo-server', 'failed'), snapshot('linear', 'needs-auth')],
      targets: { linear: { serverName: 'linear', serverUrl: 'https://mcp.example/linear' } },
    });
    const command = createMcpLoginCommand({
      manager,
      store,
      addSystemMessage: (m) => messages.push(m),
      login,
    });

    command.action('repo-server');

    expect(login).not.toHaveBeenCalled();
    expect(messages[0]).toContain('cannot use OAuth');
  });

  it('runs the flow, reconnects, and reports the resulting state', async () => {
    const messages: string[] = [];
    const { manager, reconnected } = stubManager({
      servers: [snapshot('linear', 'needs-auth')],
      targets: { linear: { serverName: 'linear', serverUrl: 'https://mcp.example/linear', redirectPorts: [33418] } },
    });
    const login = vi.fn(async () => ({ interactive: true }));
    const command = createMcpLoginCommand({ manager, store, addSystemMessage: (m) => messages.push(m), login });

    command.action('linear');
    await settle();

    expect(login).toHaveBeenCalledWith(
      expect.objectContaining({
        serverName: 'linear',
        serverUrl: 'https://mcp.example/linear',
        redirectPorts: [33418],
      }),
    );
    expect(reconnected).toEqual(['linear']);
    expect(messages.at(-1)).toBe('MCP server "linear" is ready.');
  });

  it('reports a server that is still not ready after a successful login', async () => {
    const messages: string[] = [];
    const { manager } = stubManager({
      servers: [snapshot('linear', 'needs-auth')],
      targets: { linear: { serverName: 'linear', serverUrl: 'https://mcp.example/linear' } },
      stateAfterReconnect: 'failed',
    });
    const command = createMcpLoginCommand({
      manager,
      store,
      addSystemMessage: (m) => messages.push(m),
      login: async () => ({ interactive: true }),
    });

    command.action('linear');
    await settle();

    expect(messages.at(-1)).toBe('MCP server "linear" is failed after login.');
  });

  it('surfaces a failed login instead of leaving the user without an outcome', async () => {
    const messages: string[] = [];
    const { manager, reconnected } = stubManager({
      servers: [snapshot('linear', 'needs-auth')],
      targets: { linear: { serverName: 'linear', serverUrl: 'https://mcp.example/linear' } },
    });
    const command = createMcpLoginCommand({
      manager,
      store,
      addSystemMessage: (m) => messages.push(m),
      login: async () => {
        throw new Error('authorization server refused the client');
      },
    });

    command.action('linear');
    await settle();

    expect(reconnected).toEqual([]);
    expect(messages.at(-1)).toContain('authorization server refused the client');
  });
});
