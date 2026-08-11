import { expect, it } from 'vitest';
import { buildMentorPoolListItems, formatMentorPoolReasoning } from './use-mentor-pool-selection.js';

it('only offers reorder when a pool has at least two entries', () => {
  const emptyActions = buildMentorPoolListItems([]).filter((item) => item.kind === 'action');
  const oneEntryActions = buildMentorPoolListItems([{ model: 'gpt-5' }]).filter((item) => item.kind === 'action');
  const twoEntryActions = buildMentorPoolListItems([{ model: 'gpt-5' }, { model: 'sonnet' }]).filter(
    (item) => item.kind === 'action',
  );

  expect(emptyActions.map((item) => item.action)).toEqual(['add', 'save']);
  expect(oneEntryActions.map((item) => item.action)).toEqual(['add', 'save']);
  expect(twoEntryActions.map((item) => item.action)).toEqual(['add', 'reorder', 'save']);
});

it('describes inherited and explicit reasoning without changing stored values', () => {
  expect(formatMentorPoolReasoning()).toBe('Inherit mentor reasoning');
  expect(formatMentorPoolReasoning('default')).toBe('Provider default');
  expect(formatMentorPoolReasoning('high')).toBe('High');
  expect(formatMentorPoolReasoning('none')).toBe('None');
});
