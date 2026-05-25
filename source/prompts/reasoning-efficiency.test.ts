import test from 'ava';
import { getReasoningEfficiencyAddendum } from './reasoning-efficiency.js';

test('getReasoningEfficiencyAddendum returns a non-empty string with guidance keywords', (t) => {
  const addendum = getReasoningEfficiencyAddendum();

  t.is(typeof addendum, 'string');
  t.true(addendum.length > 0);
  t.true(addendum.includes('### Reasoning Efficiency Guidelines'));
  t.true(addendum.includes('Treat confirmed context as settled'));
  t.true(addendum.includes('End when done'));
});
