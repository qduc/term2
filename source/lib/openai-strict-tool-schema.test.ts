import test from 'ava';
import { z } from 'zod';
import { toOpenAIStrictToolSchema } from './openai-strict-tool-schema.js';

test('toOpenAIStrictToolSchema converts optional fields to nullable default null', (t) => {
  const schema = z.object({
    command: z.string(),
    timeout_ms: z.number().int().positive().optional().describe('timeout'),
  });

  const transformed = toOpenAIStrictToolSchema(schema);
  const parsed = transformed.safeParse({ command: 'echo hi' });
  t.true(parsed.success);
  if (parsed.success) {
    t.is((parsed.data as any).timeout_ms, null);
  }

  t.true(transformed.safeParse({ command: 'echo hi', timeout_ms: null }).success);
  t.true(transformed.safeParse({ command: 'echo hi', timeout_ms: 1000 }).success);
});

test('toOpenAIStrictToolSchema leaves schema unchanged when there are no optional fields', (t) => {
  const schema = z.object({
    command: z.string(),
  });

  const transformed = toOpenAIStrictToolSchema(schema);
  t.is(transformed, schema);
  t.true(transformed.safeParse({ command: 'echo hi' }).success);
});
