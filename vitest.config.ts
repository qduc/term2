import os from 'node:os';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['source/**/*.{test,spec}.{ts,tsx}', 'scripts/**/*.test.ts', 'docs/**/*.test.ts'],
    // The default suite is the unit tier only. The other tiers own their
    // commands: `pnpm test:e2e` (vitest.e2e.config.ts),
    // `pnpm test:integration` (vitest.integration.config.ts), and
    // `pnpm test:provider-black-box`, which already ran the black-box
    // `scripts/provider-black-box/**/*.test.ts` files through
    // vitest.provider-black-box.config.ts — including them here ran every one
    // of them twice.
    //
    // They are excluded from the default because they hold its critical path
    // rather than its bulk: in the 2026-09-10 isolated baseline the nine
    // integration files were 43.8s of the suite's work, cli.integration.test.ts
    // alone was ~31s of serial child-process spawns, and the black-box files
    // were fully duplicated, against 125.9s for the 598 unit files. With the
    // 10 non-black-box `scripts/**` tests, the default tier is 608 files and
    // 8342 tests. See docs/plans/slow-test-suite.md.
    exclude: ['**/node_modules/**', '**/*.e2e.*', '**/*.integration.*', 'scripts/provider-black-box/**'],
    environment: 'node',
    // Vitest defaults to cores - 1 workers to leave a core for its main thread.
    // Measured on a 4-core machine, full unit suite, 2026-10-07: 3 workers
    // 196-200s, 4 workers 158s, 6 workers 150s (but summed test time rose
    // 215s -> 294s from contention, which risks timing-sensitive tests). Much
    // of the work is import evaluation and timer/IO waiting, so the main
    // thread's share is small; one worker per core is the point before
    // contention dominates. `--maxWorkers` on the CLI still overrides this.
    maxWorkers: os.availableParallelism(),
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
