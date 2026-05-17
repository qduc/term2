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

test('schema allows optional writeBoundary', (t) => {
  const tool = createRunSubagentToolDefinition(async () => makeResult());

  t.true(
    tool.parameters.safeParse({
      role: 'worker',
      task: 'edit files',
      writeBoundary: ['src/', 'tests/'],
    }).success,
  );
  t.true(tool.parameters.safeParse({ role: 'worker', task: 'edit files' }).success);
});

test('execute returns JSON-serialized SubagentResult', async (t) => {
  const expected = makeResult({ finalText: 'Answer here.' });
  const tool = createRunSubagentToolDefinition(async () => expected);

  const raw = await tool.execute({ role: 'explorer', task: 'find files' });
  const parsed = JSON.parse(raw);

  t.is(parsed.status, 'completed');
  t.is(parsed.role, 'explorer');
  t.is(parsed.finalText, 'Answer here.');
});

test('execute returns failed result on error', async (t) => {
  const tool = createRunSubagentToolDefinition(async () => {
    throw new Error('Connection failed');
  });

  const raw = await tool.execute({ role: 'explorer', task: 'find files' });
  const parsed = JSON.parse(raw);

  t.is(parsed.status, 'failed');
  t.is(parsed.error, 'Connection failed');
});

test('execute passes writeBoundary to subagent runner', async (t) => {
  let capturedParams: any = null;
  const tool = createRunSubagentToolDefinition(async (params) => {
    capturedParams = params;
    return makeResult();
  });

  await tool.execute({ role: 'worker', task: 'update file', writeBoundary: ['src/'] });

  t.deepEqual(capturedParams.writeBoundary, ['src/']);
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
      output: JSON.stringify(result),
    },
  };

  const messages = tool.formatCommandMessage(item, 0, new Map());
  t.is(messages.length, 1);
  t.true(messages[0].command.includes('explorer'));
  t.true(messages[0].output.includes('Found 3 relevant files.'));
  t.true(messages[0].success ?? true);
});

test('formatCommandMessage renders failed result', (t) => {
  const result = makeResult({ status: 'failed', error: 'Role not found', finalText: '' });
  const tool = createRunSubagentToolDefinition(async () => result);

  const item = {
    rawItem: {
      arguments: JSON.stringify({ role: 'bad-role', task: 'do stuff' }),
      output: JSON.stringify(result),
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
      output: JSON.stringify(result),
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
      output: JSON.stringify(result),
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
  t.true(section.includes('read-only workspace access. Use for locating files and answering codebase questions.'));
  t.true(section.includes('`mentor`'));
  t.true(section.includes('advisory only, no workspace access. Use for technical advice.'));
  t.true(section.includes('`researcher`'));
  t.true(
    section.includes('web search + read-only workspace. Use for looking up external docs or current information.'),
  );
  t.true(section.includes('`worker`'));
  t.true(section.includes('read + write access. Use for implementing bounded file changes.'));
});

test('createRunSubagentToolDefinition includes dynamic roles description', (t) => {
  const tool = createRunSubagentToolDefinition(async () => makeResult());

  t.true(tool.description.includes('## Roles'));
  t.true(tool.description.includes('`explorer`'));
  t.true(
    tool.description.includes('read-only workspace access. Use for locating files and answering codebase questions.'),
  );
});
