import { expect, it } from 'vitest';
import { RepetitionDetector } from './repetition-detector.js';

it('detects a short pattern repeated enough to indicate a runaway response', () => {
  const detector = new RepetitionDetector();

  expect(detector.append('prefix ')).toBe(false);
  expect(detector.append('abc '.repeat(60))).toBe(true);
});

it('detects repetition split across streaming chunks', () => {
  const detector = new RepetitionDetector();

  for (let index = 0; index < 39; index++) {
    expect(detector.append('loop ')).toBe(false);
  }
  expect(detector.append('loop ')).toBe(true);
});

it('does not flag normal prose or whitespace-only output', () => {
  const detector = new RepetitionDetector();

  expect(detector.append('This is a normal response with varied words and punctuation.')).toBe(false);
  expect(detector.append('\n'.repeat(300))).toBe(false);
});
