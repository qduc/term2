import { describe, expect, it } from 'vitest';
import { BackgroundTaskControl } from './background-task-control.js';

class BoundMoveClient {
  #shellCandidate = {
    callId: 'call-1',
    jobId: 'job-1',
    command: 'echo shell',
    status: 'running' as const,
    startedAt: 1,
  };
  #subagentCandidate = { runId: 'run-1', role: 'worker', task: 'do work', startedAt: 1 };
  #capacity = false;
  constructor() {}
  setCapacity(value: boolean) {
    this.#capacity = value;
  }
  getForegroundShellTransferCandidate() {
    return this.#shellCandidate;
  }
  listForegroundSubagentCandidates() {
    return [this.#subagentCandidate];
  }
  moveForegroundShellToBackground(callId: string) {
    if (this.#capacity) {
      const error = new Error('full');
      error.name = 'BackgroundShellRegistryCapacityError';
      throw error;
    }
    if (callId !== this.#shellCandidate.callId) return undefined;
    return { jobId: this.#shellCandidate.jobId, status: 'running' as const };
  }
  moveForegroundSubagent(runId: string) {
    if (runId !== this.#subagentCandidate.runId) return undefined;
    return { ...this.#subagentCandidate, status: 'running' as const };
  }
  getBackgroundShellJob(id: string) {
    return id === 'job-1' ? { id, command: 'echo shell', status: 'running' as const, startedAt: 1 } : undefined;
  }
  getBackgroundSubagentStatus(runId: string) {
    return runId === 'run-1'
      ? ({
          runId,
          role: 'worker',
          task: 'do work',
          taskPreview: 'do work',
          status: 'running',
          startedAt: 1,
          elapsedMs: 0,
          toolCounts: {},
        } as const)
      : ({ status: 'not_found' } as const);
  }
  listBackgroundSubagentStatuses() {
    return [];
  }
  listBackgroundShellJobs() {
    return [];
  }
}

const makeControl = (client: BoundMoveClient) =>
  new BackgroundTaskControl({
    client: client as never,
    notifications: { enqueueUserControl: () => true } as never,
  });

describe('BackgroundTaskControl foreground transfer method binding', () => {
  it('moves shell and subagent targets, preserves capacity and missing-target results', () => {
    const client = new BoundMoveClient();
    const control = makeControl(client);
    expect(control.moveForegroundToBackground({ kind: 'shell', callId: 'call-1' })).toMatchObject({
      ok: true,
      details: { kind: 'shell', id: 'job-1' },
    });
    expect(control.moveForegroundToBackground({ kind: 'subagent', runId: 'run-1' })).toMatchObject({
      ok: true,
      details: { kind: 'subagent', id: 'run-1' },
    });
    client.setCapacity(true);
    expect(control.moveForegroundToBackground({ kind: 'shell', callId: 'call-1' })).toEqual({
      ok: false,
      code: 'capacity',
    });
    expect(control.moveForegroundToBackground({ kind: 'shell', callId: 'missing' })).toEqual({
      ok: false,
      code: 'not_found',
    });
    expect(control.moveForegroundToBackground({ kind: 'subagent', runId: 'missing' })).toEqual({
      ok: false,
      code: 'not_found',
    });
  });
});
