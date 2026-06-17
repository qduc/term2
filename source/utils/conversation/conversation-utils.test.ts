import { it, expect } from 'vitest';
import {
  parseToolArguments,
  formatToolCommand,
  createStreamingState,
  enhanceApiKeyError,
  isMaxTurnsError,
  createShellMessageOutput,
} from './conversation-utils.js';
import { TOOL_NAME_APPLY_PATCH, TOOL_NAME_SEARCH_REPLACE } from '../../tools/tool-names.js';

// =============================================================================
// parseToolArguments tests
// =============================================================================

it('parseToolArguments: returns object as-is', () => {
  const args = { command: 'echo hi' };
  expect(parseToolArguments(args)).toEqual(args);
});

it('parseToolArguments: parses valid JSON string', () => {
  const args = '{"command": "echo hi"}';
  expect(parseToolArguments(args)).toEqual({ command: 'echo hi' });
});

it('parseToolArguments: returns invalid JSON string as-is', () => {
  const args = 'not valid json';
  expect(parseToolArguments(args)).toBe(args);
});

it('parseToolArguments: returns empty string as-is', () => {
  expect(parseToolArguments('')).toBe('');
});

it('parseToolArguments: returns whitespace-only string as-is', () => {
  expect(parseToolArguments('   ')).toBe('   ');
});

it('parseToolArguments: handles null', () => {
  expect(parseToolArguments(null)).toBe(null);
});

it('parseToolArguments: handles undefined', () => {
  expect(parseToolArguments(undefined)).toBe(undefined);
});

it('parseToolArguments: parses array JSON', () => {
  const args = '["a", "b", "c"]';
  expect(parseToolArguments(args)).toEqual(['a', 'b', 'c']);
});

// =============================================================================
// formatToolCommand tests
// =============================================================================

it('formatToolCommand: shell with string command', () => {
  const result = formatToolCommand('shell', { command: 'echo hello' });
  expect(result).toBe('echo hello');
});

it('formatToolCommand: shell with commands (plural) string', () => {
  const result = formatToolCommand('shell', { commands: 'ls -la' });
  expect(result).toBe('ls -la');
});

it('formatToolCommand: shell with array commands', () => {
  const result = formatToolCommand('shell', { commands: ['cd /tmp', 'ls'] });
  expect(result).toBe('cd /tmp\nls');
});

it('formatToolCommand: shell with empty command returns tool name', () => {
  const result = formatToolCommand('shell', { command: '' });
  expect(result).toBe('shell');
});

it('formatToolCommand: grep with pattern and path', () => {
  const result = formatToolCommand('grep', {
    pattern: 'TODO',
    path: 'src/',
  });
  expect(result).toBe('grep "TODO" src/');
});

it('formatToolCommand: grep with pattern only uses default path', () => {
  const result = formatToolCommand('grep', { pattern: 'FIXME' });
  expect(result).toBe('grep "FIXME" .');
});

it('formatToolCommand: grep without pattern returns tool name', () => {
  const result = formatToolCommand('grep', {});
  expect(result).toBe('grep');
});

it('formatToolCommand: search_replace with all args', () => {
  const result = formatToolCommand(TOOL_NAME_SEARCH_REPLACE, {
    search_content: 'old',
    replace_content: 'new',
    path: 'file.ts',
  });
  expect(result).toBe('search_replace "old" → "new" file.ts');
});

it('formatToolCommand: search_replace with missing args', () => {
  const result = formatToolCommand(TOOL_NAME_SEARCH_REPLACE, {});
  expect(result).toBe('search_replace "" → "" ');
});

it('formatToolCommand: apply_patch with type and path', () => {
  const result = formatToolCommand(TOOL_NAME_APPLY_PATCH, {
    type: 'create',
    path: 'newfile.ts',
  });
  expect(result).toBe('apply_patch create newfile.ts');
});

it('formatToolCommand: apply_patch with missing args', () => {
  const result = formatToolCommand(TOOL_NAME_APPLY_PATCH, {});
  expect(result).toBe('apply_patch unknown ');
});

