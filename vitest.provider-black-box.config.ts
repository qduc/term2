import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['scripts/provider-black-box/**/*.test.ts', 'scripts/provider-black-box/**/*.blackbox.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 10_000,
  },
});
