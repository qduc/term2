// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import test from 'ava';
import React, { act } from 'react';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { InputProvider } from '../context/InputContext.js';
import { buildWorkspaceLimitWarning, usePathCompletion } from './use-path-completion.js';
import type { PathEntry } from '../services/file-service.js';

test('buildWorkspaceLimitWarning explains the total-entry breadth-first sample limit', (t) => {
  t.is(
    buildWorkspaceLimitWarning({
      truncatedByTotalLimit: true,
      limit: 5_000,
    }),
    'Path completion is limited to 5000 entries because this repo is too large. Showing a best-effort breadth-first sample.',
  );
});

test('buildWorkspaceLimitWarning returns null when nothing was truncated', (t) => {
  t.is(
    buildWorkspaceLimitWarning({
      truncatedByTotalLimit: false,
      limit: 5_000,
    }),
    null,
  );
});

const fakeEntries: PathEntry[] = [
  { path: 'a.ts', type: 'file' },
  { path: 'b.ts', type: 'file' },
];

test('does not infinitely re-render when the loggingService reference is unstable', async (t) => {
  let renders = 0;
  let loadCalls = 0;
  let renderer: ReturnType<typeof render> | null = null;
  const fakeDeps = {
    getWorkspaceEntries: async () => {
      loadCalls += 1;
      return fakeEntries;
    },
    refreshWorkspaceEntries: async () => fakeEntries,
    getWorkspaceEntriesMeta: () => ({
      lastLoadedAt: null,
      limit: 5_000,
      totalEntries: fakeEntries.length,
      truncated: false,
      truncatedByTotalLimit: false,
    }),
  };

  // Regression: a parent that recreates the loggingService reference on every
  // render must not push the hook into an infinite render loop. Before the fix,
  // logger identity changes recreated the load effect, so it re-fetched and set
  // state on every render until React reported "Maximum update depth exceeded".
  const Harness = ({ onRender }: { onRender: () => void }) => {
    onRender();
    // Fresh object every render, simulating an unstable injected logger.
    const loggingService = { warn() {}, error() {}, info() {}, debug() {} } as any;
    usePathCompletion({ ...fakeDeps, loggingService });
    return <Text>ok</Text>;
  };

  await act(async () => {
    renderer = render(
      <InputProvider>
        <Harness onRender={() => (renders += 1)} />
      </InputProvider>,
    );
    await Promise.resolve();
    await Promise.resolve();
  });

  t.is(loadCalls, 1);
  t.true(renders < 20, `expected a bounded render count, got ${renders}`);

  await act(async () => {
    renderer?.unmount();
  });
});
