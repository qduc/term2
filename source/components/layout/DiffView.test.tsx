// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import test from 'ava';
import React from 'react';
import { render } from 'ink-testing-library';
import DiffView from './DiffView.js';

test('DiffView renders small diff without collapsing', (t) => {
  const diff = [' line 1', ' line 2', '-old line', '+new line', ' line 3', ' line 4'].join('\n');

  const { lastFrame } = render(<DiffView diff={diff} />);
  const output = lastFrame() ?? '';

  t.true(output.includes('line 1'));
  t.true(output.includes('-old line'));
  t.true(output.includes('+new line'));
  t.true(output.includes('line 4'));
  t.false(output.includes('unchanged lines'));
});

test('DiffView collapses large number of consecutive unchanged lines', (t) => {
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

  const { lastFrame } = render(<DiffView diff={diff} />);
  const output = lastFrame() ?? '';

  // The first 8 lines are unchanged. Max context is 3. So it should show:
  // line 1, line 2, line 3, then a placeholder, then line 6, line 7, line 8.
  // Skipped: 8 - 3 - 3 = 2 lines (line 4, 5)
  t.true(output.includes('line 1'));
  t.true(output.includes('line 2'));
  t.true(output.includes('line 3'));
  t.false(output.includes('line 4'));
  t.false(output.includes('line 5'));
  t.true(output.includes('line 6'));
  t.true(output.includes('line 7'));
  t.true(output.includes('line 8'));
  t.true(output.includes('2 unchanged lines'));
});
