import test from 'ava';
import { appendMessagesCapped } from './message-buffer.js';

const makeMessages = (count: number, prefix = 'm') =>
  Array.from({ length: count }, (_, i) => ({ id: i, text: `${prefix}${i}` }));

test('appendMessagesCapped keeps only the newest messages up to the cap', (t) => {
  const prev = makeMessages(3);
  const next = makeMessages(3, 'n');

  const result = appendMessagesCapped(prev, next, 4);

  t.is(result.length, 4);
  t.deepEqual(
    result.map((m) => m.text),
    ['m2', 'n0', 'n1', 'n2'],
  );
});

test('appendMessagesCapped returns additions when cap is small', (t) => {
  const prev = makeMessages(2);
  const next = makeMessages(2, 'n');

  const result = appendMessagesCapped(prev, next, 2);

  t.deepEqual(
    result.map((m) => m.text),
    ['n0', 'n1'],
  );
});
