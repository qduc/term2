// Integration tier configuration (suite topology; docs/plans/slow-test-suite.md).
//
// The integration files drive real child processes, PTYs, sqlite index workers
// and session runtimes, so they extend the critical path of the default unit
// suite rather than adding bulk to it: in the 2026-09-10 isolated baseline they
// were 43.8s of the suite's work across nine files, and
// cli.integration.test.ts alone was ~31s of serial child-process spawns,
// against 125.9s for the 598 unit files. vitest.config.ts excludes them; this
// config is how they run, via `pnpm test:integration`.
//
// Unlike the e2e tier, this one needs no prior `pnpm build`:
// cli.integration.test.ts compiles the CLI into
// node_modules/.cache/term2-cli-test-build itself.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['source/**/*.integration.{test,spec}.{ts,tsx}', 'scripts/**/*.integration.{test,spec}.{ts,tsx}'],
    environment: 'node',
    globals: false,
    setupFiles: ['./source/test-helpers/vitest-network-guard.ts', './source/test-helpers/vitest-cache-isolation.ts'],
    restoreMocks: true,
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});
