import { expect, it } from 'vitest';
import { getRewindScrollOffset } from './use-rewind-selection.js';

it('scrolls the six-item picker so its initially selected last turn is visible', () => {
  expect(getRewindScrollOffset(6, 5, 0)).toBe(1);
});
