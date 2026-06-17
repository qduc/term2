// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { it, expect } from 'vitest';
import React from 'react';
import { renderInAct } from '../../test-helpers/ink-testing.js';
import DiffView from './DiffView.js';

it.sequential('DiffView renders small diff without collapsing', async () => {
  const diff = [' line 1', ' line 2', '-old line', '+new line', ' line 3', ' line 4'].join('\n');

  const { lastFrame } = await renderInAct(<DiffView diff={diff} />);
  const output = lastFrame() ?? '';

  expect(output.includes('line 1')).toBe(true);
  expect(output.includes('-old line')).toBe(true);
  expect(output.includes('+new line')).toBe(true);
  expect(output.includes('line 4')).toBe(true);
  expect(output.includes('unchanged lines')).toBe(false);
});

it.sequential('DiffView collapses large number of consecutive unchanged lines', async () => {
  const diff = [
    ' line 1',
    ' line 2',
    ' line 3',
    ' line 4',
    ' line 5',
    ' line 6',
    ' line 7',
    ' line 8',
    '-old line',
    '+new line',
    ' line 9',
    ' line 10',
  ].join('\n');

  const { lastFrame } = await renderInAct(<DiffView diff={diff} />);
  const output = lastFrame() ?? '';

  // The first 8 lines are unchanged. Max context is 3. So it should show:
  // line 1, line 2, line 3, then a placeholder, then line 6, line 7, line 8.
  // Skipped: 8 - 3 - 3 = 2 lines (line 4, 5)
  expect(output.includes('line 1')).toBe(true);
  expect(output.includes('line 2')).toBe(true);
  expect(output.includes('line 3')).toBe(true);
  expect(output.includes('line 4')).toBe(false);
  expect(output.includes('line 5')).toBe(false);
  expect(output.includes('line 6')).toBe(true);
  expect(output.includes('line 7')).toBe(true);
  expect(output.includes('line 8')).toBe(true);
  expect(output.includes('2 unchanged lines')).toBe(true);
});
