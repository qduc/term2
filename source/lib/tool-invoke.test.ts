import test from 'ava';
import { tool as createTool, RunContext } from '@openai/agents';
import { z } from 'zod';
import { repairJson, normalizeToolInput, wrapToolInvoke } from './tool-invoke.js';

// ---------------------------------------------------------------------------
// repairJson – pass-through for valid / empty input
// ---------------------------------------------------------------------------

test('repairJson returns empty string as-is', (t) => {
  t.is(repairJson(''), '');
});

test('repairJson returns whitespace-only string as-is', (t) => {
  t.is(repairJson('   '), '   ');
});

test('repairJson returns null/undefined input as-is', (t) => {
  // @ts-expect-error – testing runtime guard
  t.is(repairJson(null), null);
  // @ts-expect-error – testing runtime guard
  t.is(repairJson(undefined), undefined);
});

test('repairJson does not modify already-valid JSON', (t) => {
  const valid = '{"key": "value", "nested": {"a": 1}}';
  t.is(repairJson(valid), valid);
});

test('repairJson does not modify valid JSON with escaped quotes', (t) => {
  const valid = '{"key": "value with \\"escaped\\" quotes"}';
  t.is(repairJson(valid), valid);
});

test('repairJson does not modify valid JSON arrays', (t) => {
  const valid = '[1, 2, {"a": "b"}]';
  t.is(repairJson(valid), valid);
});

// ---------------------------------------------------------------------------
// repairJson – unescaped double quotes inside values
// ---------------------------------------------------------------------------

test('repairJson fixes unescaped double quotes in a single value', (t) => {
  const broken = '{"search_content": "No results for "searchQuery" found"}';
  const result = repairJson(broken);
  t.notThrows(() => JSON.parse(result));
  const parsed = JSON.parse(result);
  t.is(parsed.search_content, 'No results for "searchQuery" found');
});

test('repairJson fixes unescaped quotes across multiple keys', (t) => {
  const broken = '{"a": "he said "hi"", "b": "ok"}';
  const result = repairJson(broken);
  t.notThrows(() => JSON.parse(result));
});

// ---------------------------------------------------------------------------
// repairJson – trailing commas
// ---------------------------------------------------------------------------

test('repairJson removes trailing comma in object', (t) => {
  const broken = '{"a": 1, "b": 2,}';
  const result = repairJson(broken);
  t.notThrows(() => JSON.parse(result));
  t.deepEqual(JSON.parse(result), { a: 1, b: 2 });
});

test('repairJson removes trailing comma in array', (t) => {
  const broken = '[1, 2, 3,]';
  const result = repairJson(broken);
  t.notThrows(() => JSON.parse(result));
  t.deepEqual(JSON.parse(result), [1, 2, 3]);
});

// ---------------------------------------------------------------------------
// repairJson – markdown code fences
// ---------------------------------------------------------------------------

test('repairJson strips ```json code fences', (t) => {
  const broken = '```json\n{"command": "ls"}\n```';
  const result = repairJson(broken);
  t.notThrows(() => JSON.parse(result));
  t.deepEqual(JSON.parse(result), { command: 'ls' });
});

test('repairJson strips ``` code fences without language tag', (t) => {
  const broken = '```\n{"command": "ls"}\n```';
  const result = repairJson(broken);
  t.notThrows(() => JSON.parse(result));
  t.deepEqual(JSON.parse(result), { command: 'ls' });
});

// ---------------------------------------------------------------------------
// repairJson – JSON extraction from surrounding prose
// ---------------------------------------------------------------------------

test('repairJson extracts JSON from surrounding text', (t) => {
  const broken = 'Sure! Here is the tool call:\n{"command": "ls -la"}\nLet me know if you need anything else.';
  const result = repairJson(broken);
  t.notThrows(() => JSON.parse(result));
  t.deepEqual(JSON.parse(result), { command: 'ls -la' });
});

test('repairJson extracts JSON array from surrounding text', (t) => {
  const broken = 'The result is: [1, 2, 3] as expected.';
  const result = repairJson(broken);
  t.notThrows(() => JSON.parse(result));
  t.deepEqual(JSON.parse(result), [1, 2, 3]);
});

// ---------------------------------------------------------------------------
// repairJson – combined fixes
// ---------------------------------------------------------------------------

test('repairJson handles markdown fence + trailing comma', (t) => {
  const broken = '```json\n{"a": 1, "b": 2,}\n```';
  const result = repairJson(broken);
  t.notThrows(() => JSON.parse(result));
  t.deepEqual(JSON.parse(result), { a: 1, b: 2 });
});

test('repairJson escapes raw newlines inside multiline tool arguments', (t) => {
  const broken = '{"type":"create_file","path":"notes.txt","diff":"+line 1\n+line 2\n"}';
  t.throws(() => JSON.parse(broken));

  const result = repairJson(broken);

  t.notThrows(() => JSON.parse(result));
  t.deepEqual(JSON.parse(result), {
    type: 'create_file',
    path: 'notes.txt',
    diff: '+line 1\n+line 2\n',
  });
});

test('repairJson handles prose + unescaped quotes', (t) => {
  const broken = 'Here you go: {"content": "No results for "query" found"}';
  const result = repairJson(broken);
  t.notThrows(() => JSON.parse(result));
  const parsed = JSON.parse(result);
  t.is(parsed.content, 'No results for "query" found');
});

