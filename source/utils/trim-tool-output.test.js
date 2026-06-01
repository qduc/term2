import test from 'ava';
import { trimToolOutput } from '../../dist/utils/trim-tool-output.js';

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
