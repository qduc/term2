import { expect, it } from 'vitest';
import { parseToolCallArguments } from './tool-call-arguments.js';

const identity = {
  callId: 'call-1',
  toolName: 'shell',
  sessionId: 'session-1',
  traceId: 'trace-1',
};

it('parses a valid JSON object string into the arguments value with no diagnostic', () => {
  const result = parseToolCallArguments('{"command":"git status"}', identity);

  expect(result.arguments).toEqual({ command: 'git status' });
  expect(result.invalidJsonDiagnostic).toBeUndefined();
});

it('passes parsed non-object JSON values through verbatim', () => {
  const result = parseToolCallArguments('true', identity);

  expect(result.arguments).toBe(true);
  expect(result.invalidJsonDiagnostic).toBeUndefined();
});

it('returns a diagnostic carrying the caller identity for brace-prefixed malformed JSON', () => {
  const args = '{not-json';
  const result = parseToolCallArguments(args, identity);

  expect(result.arguments).toBe(args);
  expect(result.invalidJsonDiagnostic).toEqual({
    toolName: 'shell',
    toolCallId: 'call-1',
    rawPayload: '{not-json',
    normalizedToolCall: {
      toolName: 'shell',
      toolCallId: 'call-1',
      arguments: '{not-json',
    },
    validationErrors: ['arguments must be valid JSON'],
    traceId: 'trace-1',
    retryContext: { sessionId: 'session-1' },
  });
});

it('applies the brace heuristic after trimming leading whitespace, keeping the raw string as arguments', () => {
  const args = '  {broken';
  const result = parseToolCallArguments(args, identity);

  expect(result.arguments).toBe(args);
  expect(result.invalidJsonDiagnostic?.rawPayload).toBe('{broken');
  expect(result.invalidJsonDiagnostic?.normalizedToolCall.arguments).toBe(args);
});

it('silently passes a malformed non-brace string through with no diagnostic', () => {
  const args = '"unterminated';
  const result = parseToolCallArguments(args, identity);

  expect(result.arguments).toBe(args);
  expect(result.invalidJsonDiagnostic).toBeUndefined();
});

it('passes an empty or whitespace-only string through with no diagnostic', () => {
  for (const args of ['', '   ', '\t\n']) {
    const result = parseToolCallArguments(args, identity);
    expect(result.arguments).toBe(args);
    expect(result.invalidJsonDiagnostic).toBeUndefined();
  }
});

it('passes non-string arguments through unchanged', () => {
  const args = { command: 'git status' };
  const result = parseToolCallArguments(args, identity);

  expect(result.arguments).toBe(args);
  expect(result.invalidJsonDiagnostic).toBeUndefined();
});

it('falls back to the unknown tool name in the diagnostic when toolName is empty', () => {
  const result = parseToolCallArguments('{broken', { ...identity, toolName: '' });

  expect(result.invalidJsonDiagnostic?.toolName).toBe('unknown');
  expect(result.invalidJsonDiagnostic?.normalizedToolCall.toolName).toBe('unknown');
});
