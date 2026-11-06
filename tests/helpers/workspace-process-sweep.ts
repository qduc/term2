import { afterAll, afterEach } from 'vitest';
import { killLeakedWorkspaceProcesses, TEST_OWNER_ENV } from './kill-workspace-processes.js';

// Mark everything this worker starts, then reap what outlived its workspace: a failed or
// timed-out test must not leave a background fixture loop running for days.
process.env[TEST_OWNER_ENV] ??= `${process.pid}`;
afterEach(() => {
  killLeakedWorkspaceProcesses();
});
afterAll(() => {
  killLeakedWorkspaceProcesses();
});
