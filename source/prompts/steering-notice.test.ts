import { expect, it } from 'vitest';
import { stripSteeringNotice, withSteeringNotice } from './steering-notice.js';

it('steering distinguishes side questions, added constraints, replacement, and queued tasks', () => {
  const text = withSteeringNotice('How far along are you?');
  expect(text).toContain('before your next tool call');
  expect(text).toContain('continue the pending work in the same response');
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

it('strips the previous status-aware notice from saved conversation messages', () => {
  const previous = `[Steering message: the user sent this while you were working, so it arrives mid-turn rather than as a new turn.
- For status or side questions, answer briefly, then resume the active task.
- Incorporate corrections and new constraints while preserving the active objective, unless the user explicitly pauses, cancels, or replaces it. Drop only superseded work.
- For an unrelated task, acknowledge it, finish the active task, then handle it unless the user explicitly changes priority.]`;
  expect(stripSteeringNotice(`${previous}\n\nWhat is done so far?`)).toBe('What is done so far?');
});
