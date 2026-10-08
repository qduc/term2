// Per-file reset for the shared-worker run (vitest.shared.config.ts).
//
// With `isolate: false` a worker keeps its process across test files, so state that an
// isolated run would discard leaks from one file into the next. This setup file runs
// before each file and, after it, puts back what the file left behind:
//   - the application module registry (provider registry, caches, singletons) is cleared,
//     so the next file gets fresh application modules. Native ESM in node_modules is not
//     part of that registry, so heavy third-party libraries stay loaded once per worker;
//   - process.env (including the object itself), the working directory and application-owned
//     globals (term2*) are restored; see vitest-process-state.ts.
// Handles that outlive a file (sockets, timers, child processes) are not reset here.
//
// Set TERM2_SHARED_LEAK_LOG=<path> to append one JSON line per file that left anything to
// restore (shows which tests leak), and TERM2_SHARED_TRACE=<path> to append the worker pid
// file name, heap and RSS in MB at the start of each file (shows which files shared a worker
// and how its memory grows).
// See docs/plans/shared-worker-runs.md.
import fs from 'node:fs';
import { afterAll, expect, vi } from 'vitest';
import { restoreProcessState, snapshotProcessState } from './vitest-process-state.js';

const tracePath = process.env.TERM2_SHARED_TRACE;
if (tracePath) {
  const { heapUsed, rss } = process.memoryUsage();
  fs.appendFileSync(
    tracePath,
    `${process.pid}\t${Date.now()}\t${expect.getState().testPath}\t${Math.round(heapUsed / 1e6)}\t${Math.round(
      rss / 1e6,
    )}\n`,
  );
}

const snapshot = snapshotProcessState();

afterAll(() => {
  const leaked = restoreProcessState(snapshot);
  vi.resetModules();

  const logPath = process.env.TERM2_SHARED_LEAK_LOG;
  if (logPath && Object.keys(leaked).length) {
    fs.appendFileSync(logPath, `${JSON.stringify({ file: expect.getState().testPath, ...leaked })}\n`);
  }
});
