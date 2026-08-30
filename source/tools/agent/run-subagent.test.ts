import { it, expect, vi } from 'vitest';
import { z } from 'zod';
import { createRunSubagentToolDefinition, getSubagentsRolesSection } from './run-subagent.js';
import type { SubagentResult } from '../../services/subagents/types.js';
import { toOpenAIStrictToolSchema } from '../../lib/openai-strict-tool-schema.js';

function makeResult(overrides: Partial<SubagentResult> = {}): SubagentResult {
  return {
    agentId: 'test-agent-id',
    role: 'explorer',
    status: 'completed',
    finalText: 'Found the relevant files.',
    filesChanged: [],
    toolsUsed: [],
    ...overrides,
  };
}

it('createRunSubagentToolDefinition defines the tool correctly', () => {
  const tool = createRunSubagentToolDefinition(async () => makeResult());

  expect(tool.name).toBe('run_subagent');
  expect(tool.description.includes('Delegate')).toBe(true);
  expect(tool.needsApproval({ role: 'explorer', task: 'test' }, undefined)).toBe(false);
});

it('describes explorer tasks as evidence collection rather than delegated reasoning', () => {
  const tool = createRunSubagentToolDefinition(async () => makeResult());
  const roles = getSubagentsRolesSection();

  expect(tool.description).toContain('For explorer, request concrete evidence to collect');
  expect(tool.description).toContain('breadth or depth, never both');
  expect(tool.description).toContain('one cohesive implementation unit');
  expect(tool.description).toContain('one decision or challenge question');
  expect(tool.description).toContain('one retrieval objective or memory-maintenance topic boundary');
  expect(tool.description).toContain('Do not ask explorer to diagnose, recommend a fix, choose an approach');
  expect(tool.description).toContain(
    'Independent foreground explorer and librarian calls in the same model response may run in parallel',
  );
  expect(tool.description).not.toContain('when they do not use a worktree');
  expect(roles).toContain('evidence collection');
  expect(roles).toContain('never both in one run');
  expect(roles).not.toContain('answering codebase questions');
});

it('marks foreground explorer and librarian parallel-safe regardless of a worktree placeholder', () => {
  const tool = createRunSubagentToolDefinition(async () => makeResult());
  expect(typeof tool.parallelSafe).toBe('function');
  const parallelSafe = tool.parallelSafe as (params: unknown) => boolean;

  expect(parallelSafe({ execution: 'foreground', role: 'explorer', task: 'inspect' })).toBe(true);
  expect(parallelSafe({ execution: 'foreground', role: 'explorer', task: 'inspect', worktree: null })).toBe(true);
  expect(parallelSafe({ execution: 'foreground', role: 'explorer', task: 'inspect', worktree: '' })).toBe(true);
  expect(parallelSafe({ execution: 'foreground', role: 'librarian', task: 'lookup', worktree: null })).toBe(true);
  expect(parallelSafe({ execution: 'foreground', role: 'worker', task: 'edit' })).toBe(false);
  expect(parallelSafe({ execution: 'background', role: 'explorer', task: 'inspect' })).toBe(false);
});

it('requires an explicit execution mode and dispatches background work when both callbacks exist', async () => {
  const foreground = vi.fn(async () => makeResult({ finalText: 'Foreground result.' }));
  const background = vi.fn(async () => ({
    runId: 'run-background',
    role: 'explorer' as const,
    task: 'inspect',
    status: 'running' as const,
  }));
  const tool = createRunSubagentToolDefinition({ runSubagent: foreground, runSubagentAsync: background });

  expect(tool.parameters.safeParse({ role: 'explorer', task: 'inspect' }).success).toBe(false);
  expect(tool.parameters.safeParse({ execution: 'foreground', role: 'explorer', task: 'inspect' }).success).toBe(false);
  expect(tool.parameters.safeParse({ execution: 'background', role: 'explorer', task: 'inspect' }).success).toBe(true);

  await expect(tool.execute({ execution: 'background', role: 'explorer', task: 'inspect' })).resolves.toContain(
    'run-background',
  );
  expect(background).toHaveBeenCalledWith(
    { role: 'explorer', task: 'inspect', name: undefined, continue_run_id: undefined },
    undefined,
    undefined,
  );
  expect(foreground).not.toHaveBeenCalled();
});

it('rejects foreground calls at runtime when background execution is available', async () => {
  const foreground = vi.fn(async () => makeResult());
  const tool = createRunSubagentToolDefinition({
    runSubagent: foreground,
    runSubagentAsync: async () => ({ runId: 'run-background', role: 'explorer', task: 'inspect', status: 'running' }),
  });

  await expect(tool.execute({ execution: 'foreground', role: 'explorer', task: 'inspect' })).resolves.toContain(
    'foreground_unavailable',
  );
  expect(foreground).not.toHaveBeenCalled();
});

