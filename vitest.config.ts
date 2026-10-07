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
    // Vitest defaults to cores - 1 workers. The suite is CPU-bound (~89% of 4
    // cores busy) but each worker also spends time blocked on real timers, I/O
    // and process teardown, so a modest oversubscription fills those gaps.
    // Measured on a 4-core machine, full unit suite, 2026-10-07, same code:
    // 4 workers ~142s, 5 ~135s, 6 ~132s, 8 ~132s, 10 ~132s, all with the same
    // single pre-existing failure. 1.5x cores gets the whole gain; the cap keeps
    // large machines from spawning more workers than memory warrants.
    // `--maxWorkers` on the CLI still overrides this.
    maxWorkers: Math.min(Math.ceil(os.availableParallelism() * 1.5), os.availableParallelism() + 4),
    // Persist Vite's transform output on disk (node_modules/.vite/vitest), keyed
    // by file content, so unchanged modules are not re-transformed in every
    // worker of every run. On the 73-file selection for a medium change,
    // transform fell 14.5s -> 2.7s and wall 22.4s -> 19.2s; a cold cache costs
    // about 3% extra once.
    experimental: { fsModuleCache: true },
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
