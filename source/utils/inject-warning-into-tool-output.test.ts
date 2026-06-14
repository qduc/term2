import test from 'ava';
import {
  injectWarningIntoToolOutput,
  injectTurnLimitWarning,
  buildTurnLimitWarning,
} from './inject-warning-into-tool-output.js';

test('injectWarningIntoToolOutput appends to plain text', (t) => {
  const output = 'Hello World';
  const warning = ' [Warning: Turns left]';
  const result = injectWarningIntoToolOutput(output, warning);
  t.is(result, 'Hello World [Warning: Turns left]');
});

test('injectWarningIntoToolOutput handles JSON string output', (t) => {
  const output = JSON.stringify('Hello World');
  const warning = ' [Warning: Turns left]';
  const result = injectWarningIntoToolOutput(output, warning);
  t.is(JSON.parse(result), 'Hello World [Warning: Turns left]');
});

test('injectWarningIntoToolOutput appends to standard envelope JSON array stdout', (t) => {
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
  t.is(parsed.output[0].stdout, 'Command output [Warning]');
});

test('injectWarningIntoToolOutput appends to simple JSON object content', (t) => {
  const output = JSON.stringify({
    content: 'File content',
  });
  const warning = ' [Warning]';
  const result = injectWarningIntoToolOutput(output, warning);
  const parsed = JSON.parse(result);
  t.is(parsed.content, 'File content [Warning]');
});

test('injectWarningIntoToolOutput appends to standard envelope JSON array message', (t) => {
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
  t.is(parsed.output[0].message, 'Updated file.ts [Warning]');
});

test('injectWarningIntoToolOutput appends to top-level JSON object message without corrupting JSON', (t) => {
  const output = JSON.stringify({
    success: true,
    path: 'new-file.ts',
    message: 'Created new-file.ts',
  });
  const warning = ' [Warning]';
  const result = injectWarningIntoToolOutput(output, warning);
  const parsed = JSON.parse(result);
  t.is(parsed.message, 'Created new-file.ts [Warning]');
  t.is(parsed.success, true);
  t.is(parsed.path, 'new-file.ts');
});

test('injectWarningIntoToolOutput preserves JSON object shape when no text field exists', (t) => {
  const output = JSON.stringify({
    success: true,
    path: 'new-file.ts',
  });
  const warning = ' [Warning]';
  const result = injectWarningIntoToolOutput(output, warning);
  const parsed = JSON.parse(result);
  t.is(parsed.warning, warning.trim());
  t.is(parsed.success, true);
});

test('injectWarningIntoToolOutput appends warning as new item to JSON array when last item is not a string or object', (t) => {
  const output = JSON.stringify([1, 2]);
  const warning = ' [Warning]';
  const result = injectWarningIntoToolOutput(output, warning);
  const parsed = JSON.parse(result);
  t.deepEqual(parsed, [1, 2, ' [Warning]']);
});

test('injectWarningIntoToolOutput appends warning as new item in envelope output array when last item is not a string or object', (t) => {
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
  t.deepEqual(parsed.output, [
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

test('buildTurnLimitWarning produces correct warning string', (t) => {
  const warning = buildTurnLimitWarning(3);
  t.true(warning.includes('3 turns left'));
  t.true(warning.includes('[Warning: You are approaching the maximum turn limit.'));
  t.true(warning.includes('situation update message'));
});

test('injectTurnLimitWarning returns output unchanged when context is undefined', (t) => {
  const output = JSON.stringify({ output: [{ success: true, stdout: 'ok' }] });
  t.is(injectTurnLimitWarning(output, undefined), output);
});

test('injectTurnLimitWarning returns output unchanged when context is null', (t) => {
  const output = JSON.stringify({ output: [{ success: true, stdout: 'ok' }] });
  t.is(injectTurnLimitWarning(output, null), output);
});

test('injectTurnLimitWarning returns output unchanged when turns left > 5', (t) => {
  const output = 'result';
  const result = injectTurnLimitWarning(output, { turnCount: 10, maxTurns: 100 });
  t.is(result, output);
});

test('injectTurnLimitWarning returns output unchanged when turnCount or maxTurns is not a number', (t) => {
  const output = 'result';
  t.is(injectTurnLimitWarning(output, { turnCount: undefined, maxTurns: 100 }), output);
  t.is(injectTurnLimitWarning(output, { turnCount: 10, maxTurns: undefined }), output);
});

test('injectTurnLimitWarning injects warning when turns left <= 5', (t) => {
  const output = JSON.stringify({ output: [{ success: true, stdout: 'result' }] });
  const result = injectTurnLimitWarning(output, { turnCount: 96, maxTurns: 100 });
  const parsed = JSON.parse(result);
  t.true(parsed.output[0].stdout.includes('4 turns left'));
  t.true(parsed.output[0].stdout.includes('[Warning: You are approaching the maximum turn limit.'));
});

test('injectTurnLimitWarning injects warning when turns left is 0', (t) => {
  const output = JSON.stringify({ output: [{ success: true, stdout: 'result' }] });
  const result = injectTurnLimitWarning(output, { turnCount: 100, maxTurns: 100 });
  const parsed = JSON.parse(result);
  t.true(parsed.output[0].stdout.includes('0 turns left'));
});

test('injectTurnLimitWarning injects warning for plain text output', (t) => {
  const output = 'tool result';
  const result = injectTurnLimitWarning(output, { turnCount: 98, maxTurns: 100 });
  t.true(result.includes('tool result'));
  t.true(result.includes('2 turns left'));
});
