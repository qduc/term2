import { describe, expect, it, vi } from 'vitest';

import type { StatusChangeHookEvent, Term2Hooks } from './hook-contracts.js';
import { HookRegistrationClosedError, HookRegistry } from './hook-registry.js';

const event = (eventId: string): StatusChangeHookEvent => ({
  type: 'status.change',
  schemaVersion: 1,
  eventId,
  sessionId: 'session-1',
  timestamp: 1,
  scope: 'root',
  previous: 'idle',
  current: 'working',
  reason: 'turn_started',
});

describe('HookRegistry', () => {
  it('dispatches callbacks in registration order and allows duplicate callbacks', async () => {
    const registry = new HookRegistry();
    const order: string[] = [];
    const callback = () => order.push('same');

    await registry.register({ path: 'a.ts', scope: 'user' }, (hooks) => {
      hooks.on('status.change', () => {
        order.push('first');
      });
      hooks.on('status.change', () => {
        callback();
      });
      hooks.on('status.change', () => {
        callback();
      });
    });

    await registry.dispatch(event('event-1'));
    expect(order).toEqual(['first', 'same', 'same']);
  });

  it('unsubscribes one callback without changing the order of remaining callbacks', async () => {
    const registry = new HookRegistry();
    const order: string[] = [];
    let unsubscribe!: () => void;

    await registry.register((hooks) => {
      unsubscribe = hooks.on('status.change', () => {
        order.push('removed');
      });
      hooks.on('status.change', () => {
        order.push('kept');
      });
    });
    unsubscribe();

    await registry.dispatch(event('event-2'));
    expect(order).toEqual(['kept']);
  });

  it('rejects registrations retained after the registration function has completed', async () => {
    const registry = new HookRegistry();
    let retained!: Term2Hooks;

    await registry.register((hooks) => {
      retained = hooks;
    });

    expect(() => retained.on('status.change', vi.fn())).toThrow(HookRegistrationClosedError);
  });

  it('rolls back every callback when module registration fails', async () => {
    const registry = new HookRegistry();
    const callback = vi.fn();

    await expect(
      registry.register({ path: 'broken.ts', scope: 'project' }, (hooks) => {
        hooks.on('status.change', callback);
        throw new Error('broken registration');
      }),
    ).rejects.toThrow('broken registration');

    await registry.dispatch(event('event-3'));
    expect(callback).not.toHaveBeenCalled();
  });

  it('isolates callback failures and applies a per-callback timeout', async () => {
    const diagnostics: string[] = [];
    const registry = new HookRegistry({
      callbackTimeoutMs: 10,
      logger: (diagnostic) => diagnostics.push(diagnostic.code),
    });
    const order: string[] = [];

    await registry.register({ path: 'hooks.ts', scope: 'user' }, (hooks) => {
      hooks.on('status.change', () => {
        order.push('throws');
        throw new Error('callback failure');
      });
      hooks.on('status.change', async () => {
        order.push('slow');
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
      hooks.on('status.change', () => {
        order.push('after-timeout');
      });
    });

    await registry.dispatch(event('event-4'));
    expect(order).toEqual(['throws', 'slow', 'after-timeout']);
    expect(diagnostics).toEqual(['callback_failed', 'callback_timed_out']);
  });

  it('dispatches an eventId at most once, including concurrent dispatches', async () => {
    const callback = vi.fn();
    const registry = new HookRegistry();
    await registry.register((hooks) => {
      hooks.on('status.change', callback);
    });

    await Promise.all([registry.dispatch(event('same-id')), registry.dispatch(event('same-id'))]);
    expect(callback).toHaveBeenCalledTimes(1);
  });
});
