import test from 'ava';
import { clearToolFormatters, getToolFormatter, registerToolFormatters } from './command-message-formatters.js';
import type { ToolDefinition } from './types.js';

test.beforeEach(() => {
  clearToolFormatters();
});

test.afterEach(() => {
  clearToolFormatters();
});

test('registerToolFormatters indexes formatter by tool name', (t) => {
  const formatter = () => [];
  const tool = {
    name: 'example_tool',
    formatCommandMessage: formatter,
  } as Partial<ToolDefinition> as ToolDefinition;

  registerToolFormatters([tool]);

  t.is(getToolFormatter('example_tool'), formatter);
});

test('registry has no built-in formatters before registration', (t) => {
  t.is(getToolFormatter('shell'), undefined);
  t.is(getToolFormatter('web_search'), undefined);
  t.is(getToolFormatter('unknown_tool'), undefined);
});
