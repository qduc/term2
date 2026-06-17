import { it, expect } from 'vitest';
import { createRunSubagentToolDefinition, getSubagentsRolesSection } from './run-subagent.js';
import type { SubagentResult } from '../../services/subagents/types.js';

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

it('schema requires role and task', () => {
  const tool = createRunSubagentToolDefinition(async () => makeResult());

  expect(tool.parameters.safeParse({ role: 'explorer', task: 'find files' }).success).toBe(true);
  expect(tool.parameters.safeParse({ role: 'explorer' }).success).toBe(false);
  expect(tool.parameters.safeParse({ task: 'find files' }).success).toBe(false);
});

it('schema rejects unsupported roles', () => {
  const tool = createRunSubagentToolDefinition(async () => makeResult());

  for (const role of ['explorer', 'worker', 'researcher', 'mentor']) {
    expect(tool.parameters.safeParse({ role, task: 'do work' }).success).toBe(true);
  }
  expect(tool.parameters.safeParse({ role: 'custom', task: 'do work' }).success).toBe(false);
});

it('execute returns plain-text SubagentResult', async () => {
  const expected = makeResult({ finalText: 'Answer here.' });
  const tool = createRunSubagentToolDefinition(async () => expected);

  const raw = await tool.execute({ role: 'explorer', task: 'find files' });

  expect(raw.includes('Status: completed')).toBe(true);
  expect(raw.includes('Answer here.')).toBe(true);
  expect(raw.startsWith('{')).toBe(false);
});

it('execute returns failed result as plain text on error', async () => {
  const tool = createRunSubagentToolDefinition(async () => {
    throw new Error('Connection failed');
  });

  const raw = await tool.execute({ role: 'explorer', task: 'find files' });

  expect(raw.includes('Status: failed')).toBe(true);
  expect(raw.includes('Error: Connection failed')).toBe(true);
  expect(raw.startsWith('{')).toBe(false);
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
  expect(section.includes('`researcher`')).toBe(true);
  expect(section.includes('`worker`')).toBe(true);

  expect(section).toMatch(/-\s+`explorer`:\s+\S+/);
  expect(section).toMatch(/-\s+`mentor`:\s+\S+/);
  expect(section).toMatch(/-\s+`researcher`:\s+\S+/);
  expect(section).toMatch(/-\s+`worker`:\s+\S+/);
});
