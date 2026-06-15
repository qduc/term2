// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import test from 'ava';
import React from 'react';
import { renderInAct } from '../../test-helpers/ink-testing.js';
import PathSelectionMenu from './PathSelectionMenu.js';

test('PathSelectionMenu renders a warning above the menu when the workspace is truncated', async (t) => {
  const { lastFrame } = await renderInAct(
    <PathSelectionMenu
      items={[{ path: 'source/app.ts', type: 'file' }]}
      selectedIndex={0}
      query="app"
      warning="Path completion is limited to 5000 entries because this repo is too large. Showing a best-effort breadth-first sample."
    />,
    t,
  );

  t.truthy(lastFrame);
  const frame = lastFrame!();
  t.true(frame?.includes('Path completion is limited to 5000 entries because this repo is too large'));
  t.true(frame?.includes('source/app.ts'));
});