it('dispatches background work to the registry callback and returns its running handle', async () => {
  const foreground = vi.fn(async () => makeResult());
  const background = vi.fn(async () => ({
    runId: 'run-background',
    role: 'mentor' as const,
    task: 'pressure-test',
    name: 'review',
    status: 'running' as const,
  }));
  const tool = createRunSubagentToolDefinition({ runSubagent: foreground, runSubagentAsync: background });

  const raw = await tool.execute({
    execution: 'background',
    role: 'mentor',
    task: 'pressure-test',
    name: 'review',
  });

  expect(raw).toBe(
    JSON.stringify({
      runId: 'run-background',
      status: 'running',
      name: 'review',
      hint: 'Background run launched — do NOT call get_subagent_result now. End your turn; the completion notification will inline the full result.',
    }),
  );
  expect(background).toHaveBeenCalledWith(
    { role: 'mentor', task: 'pressure-test', name: 'review', continue_run_id: undefined },
    undefined,
    undefined,
  );
  expect(foreground).not.toHaveBeenCalled();
});

it('does not advertise background execution when the registry callbacks are unavailable', () => {
  const tool = createRunSubagentToolDefinition({ runSubagent: async () => makeResult() });

  expect(tool.parameters.safeParse({ execution: 'foreground', role: 'explorer', task: 'inspect' }).success).toBe(true);
  expect(tool.parameters.safeParse({ execution: 'background', role: 'explorer', task: 'inspect' }).success).toBe(false);
});

it('does not allow foreground calls to smuggle background-only inputs', async () => {
  const foreground = vi.fn(async () => makeResult());
  const tool = createRunSubagentToolDefinition({
    runSubagent: foreground,
    runSubagentAsync: async () => ({
      runId: 'run-background',
      role: 'explorer',
      task: 'inspect',
      status: 'running',
    }),
  });

  await expect(
    tool.execute({ execution: 'foreground', role: 'explorer', task: 'inspect', name: 'not-allowed' }),
  ).resolves.toContain('foreground_unavailable');
  expect(foreground).not.toHaveBeenCalled();
});

it('treats strict-provider null background fields as absent for foreground-only execution', async () => {
  const foreground = vi.fn(async () => makeResult({ finalText: 'Foreground result.' }));
  const tool = createRunSubagentToolDefinition({
    runSubagent: foreground,
  });

  await expect(
    tool.execute({
      execution: 'foreground',
      role: 'explorer',
      task: 'inspect',
      name: null,
      continue_run_id: null,
    }),
  ).resolves.toContain('Foreground result.');
  expect(foreground).toHaveBeenCalledOnce();
});

it('keeps the foreground interruption result model-visible', async () => {
  const tool = createRunSubagentToolDefinition({
    runSubagent: async () => ({ ...makeResult(), status: 'interrupted', interrupted: true }),
  });

  await expect(tool.execute({ execution: 'foreground', role: 'explorer', task: 'inspect' })).resolves.toContain(
    'Status: interrupted',
  );
});

it('uses a provider-compatible object schema instead of a discriminated union', () => {
  const tool = createRunSubagentToolDefinition({
    runSubagent: async () => makeResult(),
    runSubagentAsync: async () => ({ runId: 'run-1', role: 'explorer', task: 'inspect', status: 'running' }),
  });

  const schema = z.toJSONSchema(toOpenAIStrictToolSchema(tool.parameters)) as {
    anyOf?: unknown;
    required?: string[];
  };
  expect(schema.anyOf).toBeUndefined();
  expect(schema.required).toContain('execution');
});

it('describes task as a bounded delegated unit rather than the full parent task', () => {
  const tool = createRunSubagentToolDefinition(async () => makeResult());
  const schema = z.toJSONSchema(toOpenAIStrictToolSchema(tool.parameters)) as {
    properties?: { task?: { description?: string } };
  };

  expect(schema.properties?.task?.description).toContain('bounded delegated unit');
  expect(schema.properties?.task?.description).not.toContain('full task description');
});

it('describes task-specific context without requesting automatically supplied context', () => {
  const tool = createRunSubagentToolDefinition(async () => makeResult());

  expect(tool.description).toContain(
    'Do not repeat automatically supplied context: role instructions, generic tool guidance, worktree hygiene, environment metadata, root `AGENTS.md`, or skills catalog.',
  );
  expect(tool.description).toContain('The subagent does not see your conversation or reasoning');
});

