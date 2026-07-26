import { it, expect, describe } from 'vitest';
import {
  createRunSubagentAsyncToolDefinition,
  createGetSubagentResultToolDefinition,
  createGetSubagentStatusToolDefinition,
} from './run-subagent-async.js';
import type { SubagentRunHandle, SubagentResult, SubagentRunStatus } from '../../services/subagents/types.js';
import { SubagentRegistryError } from '../../services/subagents/subagent-async-registry.js';

function makeHandle(overrides: Partial<SubagentRunHandle> = {}): SubagentRunHandle {
  return {
    runId: 'run-123',
    role: 'explorer',
    task: 'find files',
    status: 'running',
    ...overrides,
  };
}

function makeStatus(overrides: Partial<SubagentRunStatus> = {}): SubagentRunStatus {
  return {
    runId: 'run-123',
    role: 'explorer',
    status: 'running',
    task: 'find files',
    taskPreview: 'find files',
    startedAt: 1000,
    elapsedMs: 5000,
    toolCounts: { read_file: 2, grep: 1 },
    lastToolName: 'grep',
    lastToolAt: 4500,
    ...overrides,
  };
}

function makeResult(overrides: Partial<SubagentResult> = {}): SubagentResult {
  return {
    agentId: 'run-123',
    role: 'explorer',
    status: 'completed',
    finalText: 'Found the relevant files.',
    filesChanged: [],
    toolsUsed: [],
    ...overrides,
  };
}

it('run_subagent_async tool is registered with the correct name', () => {
  const tool = createRunSubagentAsyncToolDefinition(async () => makeHandle());
  expect(tool.name).toBe('run_subagent_async');
});

it('run_subagent_async tool guidance treats a running handle as successful non-duplicated delegation', () => {
  const tool = createRunSubagentAsyncToolDefinition(async () => makeHandle());

  expect(tool.description).toContain('status: "running"');
  expect(tool.description).toContain('do not duplicate the delegated task');
  expect(tool.description).toContain('automatic completion notification');
  expect(tool.description).toContain('do NOT immediately call get_subagent_result');
});

it('run_subagent_async schema accepts supported roles', () => {
  const tool = createRunSubagentAsyncToolDefinition(async () => makeHandle());

  for (const role of ['explorer', 'researcher', 'mentor']) {
    expect(tool.parameters.safeParse({ role, task: 'do work' }).success).toBe(true);
  }
  expect(tool.parameters.safeParse({ role: 'worker', task: 'do work' }).success).toBe(true);
  expect(tool.parameters.safeParse({ role: 'librarian', task: 'do work' }).success).toBe(true);
  expect(tool.parameters.safeParse({ role: 'unknown', task: 'do work' }).success).toBe(false);
});

it('run_subagent_async requires a task', () => {
  const tool = createRunSubagentAsyncToolDefinition(async () => makeHandle());

  expect(tool.parameters.safeParse({ role: 'explorer', task: 'find files' }).success).toBe(true);
  expect(tool.parameters.safeParse({ role: 'explorer' }).success).toBe(false);
});

it('run_subagent_async returns a run handle string', async () => {
  const tool = createRunSubagentAsyncToolDefinition(async () => makeHandle({ runId: 'run-abc' }));

  const raw = await tool.execute({ role: 'explorer', task: 'find files' });

  expect(raw).toContain('run-abc');
});

it('get_subagent_result tool is registered with the correct name', () => {
  const tool = createGetSubagentResultToolDefinition(async () => makeResult());
  expect(tool.name).toBe('get_subagent_result');
});

it('get_subagent_result schema requires a runId', () => {
  const tool = createGetSubagentResultToolDefinition(async () => makeResult());

  expect(tool.parameters.safeParse({ runId: 'run-abc' }).success).toBe(true);
  expect(tool.parameters.safeParse({}).success).toBe(false);
});

it('get_subagent_result returns a formatted SubagentResult', async () => {
  const tool = createGetSubagentResultToolDefinition(async () => makeResult({ finalText: 'Answer here.' }));

  const raw = await tool.execute({ runId: 'run-abc' });

  expect(raw).toContain('Status: completed');
  expect(raw).toContain('Answer here.');
  expect(raw.startsWith('{')).toBe(false);
});

it('preserves registry error codes through the async tool boundary', async () => {
  const tool = createRunSubagentAsyncToolDefinition(async () => {
    throw new SubagentRegistryError('worker_blocked', 'Worker runs cannot be continued asynchronously');
  });

  await expect(tool.execute({ role: 'worker', task: 'continue', continue_run_id: 'run-abc' })).resolves.toBe(
    JSON.stringify({
      status: 'failed',
      error: { code: 'worker_blocked', message: 'Worker runs cannot be continued asynchronously' },
    }),
  );
});

