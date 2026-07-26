import { it, expect } from 'vitest';
import { createRunSubagentAsyncToolDefinition, createGetSubagentResultToolDefinition } from './run-subagent-async.js';
import type { SubagentRunHandle, SubagentResult } from '../../services/subagents/types.js';
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
  expect(tool.description).toContain('explicitly need the result immediately');
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
