import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import {
  injectWarningIntoToolOutput,
  injectTurnLimitWarning,
  buildTurnLimitWarning,
} from './inject-warning-into-tool-output.js';

it('injectWarningIntoToolOutput appends to plain text', () => {
  const output = 'Hello World';
  const warning = ' [Warning: Turns left]';
  const result = injectWarningIntoToolOutput(output, warning);
  expect(result).toBe('Hello World [Warning: Turns left]');
});

it('injectWarningIntoToolOutput handles JSON string output', () => {
  const output = JSON.stringify('Hello World');
  const warning = ' [Warning: Turns left]';
  const result = injectWarningIntoToolOutput(output, warning);
  expect(JSON.parse(result)).toBe('Hello World [Warning: Turns left]');
});

it('injectWarningIntoToolOutput appends to standard envelope JSON array stdout', () => {
  const output = JSON.stringify({
    output: [
      {
        success: true,
        stdout: 'Command output',
      },
    ],
  });
  const warning = ' [Warning]';
  const result = injectWarningIntoToolOutput(output, warning);
  const parsed = JSON.parse(result);
  expect(parsed.output[0].stdout).toBe('Command output [Warning]');
});

it('injectWarningIntoToolOutput appends to simple JSON object content', () => {
  const output = JSON.stringify({
    content: 'File content',
  });
  const warning = ' [Warning]';
  const result = injectWarningIntoToolOutput(output, warning);
  const parsed = JSON.parse(result);
  expect(parsed.content).toBe('File content [Warning]');
});

it('injectWarningIntoToolOutput appends to standard envelope JSON array message', () => {
  const output = JSON.stringify({
    output: [
      {
        success: true,
        message: 'Updated file.ts',
      },
    ],
  });
  const warning = ' [Warning]';
  const result = injectWarningIntoToolOutput(output, warning);
  const parsed = JSON.parse(result);
  expect(parsed.output[0].message).toBe('Updated file.ts [Warning]');
});

it('injectWarningIntoToolOutput appends to top-level JSON object message without corrupting JSON', () => {
  const output = JSON.stringify({
    success: true,
    path: 'new-file.ts',
    message: 'Created new-file.ts',
  });
  const warning = ' [Warning]';
  const result = injectWarningIntoToolOutput(output, warning);
  const parsed = JSON.parse(result);
  expect(parsed.message).toBe('Created new-file.ts [Warning]');
  expect(parsed.success).toBe(true);
  expect(parsed.path).toBe('new-file.ts');
});

it('injectWarningIntoToolOutput preserves JSON object shape when no text field exists', () => {
  const output = JSON.stringify({
    success: true,
    path: 'new-file.ts',
  });
  const warning = ' [Warning]';
  const result = injectWarningIntoToolOutput(output, warning);
  const parsed = JSON.parse(result);
  expect(parsed.warning).toBe(warning.trim());
  expect(parsed.success).toBe(true);
});

it('injectWarningIntoToolOutput appends warning as new item to JSON array when last item is not a string or object', () => {
  const output = JSON.stringify([1, 2]);
  const warning = ' [Warning]';
  const result = injectWarningIntoToolOutput(output, warning);
  const parsed = JSON.parse(result);
  expect(parsed).toEqual([1, 2, ' [Warning]']);
});

it('injectWarningIntoToolOutput appends warning as new item in envelope output array when last item is not a string or object', () => {
  const output = JSON.stringify({
    output: [
      {
        success: true,
      },
      true,
    ],
  });
  const warning = ' [Warning]';
  const result = injectWarningIntoToolOutput(output, warning);
  const parsed = JSON.parse(result);
  expect(parsed.output).toEqual([
    {
      success: true,
    },
    true,
    {
      success: true,
      stdout: ' [Warning]',
    },
  ]);
});

it('buildTurnLimitWarning produces correct warning string', () => {
  const warning = buildTurnLimitWarning(3);
  expect(warning.includes('3 turns left')).toBe(true);
  expect(warning.includes('[Warning: You are approaching the maximum turn limit.')).toBe(true);
  expect(warning.includes('situation update message')).toBe(true);
});

it('injectTurnLimitWarning returns output unchanged when context is undefined', () => {
  const output = JSON.stringify({ output: [{ success: true, stdout: 'ok' }] });
  expect(injectTurnLimitWarning(output, undefined)).toBe(output);
});

it('injectTurnLimitWarning returns output unchanged when context is null', () => {
  const output = JSON.stringify({ output: [{ success: true, stdout: 'ok' }] });
  expect(injectTurnLimitWarning(output, null)).toBe(output);
});

it('injectTurnLimitWarning returns output unchanged when turns left > 5', () => {
  const output = 'result';
  const result = injectTurnLimitWarning(output, { turnCount: 10, maxTurns: 100 });
  expect(result).toBe(output);
});

it('injectTurnLimitWarning returns output unchanged when turnCount or maxTurns is not a number', () => {
  const output = 'result';
  expect(injectTurnLimitWarning(output, { turnCount: undefined, maxTurns: 100 })).toBe(output);
  expect(injectTurnLimitWarning(output, { turnCount: 10, maxTurns: undefined })).toBe(output);
});

it('injectTurnLimitWarning injects warning when turns left <= 5', () => {
  const output = JSON.stringify({ output: [{ success: true, stdout: 'result' }] });
  const result = injectTurnLimitWarning(output, { turnCount: 96, maxTurns: 100 });
  const parsed = JSON.parse(result);
  expect(parsed.output[0].stdout.includes('4 turns left')).toBe(true);
  expect(parsed.output[0].stdout.includes('[Warning: You are approaching the maximum turn limit.')).toBe(true);
});

it('injectTurnLimitWarning injects warning when turns left is 0', () => {
  const output = JSON.stringify({ output: [{ success: true, stdout: 'result' }] });
  const result = injectTurnLimitWarning(output, { turnCount: 100, maxTurns: 100 });
  const parsed = JSON.parse(result);
  expect(parsed.output[0].stdout.includes('0 turns left')).toBe(true);
});

it('injectTurnLimitWarning injects warning for plain text output', () => {
  const output = 'tool result';
  const result = injectTurnLimitWarning(output, { turnCount: 98, maxTurns: 100 });
  expect(result.includes('tool result')).toBe(true);
  expect(result.includes('2 turns left')).toBe(true);
});
