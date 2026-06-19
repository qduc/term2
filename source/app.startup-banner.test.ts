import { it, expect } from 'vitest';
import { appendStartupBannerId } from './app-helpers.js';

it('appendStartupBannerId appends a new stable id for each clear', () => {
  expect(appendStartupBannerId(['startup-banner-0'])).toEqual(['startup-banner-0', 'startup-banner-1']);
  expect(appendStartupBannerId(['startup-banner-0', 'startup-banner-1'])).toEqual([
    'startup-banner-0',
    'startup-banner-1',
    'startup-banner-2',
  ]);
});
