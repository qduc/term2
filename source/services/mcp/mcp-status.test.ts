import { describe, expect, it } from 'vitest';
import { formatMcpNotice, formatMcpStatus, isActionableMcpState } from './mcp-status.js';
import type { McpServerSnapshot } from './mcp-tool-source.js';

const server = (over: Partial<McpServerSnapshot> = {}): McpServerSnapshot => ({
  name: 'linear',
  provenance: 'user',
  transport: 'streamable-http',
  state: 'ready',
  tools: [],
  ...over,
});

describe('formatMcpStatus', () => {
  it('names the config file when nothing is configured, since no UI defines servers', () => {
    const out = formatMcpStatus({ snapshots: [], userConfigPath: '/home/u/.config/term2/mcp.json' });
    expect(out).toContain('No MCP servers are configured.');
    expect(out).toContain('/home/u/.config/term2/mcp.json');
    expect(out).toContain('.mcp.json');
  });

  it('reports each server with a human state and a tool count when ready', () => {
    const out = formatMcpStatus({
      snapshots: [
        server({ name: 'fs', state: 'ready', tools: [{ name: 'read', inputSchema: {} }] as never }),
        server({ name: 'other', state: 'ready', tools: [] }),
      ],
    });
    expect(out).toContain('MCP servers (2):');
    expect(out).toContain('1 tool');
    expect(out).toContain('0 tools');
  });

  it('translates needs-auth into a login instruction naming every affected server', () => {
    const out = formatMcpStatus({
      snapshots: [server({ name: 'linear', state: 'needs-auth' }), server({ name: 'sentry', state: 'needs-auth' })],
    });
    expect(out).toContain('needs login');
    expect(out).toContain('/mcp-login <server> to authenticate: linear, sentry');
  });

  it('omits the login hint when nothing needs one', () => {
    expect(formatMcpStatus({ snapshots: [server({ state: 'ready' })] })).not.toContain('/mcp-login');
  });

  it('puts a long error on its own line so it cannot wrap into the columns', () => {
    const out = formatMcpStatus({
      snapshots: [server({ state: 'failed', error: 'add `"projectServers": { ... }` to the user mcp.json' })],
    });
    const errorLine = out.split('\n').find((l) => l.includes('projectServers'));
    expect(errorLine?.trim().startsWith('linear')).toBe(false);
  });
});

describe('formatMcpNotice', () => {
  it('announces the states a user can act on, carrying the remedy verbatim', () => {
    expect(
      formatMcpNotice(server({ state: 'needs-auth', error: 'requires OAuth login — run /mcp-login linear' })),
    ).toBe('MCP server "linear" needs login: requires OAuth login — run /mcp-login linear');
    expect(formatMcpNotice(server({ state: 'failed', error: 'process exited' }))).toContain('failed: process exited');
  });

  it('stays quiet for states that need no action', () => {
    expect(formatMcpNotice(server({ state: 'ready' }))).toBeUndefined();
    expect(formatMcpNotice(server({ state: 'connecting' }))).toBeUndefined();
  });

  it('agrees with isActionableMcpState', () => {
    expect(isActionableMcpState('needs-auth')).toBe(true);
    expect(isActionableMcpState('failed')).toBe(true);
    expect(isActionableMcpState('ready')).toBe(false);
    expect(isActionableMcpState('connecting')).toBe(false);
  });
});
