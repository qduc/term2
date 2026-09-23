import { describe, expect, it } from 'vitest';
import { clearInputBeforeReset } from './clear-input-before-reset.js';

describe('clearInputBeforeReset', () => {
  it('clears the composer and flushes that frame before running the reset action', async () => {
    const calls: string[] = [];
    const reset = clearInputBeforeReset(
      {
        replaceInput: (value) => calls.push(`replaceInput:${JSON.stringify(value)}`),
        waitUntilRenderFlush: async () => {
          calls.push('flush');
        },
      },
      async () => {
        calls.push('reset');
      },
    );

    await reset();

    expect(calls).toEqual(['replaceInput:""', 'flush', 'reset']);
  });

  it('does not run the reset action until the render flush settles', async () => {
    let releaseFlush!: () => void;
    let resetRan = false;
    const reset = clearInputBeforeReset(
      {
        replaceInput: () => undefined,
        waitUntilRenderFlush: () => new Promise<void>((resolve) => (releaseFlush = resolve)),
      },
      () => {
        resetRan = true;
      },
    );

    const pending = reset();
    await Promise.resolve();
    expect(resetRan).toBe(false);

    releaseFlush();
    await pending;
    expect(resetRan).toBe(true);
  });
});
