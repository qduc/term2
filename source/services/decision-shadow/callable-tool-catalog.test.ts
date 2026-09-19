import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AnyToolDefinition } from '../../tools/types.js';
import {
  bindRunCodeRegistry,
  createRunCodeToolDefinition,
  RUN_CODE_EXPOSED_TOOLS,
} from '../../tools/system/run-code/run-code.js';
import type { McpToolSource } from '../mcp/mcp-tool-source.js';
import { ToolApprovalPolicyRegistry } from '../approval/tool-approval-policy-registry.js';
import { snapshotCallableToolCatalog } from './callable-tool-catalog.js';

const tool = (name: string): AnyToolDefinition => ({
  name,
  description: `${name} description`,
  parameters: z.object({ path: z.string().optional() }),
  canRequireApproval: false,
  needsApproval: () => false,
  execute: () => undefined,
  formatCommandMessage: () => [],
});

it('snapshots the real bound run_code registry with ready and collision-filtered MCP tools', () => {
  const source: McpToolSource = {
    snapshot: () => [
      {
        name: 'browser',
        provenance: 'user',
        transport: 'stdio',
        state: 'ready',
        tools: [
          { name: 'open-page', description: 'Open a page', inputSchema: { type: 'object' } },
          { name: 'search', description: 'Collides with a built-in', inputSchema: { type: 'object' } },
        ],
      },
      {
        name: 'offline',
        provenance: 'project',
        transport: 'stdio',
        state: 'failed',
        error: 'unavailable',
        tools: [{ name: 'ignored', inputSchema: { type: 'object' } }],
      },
    ],
    callTool: async () => ({ content: [], isError: false }),
    onCatalogChanged: () => () => undefined,
  };
  const runCode = createRunCodeToolDefinition({
    loggingService: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      security: vi.fn(),
      setCorrelationId: vi.fn(),
      getCorrelationId: vi.fn(),
      clearCorrelationId: vi.fn(),
    },
    approvalPolicyRegistry: new ToolApprovalPolicyRegistry(),
    mcpToolSource: source,
  }) as unknown as AnyToolDefinition & { readonly [RUN_CODE_EXPOSED_TOOLS]: readonly AnyToolDefinition[] };
  const search = tool('browser__search');
  const tools = [tool('shell'), search, runCode];
  bindRunCodeRegistry(tools);

  const catalog = snapshotCallableToolCatalog([tool('shell'), runCode]);

  expect(catalog.map(({ name, callPath, source: sourceKind }) => ({ name, callPath, source: sourceKind }))).toEqual([
    { name: 'shell', callPath: 'direct', source: 'builtin' },
    { name: 'run_code', callPath: 'direct', source: 'builtin' },
    { name: 'browser__search', callPath: 'run_code', source: 'builtin' },
    { name: 'browser__open_page', callPath: 'run_code', source: 'mcp' },
  ]);
  expect(catalog[3]).toMatchObject({
    server: 'browser',
    originalTool: 'open-page',
    description: expect.stringContaining('Open a page'),
  });
  expect(catalog.find((entry) => entry.name === 'run_code')?.approval).toBe('possible');
  expect(catalog.every((entry) => entry.parameters && entry.approval)).toBe(true);
  expect(runCode[RUN_CODE_EXPOSED_TOOLS].map((entry) => entry.name)).toEqual(['browser__search', 'browser__open_page']);
  expect(snapshotCallableToolCatalog([])).toEqual([]);
});
