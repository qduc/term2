// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { it, expect } from 'vitest';
import React, { act } from 'react';
import { render } from 'ink-testing-library';
import PathSelectionMenu from './PathSelectionMenu.js';

it('PathSelectionMenu renders a warning above the menu when the workspace is truncated', async () => {
  let lastFrame!: () => string | undefined;
  let unmount!: () => void;

  await act(async () => {
    const result = render(
      <PathSelectionMenu
        items={[{ path: 'source/app.ts', type: 'file' }]}
        selectedIndex={0}
        query="app"
        warning="Path completion is limited to 5000 entries because this repo is too large. Showing a best-effort breadth-first sample."
      />,
    );
    lastFrame = result.lastFrame;
    unmount = result.unmount;
  });

  expect(lastFrame).toBeTruthy();
  const frame = lastFrame();
  expect(frame?.includes('Path completion is limited to 5000 entries because this repo is too large')).toBe(true);
  expect(frame?.includes('source/app.ts')).toBe(true);

  await act(async () => {
    unmount();
  });
});
