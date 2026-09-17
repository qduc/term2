import { describe, expect, it, vi } from 'vitest';
import { createRunCodeToolDefinition, getRunCodeExecutionResult } from './run-code.js';
import { createMcpCatalog, mcpMemberName } from './mcp-script-surface.js';
import { ToolApprovalPolicyRegistry } from '../../../services/approval/tool-approval-policy-registry.js';
import type { ILoggingService } from '../../../services/service-interfaces.js';
import { McpCallError, type McpServerSnapshot, type McpToolSource } from '../../../services/mcp/mcp-tool-source.js';
import { McpConnectionManager } from '../../../services/mcp/mcp-connection-manager.js';
import type { ResolvedMcpServerConfig } from '../../../services/mcp/mcp-config.js';
import { resolve } from 'node:path';

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

const source = (
  callTool: McpToolSource['callTool'],
  description = descriptor.description,
  snapshots: readonly McpServerSnapshot[] = [
    {
      name: 'remote-server',
      provenance: 'user',
      transport: 'streamable-http',
      state: 'ready',
      tools: [{ ...descriptor, description }],
    },
  ] as const,
): McpToolSource => ({
  snapshot: () => snapshots,
  callTool,
  onCatalogChanged: () => vi.fn(),
});

const make = (
  mcpToolSource: McpToolSource,
  approval = new ToolApprovalPolicyRegistry(),
  getToolRegistry: () => readonly any[] = () => [],
) =>
  createRunCodeToolDefinition({
    loggingService: logging(),
    getToolRegistry,
    getCwd: () => process.cwd(),
    approvalPolicyRegistry: approval,
    mcpToolSource,
  });

const execute = (tool: ReturnType<typeof make>, code: string) =>
  tool.execute({ code, description: 'mcp test', timeout_ms: 10_000 }, { signal: new AbortController().signal });

const executeWith = (tool: ReturnType<typeof make>, code: string, signal: AbortSignal) =>
  tool.execute(
    { code, description: 'mcp test', timeout_ms: 10_000 },
    { signal },
    { toolCall: { callId: 'review-call' } },
  );

