import test from 'ava';
import { formatLargeUncachedInputWarning } from './app.js';

test('formatLargeUncachedInputWarning describes estimate, reason, and confirmation action', (t) => {
  const text = formatLargeUncachedInputWarning({
    action: 'warn',
    warningKey: 'abc',
    reasons: ['idle_timeout'],
    estimatedTokens: 72_100,
    estimatedBytes: 288_400,
  });

  t.true(text.includes('~72k input tokens'));
  t.true(text.includes('idle for over 5m'));
  t.true(text.includes('Press Enter again'));
});
