import test from 'ava';
import {
  parseToolArguments,
  formatToolCommand,
  createStreamingState,
  enhanceApiKeyError,
  isMaxTurnsError,
  createShellMessageOutput,
} from './conversation-utils.js';

// =============================================================================
// parseToolArguments tests
// =============================================================================

test('parseToolArguments: returns object as-is', (t) => {
  const args = { command: 'echo hi' };
  t.deepEqual(parseToolArguments(args), args);
});

test('parseToolArguments: parses valid JSON string', (t) => {
  const args = '{"command": "echo hi"}';
  t.deepEqual(parseToolArguments(args), { command: 'echo hi' });
});

test('parseToolArguments: returns invalid JSON string as-is', (t) => {
  const args = 'not valid json';
  t.is(parseToolArguments(args), args);
});

test('parseToolArguments: returns empty string as-is', (t) => {
  t.is(parseToolArguments(''), '');
});

test('parseToolArguments: returns whitespace-only string as-is', (t) => {
  t.is(parseToolArguments('   '), '   ');
});

test('parseToolArguments: handles null', (t) => {
  t.is(parseToolArguments(null), null);
});

test('parseToolArguments: handles undefined', (t) => {
  t.is(parseToolArguments(undefined), undefined);
});

test('parseToolArguments: parses array JSON', (t) => {
  const args = '["a", "b", "c"]';
  t.deepEqual(parseToolArguments(args), ['a', 'b', 'c']);
});

// =============================================================================
// formatToolCommand tests
// =============================================================================

test('formatToolCommand: shell with string command', (t) => {
  const result = formatToolCommand('shell', { command: 'echo hello' });
  t.is(result, 'echo hello');
});

test('formatToolCommand: shell with commands (plural) string', (t) => {
  const result = formatToolCommand('shell', { commands: 'ls -la' });
  t.is(result, 'ls -la');
});

test('formatToolCommand: shell with array commands', (t) => {
  const result = formatToolCommand('shell', { commands: ['cd /tmp', 'ls'] });
  t.is(result, 'cd /tmp\nls');
});

test('formatToolCommand: shell with empty command returns tool name', (t) => {
  const result = formatToolCommand('shell', { command: '' });
  t.is(result, 'shell');
});

test('formatToolCommand: grep with pattern and path', (t) => {
  const result = formatToolCommand('grep', {
    pattern: 'TODO',
    path: 'src/',
  });
  t.is(result, 'grep "TODO" src/');
});

test('formatToolCommand: grep with pattern only uses default path', (t) => {
  const result = formatToolCommand('grep', { pattern: 'FIXME' });
  t.is(result, 'grep "FIXME" .');
});

test('formatToolCommand: grep without pattern returns tool name', (t) => {
  const result = formatToolCommand('grep', {});
  t.is(result, 'grep');
});

test('formatToolCommand: search_replace with all args', (t) => {
  const result = formatToolCommand('search_replace', {
    search_content: 'old',
    replace_content: 'new',
    path: 'file.ts',
  });
  t.is(result, 'search_replace "old" → "new" file.ts');
});

test('formatToolCommand: search_replace with missing args', (t) => {
  const result = formatToolCommand('search_replace', {});
  t.is(result, 'search_replace "" → "" ');
});

test('formatToolCommand: apply_patch with type and path', (t) => {
  const result = formatToolCommand('apply_patch', {
    type: 'create',
    path: 'newfile.ts',
  });
  t.is(result, 'apply_patch create newfile.ts');
});

test('formatToolCommand: apply_patch with missing args', (t) => {
  const result = formatToolCommand('apply_patch', {});
  t.is(result, 'apply_patch unknown ');
});

test('formatToolCommand: ask_mentor with question', (t) => {
  const result = formatToolCommand('ask_mentor', {
    question: 'How do I refactor this?',
  });
  t.is(result, 'ask_mentor: How do I refactor this?');
});

