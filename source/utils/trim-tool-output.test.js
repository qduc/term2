import test from 'ava';
import { trimToolOutput, injectWarningIntoToolOutput } from '../../dist/utils/trim-tool-output.js';

test('trimToolOutput trims plain string output by characters', (t) => {
  const output = 'a'.repeat(200);
  const result = trimToolOutput(output, undefined, 50);

  t.true(typeof result === 'string');
  t.true(result.includes('characters trimmed'));
  t.true(result.length < output.length);
});

test('trimToolOutput trims string fields inside JSON output', (t) => {
  const payload = JSON.stringify({
    output: 'b'.repeat(200),
    other: 'ok',
  });

  const result = trimToolOutput(payload, undefined, 50);
  const parsed = JSON.parse(result);

  t.true(parsed.output.includes('characters trimmed'));
  t.is(parsed.other, 'ok');
});

test('trimToolOutput trims nested JSON output arrays', (t) => {
  const payload = JSON.stringify({
    output: [
      {
        success: true,
        message: 'c'.repeat(200),
      },
    ],
  });

  const result = trimToolOutput(payload, undefined, 50);
  const parsed = JSON.parse(result);

  t.true(parsed.output[0].message.includes('characters trimmed'));
});

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
