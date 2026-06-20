import { it, expect } from 'vitest';
import { tool as createTool, RunContext } from '@openai/agents';
import { z } from 'zod';
import {
  repairJson,
  normalizeObjectParams,
  normalizeToolInput,
  toolErrorFunction,
  wrapNeedsApproval,
  wrapToolInvoke,
} from './tool-invoke.js';
import { toolApprovalPolicyRegistry } from '../services/approval/tool-approval-policy-registry.js';

// ---------------------------------------------------------------------------
// repairJson – pass-through for valid / empty input
// ---------------------------------------------------------------------------

it('repairJson returns empty string as-is', () => {
  expect(repairJson('')).toBe('');
});

it('repairJson returns whitespace-only string as-is', () => {
  expect(repairJson('   ')).toBe('   ');
});

it('repairJson returns null/undefined input as-is', () => {
  // @ts-expect-error – testing runtime guard
  expect(repairJson(null)).toBe(null);
  // @ts-expect-error – testing runtime guard
  expect(repairJson(undefined)).toBe(undefined);
});

it('repairJson does not modify already-valid JSON', () => {
  const valid = '{"key": "value", "nested": {"a": 1}}';
  expect(repairJson(valid)).toBe(valid);
});

it('repairJson does not modify valid JSON with escaped quotes', () => {
  const valid = '{"key": "value with \\"escaped\\" quotes"}';
  expect(repairJson(valid)).toBe(valid);
});

it('repairJson does not modify valid JSON arrays', () => {
  const valid = '[1, 2, {"a": "b"}]';
  expect(repairJson(valid)).toBe(valid);
});

// ---------------------------------------------------------------------------
// repairJson – unescaped double quotes inside values
// ---------------------------------------------------------------------------

it('repairJson fixes unescaped double quotes in a single value', () => {
  const broken = '{"search_content": "No results for "searchQuery" found"}';
  const result = repairJson(broken);
  expect(() => JSON.parse(result)).not.toThrow();
  const parsed = JSON.parse(result);
  expect(parsed.search_content).toBe('No results for "searchQuery" found');
});

it('repairJson fixes unescaped quotes across multiple keys', () => {
  const broken = '{"a": "he said "hi"", "b": "ok"}';
  const result = repairJson(broken);
  expect(() => JSON.parse(result)).not.toThrow();
});

// ---------------------------------------------------------------------------
// repairJson – trailing commas
// ---------------------------------------------------------------------------

it('repairJson removes trailing comma in object', () => {
  const broken = '{"a": 1, "b": 2,}';
  const result = repairJson(broken);
  expect(() => JSON.parse(result)).not.toThrow();
  expect(JSON.parse(result)).toEqual({ a: 1, b: 2 });
});

it('repairJson removes trailing comma in array', () => {
  const broken = '[1, 2, 3,]';
  const result = repairJson(broken);
  expect(() => JSON.parse(result)).not.toThrow();
  expect(JSON.parse(result)).toEqual([1, 2, 3]);
});

// ---------------------------------------------------------------------------
// repairJson – markdown code fences
// ---------------------------------------------------------------------------

it('repairJson strips ```json code fences', () => {
  const broken = '```json\n{"command": "ls"}\n```';
  const result = repairJson(broken);
  expect(() => JSON.parse(result)).not.toThrow();
  expect(JSON.parse(result)).toEqual({ command: 'ls' });
});

it('repairJson strips ``` code fences without language tag', () => {
  const broken = '```\n{"command": "ls"}\n```';
  const result = repairJson(broken);
  expect(() => JSON.parse(result)).not.toThrow();
  expect(JSON.parse(result)).toEqual({ command: 'ls' });
});

// ---------------------------------------------------------------------------
// repairJson – JSON extraction from surrounding prose
// ---------------------------------------------------------------------------

it('repairJson extracts JSON from surrounding text', () => {
  const broken = 'Sure! Here is the tool call:\n{"command": "ls -la"}\nLet me know if you need anything else.';
  const result = repairJson(broken);
  expect(() => JSON.parse(result)).not.toThrow();
  expect(JSON.parse(result)).toEqual({ command: 'ls -la' });
});

it('repairJson extracts JSON array from surrounding text', () => {
  const broken = 'The result is: [1, 2, 3] as expected.';
  const result = repairJson(broken);
  expect(() => JSON.parse(result)).not.toThrow();
  expect(JSON.parse(result)).toEqual([1, 2, 3]);
});

