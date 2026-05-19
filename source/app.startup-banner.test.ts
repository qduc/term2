import test from 'ava';
import { appendStartupBannerId, hasConversationContent, scheduleExitSideEffects } from './app.js';

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

test('scheduleExitSideEffects defers saving conversations until after exit scheduling', async (t) => {
  const events: string[] = [];
  const scheduled: Array<() => void> = [];

  scheduleExitSideEffects(
    [{ id: 'user-message', sender: 'user', text: 'hello' }],
    async () => {
      events.push('save');
    },
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
  await Promise.resolve();
  t.deepEqual(events, ['scheduled', 'save', 'usage']);
});

test('scheduleExitSideEffects does not save empty conversations', (t) => {
  const events: string[] = [];
  const scheduled: Array<() => void> = [];

  scheduleExitSideEffects(
    [],
    async () => {
      events.push('save');
    },
    () => {
      events.push('usage');
    },
    (callback) => {
      scheduled.push(callback);
    },
  );

  scheduled[0]!();
  t.deepEqual(events, ['usage']);
});
