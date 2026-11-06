// Integration tier configuration (suite topology; docs/plans/engineering/slow-test-suite.md).
//
// The integration files drive real child processes, PTYs, sqlite index workers
// and session runtimes, so they extend the critical path of the default unit
// suite rather than adding bulk to it: in the 2026-09-10 isolated baseline they
// were 43.8s of the suite's work across nine files, and
// cli.integration.test.ts alone was ~31s of serial child-process spawns,
// against 125.9s for the 598 unit files. vitest.config.ts excludes them; this
// config is how they run, via `pnpm test:integration`.
//
// Standalone runs need no prior build: global setup compiles one private CLI.
// CI explicitly selects its fresh production build for the CLI, gateway and
// ACP launchers, avoiding a second compilation of the same application.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.integration.{test,spec}.{ts,tsx}', 'scripts/**/*.integration.{test,spec}.{ts,tsx}'],
    environment: 'node',
    globals: false,
    // A worker can also own a real CLI or session-index child. Bound CI CPU
    // contention without sharing module state or extending any test deadline.
    maxWorkers: process.env.CI ? 2 : undefined,
    globalSetup: ['./tests/helpers/vitest-cache-global-setup.ts', './tests/helpers/integration-cli-global-setup.ts'],
    setupFiles: [
      './tests/helpers/vitest-network-guard.ts',
      './tests/helpers/vitest-cache-isolation.ts',
      './tests/helpers/cli-compile-cache-setup.ts',
      './tests/helpers/workspace-process-sweep.ts',
    ],
    restoreMocks: true,
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});
