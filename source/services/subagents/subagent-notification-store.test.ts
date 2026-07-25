import { expect, it } from 'vitest';
import { SubagentNotificationStore } from './subagent-notification-store.js';
import { SubagentAsyncRegistry } from './subagent-async-registry.js';
import { createMockLogger } from './test-helpers/subagent-manager-fixtures.js';
import type { ConversationEvent } from '../conversation/conversation-events.js';
import type { SubagentResult } from './types.js';

const result = (overrides: Partial<SubagentResult> = {}): SubagentResult => ({
  agentId: 'run-1',
  role: 'explorer',
  status: 'completed',
  finalText: 'found the bug',
  filesChanged: [],
  toolsUsed: [],
  ...overrides,
});

const completed = (overrides: Partial<SubagentResult> = {}): ConversationEvent =>
  ({ type: 'subagent_completed', result: result(overrides), async: true } as ConversationEvent);

const makeStore = (options: { now?: () => number; deliveredIdCap?: number } = {}) =>
  new SubagentNotificationStore({ now: () => 1_000, ...options });

it('records one notification carrying the run identity, status and preview', () => {
  const store = makeStore({ now: () => 4_242 });

  expect(store.enqueue(completed())).toBe(true);

  expect(store.drain()).toEqual([
    {
      runId: 'run-1',
      role: 'explorer',
      status: 'completed',
      preview: 'found the bug',
      completedAt: 4_242,
    },
  ]);
});

it('ignores completion events that are not async runs', () => {
  const store = makeStore();

  expect(store.enqueue({ type: 'subagent_completed', result: result() } as ConversationEvent)).toBe(false);
  expect(store.enqueue({ type: 'subagent_completed', result: result(), async: false } as ConversationEvent)).toBe(
    false,
  );
  expect(store.enqueue({ type: 'subagent_started', agentId: 'run-1', role: 'explorer' } as ConversationEvent)).toBe(
    false,
  );

  expect(store.pendingCount).toBe(0);
  expect(store.drain()).toEqual([]);
});

it('reports a repeated run id as not novel and keeps a single notification', () => {
  const store = makeStore();

  expect(store.enqueue(completed())).toBe(true);
  expect(store.enqueue(completed())).toBe(false);

  expect(store.drain()).toHaveLength(1);
});

it('keeps a run id deduped after it has been drained', () => {
  const store = makeStore();
  store.enqueue(completed());
  store.drain();

  expect(store.enqueue(completed())).toBe(false);
  expect(store.drain()).toEqual([]);
});

it('carries the failure status and error text of a failed run', () => {
  const store = makeStore();
  store.enqueue(completed({ agentId: 'run-fail', status: 'failed', finalText: '', error: 'model exploded' }));

  expect(store.drain()).toEqual([
    {
      runId: 'run-fail',
      role: 'explorer',
      status: 'failed',
      preview: 'model exploded',
      error: 'model exploded',
      completedAt: 1_000,
    },
  ]);
});

it('carries the cancellation status and error text of a cancelled run', () => {
  const store = makeStore();
  store.enqueue(
    completed({ agentId: 'run-cancel', status: 'cancelled', finalText: '', error: 'The subagent run was aborted.' }),
  );

  expect(store.drain()).toEqual([
    {
      runId: 'run-cancel',
      role: 'explorer',
      status: 'cancelled',
      preview: 'The subagent run was aborted.',
      error: 'The subagent run was aborted.',
      completedAt: 1_000,
    },
  ]);
});

it('drains every pending run in one call in completion order', () => {
  const store = makeStore();
  store.enqueue(completed({ agentId: 'run-a' }));
  store.enqueue(completed({ agentId: 'run-b', role: 'researcher' }));

  expect(store.pendingCount).toBe(2);
  const drained = store.drain();

  expect(drained.map((n) => n.runId)).toEqual(['run-a', 'run-b']);
  expect(store.pendingCount).toBe(0);
});

it('retains undelivered notifications ahead of newer ones for the next drain', () => {
  const store = makeStore();
  store.enqueue(completed({ agentId: 'run-a' }));
  const undelivered = store.drain();

  store.enqueue(completed({ agentId: 'run-b' }));
  store.retain(undelivered);

  expect(store.drain().map((n) => n.runId)).toEqual(['run-a', 'run-b']);
  expect(store.drain()).toEqual([]);
});

it('bounds the delivered id set so old ids are forgotten before recent ones', () => {
  const store = makeStore({ deliveredIdCap: 3 });
  for (const agentId of ['run-0', 'run-1', 'run-2', 'run-3']) {
    store.enqueue(completed({ agentId }));
  }
  store.drain();

  // The oldest id has been evicted from the bounded set; the newest are still deduped.
  expect(store.enqueue(completed({ agentId: 'run-0' }))).toBe(true);
  expect(store.enqueue(completed({ agentId: 'run-3' }))).toBe(false);
});

it('truncates a long preview to a bounded single paragraph', () => {
  const store = makeStore();
  store.enqueue(completed({ finalText: `${'x'.repeat(400)}\n\nsecond paragraph` }));

  const [notification] = store.drain();
  expect(notification.preview).toHaveLength(300);
  expect(notification.preview.endsWith('...')).toBe(true);
});

it('ignores completion events without a run id', () => {
  const store = makeStore();

  expect(store.enqueue({ type: 'subagent_completed', async: true } as ConversationEvent)).toBe(false);
  expect(store.enqueue(completed({ agentId: '' }))).toBe(false);
  expect(store.pendingCount).toBe(0);
});

it('records a notification for a real async registry run and nothing for its start event', async () => {
  const store = makeStore();
  const registry = new SubagentAsyncRegistry({
    logger: createMockLogger(),
    run: async ({ request }) => result({ role: request.role, finalText: 'registry output' }),
    onEvent: (event) => {
      store.enqueue(event);
    },
  });

  const handle = registry.startRun({ role: 'explorer', task: 'inspect' });
  await registry.getResult(handle.runId);

  expect(store.drain()).toEqual([
    {
      runId: handle.runId,
      role: 'explorer',
      status: 'completed',
      preview: 'registry output',
      completedAt: 1_000,
    },
  ]);
  registry.dispose();
});
