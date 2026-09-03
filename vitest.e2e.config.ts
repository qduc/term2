// e2e tier configuration (suite topology; docs/plans/test-suite-audit.md).
//
// The process-level e2e files (terminal UI smoke test, package build/rollback
// round trip, fake-codex network scenarios) are excluded from the default unit
// suite in vitest.config.ts and run only through this config via
// `pnpm test:e2e` / `pnpm test:codex-network`. cli.e2e.test.ts carries its own
// 600s per-test budget (tsx cold start under CI contention); the base timeouts
// below only bound the fast helper tests.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['source/**/*.e2e.test.ts', 'scripts/**/*.e2e.test.ts'],
    environment: 'node',
    globals: false,
    setupFiles: ['./source/test-helpers/vitest-network-guard.ts'],
    restoreMocks: true,
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});