// ---------------------------------------------------------------------------
// repairJson – combined fixes
// ---------------------------------------------------------------------------

it('repairJson handles markdown fence + trailing comma', () => {
  const broken = '```json\n{"a": 1, "b": 2,}\n```';
  const result = repairJson(broken);
  expect(() => JSON.parse(result)).not.toThrow();
  expect(JSON.parse(result)).toEqual({ a: 1, b: 2 });
});

it('repairJson escapes raw newlines inside multiline tool arguments', () => {
  const broken = '{"type":"create_file","path":"notes.txt","diff":"+line 1\n+line 2\n"}';
  expect(() => JSON.parse(broken)).toThrow();

  const result = repairJson(broken);

  expect(() => JSON.parse(result)).not.toThrow();
  expect(JSON.parse(result)).toEqual({
    type: 'create_file',
    path: 'notes.txt',
    diff: '+line 1\n+line 2\n',
  });
});

it('repairJson handles prose + unescaped quotes', () => {
  const broken = 'Here you go: {"content": "No results for "query" found"}';
  const result = repairJson(broken);
  expect(() => JSON.parse(result)).not.toThrow();
  const parsed = JSON.parse(result);
  expect(parsed.content).toBe('No results for "query" found');
});

// ---------------------------------------------------------------------------
// repairJson – size guard
// ---------------------------------------------------------------------------

it('repairJson skips repair for payloads exceeding max length', () => {
  // Create a broken JSON string that's very large
  const bigContent = 'x'.repeat(200_001);
  const broken = `{"key": "${bigContent}"}`;
  // Should return as-is without attempting repair
  expect(repairJson(broken)).toBe(broken);
});

// ---------------------------------------------------------------------------
// normalizeToolInput
// ---------------------------------------------------------------------------

it('normalizeToolInput returns repaired JSON for string input', () => {
  const broken = '{"key": "bad "quote" here"}';
  const result = normalizeToolInput(broken);
  expect(() => JSON.parse(result)).not.toThrow();
});

it('normalizeToolInput stringifies object input', () => {
  const result = normalizeToolInput({ a: 1 });
  expect(result).toBe('{"a":1}');
});

it('normalizeToolInput returns {} for un-serializable input', () => {
  const circular: any = {};
  circular.self = circular;
  const result = normalizeToolInput(circular);
  expect(result).toBe('{}');
});

it('normalizeToolInput passes through valid JSON strings', () => {
  const valid = '{"key": "value"}';
  expect(normalizeToolInput(valid)).toBe(valid);
});

it('wrapNeedsApproval interrupts valid calls while registry preserves the original read-only policy', async () => {
  toolApprovalPolicyRegistry.clear();
  const definition = {
    name: 'read_file',
    parameters: z.object({ path: z.string() }),
    needsApproval: async () => false,
  };

  const wrapped = wrapNeedsApproval(definition, {
    toolName: definition.name,
    registry: toolApprovalPolicyRegistry,
  });

  await expect(wrapped({}, { path: 'README.md' })).resolves.toBe(true);
  await expect(
    toolApprovalPolicyRegistry.evaluate({
      toolName: 'read_file',
      args: { path: 'README.md' },
      context: {},
    }),
  ).resolves.toEqual({ kind: 'auto_approve' });
});

it('wrapNeedsApproval still bypasses approval for invalid tool args', async () => {
  const wrapped = wrapNeedsApproval({
    name: 'read_file',
    parameters: z.object({ path: z.string() }),
    needsApproval: async () => false,
  });

  await expect(wrapped({}, { path: 123 })).resolves.toBe(false);
});

it('wrapNeedsApproval still bypasses approval when an interceptor rejects execution', async () => {
  let originalPolicyCalled = false;
  const wrapped = wrapNeedsApproval(
    {
      name: 'shell',
      parameters: z.object({ command: z.string() }),
      needsApproval: async () => {
        originalPolicyCalled = true;
        return true;
      },
    },
    {
      checkInterceptors: async () => 'plan mode blocked this call',
    },
  );

  await expect(wrapped({}, { command: 'touch blocked.txt' })).resolves.toBe(false);
  expect(originalPolicyCalled).toBe(false);
});

