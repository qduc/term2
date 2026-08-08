import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApplicationRunLoop, type ApplicationAgent } from '../agent-runtime/application-run-loop.js';
import { NestedSubagentRunner } from './nested-runner.js';
import type { BackgroundSubagentApprovalPause } from './foreground-subagent-lease.js';
import { getSubagentRunContext, type SubagentRunContext } from './tool-policy.js';
import { ApprovalLedger, type ToolInvocationContext } from '../agent-runtime/tool-invocation-context.js';
import { ToolOwnershipRegistry } from '../approval/tool-ownership-registry.js';
import type { SubagentToolFactory } from './tool-policy.js';
import type { SubagentDefinition } from './types.js';
import type { ConversationEvent } from '../conversation/conversation-events.js';
import type { ToolDefinition } from '../../tools/types.js';
import {
  createMockLogger,
  createMockSettings,
  createSessionContextService,
  registerTestProvider,
} from './test-helpers/subagent-manager-fixtures.js';

function workerDefinition(providerId: string): SubagentDefinition {
  return {
    role: 'worker',
    name: 'worker',
    instructions: 'You are a worker. Update the notes file.',
    canRead: true,
    canWrite: true,
    canSearchWeb: false,
    canRunShell: false,
    maxTurns: 8,
    model: 'nested-model',
    provider: providerId,
    reasoningEffort: 'default',
  };
}

/**
 * Builds a NestedSubagentRunner wired to a scripted provider whose model runs
 * `fake_tool` once and then finishes with a summary message. The fake tool
 * records its run through the SubagentRunContext — the bookkeeping that was
 * inert before the ToolInvocationContext slot (F2).
 */
function buildNestedRunner(
  options: {
    /** Make the nested tool pause for approval, so the nested run interrupts. */
    needsApproval?: boolean;
    /** Override the role's turn budget. */
    maxTurns?: number;
    /** Override the role's provider output-token cap. */
    maxTokens?: number;
    /** Script a model that never stops calling tools, so only a budget ends it. */
    alwaysCallsTool?: boolean;
    /** Fail the exact continuation after an approved child tool. */
    failAfterApproval?: boolean;
    onEvent?: (event: ConversationEvent) => void;
    onBackgroundApprovalPause?: (pause: BackgroundSubagentApprovalPause) => void;
  } = {},
) {
  let first = true;
  let call = 0;
  const requests: any[] = [];
  const providerId = registerTestProvider({
    label: 'Nested scripted provider',
    createStreamedModel: () => ({
      async *stream(request: any) {
        requests.push(request);
        if (options.failAfterApproval && request.input.some((item: any) => item.type === 'tool_result')) {
          throw new Error('late nested provider failure');
        }
        if (options.alwaysCallsTool) {
          call++;
          yield { type: 'tool_call', id: `nested-call-${call}`, name: 'fake_tool', arguments: '{"path":"notes.md"}' };
          yield { type: 'completion', responseId: `resp-${call}`, output: [] };
        } else if (first) {
          first = false;
          yield { type: 'tool_call', id: 'nested-call-1', name: 'fake_tool', arguments: '{"path":"notes.md"}' };
          yield { type: 'completion', responseId: 'resp-1', output: [] };
        } else {
          yield {
            type: 'completion',
            responseId: 'resp-2',
            output: [{ type: 'message', content: [{ type: 'text', text: 'Summary: updated notes.' }] }],
          };
        }
      },
    }),
    fetchModels: async () => [{ id: 'nested-model' }],
  });

  const fakeTool: ToolDefinition = {
    name: 'fake_tool',
    description: 'Fake tool that records its run through the subagent context',
    parameters: z.object({ path: z.string() }),
    needsApproval: () => options.needsApproval ?? false,
    formatCommandMessage: () => [],
    execute: async (_params: any, context: unknown) => {
      const runContext = getSubagentRunContext(context);
      runContext?.filesChanged.push('notes.md');
      if (runContext) runContext.toolCounts.fake_tool = (runContext.toolCounts.fake_tool ?? 0) + 1;
      return 'Updated notes.md';
    },
  };

  const stubToolFactory = {
    buildToolDefinitions: () => [fakeTool],
    buildAgentTools: () => [fakeTool],
  } as unknown as SubagentToolFactory;

  const runner = new NestedSubagentRunner({
    logger: createMockLogger(),
    settings: createMockSettings({ 'agent.model': 'nested-model', 'agent.provider': providerId }),
    sessionContextService: createSessionContextService(),
    toolFactory: stubToolFactory,
    roleToolCache: new Map(),
    resolveRole: () => ({
      ...workerDefinition(providerId),
      ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
      ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
    }),
    toolOwnership: new ToolOwnershipRegistry(),
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
    ...(options.onBackgroundApprovalPause ? { backgroundApprovalPauseSink: options.onBackgroundApprovalPause } : {}),
  });

  return { runner, providerId, requests };
}

