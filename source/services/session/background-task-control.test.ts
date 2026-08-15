import { describe, expect, it, vi } from 'vitest';
import { BackgroundTaskControl } from './background-task-control.js';
import { SubagentNotificationStore } from '../subagents/subagent-notification-store.js';
import { BACKGROUND_SUBAGENT_QUIET_AFTER_MS } from './background-task-control.js';

const subagentStatus = (overrides: Record<string, unknown> = {}) => ({
  runId: 'run-1',
  name: 'scan',
  role: 'explorer',
  status: 'running' as const,
  task: 'inspect the implementation',
  taskPreview: 'inspect the implementation',
  startedAt: 100,
  elapsedMs: 50,
  toolCounts: {},
  ...overrides,
});

const shellJob = (overrides: Record<string, unknown> = {}) => ({
  id: 'shell-1',
  command: 'pnpm test',
  status: 'running' as const,
  startedAt: 200,
  ...overrides,
});

describe('BackgroundTaskControl', () => {
  it('normalizes observed, provider-waiting, and quiet activity without treating quiet as terminal', () => {
    const requestStop = vi.fn((runId: string) => ({ ok: true as const, runId, status: 'cancelling' as const }));
    const now = 100_000;
    const control = new BackgroundTaskControl({
      now: () => now,
      client: {
        listBackgroundSubagentStatuses: () => [
          subagentStatus({ runId: 'active', lastActivityAt: now - 1_000, activityState: 'active' }),
          subagentStatus({
            runId: 'provider',
            lastActivityAt: now - 1_000,
            activityState: 'waiting',
            waitingReason: 'provider',
          }),
          subagentStatus({
            runId: 'quiet',
            lastActivityAt: now - BACKGROUND_SUBAGENT_QUIET_AFTER_MS - 1,
            activityState: 'active',
          }),
        ],
        getBackgroundSubagentStatus: (id) =>
          subagentStatus({
            runId: id,
            lastActivityAt: now - BACKGROUND_SUBAGENT_QUIET_AFTER_MS - 1,
            activityState: 'active',
          }),
        requestBackgroundSubagentStop: requestStop,
      },
      notifications: new SubagentNotificationStore(),
    });

    expect(control.listDetails()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'active',
          activity: expect.objectContaining({
            phase: 'active',
            liveness: expect.objectContaining({ state: 'recent' }),
          }),
        }),
        expect.objectContaining({
          id: 'provider',
          activity: expect.objectContaining({
            phase: 'waiting',
            reason: 'provider',
            liveness: expect.objectContaining({ state: 'recent' }),
          }),
        }),
        expect.objectContaining({
          id: 'quiet',
          activity: expect.objectContaining({
            phase: 'active',
            liveness: expect.objectContaining({
              state: 'quiet',
              lastObservedAt: now - BACKGROUND_SUBAGENT_QUIET_AFTER_MS - 1,
            }),
          }),
        }),
      ]),
    );

    expect(control.requestStop({ kind: 'subagent', id: 'quiet' })).toEqual({
      ok: true,
      details: expect.objectContaining({
        id: 'quiet',
        activity: expect.objectContaining({
          phase: 'cancelling',
          lastObservation: expect.objectContaining({ kind: 'stop_requested' }),
        }),
      }),
    });
  });

  it('keeps approval waiting and confirmed failure distinct from quiet', () => {
    const control = new BackgroundTaskControl({
      now: () => 100_000,
      client: {
        listBackgroundSubagentStatuses: () => [
          subagentStatus({
            runId: 'approval',
            status: 'awaiting_approval',
            activityState: 'waiting',
            waitingReason: 'approval',
          }),
          subagentStatus({ runId: 'failed', status: 'failed', activityState: 'active', lastActivityAt: 1_000 }),
        ],
        getBackgroundSubagentStatus: (id) =>
          id === 'approval'
            ? subagentStatus({
                runId: id,
                status: 'awaiting_approval',
                activityState: 'waiting',
                waitingReason: 'approval',
              })
            : subagentStatus({ runId: id, status: 'failed', activityState: 'active', lastActivityAt: 1_000 }),
      },
      notifications: new SubagentNotificationStore(),
    });

    expect(control.getDetails({ kind: 'subagent', id: 'approval' })).toEqual(
      expect.objectContaining({ activity: expect.objectContaining({ phase: 'waiting', reason: 'approval' }) }),
    );
    expect(control.getDetails({ kind: 'subagent', id: 'failed' })).toEqual(
      expect.objectContaining({ status: 'failed', activity: expect.objectContaining({ phase: 'settled' }) }),
    );
  });

  it('lists live work before retained terminal work and returns executor-specific details', () => {
    const control = new BackgroundTaskControl({
      client: {
        listBackgroundSubagentStatuses: () => [
          subagentStatus(),
          subagentStatus({ runId: 'run-old', status: 'completed' }),
        ],
        listBackgroundShellJobs: () => [
          shellJob({
            status: 'failed',
            completedAt: 300,
            error: 'exit 1',
            result: { output: 'failing assertion', status: 'failed' },
          }),
        ],
        getBackgroundSubagentStatus: (id) =>
          id === 'run-1' ? subagentStatus() : subagentStatus({ status: 'not_found' }),
        getBackgroundShellJob: (id) => (id === 'shell-1' ? shellJob() : undefined),
      },
      notifications: new SubagentNotificationStore(),
    });

    expect(control.listDetails()).toEqual([
      expect.objectContaining({ kind: 'subagent', id: 'run-1', name: 'scan', status: 'running' }),
      expect.objectContaining({ kind: 'subagent', id: 'run-old', status: 'completed' }),
      expect.objectContaining({
        kind: 'shell',
        id: 'shell-1',
        status: 'failed',
        error: 'exit 1',
        output: 'failing assertion',
      }),
    ]);
    expect(control.getDetails({ kind: 'shell', id: 'shell-1' })).toEqual(
      expect.objectContaining({ kind: 'shell', command: 'pnpm test' }),
    );
  });

  it('requests a subagent stop once, wakes observers, and leaves its later cancellation completion owed', () => {
    const notifications = new SubagentNotificationStore();
    const onNotification = vi.fn();
    const onTaskChange = vi.fn();
    const requestStop = vi.fn(() => ({ ok: true as const, runId: 'run-1', status: 'cancelling' as const }));
    const control = new BackgroundTaskControl({
      client: {
        getBackgroundSubagentStatus: () => subagentStatus(),
        requestBackgroundSubagentStop: requestStop,
      },
      notifications,
      onNotification,
      onTaskChange,
    });

    expect(control.requestStop({ kind: 'subagent', id: 'run-1' })).toEqual({
      ok: true,
      details: expect.objectContaining({ kind: 'subagent', id: 'run-1', status: 'cancelling' }),
    });
    expect(control.requestStop({ kind: 'subagent', id: 'run-1' }).ok).toBe(true);
    expect(requestStop).toHaveBeenCalledTimes(2);
    expect(onNotification).toHaveBeenCalledTimes(1);
    expect(onTaskChange).toHaveBeenCalledTimes(2);
    expect(notifications.drain()).toEqual([
      expect.objectContaining({ kind: 'user_control', action: 'stop', target: { kind: 'subagent', id: 'run-1' } }),
    ]);

    expect(
      notifications.enqueue({
        type: 'subagent_completed',
        async: true,
        result: {
          agentId: 'run-1',
          role: 'explorer',
          status: 'cancelled',
          finalText: '',
          filesChanged: [],
          toolsUsed: [],
        },
      }),
    ).toBe(true);
  });

  it('does not request a stale shell target or notify the main agent', () => {
    const notifications = new SubagentNotificationStore();
    const requestStop = vi.fn(() => true);
    const control = new BackgroundTaskControl({
      client: {
        getBackgroundShellJob: () => undefined,
        requestBackgroundShellStop: requestStop,
      },
      notifications,
      onNotification: vi.fn(),
      onTaskChange: vi.fn(),
    });

    expect(control.getDetails({ kind: 'shell', id: 'gone' })).toBeNull();
    expect(control.requestStop({ kind: 'shell', id: 'gone' })).toEqual({ ok: false, code: 'not_found' });
    expect(requestStop).not.toHaveBeenCalled();
    expect(notifications.pendingCount).toBe(0);
  });

  it('adopts a foreground shell only after it is still transferable and notifies the next agent step', () => {
    const notifications = new SubagentNotificationStore();
    const onNotification = vi.fn();
    const onTaskChange = vi.fn();
    const move = vi.fn(() => ({ jobId: 'shell-1', status: 'running' as const }));
    const control = new BackgroundTaskControl({
      client: {
        getForegroundShellTransferCandidate: () => ({
          callId: 'call-1',
          jobId: 'shell-1',
          command: 'pnpm test',
          status: 'running',
          startedAt: 200,
        }),
        moveForegroundShellToBackground: move,
        getBackgroundShellJob: (id) => (id === 'shell-1' ? shellJob() : undefined),
      },
      notifications,
      onNotification,
      onTaskChange,
    });

    expect(control.getForegroundTransferCandidate()).toEqual({
      kind: 'shell',
      callId: 'call-1',
      jobId: 'shell-1',
      command: 'pnpm test',
      status: 'running',
      startedAt: 200,
    });
    expect(control.moveForegroundToBackground({ kind: 'shell', callId: 'call-1' })).toEqual({
      ok: true,
      details: expect.objectContaining({ kind: 'shell', id: 'shell-1', command: 'pnpm test' }),
    });
    expect(move).toHaveBeenCalledWith('call-1');
    expect(onNotification).toHaveBeenCalledTimes(1);
    expect(onTaskChange).toHaveBeenCalledTimes(1);
    expect(notifications.drain()).toEqual([
      expect.objectContaining({
        kind: 'user_control',
        action: 'background',
        target: { kind: 'shell', id: 'shell-1' },
      }),
    ]);
  });

  it('does not notify when the foreground shell cannot be adopted', () => {
    const notifications = new SubagentNotificationStore();
    const control = new BackgroundTaskControl({
      client: {
        getForegroundShellTransferCandidate: () => ({
          callId: 'call-1',
          jobId: 'shell-1',
          command: 'pnpm test',
          status: 'running',
          startedAt: 200,
        }),
        moveForegroundShellToBackground: () => {
          throw Object.assign(new Error('full'), { name: 'BackgroundShellRegistryCapacityError' });
        },
      },
      notifications,
    });

    expect(control.moveForegroundToBackground({ kind: 'shell', callId: 'call-1' })).toEqual({
      ok: false,
      code: 'capacity',
    });
    expect(notifications.pendingCount).toBe(0);
  });

  it('adopts a foreground subagent through the session control port and notifies the next planning step', () => {
    const notifications = new SubagentNotificationStore();
    const onNotification = vi.fn();
    const onTaskChange = vi.fn();
    const move = vi.fn(() => ({ runId: 'child-1', role: 'worker', status: 'running' as const, task: 'inspect tests' }));
    const control = new BackgroundTaskControl({
      client: {
        listForegroundSubagentCandidates: () => [
          { runId: 'child-1', role: 'worker', task: 'inspect tests', parentTool: 'run_subagent', startedAt: 1_000 },
        ],
        moveForegroundSubagent: move,
        getBackgroundSubagentStatus: (runId) => subagentStatus({ runId, role: 'worker', task: 'inspect tests' }),
      },
      notifications,
      onNotification,
      onTaskChange,
    });

    expect(control.listForegroundTransferCandidates()).toContainEqual(
      expect.objectContaining({ kind: 'subagent', runId: 'child-1', role: 'worker', status: 'running' }),
    );
    expect(control.moveForegroundToBackground({ kind: 'subagent', runId: 'child-1' })).toEqual({
      ok: true,
      details: expect.objectContaining({ kind: 'subagent', id: 'child-1', status: 'running' }),
    });
    expect(move).toHaveBeenCalledWith('child-1');
    expect(onNotification).toHaveBeenCalledOnce();
    expect(onTaskChange).toHaveBeenCalledOnce();
    expect(notifications.drain()).toEqual([
      expect.objectContaining({
        kind: 'user_control',
        action: 'background',
        target: { kind: 'subagent', id: 'child-1' },
      }),
    ]);
  });

  it('reports unavailable when a stop target reader capability is absent', () => {
    const notifications = new SubagentNotificationStore();
    const requestSubagentStop = vi.fn();
    const requestShellStop = vi.fn();
    const control = new BackgroundTaskControl({
      client: {
        requestBackgroundSubagentStop: requestSubagentStop,
        requestBackgroundShellStop: requestShellStop,
      },
      notifications,
    });

    expect(control.requestStop({ kind: 'subagent', id: 'run-1' })).toEqual({ ok: false, code: 'unavailable' });
    expect(control.requestStop({ kind: 'shell', id: 'shell-1' })).toEqual({ ok: false, code: 'unavailable' });
    expect(requestSubagentStop).not.toHaveBeenCalled();
    expect(requestShellStop).not.toHaveBeenCalled();
    expect(notifications.pendingCount).toBe(0);
  });

  it('reports unavailable when a discovered foreground shell cannot be moved', () => {
    const notifications = new SubagentNotificationStore();
    const control = new BackgroundTaskControl({
      client: {
        getForegroundShellTransferCandidate: () => ({
          callId: 'call-1',
          jobId: 'shell-1',
          command: 'pnpm test',
          status: 'running',
          startedAt: 200,
        }),
      },
      notifications,
    });

    expect(control.moveForegroundToBackground({ kind: 'shell', callId: 'call-1' })).toEqual({
      ok: false,
      code: 'unavailable',
    });
    expect(notifications.pendingCount).toBe(0);
  });

  it('reports unavailable when a discovered foreground subagent cannot be moved', () => {
    const notifications = new SubagentNotificationStore();
    const control = new BackgroundTaskControl({
      client: {
        listForegroundSubagentCandidates: () => [
          { runId: 'child-1', role: 'worker', task: 'inspect tests', parentTool: 'run_subagent', startedAt: 1_000 },
        ],
      },
      notifications,
    });

    expect(control.moveForegroundToBackground({ kind: 'subagent', runId: 'child-1' })).toEqual({
      ok: false,
      code: 'unavailable',
    });
    expect(notifications.pendingCount).toBe(0);
  });

  it('reports unavailable rather than not found when foreground discovery is unsupported', () => {
    const notifications = new SubagentNotificationStore();
    const control = new BackgroundTaskControl({
      client: {},
      notifications,
    });

    expect(control.moveForegroundToBackground({ kind: 'shell', callId: 'call-1' })).toEqual({
      ok: false,
      code: 'unavailable',
    });
    expect(control.moveForegroundToBackground({ kind: 'subagent', runId: 'child-1' })).toEqual({
      ok: false,
      code: 'unavailable',
    });
    expect(notifications.pendingCount).toBe(0);
  });
});
