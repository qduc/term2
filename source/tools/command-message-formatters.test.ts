import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { clearToolFormatters, getToolFormatter, registerToolFormatters } from './command-message-formatters.js';
import type { ToolDefinition } from './types.js';

beforeEach(() => {
  clearToolFormatters();
});

afterEach(() => {
  clearToolFormatters();
});

it('registerToolFormatters indexes formatter by tool name', () => {
  const formatter = () => [];
  const tool = {
    name: 'example_tool',
    formatCommandMessage: formatter,
  } as Partial<ToolDefinition> as ToolDefinition;

  registerToolFormatters([tool]);

  expect(getToolFormatter('example_tool')).toBe(formatter);
});

it('registry has no built-in formatters before registration', () => {
  expect(getToolFormatter('shell')).toBe(undefined);
  expect(getToolFormatter('web_search')).toBe(undefined);
  expect(getToolFormatter('unknown_tool')).toBe(undefined);
});
