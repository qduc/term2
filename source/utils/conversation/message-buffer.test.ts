import { it, expect } from 'vitest';
import { appendMessagesCapped } from './message-buffer.js';

const makeMessages = (count: number, prefix = 'm') =>
  Array.from({ length: count }, (_, i) => ({ id: i, text: `${prefix}${i}` }));

it('appendMessagesCapped keeps only the newest messages up to the cap', () => {
  const prev = makeMessages(3);
  const next = makeMessages(3, 'n');

  const result = appendMessagesCapped(prev, next, 4);

  expect(result.length).toBe(4);
  expect(result.map((m) => m.text)).toEqual(['m2', 'n0', 'n1', 'n2']);
});

it('appendMessagesCapped returns additions when cap is small', () => {
  const prev = makeMessages(2);
  const next = makeMessages(2, 'n');

  const result = appendMessagesCapped(prev, next, 2);

  expect(result.map((m) => m.text)).toEqual(['n0', 'n1']);
});
