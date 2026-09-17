import { describe, expect, it, vi } from 'vitest';
import { createRunCodeToolDefinition } from './run-code.js';
import { ToolApprovalPolicyRegistry } from '../../../services/approval/tool-approval-policy-registry.js';
import type { ILoggingService } from '../../../services/service-interfaces.js';
import type { McpToolSource } from '../../../services/mcp/mcp-tool-source.js';

const logging = (): ILoggingService =>
  ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), security: vi.fn() } as unknown as ILoggingService);

const descriptor = {
  name: 'echo-tool',
  description: 'A server-authored description that should only appear in describe output.',
  inputSchema: {
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value'],
  },
  annotations: { readOnlyHint: true },
};

const source = (callTool: McpToolSource['callTool'], description = descriptor.description): McpToolSource => ({
  snapshot: () => [
    {
      name: 'remote-server',
      provenance: 'user',
      transport: 'streamable-http',
      state: 'ready',
      tools: [{ ...descriptor, description }],
    },
  ],
  callTool,
  onCatalogChanged: () => vi.fn(),
});

const make = (mcpToolSource: McpToolSource, approval = new ToolApprovalPolicyRegistry()) =>
  createRunCodeToolDefinition({
    loggingService: logging(),
    getToolRegistry: () => [],
    getCwd: () => process.cwd(),
    approvalPolicyRegistry: approval,
    mcpToolSource,
  });

const execute = (tool: ReturnType<typeof make>, code: string) =>
  tool.execute({ code, description: 'mcp test', timeout_ms: 10_000 }, { signal: new AbortController().signal });

describe('run_code MCP script surface', () => {
  it('keeps MCP members script-only while rendering a compact catalog', () => {
    const runCode = make(source(vi.fn()));
    expect(runCode.name).toBe('run_code');
    expect(runCode.description).toContain('remote-server: ready, 1 tool');
    expect(runCode.description).toContain('remote_server__echo_tool');
    expect(runCode.description).not.toContain('server-authored description');
  });

  it('calls a ready MCP tool through the policy registry and returns structured content', async () => {
    const callTool = vi.fn(async () => ({
      content: [{ type: 'text', text: 'ignored' }],
      structuredContent: { ok: 7 },
      isError: false,
    }));
    const approval = new ToolApprovalPolicyRegistry();
    const runCode = make(source(callTool), approval);
    void runCode.description;
    approval.register({ toolName: 'remote_server__echo_tool', needsApproval: () => false });
    const evaluate = vi.spyOn(approval, 'evaluate');
    const output = String(await execute(runCode, "return await tools.remote_server__echo_tool({ value: 'hello' });"));
    expect(output).toContain('"ok":7');
    expect(callTool).toHaveBeenCalledWith(
      'remote-server',
      'echo-tool',
      { value: 'hello' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(evaluate).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'remote_server__echo_tool' }));
  });

  it('validates required and primitive arguments before approval or server call', async () => {
    const callTool = vi.fn();
    const approval = new ToolApprovalPolicyRegistry();
    const runCode = make(source(callTool), approval);
    const output = String(await execute(runCode, 'return await tools.remote_server__echo_tool({ value: 3 });'));
    expect(output).toContain('Invalid parameters');
    expect(callTool).not.toHaveBeenCalled();
  });

  it('returns server errors as a script-visible failure envelope', async () => {
    const approval = new ToolApprovalPolicyRegistry();
    const runCode = make(
      source(async () => ({ content: [{ type: 'text', text: 'bad input' }], isError: true })),
      approval,
    );
    void runCode.description;
    approval.register({ toolName: 'remote_server__echo_tool', needsApproval: () => false });
    const output = String(await execute(runCode, "return await tools.remote_server__echo_tool({ value: 'x' });"));
    expect(output).toContain('"ok":false');
    expect(output).toContain('bad input');
  });

  it('denies an MCP call when approval is required but no nested owner is present', async () => {
    const approval = new ToolApprovalPolicyRegistry();
    const runCode = make(source(vi.fn()), approval);
    const output = String(await execute(runCode, "return await tools.remote_server__echo_tool({ value: 'x' });"));
    expect(output).toContain('requires approval');
  });

  it('describes original names and caps server-provided text', async () => {
    const longDescription = 'x'.repeat(3000);
    const runCode = make(source(vi.fn(), longDescription));
    const output = String(await execute(runCode, "return await tools.describe('remote_server__echo_tool');"));
    expect(output).toContain('"server":"remote-server"');
    expect(output).toContain('"tool":"echo-tool"');
    expect(output).not.toContain(longDescription);
  });
});
