import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawned = vi.hoisted(() => [] as Array<{ args: string[]; child: any }>);

vi.mock('node:fs', () => ({ appendFileSync: vi.fn() }));
vi.mock('node:child_process', () => ({
  spawn: vi.fn((_command: string, args: string[]) => {
    const child = new EventEmitter() as any;
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    spawned.push({ args, child });
    return child;
  }),
}));

import register from './herdr-status-hook.js';

describe('Herdr status hook', () => {
  afterEach(() => {
    vi.useRealTimers();
    spawned.length = 0;
    delete process.env.HERDR_PANE_ID;
  });

  function callbacks(): Map<string, (event: any) => any> {
    const result = new Map<string, (event: any) => any>();
    register({
      on: (event: string, callback: (event: any) => any) => {
        result.set(event, callback);
        return () => result.delete(event);
      },
    } as any);
    return result;
  }

  async function flushQueue(): Promise<void> {
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
  }

  it('reports approval waits as blocked and serializes reports', async () => {
    process.env.HERDR_PANE_ID = 'pane-1';
    const handlers = callbacks();

    handlers.get('status.change')?.({ current: 'waiting_for_approval', sessionId: 'session-1' });
    handlers.get('status.change')?.({ current: 'working', sessionId: 'session-1' });

    await vi.waitFor(() => expect(spawned).toHaveLength(1));
    expect(spawned[0].args).toContain('blocked');
    spawned[0].child.emit('close', 0);
    await vi.waitFor(() => expect(spawned).toHaveLength(2));
    expect(spawned[1].args).toContain('working');
    spawned[1].child.emit('close', 0);
  });

  it('retries a failed report before advancing the queue', async () => {
    process.env.HERDR_PANE_ID = 'pane-1';
    const handlers = callbacks();

    handlers.get('status.change')?.({ current: 'waiting_for_approval', sessionId: 'session-1' });
    await vi.waitFor(() => expect(spawned).toHaveLength(1));
    spawned[0].child.emit('close', 1);
    await vi.waitFor(() => expect(spawned).toHaveLength(2));
    spawned[1].child.emit('close', 0);
  });

  it('does not retry until a timed-out reporter closes', async () => {
    vi.useFakeTimers();
    process.env.HERDR_PANE_ID = 'pane-1';
    const handlers = callbacks();

    handlers.get('status.change')?.({ current: 'waiting_for_approval', sessionId: 'session-1' });
    handlers.get('status.change')?.({ current: 'working', sessionId: 'session-1' });
    await flushQueue();
    expect(spawned).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(5000);
    expect(spawned[0].child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(spawned).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(spawned[0].child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(spawned).toHaveLength(1);

    spawned[0].child.emit('close', null);
    await flushQueue();
    expect(spawned).toHaveLength(2);
    spawned[1].child.emit('close', 0);
    await flushQueue();
    expect(spawned).toHaveLength(3);
    expect(spawned[2].args).toContain('working');
    spawned[2].child.emit('close', 0);
    await flushQueue();
  });

  it('queues startup registration before the initial idle report', async () => {
    process.env.HERDR_PANE_ID = 'pane-1';
    const handlers = callbacks();

    const startup = handlers.get('session.start')?.({ sessionId: 'session-1' });
    handlers.get('status.change')?.({ current: 'working', sessionId: 'session-1' });

    await vi.waitFor(() => expect(spawned).toHaveLength(1));
    expect(spawned[0].args).toContain('report-agent-session');
    spawned[0].child.emit('close', 0);
    await vi.waitFor(() => expect(spawned).toHaveLength(2));
    expect(spawned[1].args).toContain('idle');
    spawned[1].child.emit('close', 0);
    await vi.waitFor(() => expect(spawned).toHaveLength(3));
    expect(spawned[2].args).toContain('working');
    spawned[2].child.emit('close', 0);
    await startup;
  });
});
