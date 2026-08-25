import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['scripts/provider-black-box/**/*.test.ts', 'scripts/provider-black-box/**/*.blackbox.ts'],
    environment: 'node',
    // A scenario drives several PTY turns through the shipped CLI; on shared
    // CI runners a single multi-turn lifecycle can outgrow vitest's default
    // ceiling long before any individual harness wait does.
    testTimeout: 90_000,
    hookTimeout: 30_000,
  },
});
