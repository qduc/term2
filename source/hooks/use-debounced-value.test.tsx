// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import React, { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { useDebouncedValue } from './use-debounced-value.js';

const Probe = ({ value, shouldFlush }: { value: string; shouldFlush?: (value: string) => boolean }) => {
  const debounced = useDebouncedValue(value, 250, shouldFlush);
  return <Text>{`[${debounced}]`}</Text>;
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

it('holds the previous value until the source stops changing', async () => {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<Probe value="" />);
  });

  for (const value of ['h', 'he', 'hel']) {
    await act(async () => {
      view.rerender(<Probe value={value} />);
    });
    await advance(200);
  }

  // Each change restarted the timer, so nothing has settled yet.
  expect(view.lastFrame()).toBe('[]');

  await advance(250);
  expect(view.lastFrame()).toBe('[hel]');

  view.unmount();
});

it('settles on the latest value, not an intermediate one', async () => {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<Probe value="a" />);
  });

  await act(async () => {
    view.rerender(<Probe value="ab" />);
  });
  await act(async () => {
    view.rerender(<Probe value="abc" />);
  });
  await advance(250);

  expect(view.lastFrame()).toBe('[abc]');

  view.unmount();
});

it('bypasses the delay for values the caller marks as urgent', async () => {
  const shouldFlush = (value: string) => value === '';
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<Probe value="typed" shouldFlush={shouldFlush} />);
  });
  await advance(250);
  expect(view.lastFrame()).toBe('[typed]');

  await act(async () => {
    view.rerender(<Probe value="" shouldFlush={shouldFlush} />);
  });

  // No timer advance: the flush predicate applied on the spot.
  expect(view.lastFrame()).toBe('[]');

  view.unmount();
});

it('does not emit a value after unmount', async () => {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<Probe value="a" />);
  });
  await act(async () => {
    view.rerender(<Probe value="b" />);
  });

  view.unmount();
  const framesAtUnmount = view.frames.length;
  await advance(500);

  // The pending timer was cancelled by the effect cleanup. Had it fired it
  // would have set state on an unmounted tree and produced another frame.
  expect(view.frames.length).toBe(framesAtUnmount);
});
