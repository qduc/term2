import React from 'react';
import { expect, it } from 'vitest';
import BackgroundTaskManager from './BackgroundTaskManager.js';
import type {
  BackgroundTaskControlDetails,
  ForegroundTransferCandidate,
} from '../../services/session/background-task-control.js';
import { renderInAct, toVisibleText } from '../../test-helpers/ink-testing.js';

const taskDetails = (id: string, status: 'running' | 'awaiting_approval' | 'completed'): BackgroundTaskControlDetails =>
  status === 'awaiting_approval'
    ? {
        kind: 'subagent',
        id,
        role: 'reviewer',
        task: 's'.repeat(100),
        taskPreview: 's'.repeat(100),
        status,
        startedAt: 1,
        elapsedMs: 0,
        toolCounts: {},
        activity: {
          phase: 'waiting',
          reason: 'approval',
          lastObservation: { kind: 'approval_requested', at: 1 },
          liveness: { state: 'quiet', lastObservedAt: 1, ageMs: 1000 },
        },
      }
    : { kind: 'shell', id, command: 's'.repeat(100), status, startedAt: 1 };

it('keeps long foreground and approval identities on one row and hides settled tasks', async () => {
  const foreground: ForegroundTransferCandidate = {
    kind: 'subagent',
    runId: 'worker-1',
    role: 'worker',
    task: 'w'.repeat(100),
    startedAt: 1,
    status: 'running',
  };
  const view = await renderInAct(
    <BackgroundTaskManager
      open
      listDetails={() => [taskDetails('waiting', 'awaiting_approval'), taskDetails('settled', 'completed')]}
      getDetails={() => null}
      requestStop={() => ({ ok: false, code: 'not_active' })}
      listForegroundTransferCandidates={() => [foreground]}
    />,
  );
  const frame = view.lastFrame();
  const lines = toVisibleText(frame ?? '').split('\n');
  const workerLine = lines.find((line) => line.includes('[worker · foreground]'));
  const waitingLine = lines.find((line) => line.includes('[reviewer]') && line.includes('awaiting approval'));
  expect(workerLine).toContain('running');
  expect(waitingLine).toContain('awaiting approval response · quiet');
  expect(lines.join('\n')).toContain('waiting');
  expect(lines.join('\n')).not.toContain('settled');
});
