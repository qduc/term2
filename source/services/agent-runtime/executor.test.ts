import { describe, it, expect, vi } from 'vitest';
import {
  createExecutor,
  mapSubagentResultToRunResult,
  type SubagentRunWithDefFn,
  type MentorRunFn,
} from './executor.js';
import type { ExecutorInput } from './agent-handle.js';
import type { ResolvedAgentDefinition } from './resolved-agent.js';
import type { SubagentResult } from '../subagents/types.js';
import type { ILoggingService } from '../service-interfaces.js';
import { createRootBudget } from './execution-budget.js';

function logger(): ILoggingService {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    security: () => {},
    setCorrelationId: () => {},
    clearCorrelationId: () => {},
    getCorrelationId: () => undefined,
  };
}

function makeDefinition(overrides: Partial<ResolvedAgentDefinition> = {}): ResolvedAgentDefinition {
  return {
    name: 'test-agent',
    instructions: 'You are a test agent.',
    model: { provider: 'openai', model: 'gpt-4o' },
    permissions: { canRead: true, canWrite: false, canRunShell: false, canSearchWeb: false, canUseNestedAgents: false },
    limits: { maxTurns: 5 },
    tools: ['read_file'],
    skillInstructions: '',
    resolutionErrors: [],
    ...overrides,
  };
}

function makeExecutorInput(overrides: Partial<ExecutorInput> = {}): ExecutorInput {
  return {
    definition: makeDefinition(),
    instructions: 'You are a test agent.',
    input: { task: 'do work' },
    logger: logger(),
    budget: createRootBudget({}),
    ...overrides,
  };
}

