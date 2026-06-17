import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { getReasoningEfficiencyAddendum } from './reasoning-efficiency.js';

it('getReasoningEfficiencyAddendum returns a non-empty string with guidance keywords', () => {
  const addendum = getReasoningEfficiencyAddendum();

  expect(typeof addendum).toBe('string');
  expect(addendum.length > 0).toBe(true);
  expect(addendum.includes('### Reasoning Efficiency Guidelines')).toBe(true);
  expect(addendum.includes('Treat confirmed context as settled')).toBe(true);
  expect(addendum.includes('End when done')).toBe(true);
});