// ---------------------------------------------------------------------------
// wrapToolInvoke
// ---------------------------------------------------------------------------

it('wrapToolInvoke stringifies object inputs for tool invocations', async () => {
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

  expect(result).toBe('ok:hi');
});

it('wrapToolInvoke repairs multiline string arguments before SDK validation', async () => {
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

  expect(result).toBe('+line 1\n+line 2\n');
});

it('wrapToolInvoke strict parsing does not repair invalid JSON escapes', async () => {
  const parametersSchema = z.object({
    pattern: z.string(),
  });
  const rawTool = createTool({
    name: 'grep',
    description: 'grep tool',
    parameters: parametersSchema,
    errorFunction: toolErrorFunction,
    execute: async (params) => params.pattern,
  });

  const wrappedTool = wrapToolInvoke(rawTool, parametersSchema, { argumentParsing: 'strict' });
  const result = await wrappedTool.invoke({} as RunContext, String.raw`{"pattern":"\w"}`);

  expect(result).toMatch(/Tool input did not match schema for grep|Tool input was invalid for this tool/);
  expect(result).toMatch(/Retry with/);
});

it('wrapToolInvoke strict parsing accepts standard JSON regex escaping', async () => {
  const parametersSchema = z.object({
    pattern: z.string(),
  });
  const rawTool = createTool({
    name: 'grep',
    description: 'grep tool',
    parameters: parametersSchema,
    errorFunction: toolErrorFunction,
    execute: async (params) => params.pattern,
  });

  const wrappedTool = wrapToolInvoke(rawTool, parametersSchema, { argumentParsing: 'strict' });
  const result = await wrappedTool.invoke({} as RunContext, String.raw`{"pattern":"\\w"}`);

  expect(result).toBe(String.raw`\w`);
});

it('normalizeToolInput with schema filters sentinel values for optional fields', () => {
  const schema = z.object({
    path: z.string(),
    start_line: z.number().optional(),
    end_line: z.number().optional(),
    tags: z.array(z.string()).optional(),
  });

  const input = {
    path: 'README.md',
    start_line: 'None',
    end_line: 'null',
    tags: 'null',
  };

  const result = normalizeToolInput(input, schema);
  expect(JSON.parse(result)).toEqual({ path: 'README.md' });
});

it('normalizeToolInput with schema coerces boolean string inputs', () => {
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
  expect(JSON.parse(result)).toEqual({
    pattern: 'test',
    no_ignore: false,
    case_sensitive: true,
  });
});

// Integration: real createTool + errorFunction + wrapToolInvoke path. When the
// SDK fails schema validation, the diagnostics are surfaced as a NON-FATAL
// result string (not thrown) so the model can self-correct within the turn.
it('wrapToolInvoke surfaces schema diagnostics as a non-fatal result for invalid input', async () => {
  const parametersSchema = z.object({
    pattern: z.string(),
    no_ignore: z.boolean().optional(),
  });
  const rawTool = createTool({
    name: 'grep',
    description: 'grep tool',
    parameters: parametersSchema,
    errorFunction: toolErrorFunction,
    execute: async () => 'ok',
  });

  const wrappedTool = wrapToolInvoke(rawTool, parametersSchema);
  const result = await wrappedTool.invoke({} as RunContext, '{"pattern": "test", "no_ignore": "not-a-bool"}');

  expect(result).toBe(
    'Tool input did not match schema for grep: no_ignore must be boolean, got string "not-a-bool". Retry with valid JSON arguments.',
  );
});

// Regression: tool output that merely *mentions* the validation error must be
// returned verbatim and must NOT be re-interpreted as a validation failure.
it('wrapToolInvoke returns tool output verbatim even when it mentions InvalidToolInputError', async () => {
  const parametersSchema = z.object({ path: z.string() });
  const toolOutput = 'File contents: throw new InvalidToolInputError("Invalid JSON input for tool")';
  const rawTool = createTool({
    name: 'read_file',
    description: 'read file tool',
    parameters: parametersSchema,
    errorFunction: toolErrorFunction,
    execute: async () => toolOutput,
  });

  const wrappedTool = wrapToolInvoke(rawTool, parametersSchema);
  const result = await wrappedTool.invoke({} as RunContext, '{"path": "notes.md"}');

  expect(result).toBe(toolOutput);
});

