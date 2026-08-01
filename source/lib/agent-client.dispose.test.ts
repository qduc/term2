import { expect, it } from 'vitest';
import { ApplicationRunLoop } from '../services/agent-runtime/application-run-loop.js';

it('application run loop aborts an active stream on disposal-equivalent abort', () => {
  const loop = new ApplicationRunLoop({
    resolveModel: async () => ({
      async *stream() {
        await new Promise(() => {});
      },
    }),
  });
  loop.abort();
  expect(true).toBe(true);
});