it('schema requires role and task', () => {
  const tool = createRunSubagentToolDefinition(async () => makeResult());

  expect(tool.parameters.safeParse({ execution: 'foreground', role: 'explorer', task: 'find files' }).success).toBe(
    true,
  );
  expect(tool.parameters.safeParse({ execution: 'foreground', role: 'explorer' }).success).toBe(false);
  expect(tool.parameters.safeParse({ execution: 'foreground', task: 'find files' }).success).toBe(false);
});

it('schema accepts delegatable roles but hides mentor behind ask_mentor', () => {
  const tool = createRunSubagentToolDefinition(async () => makeResult());

  for (const role of ['explorer', 'worker', 'librarian']) {
    expect(tool.parameters.safeParse({ execution: 'foreground', role, task: 'do work' }).success).toBe(true);
  }
  expect(tool.parameters.safeParse({ execution: 'foreground', role: 'mentor', task: 'do work' }).success).toBe(false);
  expect(tool.parameters.safeParse({ execution: 'foreground', role: 'custom', task: 'do work' }).success).toBe(false);
});

it('execute returns plain-text SubagentResult', async () => {
  const expected = makeResult({
    finalText: 'Answer here.',
    validation: {
      command: 'pnpm typecheck',
      exitStatus: 0,
      outputExcerpt: 'No errors found',
    },
    diffStat: [{ path: 'source/example.ts', added: 3, deleted: 1 }],
  });
  const tool = createRunSubagentToolDefinition(async () => expected);

  const raw = (await tool.execute({ role: 'explorer', task: 'find files' })) as string;

  expect(raw.includes('Status: completed')).toBe(true);
  expect(raw.includes('Answer here.')).toBe(true);
  expect(raw).toContain('Validation: pnpm typecheck → exit 0');
  expect(raw).toContain('Output excerpt: No errors found');
  expect(raw).toContain('Diff stat:');
  expect(raw).toContain('  source/example.ts +3/-1');
  expect(raw.startsWith('{')).toBe(false);
});

it('execute returns failed result as plain text on error', async () => {
  const tool = createRunSubagentToolDefinition(async () => {
    throw new Error('Connection failed');
  });

  const raw = (await tool.execute({ role: 'explorer', task: 'find files' })) as string;

  expect(raw.includes('Status: failed')).toBe(true);
  expect(raw.includes('Error: Connection failed')).toBe(true);
  expect(raw.startsWith('{')).toBe(false);
});

it('execute propagates abort errors', async () => {
  const abortError = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
  const tool = createRunSubagentToolDefinition(async () => {
    throw abortError;
  });

  await expect(tool.execute({ role: 'explorer', task: 'find files' })).rejects.toBe(abortError);
});

it('execute passes tool invocation details to subagent runner', async () => {
  let capturedDetails: unknown;
  const tool = createRunSubagentToolDefinition(async (_params, _context, details) => {
    capturedDetails = details;
    return makeResult();
  });
  const abortController = new AbortController();
  const details = { signal: abortController.signal };

  await tool.execute({ role: 'explorer', task: 'find files' }, undefined, details);

  expect(capturedDetails).toBe(details);
});

it('formatCommandMessage renders completed result', () => {
  const result = makeResult({
    finalText: 'Found 3 relevant files.',
    toolsUsed: [{ toolName: 'read_file', count: 3 }],
  });
  const tool = createRunSubagentToolDefinition(async () => result);

  const item = {
    rawItem: {
      arguments: JSON.stringify({ role: 'explorer', task: 'find files' }),
      output: 'Status: completed\n\nFound 3 relevant files.\n\nTools used: read_file(3)',
    },
  };

  const messages = tool.formatCommandMessage(item, 0, new Map());
  expect(messages.length).toBe(1);
  expect(messages[0].command.includes('explorer')).toBe(true);
  expect(messages[0].command.includes('find files')).toBe(true);
  expect(messages[0].output.includes('Found 3 relevant files.')).toBe(true);
  expect(messages[0].success ?? true).toBe(true);
});

it('formatCommandMessage marks a rejected background launch as failed', () => {
  const tool = createRunSubagentToolDefinition({
    runSubagentAsync: async () => ({ runId: 'unused', role: 'explorer', task: 'inspect', status: 'running' }),
  });
  const item = {
    rawItem: {
      arguments: JSON.stringify({ execution: 'background', role: 'explorer', task: 'inspect' }),
      output: JSON.stringify({
        status: 'failed',
        error: { code: 'name_in_use', message: 'Async subagent name is already active: review' },
      }),
    },
  };

  const [message] = tool.formatCommandMessage(item, 0, new Map());

  expect(message.success).toBe(false);
  expect(message.command).toContain('failed');
  expect(message.output).toContain('Async subagent name is already active: review');
});

