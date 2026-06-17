import { it, expect } from 'vitest';
import {
  TERMINAL_REDRAW_CLEAR,
  appendStartupBannerId,
  clearTerminalForRedraw,
  hasConversationContent,
  scheduleExitSideEffects,
} from './app.js';

it('appendStartupBannerId appends a new stable id for each clear', () => {
  expect(appendStartupBannerId(['startup-banner-0'])).toEqual(['startup-banner-0', 'startup-banner-1']);
  expect(appendStartupBannerId(['startup-banner-0', 'startup-banner-1'])).toEqual([
    'startup-banner-0',
    'startup-banner-1',
    'startup-banner-2',
  ]);
});

it('hasConversationContent ignores empty and system-only conversations', () => {
  expect(hasConversationContent([])).toBe(false);
  expect(hasConversationContent([{ id: 'system-message', sender: 'system', text: 'Welcome' }])).toBe(false);
});

it('hasConversationContent detects real conversation messages', () => {
  expect(hasConversationContent([{ id: 'user-message', sender: 'user', text: 'hello' }])).toBe(true);
  expect(hasConversationContent([{ id: 'assistant-message', sender: 'bot', text: 'hello' }])).toBe(true);
});

it('clearTerminalForRedraw clears scrollback and moves cursor home', () => {
  const writes: string[] = [];
  clearTerminalForRedraw({
    write: (value) => {
      writes.push(value);
      return true;
    },
  });

  expect(writes).toEqual([TERMINAL_REDRAW_CLEAR]);
});

it('scheduleExitSideEffects schedules the exit-usage hook', () => {
  const events: string[] = [];
  const scheduled: Array<() => void> = [];

  scheduleExitSideEffects(
    [{ id: 'user-message', sender: 'user', text: 'hello' }],
    () => {
      events.push('usage');
    },
    (callback) => {
      scheduled.push(callback);
      events.push('scheduled');
    },
  );

  expect(events).toEqual(['scheduled']);
  scheduled[0]!();
  expect(events).toEqual(['scheduled', 'usage']);
});
