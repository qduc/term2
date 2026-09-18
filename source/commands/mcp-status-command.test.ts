import { describe, expect, it, vi } from 'vitest';
import { createMcpStatusCommand } from './mcp-status-command.js';
import { resolveSlashCommand } from '../slash-commands.js';
import type { McpConnectionManager } from '../services/mcp/mcp-connection-manager.js';
import type { McpServerSnapshot } from '../services/mcp/mcp-tool-source.js';

const managerWith = (snapshots: McpServerSnapshot[]): McpConnectionManager =>
  ({ snapshot: () => snapshots } as unknown as McpConnectionManager);

const server = (name: string, state: McpServerSnapshot['state'], error?: string): McpServerSnapshot => ({
  name,
  provenance: 'user',
  transport: 'streamable-http',
  state,
  tools: [],
  ...(error !== undefined ? { error } : {}),
});

describe('/mcp', () => {
  it('opens the interactive manager when the UI supplies one', () => {
    const openMcpMenu = vi.fn();
    const addSystemMessage = vi.fn();
    createMcpStatusCommand({ manager: null, addSystemMessage, openMcpMenu }).action();
    expect(openMcpMenu).toHaveBeenCalledOnce();
    expect(addSystemMessage).not.toHaveBeenCalled();
  });
  it('shows the config path when no manager was composed at all', () => {
    const messages: string[] = [];
    createMcpStatusCommand({
      manager: null,
      userConfigPath: '/home/u/mcp.json',
      addSystemMessage: (m) => messages.push(m),
    }).action();
    expect(messages[0]).toContain('No MCP servers are configured.');
    expect(messages[0]).toContain('/home/u/mcp.json');
  });

  it('lists servers with their state, including why one is unusable', () => {
    const messages: string[] = [];
    createMcpStatusCommand({
      manager: managerWith([server('linear', 'needs-auth', 'run /mcp-login linear'), server('fs', 'ready')]),
      addSystemMessage: (m) => messages.push(m),
    }).action();
    expect(messages[0]).toContain('linear');
    expect(messages[0]).toContain('needs login');
    expect(messages[0]).toContain('run /mcp-login linear');
    expect(messages[0]).toContain('fs');
  });

  it('resolves /mcp to status and /mcp-login to login, despite the shared prefix', () => {
    // resolveSlashCommand prefix-matches, so "mcp" would be ambiguous were it
    // not for the exact-match pass that runs first.
    const status = createMcpStatusCommand({ manager: null, addSystemMessage: vi.fn() });
    const login = { name: 'mcp-login', description: '', action: () => true };
    const all = [status, login];
    expect(resolveSlashCommand(all, 'mcp')?.name).toBe('mcp');
    expect(resolveSlashCommand(all, 'mcp-login')?.name).toBe('mcp-login');
    expect(resolveSlashCommand(all, 'mcp-')?.name).toBe('mcp-login');
  });
});
