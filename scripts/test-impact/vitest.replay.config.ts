import fs from 'node:fs';
import { BaseSequencer } from 'vitest/node';
import { defineConfig } from 'vitest/config';
import base from '../../vitest.config';

// Replays an exact file order in ONE shared worker, with the same per-file reset as
// `pnpm test:shared`. ORDER_FILE lists repo-relative test files, one per line, in the order
// to run them. Used by ddmin-order.mjs to shrink a failing worker's history to the file
// that causes it. Not used by any test script.
const order = fs
  .readFileSync(process.env.ORDER_FILE!, 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean);
const rank = new Map(order.map((file, index) => [file, index]));

class ReplaySequencer extends BaseSequencer {
  async sort(files: any[]) {
    const rel = (file: any) => String(file.moduleId ?? file.file ?? file).replace(`${process.cwd()}/`, '');
    return [...files].sort((a, b) => (rank.get(rel(a)) ?? 1e9) - (rank.get(rel(b)) ?? 1e9));
  }
}

const t = base.test!;
export default defineConfig({
  test: {
    ...t,
    include: order,
    isolate: false,
    maxWorkers: 1,
    fileParallelism: false,
    setupFiles: [...(t.setupFiles as string[]), './source/test-helpers/vitest-reset-modules.ts'],
    sequence: { sequencer: ReplaySequencer as any },
  },
});
