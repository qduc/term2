import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ExecutionContext } from '../../../src/tools/execution-context.js';
import { ToolApprovalPolicyRegistry } from '../../../src/session/approval/tool-approval-policy-registry.js';
import { createSourceToolRegistry } from '../../../src/app/source-tools.js';
import { SessionAccessState } from '../../../src/session/session/session-access-state.js';
import type { Tool, ToolContext } from '../../../src/tools/index.js';
import { withActiveWorkspaceRoot } from '../../../src/tools/workspace/active-workspace-root.js';
import { createMockSettingsService } from '../../helpers/settings-service.mock.js';
import { createApplyPatchToolDefinition } from '../../../src/tools/file/apply-patch.js';
import { resolveAncillaryModelTier } from '../../../src/session/agent-runtime/model-resolver.js';
import type { AnyToolDefinition } from '../../../src/tools/types.js';
import { buildAgentTools, type AgentFactoryDeps } from '../../../src/app/lib/agent-factory.js';
import { createEditorImpl } from '../../../src/tools/editor-impl.js';

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
  const settings = createMockSettingsService({ 'shell.autoApproveMode': 'off' });
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
        resolveHealingModel: () => resolveAncillaryModelTier('chore', settings),
        settingsService: settings,
        loggingService: logger,
        executionContext,
      }),
    ],
    resolvedModel: 'gpt-6.1-sol',
    shouldUseNativePatchTool: true,
    deps,
  });
  return { cwd, ...adapt([...tools], settings, approvalPolicyRegistry, cwd) };
}

function adapt(
  definitions: AnyToolDefinition[],
  settings: ReturnType<typeof createMockSettingsService>,
  policies: ToolApprovalPolicyRegistry,
  cwd: string,
) {
  const access = new SessionAccessState(settings);
  cleanups.push(() => access.dispose());
  const registry = createSourceToolRegistry(definitions, {
    withWorkspace: (operation) => withActiveWorkspaceRoot(() => cwd, operation),
    policies,
    settings,
    sessionAccess: access,
    sessionId: 'native-patch-test',
    withAnswer: (_answer, operation) => operation(),
  });
  cleanups.push(() => registry.dispose());
  const context: ToolContext = {
    app: {
      workspace: { root: cwd, target: 'local', access: 'read_write' },
      settings: { get: (key) => settings.getDynamic(key) as never, watch: () => () => {} },
    },
    signal: new AbortController().signal,
    progress() {},
    runNested: async () => {
      throw new Error('Unexpected nested run');
    },
  };
  return { tool: registry.get('apply_patch')!, context };
}

async function settle(tool: Tool, context: ToolContext, args: string) {
  try {
    const input = tool.parse(args);
    const approval = await tool.approval(input, context);
    if (approval.kind === 'ask') return { results: [], pending: 1 };
    if (approval.kind !== 'none') throw new Error(`Unexpected approval: ${approval.kind}`);
    const result = await tool.execute(input, context);
    return { results: [result.output], pending: 0 };
  } catch (error) {
    return { results: [String(error)], pending: 0 };
  }
}

describe('native freeform apply_patch through the source tool boundary', () => {
  it('writes the file from a freeform patch script', async () => {
    const { cwd, tool, context } = await nativePatchTool();
    const { results, pending } = await settle(tool, context, PATCH);
    expect(pending).toBe(0);
    expect(results).toEqual(['Created hello.txt']);
    expect(await readFile(join(cwd, 'hello.txt'), 'utf8')).toBe('hi\n');
  });

  it('leaves a delete pending approval', async () => {
    const { cwd, tool, context } = await nativePatchTool();
    await writeFile(join(cwd, 'gone.txt'), 'x\n');
    const patch = ['*** Begin Patch', '*** Delete File: gone.txt', '*** End Patch', ''].join('\n');
    const { results, pending } = await settle(tool, context, patch);
    expect(pending).toBe(1);
    expect(results).toEqual([]);
    expect(await readFile(join(cwd, 'gone.txt'), 'utf8')).toBe('x\n');
  });

  it('reports a malformed freeform patch without asking the model to resend JSON', async () => {
    const { cwd, tool, context } = await nativePatchTool();
    const { results, pending } = await settle(
      tool,
      context,
      '{"operations":[{"type":"create_file","path":"hello.txt","diff":"+hi"}]}',
    );
    expect(pending).toBe(0);
    expect(String(results[0])).toMatch(/Invalid patch/);
    expect(String(results[0])).not.toMatch(/Unrecognized key|Retry with valid JSON/);
    await expect(readFile(join(cwd, 'hello.txt'), 'utf8')).rejects.toThrow();
  });
});