function parentToolContext(): ToolInvocationContext<SubagentRunContext> {
  return {
    context: {
      agentId: 'parent-agent',
      role: 'explorer',
      task: 'delegate',
      filesChanged: [],
      toolCounts: {},
      activeCommandMessages: {},
      turnCount: 0,
      maxTurns: 8,
    },
    approvals: new ApprovalLedger(),
  };
}

function nestedAgent(needsApproval: boolean, calls: string[]): ApplicationAgent {
  return {
    name: 'nested-test-agent',
    instructions: 'Use the nested tool.',
    model: 'nested-model',
    tools: [
      {
        name: 'nested_tool',
        description: 'A nested tool.',
        parameters: z.object({ value: z.string() }),
        needsApproval: () => needsApproval,
        execute: (_params, _context, details) => {
          calls.push((details as any)?.toolCall?.callId ?? 'missing');
          return 'ok';
        },
        formatCommandMessage: () => [],
      },
    ],
  };
}

describe('ApplicationRunLoop nested tool', () => {
  it('executes a nested application-owned tool with a stable call ID', async () => {
    const calls: string[] = [];
    const loop = new ApplicationRunLoop({
      resolveModel: async () => ({
        async *stream(request) {
          if (request.input.some((item) => item.type === 'tool_result')) {
            yield {
              type: 'completion',
              responseId: 'response-2',
              output: [{ type: 'message', content: [{ type: 'text', text: 'done' }] }],
            };
          } else {
            const call = { id: 'nested-call-1', name: 'nested_tool', arguments: '{"value":"x"}' };
            yield { type: 'tool_call', ...call };
            yield { type: 'completion', responseId: 'response-1', output: [{ type: 'tool_call', ...call }] };
          }
        },
      }),
    });
    const stream = loop.startStream(nestedAgent(false, calls), 'delegate');
    await stream.completed;
    expect(calls).toEqual(['nested-call-1']);
    expect(stream.finalOutput).toBe('done');
  });

  it('pauses and resumes an application-owned nested tool approval', async () => {
    const calls: string[] = [];
    const loop = new ApplicationRunLoop({
      resolveModel: async () => ({
        async *stream(request) {
          if (request.input.some((item) => item.type === 'tool_result')) {
            yield {
              type: 'completion',
              responseId: 'response-2',
              output: [{ type: 'message', content: [{ type: 'text', text: 'approved' }] }],
            };
          } else {
            const call = { id: 'nested-call-approval', name: 'nested_tool', arguments: '{"value":"x"}' };
            yield { type: 'tool_call', ...call };
            yield { type: 'completion', responseId: 'response-1', output: [{ type: 'tool_call', ...call }] };
          }
        },
      }),
    });
    const stream = loop.startStream(nestedAgent(true, calls), 'delegate');
    await stream.completed;
    expect(stream.interruptions).toHaveLength(1);
    const handle = stream.state!;
    handle.approve?.(stream.interruptions![0]);
    const resumed = loop.continueRunStream(handle);
    await resumed.completed;
    expect(calls).toEqual(['nested-call-approval']);
    expect(resumed.finalOutput).toBe('approved');
  });
});