it('toolErrorFunction rethrows schema-validation errors for diagnostics handling', () => {
  const err = new Error('Invalid JSON input for tool');
  err.name = 'InvalidToolInputError';
  expect(() => toolErrorFunction({} as RunContext, err)).toThrow(err);
});

it('toolErrorFunction rethrows abort errors', () => {
  const err = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
  expect(() => toolErrorFunction({} as RunContext, err)).toThrow(err);
});

it('toolErrorFunction returns a non-fatal message for other runtime errors', () => {
  const result = toolErrorFunction({} as RunContext, new Error('disk on fire'));
  expect(result).toBe('An error occurred while running the tool. Please try again. Error: Error: disk on fire');
});

it('normalizeToolInput with schema coerces stringified array and object inputs', () => {
  const schema = z.object({
    tags: z.array(z.string()).optional(),
    config: z
      .object({
        debug: z.boolean(),
      })
      .optional(),
  });

  const input = {
    tags: '["src", "tests"]',
    config: '{"debug": true}',
  };

  const result = normalizeToolInput(input, schema);
  expect(JSON.parse(result)).toEqual({
    tags: ['src', 'tests'],
    config: { debug: true },
  });
});

it('normalizeToolInput with schema coerces empty stringified array', () => {
  const schema = z.object({
    tags: z.array(z.string()).optional(),
  });

  const input = {
    tags: '[]',
  };

  const result = normalizeToolInput(input, schema);
  expect(JSON.parse(result)).toEqual({
    tags: [],
  });
});

// ---------------------------------------------------------------------------
// normalizeObjectParams
// ---------------------------------------------------------------------------

it('normalizeObjectParams returns null/undefined/non-object unchanged', () => {
  expect(normalizeObjectParams(null)).toBe(null);
  expect(normalizeObjectParams(undefined)).toBe(undefined);
  expect(normalizeObjectParams('hello')).toBe('hello');
  expect(normalizeObjectParams([1, 2])).toEqual([1, 2]);
});

it('normalizeObjectParams returns object unchanged when no schema provided', () => {
  const obj = { a: 1 };
  expect(normalizeObjectParams(obj)).toBe(obj); // same reference
});

it('normalizeObjectParams filters null sentinels on optional fields', () => {
  const schema = z.object({
    name: z.string(),
    count: z.number().optional(),
  });

  const result = normalizeObjectParams({ name: 'test', count: null }, schema) as Record<string, unknown>;
  expect(result).toEqual({ name: 'test' });
  expect('count' in (result as object)).toBe(false);
});

it('normalizeObjectParams coerces boolean strings', () => {
  const schema = z.object({
    flag: z.boolean(),
  });

  const result = normalizeObjectParams({ flag: 'true' }, schema) as Record<string, unknown>;
  expect(result.flag).toBe(true);
});

it('normalizeObjectParams coerces stringified arrays', () => {
  const schema = z.object({
    tags: z.array(z.string()),
  });

  const result = normalizeObjectParams({ tags: '["a","b"]' }, schema) as Record<string, unknown>;
  expect(result.tags).toEqual(['a', 'b']);
});

it('normalizeObjectParams coerces stringified objects', () => {
  const schema = z.object({
    config: z.object({ key: z.string() }),
  });

  const result = normalizeObjectParams({ config: '{"key":"val"}' }, schema) as Record<string, unknown>;
  expect(result.config).toEqual({ key: 'val' });
});

it('normalizeObjectParams returns same reference when no modifications needed', () => {
  const schema = z.object({ name: z.string() });
  const obj = { name: 'test' };
  expect(normalizeObjectParams(obj, schema)).toBe(obj);
});

it('normalizeObjectParams filters string sentinels on optional fields', () => {
  const schema = z.object({
    path: z.string(),
    start: z.number().optional(),
  });

  const result = normalizeObjectParams({ path: '/a', start: 'None' }, schema) as Record<string, unknown>;
  expect('start' in (result as object)).toBe(false);
});

it('normalizeObjectParams filters "undefined" string sentinel on optional fields', () => {
  const schema = z.object({
    path: z.string(),
    code: z.string().optional(),
  });

  const result = normalizeObjectParams({ path: '/a', code: 'undefined' }, schema) as Record<string, unknown>;
  expect('code' in (result as object)).toBe(false);
});
