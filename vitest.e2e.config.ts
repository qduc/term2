// e2e tier configuration (suite topology; docs/plans/engineering/test-suite-audit.md).
//
// The process-level e2e files (terminal UI smoke test, package build/rollback
// round trip, fake-codex network scenarios) are excluded from the default unit
// suite in vitest.config.ts and run only through this config via
// `pnpm test:e2e` / `pnpm test:codex-network`. Files that launch the built CLI
// carry their own per-test budgets; the base timeouts below only bound the fast
// helper tests. Every built-CLI launch shares one primed V8 compile cache.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.e2e.test.ts', 'scripts/**/*.e2e.test.ts'],
    environment: 'node',
    globals: false,
    globalSetup: ['./tests/helpers/vitest-cache-global-setup.ts', './tests/helpers/e2e-cli-global-setup.ts'],
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
