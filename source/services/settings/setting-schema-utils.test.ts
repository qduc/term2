import { it, expect } from 'vitest';
import { z } from 'zod';
import { resolveSettingAtPath, unwrapSchema } from './setting-schema-utils.js';

it('unwrapSchema returns the inner type of .optional()', () => {
  const schema = z.string().optional();
  const result = unwrapSchema(schema);
  expect(result).toBeInstanceOf(z.ZodString);
});

it('unwrapSchema returns the inner type of .nullable()', () => {
  const schema = z.string().nullable();
  const result = unwrapSchema(schema);
  expect(result).toBeInstanceOf(z.ZodString);
});

it('unwrapSchema returns the inner type of .default()', () => {
  const schema = z.string().default('hello');
  const result = unwrapSchema(schema);
  expect(result).toBeInstanceOf(z.ZodString);
});

it('unwrapSchema handles chained wrappers', () => {
  const schema = z.number().optional().default(42);
  const result = unwrapSchema(schema);
  expect(result).toBeInstanceOf(z.ZodNumber);
});

it('unwrapSchema returns non-wrapped schemas unchanged', () => {
  const schema = z.string();
  const result = unwrapSchema(schema);
  expect(result).toBeInstanceOf(z.ZodString);
});

it('unwrapSchema handles .transform() (ZodPipe in Zod v4)', () => {
  const schema = z.string().transform((v) => v.toUpperCase());
  const result = unwrapSchema(schema);
  expect(result).toBeInstanceOf(z.ZodString);
});

it('unwrapSchema handles null/undefined input gracefully', () => {
  expect(unwrapSchema(null)).toBeNull();
  expect(unwrapSchema(undefined)).toBeUndefined();
});

it('resolveSettingAtPath returns string schema for agent.model (after unwrap)', () => {
  const result = resolveSettingAtPath('agent.model');
  const unwrapped = unwrapSchema(result);
  expect(unwrapped).toBeInstanceOf(z.ZodString);
});

it('resolveSettingAtPath returns enum schema for agent.reasoningEffort (after unwrap)', () => {
  const result = resolveSettingAtPath('agent.reasoningEffort');
  const unwrapped = unwrapSchema(result);
  expect(unwrapped).toBeInstanceOf(z.ZodEnum);
});

it('resolveSettingAtPath returns number schema for agent.temperature (after unwrap)', () => {
  const result = resolveSettingAtPath('agent.temperature');
  const unwrapped = unwrapSchema(result);
  expect(unwrapped).toBeInstanceOf(z.ZodNumber);
});

it('resolveSettingAtPath returns number schema for shell.timeout (after unwrap)', () => {
  const result = resolveSettingAtPath('shell.timeout');
  const unwrapped = unwrapSchema(result);
  expect(unwrapped).toBeInstanceOf(z.ZodNumber);
});

it('resolveSettingAtPath returns boolean schema for logging.suppressConsoleOutput (after unwrap)', () => {
  const result = resolveSettingAtPath('logging.suppressConsoleOutput');
  const unwrapped = unwrapSchema(result);
  expect(unwrapped).toBeInstanceOf(z.ZodBoolean);
});

it('resolveSettingAtPath returns number schema for ssh.port (after unwrap)', () => {
  const result = resolveSettingAtPath('ssh.port');
  const unwrapped = unwrapSchema(result);
  expect(unwrapped).toBeInstanceOf(z.ZodNumber);
});

it('resolveSettingAtPath handles nested keys like webSearch.tavily.apiKey', () => {
  const result = resolveSettingAtPath('webSearch.tavily.apiKey');
  const unwrapped = unwrapSchema(result);
  expect(unwrapped).toBeInstanceOf(z.ZodString);
});

it('resolveSettingAtPath returns undefined for unknown key', () => {
  const result = resolveSettingAtPath('nonexistent.key');
  expect(result).toBeUndefined();
});

it('resolveSettingAtPath returns undefined for empty string', () => {
  const result = resolveSettingAtPath('');
  expect(result).toBeUndefined();
});

it('resolveSettingAtPath navigates through optional wrapper objects', () => {
  // agent.openrouter is .optional() on the parent object
  const result = resolveSettingAtPath('agent.openrouter.apiKey');
  const unwrapped = unwrapSchema(result);
  expect(unwrapped).toBeInstanceOf(z.ZodString);
});

it('unwrapSchema and resolveSettingAtPath agree on type for all simple settings', () => {
  const cases: Array<{ key: string; expectedCtor: new (...args: any[]) => any }> = [
    { key: 'agent.model', expectedCtor: z.ZodString },
    { key: 'shell.timeout', expectedCtor: z.ZodNumber },
    { key: 'logging.logLevel', expectedCtor: z.ZodEnum },
    { key: 'app.mentorMode', expectedCtor: z.ZodBoolean },
  ];

  for (const { key, expectedCtor } of cases) {
    const result = resolveSettingAtPath(key);
    const unwrapped = unwrapSchema(result);
    expect(unwrapped).toBeInstanceOf(expectedCtor);
  }
});
