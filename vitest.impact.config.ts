import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config';

// Footprint-recording variant of the unit config. Not used by `pnpm test`.
// Run via scripts/test-impact/record.mjs, which sets TERM2_IMPACT_DIR.
export default mergeConfig(
  base,
  defineConfig({
    test: { setupFiles: ['./scripts/test-impact/recorder.setup.ts'] },
  }),
);