it('formatToolCommand: ask_mentor with question', () => {
  const result = formatToolCommand('ask_mentor', {
    question: 'How do I refactor this?',
  });
  expect(result).toBe('ask_mentor: How do I refactor this?');
});

it('formatToolCommand: ask_mentor with empty question', () => {
  const result = formatToolCommand('ask_mentor', {});
  expect(result).toBe('ask_mentor: ');
});

it('formatToolCommand: unknown tool returns tool name', () => {
  const result = formatToolCommand('custom_tool', { foo: 'bar' });
  expect(result).toBe('custom_tool');
});

it('formatToolCommand: handles null/undefined args', () => {
  const result = formatToolCommand('shell', null as any);
  expect(result).toBe('shell');
});

// =============================================================================
// createStreamingState tests
// =============================================================================

it('createStreamingState: returns correct initial values', () => {
  const state = createStreamingState();
  expect(state.accumulatedText).toBe('');
  expect(state.accumulatedReasoningText).toBe('');
  expect(state.flushedReasoningLength).toBe(0);
  expect(state.textWasFlushed).toBe(false);
  expect(state.currentReasoningMessageId).toBe(null);
});

it('createStreamingState: returns new object each call', () => {
  const state1 = createStreamingState();
  const state2 = createStreamingState();
  expect(state1).not.toBe(state2);
});

// =============================================================================
// enhanceApiKeyError tests
// =============================================================================

it('enhanceApiKeyError: enhances OPENAI_API_KEY message', () => {
  const result = enhanceApiKeyError('Missing OPENAI_API_KEY');
  expect(result.includes('OpenAI API key is not configured')).toBe(true);
  expect(result.includes('platform.openai.com/api-keys')).toBe(true);
});

it('enhanceApiKeyError: enhances 401 unauthorized message', () => {
  const result = enhanceApiKeyError('Error 401: Unauthorized access');
  expect(result.includes('OpenAI API key is not configured')).toBe(true);
});

it('enhanceApiKeyError: passes through other errors', () => {
  const result = enhanceApiKeyError('Network timeout');
  expect(result).toBe('Network timeout');
});

it('enhanceApiKeyError: handles empty string', () => {
  const result = enhanceApiKeyError('');
  expect(result).toBe('');
});

// =============================================================================
// isMaxTurnsError tests
// =============================================================================

it('isMaxTurnsError: returns true for max turns exceeded', () => {
  expect(isMaxTurnsError('Max turns (10) exceeded')).toBe(true);
});

it('isMaxTurnsError: returns false for partial match - only Max turns', () => {
  expect(isMaxTurnsError('Max turns reached')).toBe(false);
});

it('isMaxTurnsError: returns false for partial match - only exceeded', () => {
  expect(isMaxTurnsError('Rate limit exceeded')).toBe(false);
});

it('isMaxTurnsError: returns false for unrelated message', () => {
  expect(isMaxTurnsError('Something went wrong')).toBe(false);
});

it('isMaxTurnsError: returns false for empty string', () => {
  expect(isMaxTurnsError('')).toBe(false);
});

// =============================================================================
// createShellMessageOutput tests
// =============================================================================

it('createShellMessageOutput: stdout only', () => {
  const result = createShellMessageOutput(0, 'hello world', '');
  expect(result).toBe('hello world\n\nReturn code: 0');
});

it('createShellMessageOutput: stderr only', () => {
  const result = createShellMessageOutput(1, '', 'error occurred');
  expect(result).toBe('error occurred\n\nReturn code: 1');
});

it('createShellMessageOutput: both stdout and stderr', () => {
  const result = createShellMessageOutput(0, 'output', 'warning');
  expect(result).toBe('output\nwarning\n\nReturn code: 0');
});

it('createShellMessageOutput: null return code', () => {
  const result = createShellMessageOutput(null, 'output', '');
  expect(result).toBe('output');
});

it('createShellMessageOutput: empty output with return code', () => {
  const result = createShellMessageOutput(0, '', '');
  expect(result).toBe('\n\nReturn code: 0');
});

it('createShellMessageOutput: trims trailing newlines from stdout', () => {
  const result = createShellMessageOutput(0, 'hello\n\n', '');
  expect(result).toBe('hello\n\nReturn code: 0');
});
