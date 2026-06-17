import { it, expect } from 'vitest';
import { SessionContextService } from './session-context-service.js';

it('getContext returns null outside runWithContext', () => {
  const service = new SessionContextService();

  expect(service.getContext()).toBe(null);
});

it('context is visible inside runWithContext', () => {
  const service = new SessionContextService();
  const context = { sessionId: 'session-1', sessionStartedAt: '2025-01-01T00:00:00.000Z' };

  const result = service.runWithContext(context, () => {
    expect(service.getContext()).toEqual(context);
    return 'ok';
  });

  expect(result).toBe('ok');
});

it('context survives across an awaited promise', async () => {
  const service = new SessionContextService();
  const context = { sessionId: 'session-2', sessionStartedAt: '2025-01-02T00:00:00.000Z', traceId: 'trace-1' };

  await service.runWithContext(context, async () => {
    await Promise.resolve();
    expect(service.getContext()).toEqual(context);
  });
});

it('nested runWithContext restores the outer context after inner completes', async () => {
  const service = new SessionContextService();
  const outer = { sessionId: 'outer', sessionStartedAt: '2025-01-03T00:00:00.000Z' };
  const inner = { sessionId: 'inner', sessionStartedAt: '2025-01-04T00:00:00.000Z', evaluator: true as const };

  await service.runWithContext(outer, async () => {
    expect(service.getContext()).toEqual(outer);

    await service.runWithContext(inner, async () => {
      expect(service.getContext()).toEqual(inner);
      await Promise.resolve();
      expect(service.getContext()).toEqual(inner);
    });

    expect(service.getContext()).toEqual(outer);
  });
});
