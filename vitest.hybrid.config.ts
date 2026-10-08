import fs from 'node:fs';
import { defineConfig } from 'vitest/config';
import base from './vitest.config';

// Hybrid run: the verified manifest shares workers (isolate: false) so module
// loading and schema construction are paid once per worker instead of once per
// file; every other file stays isolated. All files still run. This is a
// development accelerator, not the CI authority — `pnpm test` is fully isolated.
// See .github/vitest.shared-modules.txt for the admission rule.
const manifest = fs
  .readFileSync('.github/vitest.shared-modules.txt', 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#') && fs.existsSync(line));

const shared = base.test!;
export default defineConfig({
  test: {
    maxWorkers: shared.maxWorkers,
    projects: [
      { test: { ...shared, name: 'shared-modules', include: manifest, isolate: false, maxWorkers: undefined } },
      {
        test: { ...shared, name: 'isolated', exclude: [...(shared.exclude ?? []), ...manifest], maxWorkers: undefined },
      },
    ],
  },
});
