import { expect, it } from 'vitest';
import { stripSteeringNotice, withSteeringNotice } from './steering-notice.js';

it('steering distinguishes side questions, added constraints, replacement, and queued tasks', () => {
  const text = withSteeringNotice('How far along are you?');
  expect(text).toContain('answer briefly, then resume the active task');
  expect(text).toContain('Incorporate corrections and new constraints');
  expect(text).toContain('pauses, cancels, or replaces');
  expect(text).toContain('unrelated task');
  expect(text).toContain('How far along are you?');
});

it.each(['How far along are you?', 'Keep the API compatible.\nAlso update the docs.', 'Stop.'])(
  'steering round-trips user text: %s',
  (text) => expect(stripSteeringNotice(withSteeringNotice(text))).toBe(text),
);

it('still strips the original notice from saved conversation messages', () => {
  const legacy = `[Steering message: the user sent this while you were working, so it arrives mid-turn rather than as a new turn.
- If it changes what you should be doing, change direction now and drop the superseded plan.
- If it does not bear on the work in progress, treat it as the next task rather than an interruption: acknowledge it, finish what you are doing, and handle it after.]`;
  expect(stripSteeringNotice(`${legacy}\n\nKeep the API compatible.`)).toBe('Keep the API compatible.');
});

it('leaves ordinary user messages unchanged', () => {
  expect(stripSteeringNotice('No steering notice here.')).toBe('No steering notice here.');
});
