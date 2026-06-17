import React, { act } from 'react';
import { render } from 'ink-testing-library';
import { stripVTControlCharacters } from 'node:util';

type TeardownContext = {
  teardown: (callback: () => void | Promise<void>) => void;
};

type InkRenderResult = ReturnType<typeof render>;

// Module-level store for teardown callbacks when no AVA-style context is provided.
const teardownCallbacks: Array<() => void | Promise<void>> = [];

/**
 * Run all pending teardowns (call from vitest's afterEach or onTestFinished).
 */
export const runTeardowns = async (): Promise<void> => {
  for (const cb of teardownCallbacks.splice(0)) {
    await cb();
  }
};

export const toVisibleText = (value: string): string => stripVTControlCharacters(value);

export const renderInAct = async (element: React.ReactElement, context?: TeardownContext): Promise<InkRenderResult> => {
  let result!: InkRenderResult;

  await act(async () => {
    result = render(element);
    await Promise.resolve();
  });

  const schedule =
    context?.teardown ??
    ((fn: () => void | Promise<void>) => {
      teardownCallbacks.push(fn);
    });

  schedule(async () => {
    await act(async () => {
      result.unmount();
    });
  });

  return result;
};

export const rerenderInAct = async (view: InkRenderResult, element: React.ReactElement): Promise<void> => {
  await act(async () => {
    view.rerender(element);
  });
};
