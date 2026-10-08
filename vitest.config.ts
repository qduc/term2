import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['source/**/*.{test,spec}.{ts,tsx}', 'scripts/**/*.test.ts', 'docs/**/*.test.ts'],
    // During the evidence-driven development experiment the only committed
    // files in this tier are the static repository guards listed in
    // scripts/check-no-unit-tests.mjs; the unit suite was removed (tag
    // `unit-suite-baseline` keeps it). This config also runs the temporary,
    // uncommitted tests agents write while verifying a change.
    // See docs/experiments/evidence-driven-development/README.md.
    //
    // The other tiers own their commands: `pnpm test:e2e`
    // (vitest.e2e.config.ts), `pnpm test:integration`
    // (vitest.integration.config.ts), and `pnpm test:provider-black-box`
    // (vitest.provider-black-box.config.ts).
    exclude: ['**/node_modules/**', '**/*.e2e.*', '**/*.integration.*', 'scripts/provider-black-box/**'],
    environment: 'node',
    globals: false,
    setupFiles: ['./source/test-helpers/vitest-network-guard.ts', './source/test-helpers/vitest-cache-isolation.ts'],
    restoreMocks: true,
    testTimeout: 10_000,
    hookTimeout: 10_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
});
