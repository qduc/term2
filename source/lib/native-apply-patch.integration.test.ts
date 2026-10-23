import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ExecutionContext } from '../services/execution-context.js';
import { ToolApprovalPolicyRegistry } from '../services/approval/tool-approval-policy-registry.js';
import { ApprovalLedger } from '../services/agent-runtime/tool-invocation-context.js';
import { ToolCallExecution } from '../services/agent-runtime/tool-call-execution.js';
import { createMockSettingsService } from '../services/settings/settings-service.mock.js';
import { createApplyPatchToolDefinition } from '../tools/file/apply-patch.js';
import type { AnyToolDefinition } from '../tools/types.js';
import { buildAgentTools, type AgentFactoryDeps } from './agent-factory.js';
import { createEditorImpl } from './editor-impl.js';

const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  security() {},
  setCorrelationId() {},
  getCorrelationId: () => undefined,
  clearCorrelationId() {},
};

const cleanups: Array<() => Promise<unknown> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const PATCH = ['*** Begin Patch', '*** Add File: hello.txt', '+hi', '*** End Patch', ''].join('\n');

async function nativePatchTool() {
  const cwd = await mkdtemp(join(tmpdir(), 'term2-native-patch-'));
  cleanups.push(() => rm(cwd, { recursive: true, force: true }));
  const settings = createMockSettingsService({ 'shell.autoApproveMode': 'always' });
  const executionContext = ExecutionContext.pin(cwd);
  const approvalPolicyRegistry = new ToolApprovalPolicyRegistry();
  const deps: AgentFactoryDeps = {
    settings,
    logger,
    executionContext,
    approvalPolicyRegistry,
    editor: createEditorImpl({ settingsService: settings, loggingService: logger, executionContext }),
    providerId: 'codex',
    serviceTierOverrideForNextRequest: null,
    createMentor: async () => '',
    runSubagent: async () => ({ finalText: '' }),
    runSubagentAsync: async () => ({ runId: 'unused', status: 'running' }),
    getSubagentResult: async () => ({}),
    sendSubagentMessage: () => ({}),
    cancelSubagentRun: () => ({}),
    checkToolInterceptors: async () => null,
  };
  const tools = buildAgentTools({
    toolDefinitions: [
      createApplyPatchToolDefinition({
        settingsService: settings,
        loggingService: logger,
        executionContext,
      }),
    ],
    resolvedModel: 'gpt-6.1-sol',
    shouldUseNativePatchTool: true,
    deps,
  });
  return { cwd, tool: tools.find((tool) => tool.name === 'apply_patch')! };
}

async function settle(tool: AnyToolDefinition, args: string) {
  const approvals = new ApprovalLedger();
  const results: unknown[] = [];
  const execution = new ToolCallExecution({});
  const context = {
    tools: [tool],
    approvals,
    toolContext: { context: {}, approvals },
    onCall() {},
    onDispatch() {},
    onExecutionStarted() {},
    onToolStall() {},
    onResult(_entry: unknown, result: unknown) {
      results.push(result);
    },
  };
  await execution.plan(
    [{ type: 'tool_call', id: 'call-1', name: tool.name, arguments: args, toolType: 'custom' }],
    context,
  );
  await execution.settle(context);
  return { results, pending: execution.pendingApprovals.length };
}

describe('native freeform apply_patch through the run loop', () => {
  it('writes the file from a freeform patch script', async () => {
    const { cwd, tool } = await nativePatchTool();
    const { results, pending } = await settle(tool, PATCH);
    expect(pending).toBe(0);
    expect(results).toEqual(['Created hello.txt']);
    expect(await readFile(join(cwd, 'hello.txt'), 'utf8')).toBe('hi\n');
  });

  it('leaves a delete pending approval', async () => {
    const { cwd, tool } = await nativePatchTool();
    await writeFile(join(cwd, 'gone.txt'), 'x\n');
    const patch = ['*** Begin Patch', '*** Delete File: gone.txt', '*** End Patch', ''].join('\n');
    const { results, pending } = await settle(tool, patch);
    expect(pending).toBe(1);
    expect(results).toEqual([]);
    expect(await readFile(join(cwd, 'gone.txt'), 'utf8')).toBe('x\n');
  });

  it('reports a malformed freeform patch without asking the model to resend JSON', async () => {
    const { cwd, tool } = await nativePatchTool();
    const { results, pending } = await settle(
      tool,
      '{"operations":[{"type":"create_file","path":"hello.txt","diff":"+hi"}]}',
    );
    expect(pending).toBe(0);
    expect(String(results[0])).toMatch(/Invalid patch/);
    expect(String(results[0])).not.toMatch(/Unrecognized key/);
    await expect(readFile(join(cwd, 'hello.txt'), 'utf8')).rejects.toThrow();
  });

  it('rejects a parser that returns a shape the tool schema does not accept', async () => {
    let executed = false;
    const schema = z.object({ patch: z.string() }).strict();
    const tool: AnyToolDefinition = {
      name: 'apply_patch',
      description: 'fixture',
      parameters: schema,
      canonicalParameters: schema,
      needsApproval: async () => false,
      parseModelArguments: () => ({ operations: [] }),
      execute: async () => {
        executed = true;
        return 'ran';
      },
      formatCommandMessage: () => [],
    };
    const { results, pending } = await settle(tool, '*** Begin Patch\n*** End Patch\n');
    expect(pending).toBe(0);
    expect(executed).toBe(false);
    expect(String(results[0])).toMatch(/harness defect/);
    expect(String(results[0])).not.toMatch(/Retry with valid JSON/);
  });
});