// ---------------------------------------------------------------------------
// repairJson – size guard
// ---------------------------------------------------------------------------

test('repairJson skips repair for payloads exceeding max length', (t) => {
  // Create a broken JSON string that's very large
  const bigContent = 'x'.repeat(200_001);
  const broken = `{"key": "${bigContent}"}`;
  // Should return as-is without attempting repair
  t.is(repairJson(broken), broken);
});

// ---------------------------------------------------------------------------
// normalizeToolInput
// ---------------------------------------------------------------------------

test('normalizeToolInput returns repaired JSON for string input', (t) => {
  const broken = '{"key": "bad "quote" here"}';
  const result = normalizeToolInput(broken);
  t.notThrows(() => JSON.parse(result));
});

test('normalizeToolInput stringifies object input', (t) => {
  const result = normalizeToolInput({ a: 1 });
  t.is(result, '{"a":1}');
});

test('normalizeToolInput returns {} for un-serializable input', (t) => {
  const circular: any = {};
  circular.self = circular;
  const result = normalizeToolInput(circular);
  t.is(result, '{}');
});

test('normalizeToolInput passes through valid JSON strings', (t) => {
  const valid = '{"key": "value"}';
  t.is(normalizeToolInput(valid), valid);
});

// ---------------------------------------------------------------------------
// wrapToolInvoke
// ---------------------------------------------------------------------------

test('wrapToolInvoke stringifies object inputs for tool invocations', async (t) => {
  const rawTool = createTool({
    name: 'echo_tool',
    description: 'A test tool that echoes the input value',
    parameters: z.object({
      value: z.string(),
    }),
    strict: true,
    execute: async (params) => `ok:${params.value}`,
  });

  const wrappedTool = wrapToolInvoke(rawTool);
  const result = await wrappedTool.invoke({} as RunContext, '{"value":"hi"}');

  t.is(result, 'ok:hi');
});

test('wrapToolInvoke repairs multiline string arguments before SDK validation', async (t) => {
  const rawTool = createTool({
    name: 'patch_like_tool',
    description: 'A test tool with a multiline diff argument',
    parameters: z.object({
      diff: z.string(),
    }),
    strict: true,
    execute: async (params) => params.diff,
  });

  const wrappedTool = wrapToolInvoke(rawTool);
  const result = await wrappedTool.invoke({} as RunContext, '{"diff":"+line 1\n+line 2\n"}');

  t.is(result, '+line 1\n+line 2\n');
});

test('normalizeToolInput with schema filters sentinel values for optional fields', (t) => {
  const schema = z.object({
    path: z.string(),
    start_line: z.number().optional(),
    end_line: z.number().optional(),
    writeBoundary: z.array(z.string()).optional(),
  });

  const input = {
    path: 'README.md',
    start_line: 'None',
    end_line: 'null',
    writeBoundary: 'null',
  };

  const result = normalizeToolInput(input, schema);
  t.deepEqual(JSON.parse(result), { path: 'README.md' });
});

test('normalizeToolInput with schema coerces boolean string inputs', (t) => {
  const schema = z.object({
    pattern: z.string(),
    no_ignore: z.boolean().optional(),
    case_sensitive: z.boolean(),
  });

  const input = {
    pattern: 'test',
    no_ignore: 'false',
    case_sensitive: 'TRUE',
  };

  const result = normalizeToolInput(input, schema);
  t.deepEqual(JSON.parse(result), {
    pattern: 'test',
    no_ignore: false,
    case_sensitive: true,
  });
});

test('wrapToolInvoke intercepts InvalidToolInputError exception and formats diagnostics', async (t) => {
  const parametersSchema = z.object({
    pattern: z.string(),
    no_ignore: z.boolean().optional(),
  });
  const rawTool = createTool({
    name: 'grep',
    description: 'grep tool',
    parameters: parametersSchema,
    execute: async () => 'ok',
  });

  rawTool.invoke = async (_context, _input, _details) => {
    const err = new Error('Invalid JSON input for tool');
    err.name = 'InvalidToolInputError';
    throw err;
  };

  const wrappedTool = wrapToolInvoke(rawTool, parametersSchema);
  const err = await t.throwsAsync(() =>
    wrappedTool.invoke({} as RunContext, '{"pattern": "test", "no_ignore": "not-a-bool"}'),
  );
  t.is(
    err?.message,
    'Tool input did not match schema for grep: no_ignore must be boolean, got string "not-a-bool". Retry with valid JSON arguments.',
  );
});
test('wrapToolInvoke intercepts InvalidToolInputError result string and formats diagnostics', async (t) => {
  const parametersSchema = z.object({
    pattern: z.string(),
    no_ignore: z.boolean().optional(),
  });
  const rawTool = createTool({
    name: 'grep',
    description: 'grep tool',
    parameters: parametersSchema,
    execute: async () => 'ok',
  });

  rawTool.invoke = async (_context, _input, _details) => {
    return 'An error occurred while running the tool. Please try again. Error: InvalidToolInputError: Invalid JSON input for tool';
  };

  const wrappedTool = wrapToolInvoke(rawTool, parametersSchema);

  const result = await wrappedTool.invoke({} as RunContext, '{"pattern": "test", "no_ignore": "not-a-bool"}');
  t.is(
    result,
    'Tool input did not match schema for grep: no_ignore must be boolean, got string "not-a-bool". Retry with valid JSON arguments.',
  );
});
