import { describe, expect, it } from 'vitest';
import { TurnStableMcpToolSource } from './turn-stable-mcp-tool-source.js';
import type { McpServerSnapshot, McpToolSource } from './mcp-tool-source.js';

const server = (name: string): McpServerSnapshot => ({
  name,
  provenance: 'user',
  transport: 'stdio',
  state: 'ready',
  tools: [],
});

describe('TurnStableMcpToolSource', () => {
  it('freezes a catalog within a turn and refreshes at the next boundary', () => {
    let current = [server('first')];
    const listeners = new Set<() => void>();
    const live: McpToolSource = {
      snapshot: () => current,
      callTool: async () => ({ content: [], isError: false }),
      onCatalogChanged: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const source = new TurnStableMcpToolSource(live);
    current = [server('second')];
    listeners.forEach((listener) => listener());
    expect(source.snapshot()[0]?.name).toBe('first');
    source.beginTurn();
    expect(source.snapshot()[0]?.name).toBe('second');
    source.dispose();
  });
});
