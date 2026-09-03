import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['source/**/*.{test,spec}.{ts,tsx}', 'scripts/**/*.test.ts'],
    // The e2e tier runs through `pnpm test:e2e` (vitest.e2e.config.ts), never
    // inside the default unit suite; see docs/plans/test-suite-audit.md.
    exclude: ['**/node_modules/**', '**/*.e2e.*'],
    environment: 'node',
    globals: false,
    setupFiles: ['./source/test-helpers/vitest-network-guard.ts'],
    restoreMocks: true,
    testTimeout: 10_000,
    hookTimeout: 10_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
});
