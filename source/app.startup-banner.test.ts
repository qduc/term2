import test from 'ava';
import {
  TERMINAL_REDRAW_CLEAR,
  appendStartupBannerId,
  clearTerminalForRedraw,
  hasConversationContent,
  scheduleExitSideEffects,
} from './app.js';

test('appendStartupBannerId appends a new stable id for each clear', (t) => {
  t.deepEqual(appendStartupBannerId(['startup-banner-0']), ['startup-banner-0', 'startup-banner-1']);
  t.deepEqual(appendStartupBannerId(['startup-banner-0', 'startup-banner-1']), [
    'startup-banner-0',
    'startup-banner-1',
    'startup-banner-2',
  ]);
});

test('hasConversationContent ignores empty and system-only conversations', (t) => {
  t.false(hasConversationContent([]));
  t.false(hasConversationContent([{ id: 'system-message', sender: 'system', text: 'Welcome' }]));
});

test('hasConversationContent detects real conversation messages', (t) => {
  t.true(hasConversationContent([{ id: 'user-message', sender: 'user', text: 'hello' }]));
  t.true(hasConversationContent([{ id: 'assistant-message', sender: 'bot', text: 'hello' }]));
});

test('clearTerminalForRedraw clears scrollback and moves cursor home', (t) => {
  const writes: string[] = [];
  clearTerminalForRedraw({
    write: (value) => {
      writes.push(value);
      return true;
    },
  });

  t.deepEqual(writes, [TERMINAL_REDRAW_CLEAR]);
});

test('scheduleExitSideEffects schedules the exit-usage hook', (t) => {
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

  t.deepEqual(events, ['scheduled']);
  scheduled[0]!();
  t.deepEqual(events, ['scheduled', 'usage']);
});
