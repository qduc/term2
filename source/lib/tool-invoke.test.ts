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