test('formatToolCommand: ask_mentor with empty question', (t) => {
  const result = formatToolCommand('ask_mentor', {});
  t.is(result, 'ask_mentor: ');
});

test('formatToolCommand: unknown tool returns tool name', (t) => {
  const result = formatToolCommand('custom_tool', { foo: 'bar' });
  t.is(result, 'custom_tool');
});

test('formatToolCommand: handles null/undefined args', (t) => {
  const result = formatToolCommand('shell', null as any);
  t.is(result, 'shell');
});

// =============================================================================
// createStreamingState tests
// =============================================================================

test('createStreamingState: returns correct initial values', (t) => {
  const state = createStreamingState();
  t.is(state.accumulatedText, '');
  t.is(state.accumulatedReasoningText, '');
  t.is(state.flushedReasoningLength, 0);
  t.is(state.textWasFlushed, false);
  t.is(state.currentReasoningMessageId, null);
});

test('createStreamingState: returns new object each call', (t) => {
  const state1 = createStreamingState();
  const state2 = createStreamingState();
  t.not(state1, state2);
});

// =============================================================================
// enhanceApiKeyError tests
// =============================================================================

test('enhanceApiKeyError: enhances OPENAI_API_KEY message', (t) => {
  const result = enhanceApiKeyError('Missing OPENAI_API_KEY');
  t.true(result.includes('OpenAI API key is not configured'));
  t.true(result.includes('platform.openai.com/api-keys'));
});

test('enhanceApiKeyError: enhances 401 unauthorized message', (t) => {
  const result = enhanceApiKeyError('Error 401: Unauthorized access');
  t.true(result.includes('OpenAI API key is not configured'));
});

test('enhanceApiKeyError: passes through other errors', (t) => {
  const result = enhanceApiKeyError('Network timeout');
  t.is(result, 'Network timeout');
});

test('enhanceApiKeyError: handles empty string', (t) => {
  const result = enhanceApiKeyError('');
  t.is(result, '');
});

// =============================================================================
// isMaxTurnsError tests
// =============================================================================

test('isMaxTurnsError: returns true for max turns exceeded', (t) => {
  t.true(isMaxTurnsError('Max turns (10) exceeded'));
});

test('isMaxTurnsError: returns false for partial match - only Max turns', (t) => {
  t.false(isMaxTurnsError('Max turns reached'));
});

test('isMaxTurnsError: returns false for partial match - only exceeded', (t) => {
  t.false(isMaxTurnsError('Rate limit exceeded'));
});

test('isMaxTurnsError: returns false for unrelated message', (t) => {
  t.false(isMaxTurnsError('Something went wrong'));
});

test('isMaxTurnsError: returns false for empty string', (t) => {
  t.false(isMaxTurnsError(''));
});

// =============================================================================
// createShellMessageOutput tests
// =============================================================================

test('createShellMessageOutput: stdout only', (t) => {
  const result = createShellMessageOutput(0, 'hello world', '');
  t.is(result, 'hello world\n\nReturn code: 0');
});

test('createShellMessageOutput: stderr only', (t) => {
  const result = createShellMessageOutput(1, '', 'error occurred');
  t.is(result, 'error occurred\n\nReturn code: 1');
});

test('createShellMessageOutput: both stdout and stderr', (t) => {
  const result = createShellMessageOutput(0, 'output', 'warning');
  t.is(result, 'output\nwarning\n\nReturn code: 0');
});

test('createShellMessageOutput: null return code', (t) => {
  const result = createShellMessageOutput(null, 'output', '');
  t.is(result, 'output');
});

test('createShellMessageOutput: empty output with return code', (t) => {
  const result = createShellMessageOutput(0, '', '');
  t.is(result, '\n\nReturn code: 0');
});

test('createShellMessageOutput: trims trailing newlines from stdout', (t) => {
  const result = createShellMessageOutput(0, 'hello\n\n', '');
  t.is(result, 'hello\n\nReturn code: 0');
});