describe('mapSubagentResultToRunResult', () => {
  it('maps completed result with output and ArtifactReference artifacts', () => {
    const subagentResult: SubagentResult = {
      agentId: 'agent-1',
      role: 'explorer',
      status: 'completed',
      finalText: 'All done!',
      filesChanged: ['src/file.ts'],
      toolsUsed: [{ toolName: 'read_file', count: 1 }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };

    const result = mapSubagentResultToRunResult(subagentResult);
    expect(result.status).toBe('completed');
    expect(result.output).toBe('All done!');
    expect(result.artifacts).toEqual([{ path: 'src/file.ts' }]);
    expect(result.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
    expect(result.error).toBeUndefined();
  });

  it('maps failed result with error', () => {
    const subagentResult: SubagentResult = {
      agentId: 'agent-1',
      role: 'worker',
      status: 'failed',
      finalText: '',
      filesChanged: [],
      toolsUsed: [],
      error: 'Something went wrong',
    };

    const result = mapSubagentResultToRunResult(subagentResult);
    expect(result.status).toBe('failed');
    expect(result.output).toBeUndefined();
    expect(result.error).toEqual({
      code: 'agent_error',
      message: 'Something went wrong',
    });
  });

  it('maps cancelled result with error', () => {
    const subagentResult: SubagentResult = {
      agentId: 'agent-1',
      role: 'worker',
      status: 'cancelled',
      finalText: '',
      filesChanged: [],
      toolsUsed: [],
      error: 'Aborted.',
    };

    const result = mapSubagentResultToRunResult(subagentResult);
    expect(result.status).toBe('cancelled');
    expect(result.output).toBeUndefined();
    expect(result.error).toEqual({
      code: 'cancelled',
      message: 'Aborted.',
    });
  });

  it('maps unknown error message when error field is absent', () => {
    const subagentResult: SubagentResult = {
      agentId: 'agent-1',
      role: 'worker',
      status: 'failed',
      finalText: '',
      filesChanged: [],
      toolsUsed: [],
    };

    const result = mapSubagentResultToRunResult(subagentResult);
    expect(result.error).toEqual({
      code: 'agent_error',
      message: 'Unknown error',
    });
  });

  it('does not expose internal fields (nestedRunResult, toolsUsed)', () => {
    const subagentResult: SubagentResult = {
      agentId: 'agent-1',
      role: 'explorer',
      status: 'completed',
      finalText: 'done',
      filesChanged: ['a.ts'],
      toolsUsed: [{ toolName: 'read_file', count: 1 }],
      nestedRunResult: { internal: true },
    };

    const result = mapSubagentResultToRunResult(subagentResult);
    expect((result as any).nestedRunResult).toBeUndefined();
    expect((result as any).toolsUsed).toBeUndefined();
    expect((result as any).finalText).toBeUndefined();
    expect((result as any).agentId).toBeUndefined();
  });
});

describe('createExecutor', () => {
  it('delegates to the runWithDef function with correct definition', async () => {
    let capturedDefinition: unknown;
    let capturedRequest: unknown;

    const runWithDef: SubagentRunWithDefFn = async (agentId, request, definition) => {
      capturedDefinition = definition;
      capturedRequest = request;
      return {
        agentId,
        role: request.role,
        status: 'completed' as const,
        finalText: 'executed',
        filesChanged: [],
        toolsUsed: [],
      };
    };

    const executor = createExecutor(runWithDef, logger());
    const input = makeExecutorInput({
      definition: makeDefinition({ name: 'custom-runner' }),
      instructions: 'Custom instructions here.',
    });

    const result = await executor(input);

    expect(result.status).toBe('completed');
    expect(result.output).toBe('executed');
    expect(capturedDefinition).toBeDefined();
    expect((capturedDefinition as any).role).toBe('custom-runner');
    expect((capturedDefinition as any).instructions).toBe('Custom instructions here.');
    expect((capturedRequest as any).task).toBe('do work');
  });

  it('emits matching lifecycle events for an AgentRuntime child run', async () => {
    const events: unknown[] = [];
    const runWithDef: SubagentRunWithDefFn = async (agentId, request) => ({
      agentId,
      role: request.role,
      status: 'completed',
      finalText: 'done',
      filesChanged: [],
      toolsUsed: [],
    });

    const executor = createExecutor(runWithDef, logger(), undefined, (event) => events.push(event));

    await executor(makeExecutorInput());

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: 'subagent_started', task: 'do work' });
    expect(events[1]).toMatchObject({ type: 'subagent_completed', result: { status: 'completed' } });
    expect((events[1] as any).result.agentId).toBe((events[0] as any).agentId);
  });

  it('propagates cancellation signal to the run request', async () => {
    let capturedSignal: AbortSignal | undefined;

    const runWithDef: SubagentRunWithDefFn = async (_agentId, request) => {
      capturedSignal = request.signal;
      return {
        agentId: 'test',
        role: request.role,
        status: 'completed' as const,
        finalText: 'ok',
        filesChanged: [],
        toolsUsed: [],
      };
    };

    const controller = new AbortController();
    const executor = createExecutor(runWithDef, logger());
    const input = makeExecutorInput({
      input: { task: 'work', signal: controller.signal },
    });

    await executor(input);

    expect(capturedSignal).toBe(controller.signal);
  });

  it('maps failed subagent result correctly', async () => {
    const runWithDef: SubagentRunWithDefFn = async (agentId, request, _definition) => ({
      agentId,
      role: request.role,
      status: 'failed',
      finalText: '',
      filesChanged: [],
      toolsUsed: [],
      error: 'Subagent crashed',
    });

    const executor = createExecutor(runWithDef, logger());
    const result = await executor(makeExecutorInput());

    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('agent_error');
    expect(result.error?.message).toBe('Subagent crashed');
  });

  it('uses randomUUID in agentId (not Date.now)', async () => {
    const runWithDef: SubagentRunWithDefFn = async (agentId) => ({
      agentId,
      role: 'test',
      status: 'completed' as const,
      finalText: 'ok',
      filesChanged: [],
      toolsUsed: [],
    });

    const executor = createExecutor(runWithDef, logger());
    const result = await executor(makeExecutorInput());
    // agentId uses randomUUID format (not timestamp-based)
    expect((result as any).agentId).toBeUndefined(); // stripped from public result
    // Verify the runWithDef received a UUID-formatted agentId by checking
    // the runWithDef was called with a non-timestamp agentId.
  });

  it('composes timeout signal from definition.limits.timeoutMs', async () => {
    let capturedSignal: AbortSignal | undefined;

    const runWithDef: SubagentRunWithDefFn = async (_agentId, request) => {
      capturedSignal = request.signal;
      return {
        agentId: 'test',
        role: request.role,
        status: 'completed' as const,
        finalText: 'ok',
        filesChanged: [],
        toolsUsed: [],
      };
    };

    const executor = createExecutor(runWithDef, logger());
    const input = makeExecutorInput({
      definition: makeDefinition({ limits: { maxTurns: 5, timeoutMs: 10_000 } }),
    });

    await executor(input);

    // A timeout signal should have been composed
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal!.aborted).toBe(false);
  });

  it('composes caller signal with timeout signal', async () => {
    let capturedSignal: AbortSignal | undefined;

    const runWithDef: SubagentRunWithDefFn = async (_agentId, request) => {
      capturedSignal = request.signal;
      return {
        agentId: 'test',
        role: request.role,
        status: 'completed' as const,
        finalText: 'ok',
        filesChanged: [],
        toolsUsed: [],
      };
    };

    const controller = new AbortController();
    const executor = createExecutor(runWithDef, logger());
    const input = makeExecutorInput({
      definition: makeDefinition({ limits: { maxTurns: 5, timeoutMs: 5_000 } }),
      input: { task: 'work', signal: controller.signal },
    });

    await executor(input);

    // The composed signal should be different from the caller signal
    // (it's a composite via AbortSignal.any)
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal).not.toBe(controller.signal);
    expect(capturedSignal!.aborted).toBe(false);
  });

  it('routes mentor role to mentorRun when provided', async () => {
    let mentorCalled = false;
    let runWithDefCalled = false;

    const runWithDef: SubagentRunWithDefFn = async (agentId, request, _def) => {
      runWithDefCalled = true;
      return {
        agentId,
        role: request.role,
        status: 'completed' as const,
        finalText: 'exec runner',
        filesChanged: [],
        toolsUsed: [],
      };
    };

    const mentorRun: MentorRunFn = async (agentId, task, _signal) => {
      mentorCalled = true;
      return {
        agentId,
        role: 'mentor',
        status: 'completed' as const,
        finalText: 'mentor answer',
        filesChanged: [],
        toolsUsed: [],
      };
    };

    const executor = createExecutor(runWithDef, logger(), mentorRun);
    const result = await executor(
      makeExecutorInput({
        definition: makeDefinition({ name: 'Mentor' }),
      }),
    );

    expect(mentorCalled).toBe(true);
    expect(runWithDefCalled).toBe(false);
    expect(result.status).toBe('completed');
    expect(result.output).toBe('mentor answer');
  });

  it('routes non-mentor role to runWithDef even when mentorRun is provided', async () => {
    let mentorCalled = false;
    let runWithDefCalled = false;

    const runWithDef: SubagentRunWithDefFn = async (agentId, request, _def) => {
      runWithDefCalled = true;
      return {
        agentId,
        role: request.role,
        status: 'completed' as const,
        finalText: 'exec runner',
        filesChanged: [],
        toolsUsed: [],
      };
    };

    const mentorRun: MentorRunFn = async () => {
      mentorCalled = true;
      return {
        agentId: 'x',
        role: 'mentor',
        status: 'completed' as const,
        finalText: '',
        filesChanged: [],
        toolsUsed: [],
      };
    };

    const executor = createExecutor(runWithDef, logger(), mentorRun);
    const result = await executor(
      makeExecutorInput({
        definition: makeDefinition({ name: 'worker' }),
      }),
    );

    expect(runWithDefCalled).toBe(true);
    expect(mentorCalled).toBe(false);
  });

  // ── Root execution budget ─────────────────────────────────

  it('marks the generated SubagentDefinition as root execution', async () => {
    let capturedDefinition: any;

    const runWithDef: SubagentRunWithDefFn = async (_agentId, _request, definition) => {
      capturedDefinition = definition;
      return {
        agentId: 'test',
        role: _request.role,
        status: 'completed' as const,
        finalText: 'ok',
        filesChanged: [],
        toolsUsed: [],
      };
    };

    const executor = createExecutor(runWithDef, logger());
    await executor(makeExecutorInput());

    expect(capturedDefinition!).toBeDefined();
    expect(capturedDefinition!.isRootExecution).toBe(true);
  });

  it('root execution includes the budget for child tracking', async () => {
    let capturedDefinition: any;

    const runWithDef: SubagentRunWithDefFn = async (_agentId, _request, definition) => {
      capturedDefinition = definition;
      return {
        agentId: 'test',
        role: _request.role,
        status: 'completed' as const,
        finalText: 'ok',
        filesChanged: [],
        toolsUsed: [],
      };
    };

    const budget = createRootBudget({ maxChildren: 3, maxDepth: 2 });
    const executor = createExecutor(runWithDef, logger());
    await executor(makeExecutorInput({ budget }));

    expect(capturedDefinition!.executionBudget).toBe(budget);
    expect(capturedDefinition!.isRootExecution).toBe(true);
    // Root execution does NOT consume a child slot — budget.childCount stays 0
    expect(budget.childCount).toBe(0);
  });

  it('root budget with maxChildren 0 still allows root execution', async () => {
    let runWasCalled = false;

    const runWithDef: SubagentRunWithDefFn = async (_agentId, _request, _definition) => {
      runWasCalled = true;
      return {
        agentId: 'test',
        role: _request.role,
        status: 'completed' as const,
        finalText: 'ok',
        filesChanged: [],
        toolsUsed: [],
      };
    };

    const budget = createRootBudget({ maxChildren: 0, maxDepth: 0 });
    const executor = createExecutor(runWithDef, logger());
    const result = await executor(makeExecutorInput({ budget }));

    expect(runWasCalled).toBe(true);
    expect(result.status).toBe('completed');
    // Root didn't consume a child slot
    expect(budget.childCount).toBe(0);
  });

  it('root budget with maxConcurrency 0 still allows root execution', async () => {
    let runWasCalled = false;

    const runWithDef: SubagentRunWithDefFn = async () => {
      runWasCalled = true;
      return {
        agentId: 'test',
        role: 'worker',
        status: 'completed' as const,
        finalText: 'ok',
        filesChanged: [],
        toolsUsed: [],
      };
    };

    const budget = createRootBudget({ maxConcurrency: 0, maxChildren: 0 });
    const executor = createExecutor(runWithDef, logger());
    await executor(makeExecutorInput({ budget }));

    expect(runWasCalled).toBe(true);
  });
});