it('get_subagent_result returns failed result text on error', async () => {
  const tool = createGetSubagentResultToolDefinition(async () => {
    throw new Error('Run not found');
  });

  const raw = await tool.execute({ runId: 'run-abc' });

  expect(raw).toContain('Status: failed');
  expect(raw).toContain('Run not found');
});

it('run_subagent_async formatCommandMessage renders started async run', () => {
  const tool = createRunSubagentAsyncToolDefinition(async () => makeHandle());

  const item = {
    rawItem: {
      arguments: JSON.stringify({ role: 'explorer', task: 'find files' }),
      output: 'Started async run run-123',
    },
  };

  const messages = tool.formatCommandMessage(item, 0, new Map());
  expect(messages.length).toBe(1);
  expect(messages[0].command).toContain('run_subagent_async');
  expect(messages[0].command).toContain('explorer');
  expect(messages[0].command).toContain('find files');
});

it('get_subagent_result formatCommandMessage renders completed result', () => {
  const tool = createGetSubagentResultToolDefinition(async () => makeResult());

  const item = {
    rawItem: {
      arguments: JSON.stringify({ runId: 'run-123' }),
      output: 'Status: completed\n\nFound the relevant files.',
    },
  };

  const messages = tool.formatCommandMessage(item, 0, new Map());
  expect(messages.length).toBe(1);
  expect(messages[0].command).toContain('get_subagent_result');
  expect(messages[0].output).toContain('Found the relevant files.');
  expect(messages[0].success).toBe(true);
});

describe('get_subagent_status tool', () => {
  it('is registered with the correct name', () => {
    const tool = createGetSubagentStatusToolDefinition(() => makeStatus());
    expect(tool.name).toBe('get_subagent_status');
  });

  it('never needs approval', () => {
    const tool = createGetSubagentStatusToolDefinition(() => makeStatus());
    expect(tool.needsApproval({} as any)).toBe(false);
  });

  it('description states the non-blocking contract and the boundary with get_subagent_result', () => {
    const tool = createGetSubagentStatusToolDefinition(() => makeStatus());
    expect(tool.description).toContain('never blocks');
    expect(tool.description).toContain('get_subagent_result');
    expect(tool.description).toContain('never the final report');
  });

  it('accepts an optional runId (single run or all-runs listing)', () => {
    const tool = createGetSubagentStatusToolDefinition(() => makeStatus());
    expect(tool.parameters.safeParse({ runId: 'run-abc' }).success).toBe(true);
    expect(tool.parameters.safeParse({}).success).toBe(true);
  });

  it('formats a single running run and points to get_subagent_result for completion', () => {
    const tool = createGetSubagentStatusToolDefinition(() => makeStatus());
    const raw = tool.execute({ runId: 'run-123' });
    expect(raw).toContain('running');
    expect(raw).toContain('grep');
    expect(raw).toContain('get_subagent_result');
    // Peek must not leak completion detail.
    expect(raw).not.toContain('final');
    expect(raw.startsWith('{')).toBe(false);
  });

  it('formats an all-runs listing when runId is omitted', () => {
    const tool = createGetSubagentStatusToolDefinition(() => [
      makeStatus({ runId: 'run-a', role: 'explorer' }),
      makeStatus({
        runId: 'run-b',
        role: 'worker',
        status: 'running',
        task: 'edit',
        taskPreview: 'edit',
        toolCounts: { search_replace: 3 },
      }),
    ]);
    const raw = tool.execute({});
    expect(raw).toContain('run-a');
    expect(raw).toContain('run-b');
    expect(raw).toContain('explorer');
    expect(raw).toContain('worker');
  });

  it('reports a not-found run without throwing', () => {
    const tool = createGetSubagentStatusToolDefinition(() =>
      makeStatus({
        runId: 'ghost',
        status: 'not_found',
        task: '',
        taskPreview: '',
        toolCounts: {},
        lastToolName: undefined,
        lastToolAt: undefined,
        elapsedMs: 0,
        startedAt: 0,
      }),
    );
    const raw = tool.execute({ runId: 'ghost' });
    expect(raw).toContain('not found');
  });

  it('execute is synchronous and does not await a run promise', () => {
    const tool = createGetSubagentStatusToolDefinition(() => makeStatus());
    // Structural assertion: execute does not return a Promise for the happy path.
    const out = tool.execute({ runId: 'run-123' });
    expect(typeof out).toBe('string');
  });
});
