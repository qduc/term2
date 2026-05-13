import test from 'ava';
import { appendStartupBannerId } from './app.js';

test('appendStartupBannerId appends a new stable id for each clear', (t) => {
  t.deepEqual(appendStartupBannerId(['startup-banner-0']), ['startup-banner-0', 'startup-banner-1']);
  t.deepEqual(appendStartupBannerId(['startup-banner-0', 'startup-banner-1']), [
    'startup-banner-0',
    'startup-banner-1',
    'startup-banner-2',
  ]);
});