it('formatCommandMessage truncates long task in command', () => {
  const tool = createRunSubagentToolDefinition(async () => makeResult());
  const longTask = 'a'.repeat(400);

  const item = {
    rawItem: {
      arguments: JSON.stringify({ role: 'explorer', task: longTask }),
      output: 'Status: completed\n\nDone.',
    },
  };

  const messages = tool.formatCommandMessage(item, 0, new Map());
  expect(messages[0].command.length).toBe('run_subagent [explorer] '.length + 300);
  expect(messages[0].command.endsWith('...')).toBe(true);
});

it('formatCommandMessage uses only the first paragraph', () => {
  const tool = createRunSubagentToolDefinition(async () => makeResult());
  const taskWithParagraphs = 'First paragraph content.\n\nSecond paragraph content that should be ignored.';

  const item = {
    rawItem: {
      arguments: JSON.stringify({ role: 'explorer', task: taskWithParagraphs }),
      output: 'Status: completed\n\nDone.',
    },
  };

  const messages = tool.formatCommandMessage(item, 0, new Map());
  expect(messages[0].command).toBe('run_subagent [explorer] First paragraph content.');
});

it('formatCommandMessage truncates long output', () => {
  const longOutput = 'b'.repeat(400);
  const tool = createRunSubagentToolDefinition(async () => makeResult());

  const item = {
    rawItem: {
      arguments: JSON.stringify({ role: 'explorer', task: 'find files' }),
      output: JSON.stringify(makeResult({ finalText: longOutput })),
    },
  };

  const messages = tool.formatCommandMessage(item, 0, new Map());
  expect(messages[0].output.split('\n')[0].length).toBe(300);
  expect(messages[0].output.split('\n')[0].endsWith('...')).toBe(true);
});

it('formatCommandMessage uses only the first paragraph of output', () => {
  const outputWithParagraphs = 'First output paragraph.\n\nSecond output paragraph.';
  const tool = createRunSubagentToolDefinition(async () => makeResult());

  const item = {
    rawItem: {
      arguments: JSON.stringify({ role: 'explorer', task: 'find files' }),
      output: JSON.stringify(makeResult({ finalText: outputWithParagraphs })),
    },
  };

  const messages = tool.formatCommandMessage(item, 0, new Map());
  expect(messages[0].output.split('\n')[0]).toBe('First output paragraph.');
});

it('formatCommandMessage renders failed result', () => {
  const result = makeResult({ status: 'failed', error: 'Role not found', finalText: '' });
  const tool = createRunSubagentToolDefinition(async () => result);

  const item = {
    rawItem: {
      arguments: JSON.stringify({ role: 'bad-role', task: 'do stuff' }),
      output: 'Status: failed\nError: Role not found',
    },
  };

  const messages = tool.formatCommandMessage(item, 0, new Map());
  expect(messages.length).toBe(1);
  expect(messages[0].success!).toBe(false);
});

it('formatCommandMessage includes tool usage summary', () => {
  const result = makeResult({
    toolsUsed: [
      { toolName: 'read_file', count: 5 },
      { toolName: 'grep', count: 2 },
    ],
  });
  const tool = createRunSubagentToolDefinition(async () => result);

  const item = {
    rawItem: {
      arguments: JSON.stringify({ role: 'explorer', task: 'search codebase' }),
      output: 'Status: completed\n\nResult text.\n\nTools used: read_file(5), grep(2)',
    },
  };

  const messages = tool.formatCommandMessage(item, 0, new Map());
  expect(messages[0].output.includes('read_file(5)')).toBe(true);
  expect(messages[0].output.includes('grep(2)')).toBe(true);
});

it('formatCommandMessage includes files changed summary for worker', () => {
  const result = makeResult({
    role: 'worker',
    filesChanged: ['src/foo.ts', 'src/bar.ts'],
  });
  const tool = createRunSubagentToolDefinition(async () => result);

  const item = {
    rawItem: {
      arguments: JSON.stringify({ role: 'worker', task: 'update code' }),
      output: 'Status: completed\n\nDone.\n\nFiles changed: src/foo.ts, src/bar.ts',
    },
  };

  const messages = tool.formatCommandMessage(item, 0, new Map());
  expect(messages[0].output.includes('src/foo.ts')).toBe(true);
  expect(messages[0].output.includes('src/bar.ts')).toBe(true);
});

it('getSubagentsRolesSection extracts descriptions from markdown files', () => {
  const section = getSubagentsRolesSection();

  expect(section.includes('## Roles')).toBe(true);
  expect(section.includes('`explorer`')).toBe(true);
  expect(section.includes('`mentor`')).toBe(true);
  expect(section.includes('`worker`')).toBe(true);

  expect(section).toMatch(/-\s+`explorer`:\s+\S+/);
  expect(section).toMatch(/-\s+`mentor`:\s+\S+/);
  expect(section).toMatch(/-\s+`worker`:\s+\S+/);
});
