import test from 'ava';
import { SessionContextService } from './session-context-service.js';

test('getContext returns null outside runWithContext', (t) => {
  const service = new SessionContextService();

  t.is(service.getContext(), null);
});

test('context is visible inside runWithContext', (t) => {
  const service = new SessionContextService();
  const context = { sessionId: 'session-1', sessionStartedAt: '2025-01-01T00:00:00.000Z' };

  const result = service.runWithContext(context, () => {
    t.deepEqual(service.getContext(), context);
    return 'ok';
  });

  t.is(result, 'ok');
});

test('context survives across an awaited promise', async (t) => {
  const service = new SessionContextService();
  const context = { sessionId: 'session-2', sessionStartedAt: '2025-01-02T00:00:00.000Z', traceId: 'trace-1' };

  await service.runWithContext(context, async () => {
    await Promise.resolve();
    t.deepEqual(service.getContext(), context);
  });
});

test('nested runWithContext restores the outer context after inner completes', async (t) => {
  const service = new SessionContextService();
  const outer = { sessionId: 'outer', sessionStartedAt: '2025-01-03T00:00:00.000Z' };
  const inner = { sessionId: 'inner', sessionStartedAt: '2025-01-04T00:00:00.000Z', evaluator: true as const };

  await service.runWithContext(outer, async () => {
    t.deepEqual(service.getContext(), outer);

    await service.runWithContext(inner, async () => {
      t.deepEqual(service.getContext(), inner);
      await Promise.resolve();
      t.deepEqual(service.getContext(), inner);
    });

    t.deepEqual(service.getContext(), outer);
  });
});
