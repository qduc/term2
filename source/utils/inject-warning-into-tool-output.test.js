import test from 'ava';
import { injectWarningIntoToolOutput } from '../../dist/utils/inject-warning-into-tool-output.js';

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
