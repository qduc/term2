import test from 'ava';
import { createRunSubagentToolDefinition, getSubagentsRolesSection } from './run-subagent.js';
import type { SubagentResult } from '../services/subagents/types.js';

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

test('createRunSubagentToolDefinition defines the tool correctly', (t) => {
  const tool = createRunSubagentToolDefinition(async () => makeResult());

  t.is(tool.name, 'run_subagent');
  t.true(tool.description.includes('Delegate'));
  t.is(tool.needsApproval({ role: 'explorer', task: 'test' }, undefined), false);
});

test('schema requires role and task', (t) => {
  const tool = createRunSubagentToolDefinition(async () => makeResult());

  t.true(tool.parameters.safeParse({ role: 'explorer', task: 'find files' }).success);
  t.false(tool.parameters.safeParse({ role: 'explorer' }).success);
  t.false(tool.parameters.safeParse({ task: 'find files' }).success);
});

test('schema rejects unsupported roles', (t) => {
  const tool = createRunSubagentToolDefinition(async () => makeResult());

  for (const role of ['explorer', 'worker', 'researcher', 'mentor']) {
    t.true(tool.parameters.safeParse({ role, task: 'do work' }).success);
  }
  t.false(tool.parameters.safeParse({ role: 'custom', task: 'do work' }).success);
});

test('execute returns plain-text SubagentResult', async (t) => {
  const expected = makeResult({ finalText: 'Answer here.' });
  const tool = createRunSubagentToolDefinition(async () => expected);

  const raw = await tool.execute({ role: 'explorer', task: 'find files' });

  t.true(raw.includes('Status: completed'));
  t.true(raw.includes('Answer here.'));
  t.false(raw.startsWith('{'));
});

test('execute returns failed result as plain text on error', async (t) => {
  const tool = createRunSubagentToolDefinition(async () => {
    throw new Error('Connection failed');
  });

  const raw = await tool.execute({ role: 'explorer', task: 'find files' });

  t.true(raw.includes('Status: failed'));
  t.true(raw.includes('Error: Connection failed'));
  t.false(raw.startsWith('{'));
});

test('execute passes tool invocation details to subagent runner', async (t) => {
  let capturedDetails: unknown;
  const tool = createRunSubagentToolDefinition(async (_params, _context, details) => {
    capturedDetails = details;
    return makeResult();
  });
  const abortController = new AbortController();
  const details = { signal: abortController.signal };

  await tool.execute({ role: 'explorer', task: 'find files' }, undefined, details);

  t.is(capturedDetails, details);
});

test('formatCommandMessage renders completed result', (t) => {
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
  t.is(messages.length, 1);
  t.true(messages[0].command.includes('explorer'));
  t.true(messages[0].command.includes('find files'));
  t.true(messages[0].output.includes('Found 3 relevant files.'));
  t.true(messages[0].success ?? true);
});

test('formatCommandMessage truncates long task in command', (t) => {
  const tool = createRunSubagentToolDefinition(async () => makeResult());
  const longTask = 'a'.repeat(400);

  const item = {
    rawItem: {
      arguments: JSON.stringify({ role: 'explorer', task: longTask }),
      output: 'Status: completed\n\nDone.',
    },
  };

  const messages = tool.formatCommandMessage(item, 0, new Map());
  t.is(messages[0].command.length, 'run_subagent [explorer] '.length + 300);
  t.true(messages[0].command.endsWith('...'));
});

test('formatCommandMessage uses only the first paragraph', (t) => {
  const tool = createRunSubagentToolDefinition(async () => makeResult());
  const taskWithParagraphs = 'First paragraph content.\n\nSecond paragraph content that should be ignored.';

  const item = {
    rawItem: {
      arguments: JSON.stringify({ role: 'explorer', task: taskWithParagraphs }),
      output: 'Status: completed\n\nDone.',
    },
  };

  const messages = tool.formatCommandMessage(item, 0, new Map());
  t.is(messages[0].command, 'run_subagent [explorer] First paragraph content.');
});

test('formatCommandMessage truncates long output', (t) => {
  const longOutput = 'b'.repeat(400);
  const tool = createRunSubagentToolDefinition(async () => makeResult());

  const item = {
    rawItem: {
      arguments: JSON.stringify({ role: 'explorer', task: 'find files' }),
      output: JSON.stringify(makeResult({ finalText: longOutput })),
    },
  };

  const messages = tool.formatCommandMessage(item, 0, new Map());
  t.is(messages[0].output.split('\n')[0].length, 300);
  t.true(messages[0].output.split('\n')[0].endsWith('...'));
});

test('formatCommandMessage uses only the first paragraph of output', (t) => {
  const outputWithParagraphs = 'First output paragraph.\n\nSecond output paragraph.';
  const tool = createRunSubagentToolDefinition(async () => makeResult());

  const item = {
    rawItem: {
      arguments: JSON.stringify({ role: 'explorer', task: 'find files' }),
      output: JSON.stringify(makeResult({ finalText: outputWithParagraphs })),
    },
  };

  const messages = tool.formatCommandMessage(item, 0, new Map());
  t.is(messages[0].output.split('\n')[0], 'First output paragraph.');
});

test('formatCommandMessage renders failed result', (t) => {
  const result = makeResult({ status: 'failed', error: 'Role not found', finalText: '' });
  const tool = createRunSubagentToolDefinition(async () => result);

  const item = {
    rawItem: {
      arguments: JSON.stringify({ role: 'bad-role', task: 'do stuff' }),
      output: 'Status: failed\nError: Role not found',
    },
  };

  const messages = tool.formatCommandMessage(item, 0, new Map());
  t.is(messages.length, 1);
  t.false(messages[0].success!);
});

test('formatCommandMessage includes tool usage summary', (t) => {
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
  t.true(messages[0].output.includes('read_file(5)'));
  t.true(messages[0].output.includes('grep(2)'));
});

test('formatCommandMessage includes files changed summary for worker', (t) => {
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
  t.true(messages[0].output.includes('src/foo.ts'));
  t.true(messages[0].output.includes('src/bar.ts'));
});

test('getSubagentsRolesSection extracts descriptions from markdown files', (t) => {
  const section = getSubagentsRolesSection();

  t.true(section.includes('## Roles'));
  t.true(section.includes('`explorer`'));
  t.true(section.includes('`mentor`'));
  t.true(section.includes('`researcher`'));
  t.true(section.includes('`worker`'));

  t.regex(section, /-\s+`explorer`:\s+\S+/);
  t.regex(section, /-\s+`mentor`:\s+\S+/);
  t.regex(section, /-\s+`researcher`:\s+\S+/);
  t.regex(section, /-\s+`worker`:\s+\S+/);
});
