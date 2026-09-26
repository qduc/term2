import { it, expect } from 'vitest';
import { createDurableGoal } from './durable-goal.js';

it('creates active bounded goals and omits blank optional criteria', () => {
  expect(createDurableGoal('  Ship it  ', '   ')).toMatchObject({ outcome: 'Ship it', status: 'active' });
  expect(createDurableGoal('Ship it').successCriteria).toBeUndefined();
});

it('rejects empty and over-bound goal fields instead of truncating', () => {
  expect(() => createDurableGoal('   ')).toThrow('must not be empty');
  expect(() => createDurableGoal('g'.repeat(2001))).toThrow('at most 2000');
  expect(() => createDurableGoal('Valid', 'c'.repeat(2001))).toThrow('at most 2000');
});