describe('NestedSubagentRunner end to end', () => {
  it('publishes an adopted pause through the session sink and resumes only through its application callback', async () => {
    const pauses: BackgroundSubagentApprovalPause[] = [];
    const events: ConversationEvent[] = [];
    const { runner } = buildNestedRunner({
      needsApproval: true,
      onEvent: (event) => events.push(event),
      onBackgroundApprovalPause: (pause) => pauses.push(pause),
    });

    const foreground = runner.runAsTool({ role: 'worker', task: 'update notes' }, parentToolContext(), {
      toolCall: { callId: 'transferred-pause-sink' },
    });
    const lease = runner.getForegroundLease('transferred-pause-sink')!;
    lease.adopt();
    await expect(foreground).resolves.toMatchObject({ status: 'running', agentId: 'transferred-pause-sink' });
    await vi.waitFor(() => expect(pauses).toHaveLength(1));

    const [pause] = pauses;
    expect(pause).toMatchObject({ runId: 'transferred-pause-sink', role: 'worker', generation: 1 });
    expect(
      pause.apply(({ handle, interruption }) => {
        handle.approve?.(interruption);
        return true;
      }),
    ).toBe(true);

    await vi.waitFor(() =>
      expect(events.find((event) => event.type === 'subagent_completed' && event.async === true)).toMatchObject({
        result: { agentId: 'transferred-pause-sink', status: 'completed' },
      }),
    );
    expect(pause.apply(() => true)).toBe(false);
  });

  it('turns a synchronous retained-loop launch failure into one durable adopted terminal without retaining the pause', async () => {
    const pauses: BackgroundSubagentApprovalPause[] = [];
    const events: ConversationEvent[] = [];
    const { runner } = buildNestedRunner({
      needsApproval: true,
      onEvent: (event) => events.push(event),
      onBackgroundApprovalPause: (pause) => pauses.push(pause),
    });
    const foreground = runner.runAsTool({ role: 'worker', task: 'update notes' }, parentToolContext(), {
      toolCall: { callId: 'transferred-resume-throw' },
    });
    const lease = runner.getForegroundLease('transferred-resume-throw')!;
    lease.adopt();
    await expect(foreground).resolves.toMatchObject({ status: 'running' });
    await vi.waitFor(() => expect(pauses).toHaveLength(1));
    const resumeError = new Error('continuation launch failed');
    const continueRunStream = vi.spyOn(ApplicationRunLoop.prototype, 'continueRunStream').mockImplementationOnce(() => {
      throw resumeError;
    });

    expect(
      pauses[0]!.apply(({ handle, interruption }) => {
        handle.approve?.(interruption);
        return true;
      }),
    ).toBe(true);
    continueRunStream.mockRestore();
    expect(lease.getPendingApproval()).toBeUndefined();

    await vi.waitFor(() =>
      expect(events.filter((event) => event.type === 'subagent_completed' && event.async === true)).toMatchObject([
        expect.objectContaining({
          result: expect.objectContaining({
            agentId: 'transferred-resume-throw',
            status: 'failed',
            error: 'continuation launch failed',
          }),
        }),
      ]),
    );
    expect(events.filter((event) => event.type === 'subagent_completed' && event.async === true)).toHaveLength(1);
  });

  it('emits one async terminal failure when an adopted continuation rejects', async () => {
    const events: ConversationEvent[] = [];
    const { runner } = buildNestedRunner({
      needsApproval: true,
      failAfterApproval: true,
      onEvent: (event) => events.push(event),
    });

    const foreground = runner.runAsTool({ role: 'worker', task: 'update notes' }, parentToolContext(), {
      toolCall: { callId: 'transferred-failure' },
    });
    const lease = runner.getForegroundLease('transferred-failure')!;
    lease.adopt();
    await expect(foreground).resolves.toMatchObject({ status: 'running', agentId: 'transferred-failure' });
    await vi.waitFor(() => expect(lease.getPendingApproval()).toBeDefined());
    const pending = lease.getPendingApproval()!;
    expect(
      lease.applyBackgroundApproval(pending, ({ handle, interruption }) => {
        handle.approve?.(interruption);
        return true;
      }),
    ).toBe(true);

    await vi.waitFor(() =>
      expect(events.filter((event) => event.type === 'subagent_completed' && event.async === true)).toHaveLength(1),
    );
    expect(events.find((event) => event.type === 'subagent_completed' && event.async === true)).toMatchObject({
      result: { agentId: 'transferred-failure', status: 'failed', error: 'late nested provider failure' },
    });
  });

  it('emits one async cancellation when an adopted approval pause is stopped', async () => {
    const events: ConversationEvent[] = [];
    const { runner } = buildNestedRunner({ needsApproval: true, onEvent: (event) => events.push(event) });
    const foreground = runner.runAsTool({ role: 'worker', task: 'update notes' }, parentToolContext(), {
      toolCall: { callId: 'transferred-stop' },
    });
    const lease = runner.getForegroundLease('transferred-stop')!;
    lease.adopt();
    await expect(foreground).resolves.toMatchObject({ status: 'running' });
    await vi.waitFor(() => expect(lease.getPendingApproval()).toBeDefined());
    lease.cancel();
    await vi.waitFor(() =>
      expect(events.filter((event) => event.type === 'subagent_completed' && event.async === true)).toHaveLength(1),
    );
    expect(events.find((event) => event.type === 'subagent_completed' && event.async === true)).toMatchObject({
      result: { agentId: 'transferred-stop', status: 'cancelled' },
    });
  });

  it('settles an adopted run when its fulfilled tool result is an error string', async () => {
    const events: ConversationEvent[] = [];
    const { runner } = buildNestedRunner({ onEvent: (event) => events.push(event) });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const tool = runner.getRoleAgentTool('worker') as any;
    tool.execute = async () => {
      await gate;
      return 'An error occurred while running the tool. Please try again. Error: fulfilled nested failure';
    };

    const foreground = runner.runAsTool({ role: 'worker', task: 'update notes' }, parentToolContext(), {
      toolCall: { callId: 'transferred-fulfilled-error' },
    });
    const lease = runner.getForegroundLease('transferred-fulfilled-error')!;
    lease.adopt();
    await expect(foreground).resolves.toMatchObject({ status: 'running' });
    release();

    await vi.waitFor(() =>
      expect(events.filter((event) => event.type === 'subagent_completed' && event.async === true)).toHaveLength(1),
    );
    expect(events.find((event) => event.type === 'subagent_completed' && event.async === true)).toMatchObject({
      result: { agentId: 'transferred-fulfilled-error', status: 'failed', error: 'fulfilled nested failure' },
    });
  });

  it('runs a nested role tool, executes a tool, and returns a parseable SubagentResult with filesChanged and toolsUsed (F1 pin)', async () => {
    const { runner } = buildNestedRunner();

    const result = await runner.runAsTool({ role: 'worker', task: 'update notes' }, parentToolContext(), {
      toolCall: { callId: 'parent-call-1' },
    });

    expect(result).toMatchObject({
      role: 'worker',
      status: 'completed',
      finalText: 'Summary: updated notes.',
      filesChanged: ['notes.md'],
      toolsUsed: [{ toolName: 'fake_tool', count: 1 }],
    });
    // The nested run's identity came from the parent tool call, so the result
    // is attributable to the subagent the UI has seen.
    expect(result.agentId).toBe('parent-call-1');
  });

  it('projects a nested role maxTokens setting into every provider request', async () => {
    const { runner, requests } = buildNestedRunner({ maxTokens: 321 });

    await runner.runAsTool({ role: 'worker', task: 'update notes' }, parentToolContext(), {
      toolCall: { callId: 'parent-call-1' },
    });

    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.maxTokens)).toEqual([321, 321]);
  });

  it('honors a parent-approved tool inside the nested run (F5 through the runner)', async () => {
    const { runner } = buildNestedRunner();
    const parent = parentToolContext();
    // The user approved the nested tool call in the parent; replaying that
    // decision into the nested run must prevent a second prompt.
    parent.approvals.approveTool({ toolName: 'run_subagent_worker', callId: 'parent-call-1' });

    const result = await runner.runAsTool({ role: 'worker', task: 'update notes' }, parent, {
      toolCall: { callId: 'parent-call-1' },
    });

    expect(result.status).toBe('completed');
    expect(result.finalText).toBe('Summary: updated notes.');
  });

  it('reports an interrupted nested run as interrupted rather than completed', async () => {
    const events: ConversationEvent[] = [];
    const { runner } = buildNestedRunner({ needsApproval: true, onEvent: (event) => events.push(event) });

    const result = await runner.runAsTool({ role: 'worker', task: 'update notes' }, parentToolContext(), {
      toolCall: { callId: 'parent-call-1' },
    });

    // The run paused at an approval with work outstanding. Calling that
    // 'completed' told the parent model the opposite of what the event stream
    // said — the completion event is deliberately withheld here.
    expect(result.status).toBe('interrupted');
    expect(result.interrupted).toBe(true);
    expect(events.some((event) => event.type === 'subagent_completed')).toBe(false);
  });

  it("enforces the role's turn budget instead of running as long as the model keeps calling tools", async () => {
    const { runner } = buildNestedRunner({ alwaysCallsTool: true, maxTurns: 3 });

    await expect(
      runner.runAsTool({ role: 'worker', task: 'update notes' }, parentToolContext(), {
        toolCall: { callId: 'parent-call-1' },
      }),
    ).rejects.toThrow(/Max turns \(3\) exceeded/);
  });
});
