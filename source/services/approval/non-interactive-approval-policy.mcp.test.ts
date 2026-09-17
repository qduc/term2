import { describe, expect, it } from 'vitest';
import { runWithSession } from '../../non-interactive.js';
import type { McpToolSource } from '../mcp/mcp-tool-source.js';

const source: McpToolSource = {
  snapshot: () => [
    {
      name: 'a',
      provenance: 'user',
      transport: 'stdio',
      state: 'ready',
      tools: [
        { name: 'x', inputSchema: {} },
        { name: 'y', inputSchema: {} },
      ],
    },
    { name: 'b', provenance: 'user', transport: 'stdio', state: 'ready', tools: [{ name: 'y', inputSchema: {} }] },
  ],
  callTool: async () => ({ content: [], isError: false }),
  onCatalogChanged: () => () => {},
};

async function decide(toolName: string, allowlist?: readonly string[], mcp = true): Promise<string> {
  let answer = 'unset';
  const session = {
    async sendMessage() {
      return { type: 'approval_required' as const, approval: { agentName: 'test', toolName, argumentsText: '{}' } };
    },
    async handleApprovalDecision(value: string) {
      answer = value;
      return { type: 'response' as const, finalText: 'done', commandMessages: [] };
    },
  };
  await runWithSession(session as any, {
    prompt: 'test',
    autoApprove: true,
    mcpAllowlist: allowlist,
    mcpToolSource: mcp ? source : undefined,
  });
  return answer;
}

describe('non-interactive MCP allowlist wiring', () => {
  it('scopes wildcard entries to their server', async () => {
    expect(await decide('a__x', ['a/*'])).toBe('y');
    expect(await decide('b__y', ['a/*'])).toBe('n');
  });

  it('allows exactly one member for an exact entry', async () => {
    expect(await decide('a__x', ['a/x'])).toBe('y');
    expect(await decide('a__y', ['a/x'])).toBe('n');
  });

  it('denies empty, absent, and malformed entries', async () => {
    for (const allowlist of [undefined, [], ['a'], ['/x'], ['a/x/y'], ['']]) {
      expect(await decide('a__x', allowlist)).toBe('n');
    }
  });

  it('does not classify a non-MCP double-underscore tool as MCP', async () => {
    expect(await decide('ordinary__tool', [], false)).toBe('y');
  });
});
