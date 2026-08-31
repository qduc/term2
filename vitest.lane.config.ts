// Deterministic lane configuration for docs/plans/slow-test-suite.md.
//
// The lane runs the deterministic subset of the suite: no PTY/e2e/integration
// files, no provider-black-box scripts. It is selected by an explicit manifest
// (.github/vitest.lane.safe.txt) composed with the tier excludes, so new
// integration-style files are excluded by pattern and the manifest only ever
// narrows further.
//
// Consumers: `pnpm test:lane` / `pnpm test:lane:seed`.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['source/**/*.{test,spec}.{ts,tsx}', 'scripts/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/*.integration.*', '**/*.e2e.*', 'scripts/provider-black-box/**'],
    environment: 'node',
    globals: false,
    setupFiles: ['./source/test-helpers/vitest-network-guard.ts'],
    restoreMocks: true,
    testTimeout: 10_000,
    hookTimeout: 10_000,
    // The lane must be reproducible: explicit seed instead of Vitest's default
    // per-run seed, so shuffled runs are comparable across machines.
    sequence: { shuffle: true, seed: 20260829 },
  },
});
