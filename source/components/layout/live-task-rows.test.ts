import { expect, it } from 'vitest';
import { mergeLiveTaskRows } from './live-task-rows.js';

it('places unadopted work ahead of background rows and tags placement', () => {
  const rows = mergeLiveTaskRows({
    foreground: [
      {
        kind: 'subagent',
        runId: 'child-1',
        role: 'explorer',
        task: 'inspect fixtures',
        status: 'running',
        startedAt: 1_000,
      },
      {
        kind: 'shell',
        callId: 'call-1',
        jobId: 'job-1',
        command: 'pnpm test',
        status: 'running',
        startedAt: 1_000,
      },
    ],
    background: [
      {
        kind: 'subagent',
        id: 'run-1',
        role: 'worker',
        task: 'write the report',
        taskPreview: 'write the report',
        status: 'running',
        startedAt: 2_000,
        elapsedMs: 0,
        toolCounts: {},
      },
    ],
  });

  expect(rows.map((row) => ({ key: row.key, placement: row.placement }))).toEqual([
    { key: 'subagent:child-1', placement: 'foreground' },
    { key: 'shell:job-1', placement: 'foreground' },
    { key: 'subagent:run-1', placement: 'background' },
  ]);
});
