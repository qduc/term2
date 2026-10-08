import { defineConfig } from 'vitest/config';
import base from './vitest.config';

// Shared-worker run: every unit file runs in a worker that is reused across files
// (isolate: false) with the application module registry cleared after each file.
// Same files, same assertions as `pnpm test`; the difference is that third-party
// libraries and the worker process are paid for once per worker, not once per file.
// `pnpm test` stays fully isolated.
const t = base.test!;
export default defineConfig({
  test: {
    ...t,
    isolate: false,
    setupFiles: [...(t.setupFiles as string[]), './source/test-helpers/vitest-reset-modules.ts'],
  },
});