describe('run_code MCP script surface', () => {
  it('runs a real stdio fixture call from a script through the connection manager', async () => {
    const manager = new McpConnectionManager({
      servers: [
        {
          name: 'fx',
          provenance: 'user',
          transport: 'stdio',
          command: process.execPath,
          args: [resolve(import.meta.dirname, '../../../services/mcp/test-fixtures/stdio-fixture.mjs')],
        } satisfies ResolvedMcpServerConfig,
      ],
    });
    manager.start();
    await manager.whenSettled();
    const approval = new ToolApprovalPolicyRegistry();
    const runCode = make(manager, approval);
    void runCode.description;
    approval.register({ toolName: 'fx__echo', needsApproval: () => false });
    try {
      const rendered = await executeWith(
        runCode,
        "return await tools.fx__echo({ message: 'from-script' });",
        new AbortController().signal,
      );
      expect(String(rendered)).toContain('from-script');
    } finally {
      await manager.close();
    }
  });
  it('keeps MCP members script-only while rendering a compact catalog', () => {
    const runCode = make(source(vi.fn()));
    expect(runCode.name).toBe('run_code');
    expect(runCode.description).toContain('remote-server: ready, 1 tool');
    expect(runCode.description).toContain('remote_server__echo_tool');
    expect(runCode.description).not.toContain('tools.remote_server__echo_tool(');
    expect(runCode.description).not.toContain('value: string');
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
    const rendered = await executeWith(
      runCode,
      "return await tools.remote_server__echo_tool({ value: 'hello' });",
      new AbortController().signal,
    );
    const output = String(rendered);
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
    const rendered = await executeWith(
      runCode,
      "return await tools.remote_server__echo_tool({ value: 'x' }).catch((error) => ({ caught: true, message: String(error), hasResult: 'result' in error }));",
      new AbortController().signal,
    );
    const output = String(rendered);
    expect(output).toContain('"caught":true');
    expect(output).toContain('tools.remote_server__echo_tool failed: bad input');
    expect(output).toContain('"hasResult":false');
    expect(getRunCodeExecutionResult(rendered)?.calls.at(-1)?.outcome).toBe('error');

    const transportApproval = new ToolApprovalPolicyRegistry();
    const transportRun = make(
      source(async () => {
        throw new McpCallError('timeout', 'server call timed out');
      }),
      transportApproval,
    );
    void transportRun.description;
    transportApproval.register({ toolName: 'remote_server__echo_tool', needsApproval: () => false });
    const transportRendered = await executeWith(
      transportRun,
      "return await tools.remote_server__echo_tool({ value: 'x' }).catch((error) => ({ caught: true, message: String(error), hasResult: 'result' in error }));",
      new AbortController().signal,
    );
    expect(String(transportRendered)).toContain('[timeout] server call timed out');
    expect(String(transportRendered)).toContain(
      'tools.remote_server__echo_tool failed: [timeout] server call timed out',
    );
    expect(getRunCodeExecutionResult(transportRendered)?.calls.at(-1)?.outcome).toBe('error');
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

  it('sanitizes names and omits both sides of MCP collisions', () => {
    expect(mcpMemberName('1st-server', 'a.b')).toBe('_1st_server__a_b');
    const one = { ...descriptor, name: 'a.b' };
    const two = { ...descriptor, name: 'a-b' };
    const catalog = createMcpCatalog(
      source(vi.fn(), descriptor.description, [
        { name: '1st-server', provenance: 'user', transport: 'stdio', state: 'ready', tools: [one] },
        { name: '1st_server', provenance: 'user', transport: 'stdio', state: 'ready', tools: [two] },
      ]),
      new Set(['built-in']),
    );
    expect(catalog.tools).toHaveLength(0);
    expect(catalog.collisions).toHaveLength(1);
    const runCode = make(
      source(vi.fn(), descriptor.description, [
        { name: '1st-server', provenance: 'user', transport: 'stdio', state: 'ready', tools: [one] },
        { name: '1st_server', provenance: 'user', transport: 'stdio', state: 'ready', tools: [two] },
      ]),
    );
    expect(runCode.description).toContain('collision:');
  });

  it('omits an MCP member colliding with a built-in name', () => {
    const catalog = createMcpCatalog(source(vi.fn()), new Set(['remote_server__echo_tool']));
    expect(catalog.tools).toHaveLength(0);
    expect(catalog.collisions[0]).toContain('built-in tool');
    expect(
      make(source(vi.fn()), new ToolApprovalPolicyRegistry(), () => [{ name: 'remote_server__echo_tool' } as any])
        .description,
    ).toContain('collision:');
  });

  it('renders connecting and failed servers without members and bounds failure text', () => {
    const longError = 'e'.repeat(500);
    const runCode = make(
      source(vi.fn(), descriptor.description, [
        { name: 'connecting', provenance: 'user', transport: 'stdio', state: 'connecting', tools: [] },
        {
          name: 'failed\n-injected',
          provenance: 'user',
          transport: 'stdio',
          state: 'failed',
          error: `${longError}\n-injected`,
          tools: [],
        },
      ]),
    );
    expect(runCode.description).toContain('connecting: connecting, 0 tools');
    expect(runCode.description).toContain('failed -injected: failed, 0 tools');
    expect(runCode.description).toContain(`[server-provided error] ${longError.slice(0, 160)}`);
    expect(runCode.description).not.toContain('\n-injected');
    expect(runCode.description).not.toContain('e'.repeat(161));
  });

  it('summarizes non-text content and preserves abort propagation', async () => {
    const controller = new AbortController();
    let receivedSignal!: AbortSignal;
    let started!: () => void;
    const dispatchStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const callTool = vi.fn(async (_server, _tool, _args, options) => {
      receivedSignal = options.signal;
      started();
      await new Promise<void>((resolve) => options.signal.addEventListener('abort', () => resolve(), { once: true }));
      throw new Error('aborted');
    });
    const approval = new ToolApprovalPolicyRegistry();
    const runCode = make(source(callTool), approval);
    void runCode.description;
    approval.register({ toolName: 'remote_server__echo_tool', needsApproval: () => false });
    const pending = executeWith(
      runCode,
      "return await tools.remote_server__echo_tool({ value: 'x' });",
      controller.signal,
    );
    await dispatchStarted;
    controller.abort();
    await expect(pending).resolves.toBeDefined();
    expect(receivedSignal.aborted).toBe(true);
    const textSource = source(async () => ({ content: [{ type: 'image' }], isError: false }));
    const textRun = make(textSource, new ToolApprovalPolicyRegistry());
    void textRun.description;
    const textApproval = new ToolApprovalPolicyRegistry();
    const textRunWithApproval = make(textSource, textApproval);
    void textRunWithApproval.description;
    textApproval.register({ toolName: 'remote_server__echo_tool', needsApproval: () => false });
    expect(
      String(await execute(textRunWithApproval, "return await tools.remote_server__echo_tool({ value: 'x' });")),
    ).toContain('[image content omitted]');
  });

  it('does not mutate the provider-facing registry', async () => {
    const root: any[] = [];
    const runCode = createRunCodeToolDefinition({
      loggingService: logging(),
      getToolRegistry: () => root,
      getCwd: () => process.cwd(),
      approvalPolicyRegistry: new ToolApprovalPolicyRegistry(),
      mcpToolSource: source(vi.fn()),
    });
    void runCode.description;
    await execute(runCode, "return await tools.remote_server__echo_tool({ value: 'x' }).catch(() => null);");
    expect(root).toHaveLength(0);
    expect(root.some((tool) => tool.name === 'remote_server__echo_tool')).toBe(false);
  });
});
