// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import React, { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { useTerminalColumns } from './use-terminal-columns.js';

const Probe = () => {
  const columns = useTerminalColumns();
  return <Text>{`[${columns}]`}</Text>;
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

// ink-testing-library's mock stdout exposes `columns` as a fixed getter
// (always 100), so tests that need to simulate a resize must override it
// per-instance before emitting the event — mirroring what a real resize
// does to `process.stdout.columns`.
const setColumns = (stdout: { columns: number }, value: number) => {
  Object.defineProperty(stdout, 'columns', { value, configurable: true });
};

it('reflects the terminal width at mount', async () => {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<Probe />);
  });

  expect(view.lastFrame()).toBe('[100]');

  view.unmount();
});

it('updates after a debounced resize event', async () => {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<Probe />);
  });

  expect(view.lastFrame()).toBe('[100]');

  setColumns(view.stdout, 60);
  await act(async () => {
    view.stdout.emit('resize');
  });

  // Debounce has not elapsed yet: still the old value.
  expect(view.lastFrame()).toBe('[100]');

  await advance(120);
  expect(view.lastFrame()).toBe('[60]');

  view.unmount();
});

it('collapses rapid resize events into a single update', async () => {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<Probe />);
  });

  for (const width of [90, 70, 50]) {
    setColumns(view.stdout, width);
    await act(async () => {
      view.stdout.emit('resize');
    });
    await advance(60);
  }

  // Each resize restarted the debounce timer, so nothing has settled yet.
  expect(view.lastFrame()).toBe('[100]');

  await advance(120);
  expect(view.lastFrame()).toBe('[50]');

  view.unmount();
});

it('stops listening for resize after unmount', async () => {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<Probe />);
  });

  const listenerCountBefore = view.stdout.listenerCount('resize');
  expect(listenerCountBefore).toBeGreaterThan(0);

  view.unmount();

  expect(view.stdout.listenerCount('resize')).toBe(0);
});
