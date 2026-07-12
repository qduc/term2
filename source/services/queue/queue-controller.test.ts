import { expect, it } from 'vitest';
import {
  QueueController,
  type ActionId,
  type ExecutionId,
  type ItemId,
  type PersistedQueueV1,
  type PreflightKind,
  type QueuePersistence,
  type QueueTurnDriver,
} from './queue-controller.js';

it('admits FIFO work with an immutable dispatch snapshot and starts only one execution', async () => {
  const starts: Array<{ executionId: string; itemId: string; text: string; snapshot: { model: string } }> = [];
  const driver: QueueTurnDriver<{ model: string }> = {
    start: (execution) => {
      starts.push({
        executionId: String(execution.executionId),
        itemId: execution.item.id,
        text: execution.item.text,
        snapshot: execution.snapshot,
      });
    },
    cancel: async () => undefined,
  };
  let model = 'model-a';
  const controller = new QueueController({
    driver,
    snapshotFactory: () => ({ model }),
    ids: {
      item: (() => {
        let number = 0;
        return () => `item-${++number}`;
      })(),
      execution: (() => {
        let number = 0;
        return () => `execution-${++number}`;
      })(),
    },
    now: () => '2026-01-01T00:00:00.000Z',
  });

  await controller.command({ kind: 'submit', text: 'first' });
  await controller.command({ kind: 'submit', text: 'second' });
  model = 'model-b';

  expect(starts).toEqual([
    { executionId: 'execution-1', itemId: 'item-1', text: 'first', snapshot: { model: 'model-a' } },
  ]);
  expect(controller.state()).toMatchObject({ kind: 'running', queue: [{ id: 'item-2', text: 'second', sequence: 2 }] });

  await controller.event({ kind: 'completed', executionId: 'execution-1' as ExecutionId, terminal: { text: 'done' } });

  expect(starts).toEqual([
    { executionId: 'execution-1', itemId: 'item-1', text: 'first', snapshot: { model: 'model-a' } },
    { executionId: 'execution-2', itemId: 'item-2', text: 'second', snapshot: { model: 'model-b' } },
  ]);
});

it('holds completion admission while submissions enqueue, then dispatches the next item exactly once', async () => {
  let releaseCompletion!: () => void;
  const completion = new Promise<void>((resolve) => {
    releaseCompletion = resolve;
  });
  const starts: string[] = [];
  const controller = new QueueController({
    driver: {
      start: ({ executionId }) => {
        starts.push(String(executionId));
      },
      cancel: async () => undefined,
    },
    snapshotFactory: () => ({ model: 'a' }),
    ids: {
      item: (() => {
        let number = 0;
        return () => `item-${++number}`;
      })(),
      execution: (() => {
        let number = 0;
        return () => `execution-${++number}`;
      })(),
    },
    completionBarrier: () => completion,
  });

  await controller.command({ kind: 'submit', text: 'first' });
  const completing = controller.event({ kind: 'completed', executionId: 'execution-1' as ExecutionId, terminal: {} });
  await controller.command({ kind: 'submit', text: 'second' });

  expect(controller.state()).toMatchObject({ kind: 'completing', queue: [{ text: 'second' }] });
  expect(starts).toEqual(['execution-1']);
  releaseCompletion();
  await completing;
  expect(starts).toEqual(['execution-1', 'execution-2']);
});

it('awaits cancellation cleanup, ignores late terminal events, and retains queued items paused manually', async () => {
  let releaseCleanup!: () => void;
  const cleanup = new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });
  const starts: string[] = [];
  const controller = new QueueController({
    driver: {
      start: ({ executionId }) => {
        starts.push(String(executionId));
      },
      cancel: () => cleanup,
    },
    snapshotFactory: () => ({}),
    ids: {
      item: (() => {
        let number = 0;
        return () => `item-${++number}`;
      })(),
      execution: () => 'execution-1',
    },
  });
  await controller.command({ kind: 'submit', text: 'active' });
  await controller.command({ kind: 'submit', text: 'queued' });

  const cancelling = controller.command({ kind: 'cancel' });
  await controller.event({ kind: 'completed', executionId: 'execution-1' as ExecutionId, terminal: {} });
  expect(controller.state()).toMatchObject({ kind: 'cancelling', queue: [{ text: 'queued' }] });
  expect(starts).toEqual(['execution-1']);
  releaseCleanup();
  await cancelling;

  expect(controller.state()).toMatchObject({ kind: 'paused', reason: 'manual', queue: [{ text: 'queued' }] });
});

it('pauses on matching failure, suppresses stale events, and resumes queued work FIFO', async () => {
  const starts: string[] = [];
  const controller = new QueueController({
    driver: {
      start: ({ executionId }) => {
        starts.push(String(executionId));
      },
      cancel: async () => undefined,
    },
    snapshotFactory: () => ({}),
    ids: {
      item: (() => {
        let number = 0;
        return () => `item-${++number}`;
      })(),
      execution: (() => {
        let number = 0;
        return () => `execution-${++number}`;
      })(),
    },
  });
  await controller.command({ kind: 'submit', text: 'first' });
  await controller.command({ kind: 'submit', text: 'second' });
  await controller.command({ kind: 'submit', text: 'third' });
  await controller.event({ kind: 'failed', executionId: 'wrong' as ExecutionId, failure: {} });
  expect(controller.state()).toMatchObject({ kind: 'running', queue: [{ text: 'second' }, { text: 'third' }] });

  await controller.event({ kind: 'failed', executionId: 'execution-1' as ExecutionId, failure: {} });
  expect(controller.state()).toMatchObject({
    kind: 'paused',
    reason: 'failure',
    queue: [{ text: 'second' }, { text: 'third' }],
  });
  await controller.command({ kind: 'resume_queue' });
  expect(starts).toEqual(['execution-1', 'execution-2']);
  expect(controller.state()).toMatchObject({ kind: 'running', queue: [{ text: 'third' }] });
});

it('returns total results for capacity and queued item commands without mutating active work', async () => {
  const controller = new QueueController({
    driver: { start: () => undefined, cancel: async () => undefined },
    snapshotFactory: () => ({}),
    capacity: 1,
    ids: {
      item: (() => {
        let number = 0;
        return () => `item-${++number}`;
      })(),
      execution: () => 'execution-1',
    },
  });
  expect(await controller.command({ kind: 'submit', text: '' })).toEqual({ kind: 'rejected', reason: 'invalid' });
  await controller.command({ kind: 'submit', text: 'active' });
  await controller.command({ kind: 'submit', text: 'queued' });
  expect(await controller.command({ kind: 'submit', text: 'overflow' })).toEqual({
    kind: 'rejected',
    reason: 'capacity',
  });

  const queuedId = controller.state().queue[0].id;
  expect(await controller.command({ kind: 'edit_queued', itemId: queuedId, text: 'edited' })).toEqual({
    kind: 'accepted',
  });
  expect(controller.state().queue).toMatchObject([{ id: queuedId, text: 'edited' }]);
  const running = controller.state();
  if (running.kind !== 'running') throw new Error('expected active execution');
  const activeId = running.active.item.id;
  expect(await controller.command({ kind: 'remove_queued', itemId: activeId })).toEqual({
    kind: 'rejected',
    reason: 'not_queued',
  });
  expect(await controller.command({ kind: 'remove_queued', itemId: 'missing' as ItemId })).toEqual({
    kind: 'rejected',
    reason: 'not_queued',
  });
  expect(await controller.command({ kind: 'remove_queued', itemId: queuedId })).toEqual({ kind: 'accepted' });
  await controller.command({ kind: 'submit', text: 'discard me' });
  expect(await controller.command({ kind: 'cancel' })).toEqual({ kind: 'accepted' });
  expect(await controller.command({ kind: 'discard_queue' })).toEqual({ kind: 'accepted' });
  expect(controller.state()).toMatchObject({ kind: 'paused', queue: [] });
  expect(await controller.command({ kind: 'resume_queue' })).toEqual({ kind: 'accepted' });
  expect(await controller.command({ kind: 'resume_queue' })).toEqual({ kind: 'no_op' });
});

it('recovers queued work conservatively after an interrupted active execution', async () => {
  const records: unknown[] = [];
  const persistence: QueuePersistence = {
    load: () => records.at(-1) ?? null,
    replace: (record) => {
      records.push(record);
    },
  };
  const starts: string[] = [];
  const controller = new QueueController({
    driver: {
      start: ({ executionId }) => {
        starts.push(String(executionId));
      },
      cancel: async () => undefined,
    },
    snapshotFactory: () => ({ model: 'test' }),
    persistence,
    ids: {
      item: (() => {
        let number = 0;
        return () => `item-${++number}`;
      })(),
      execution: (() => {
        let number = 0;
        return () => `execution-${++number}`;
      })(),
    },
  });

  await controller.command({ kind: 'submit', text: 'interrupted' });
  await controller.command({ kind: 'submit', text: 'remaining' });
  expect(starts).toEqual(['execution-1']);

  const recoveredStarts: string[] = [];
  const recovered = new QueueController({
    driver: {
      start: ({ executionId }) => {
        recoveredStarts.push(String(executionId));
      },
      cancel: async () => undefined,
    },
    snapshotFactory: () => ({ model: 'test' }),
    persistence,
    ids: { item: () => 'unused', execution: () => 'execution-2' },
  });

  expect(recovered.state()).toMatchObject({
    kind: 'paused',
    reason: 'recovered_interrupted',
    queue: [{ id: 'item-2', text: 'remaining' }],
  });
  await recovered.event({ kind: 'completed', executionId: 'execution-1' as ExecutionId, terminal: {} });
  expect(recoveredStarts).toEqual([]);

  await recovered.command({ kind: 'resume_queue' });
  expect(recoveredStarts).toEqual(['execution-2']);
});

it('quarantines an invalid persisted record and exposes the recovery failure without loading it', () => {
  let quarantined = false;
  const controller = new QueueController({
    driver: { start: () => undefined, cancel: async () => undefined },
    snapshotFactory: () => ({}),
    persistence: {
      load: () => ({
        version: 1,
        nextSequence: 3,
        queue: [
          { id: 'item-2', text: 'later', sequence: 2, submittedAt: '2026-01-01T00:00:00.000Z' },
          { id: 'item-1', text: 'earlier', sequence: 1, submittedAt: '2026-01-01T00:00:00.000Z' },
        ],
      }),
      replace: () => undefined,
      quarantine: () => {
        quarantined = true;
      },
    },
  });

  expect(controller.state()).toMatchObject({
    kind: 'idle',
    queue: [],
    recovery: { kind: 'invalid_persisted_queue' },
  });
  expect(quarantined).toBe(true);
});

// ── Preflight flow ─────────────────────────────────────────────────

it('evaluates preflight at dispatch time and enters awaiting_preflight state', async () => {
  const starts: string[] = [];
  const controller = new QueueController({
    driver: {
      start: ({ executionId }) => {
        starts.push(String(executionId));
      },
      cancel: async () => undefined,
    },
    snapshotFactory: () => ({}),
    ids: {
      item: (() => {
        let n = 0;
        return () => `item-${++n}`;
      })(),
      execution: (() => {
        let n = 0;
        return () => `execution-${++n}`;
      })(),
    },
    preflightEvaluator: () => ({ preflight: { actionId: 'pf-1' as ActionId, kind: 'input_surge' } }),
  });

  await controller.command({ kind: 'submit', text: 'large input' });

  expect(starts).toEqual([]);
  const state = controller.state();
  expect(state.kind).toBe('awaiting_preflight');
  if (state.kind === 'awaiting_preflight') {
    expect(state.head.preflight).toEqual({ actionId: 'pf-1', kind: 'input_surge' });
  }
  expect(state.queue).toHaveLength(1);
});

it('accepts matching preflight answer, captures snapshot, and starts turn', async () => {
  const starts: Array<{ executionId: string; itemId: string; snapshot: { model: string } }> = [];
  let model = 'model-a';
  const controller = new QueueController({
    driver: {
      start: (execution) => {
        starts.push({
          executionId: String(execution.executionId),
          itemId: execution.item.id,
          snapshot: execution.snapshot,
        });
      },
      cancel: async () => undefined,
    },
    snapshotFactory: () => ({ model }),
    ids: {
      item: (() => {
        let n = 0;
        return () => `item-${++n}`;
      })(),
      execution: (() => {
        let n = 0;
        return () => `execution-${++n}`;
      })(),
    },
    preflightEvaluator: () => ({ preflight: { actionId: 'pf-1' as ActionId, kind: 'input_surge' } }),
  });

  await controller.command({ kind: 'submit', text: 'large' });
  // Snapshot is captured at preflight acceptance time, not at enqueue.
  model = 'model-b';
  const result = await controller.command({
    kind: 'answer_preflight',
    itemId: 'item-1' as ItemId,
    actionId: 'pf-1' as ActionId,
    accepted: true,
  });

  expect(result).toEqual({ kind: 'accepted' });
  expect(starts).toEqual([{ executionId: 'execution-1', itemId: 'item-1', snapshot: { model: 'model-b' } }]);
  expect(controller.state().kind).toBe('running');
});

it('declines preflight, removes head, and dispatches next item', async () => {
  const starts: string[] = [];
  let callCount = 0;
  const controller = new QueueController({
    driver: {
      start: ({ executionId }) => {
        starts.push(String(executionId));
      },
      cancel: async () => undefined,
    },
    snapshotFactory: () => ({}),
    ids: {
      item: (() => {
        let n = 0;
        return () => `item-${++n}`;
      })(),
      execution: (() => {
        let n = 0;
        return () => `execution-${++n}`;
      })(),
    },
    preflightEvaluator: () => {
      callCount++;
      return callCount === 1 ? { preflight: { actionId: 'pf-1' as ActionId, kind: 'input_surge' } } : null;
    },
  });

  await controller.command({ kind: 'submit', text: 'large' });
  await controller.command({ kind: 'submit', text: 'normal' });

  const result = await controller.command({
    kind: 'answer_preflight',
    itemId: 'item-1' as ItemId,
    actionId: 'pf-1' as ActionId,
    accepted: false,
  });
  expect(result).toEqual({ kind: 'accepted' });

  expect(starts).toEqual(['execution-1']);
  const state = controller.state();
  expect(state.kind).toBe('running');
  if (state.kind === 'running') {
    expect(state.active.item.id).toBe('item-2');
  }
});

it('rejects mismatched preflight answer', async () => {
  const controller = new QueueController({
    driver: { start: () => undefined, cancel: async () => undefined },
    snapshotFactory: () => ({}),
    ids: {
      item: (() => {
        let n = 0;
        return () => `item-${++n}`;
      })(),
      execution: () => 'execution-1',
    },
    preflightEvaluator: () => ({ preflight: { actionId: 'pf-1' as ActionId, kind: 'input_surge' } }),
  });

  await controller.command({ kind: 'submit', text: 'large' });

  expect(
    await controller.command({
      kind: 'answer_preflight',
      itemId: 'item-1' as ItemId,
      actionId: 'wrong' as ActionId,
      accepted: true,
    }),
  ).toEqual({ kind: 'rejected', reason: 'stale' });
  expect(
    await controller.command({
      kind: 'answer_preflight',
      itemId: 'wrong' as ItemId,
      actionId: 'pf-1' as ActionId,
      accepted: true,
    }),
  ).toEqual({ kind: 'rejected', reason: 'stale' });
  expect(controller.state().kind).toBe('awaiting_preflight');
});

it('rejects preflight answer from idle state', async () => {
  const controller = new QueueController({
    driver: { start: () => undefined, cancel: async () => undefined },
    snapshotFactory: () => ({}),
    ids: { item: () => 'item-1', execution: () => 'execution-1' },
  });

  expect(
    await controller.command({
      kind: 'answer_preflight',
      itemId: 'item-1' as ItemId,
      actionId: 'pf-1' as ActionId,
      accepted: true,
    }),
  ).toEqual({ kind: 'rejected', reason: 'stale' });
});

// ── Active action flow (tool approval + ask_user) ─────────────────

it('transitions from running to awaiting_active_action on tool_approval_requested event', async () => {
  const starts: string[] = [];
  const controller = new QueueController({
    driver: {
      start: ({ executionId }) => {
        starts.push(String(executionId));
      },
      cancel: async () => undefined,
    },
    snapshotFactory: () => ({}),
    ids: {
      item: (() => {
        let n = 0;
        return () => `item-${++n}`;
      })(),
      execution: () => 'execution-1',
    },
  });

  await controller.command({ kind: 'submit', text: 'a task' });
  expect(controller.state().kind).toBe('running');

  await controller.event({
    kind: 'tool_approval_requested',
    executionId: 'execution-1' as ExecutionId,
    actionId: 'ta-1' as ActionId,
    request: { tool: 'rm' },
  });

  const state = controller.state();
  expect(state.kind).toBe('awaiting_active_action');
  if (state.kind === 'awaiting_active_action') {
    expect(state.pendingAction).toEqual({ actionId: 'ta-1', kind: 'tool_approval' });
  }
});

it('ignores tool_approval_requested with mismatched executionId', async () => {
  const controller = new QueueController({
    driver: { start: () => undefined, cancel: async () => undefined },
    snapshotFactory: () => ({}),
    ids: {
      item: (() => {
        let n = 0;
        return () => `item-${++n}`;
      })(),
      execution: () => 'execution-1',
    },
  });

  await controller.command({ kind: 'submit', text: 'a task' });
  await controller.event({
    kind: 'tool_approval_requested',
    executionId: 'wrong' as ExecutionId,
    actionId: 'ta-1' as ActionId,
    request: {},
  });

  expect(controller.state().kind).toBe('running');
});

it('resolves tool approval and calls driver.continueAfterAction', async () => {
  const continuations: Array<{ actionId: string; kind: string; resolution: unknown }> = [];
  const controller = new QueueController({
    driver: {
      start: () => undefined,
      cancel: async () => undefined,
      continueAfterAction: (_, pendingAction, resolution) => {
        continuations.push({ actionId: pendingAction.actionId, kind: pendingAction.kind, resolution });
      },
    },
    snapshotFactory: () => ({}),
    ids: {
      item: (() => {
        let n = 0;
        return () => `item-${++n}`;
      })(),
      execution: () => 'execution-1',
    },
  });

  await controller.command({ kind: 'submit', text: 'a task' });
  await controller.event({
    kind: 'tool_approval_requested',
    executionId: 'execution-1' as ExecutionId,
    actionId: 'ta-1' as ActionId,
    request: {},
  });

  const result = await controller.command({
    kind: 'resolve_tool_approval',
    executionId: 'execution-1' as ExecutionId,
    actionId: 'ta-1' as ActionId,
    approved: true,
  });
  expect(result).toEqual({ kind: 'accepted' });
  expect(controller.state().kind).toBe('running');
  expect(continuations).toEqual([{ actionId: 'ta-1', kind: 'tool_approval', resolution: { approved: true } }]);
});

it('rejects resolve_tool_approval with mismatched IDs or wrong kind', async () => {
  const continuations: unknown[] = [];
  const controller = new QueueController({
    driver: {
      start: () => undefined,
      cancel: async () => undefined,
      continueAfterAction: () => {
        continuations.push('called');
      },
    },
    snapshotFactory: () => ({}),
    ids: {
      item: (() => {
        let n = 0;
        return () => `item-${++n}`;
      })(),
      execution: () => 'execution-1',
    },
  });

  await controller.command({ kind: 'submit', text: 'task' });
  await controller.event({
    kind: 'tool_approval_requested',
    executionId: 'execution-1' as ExecutionId,
    actionId: 'ta-1' as ActionId,
    request: {},
  });

  // Wrong executionId
  expect(
    await controller.command({
      kind: 'resolve_tool_approval',
      executionId: 'wrong' as ExecutionId,
      actionId: 'ta-1' as ActionId,
      approved: true,
    }),
  ).toEqual({ kind: 'rejected', reason: 'stale' });
  // Wrong actionId
  expect(
    await controller.command({
      kind: 'resolve_tool_approval',
      executionId: 'execution-1' as ExecutionId,
      actionId: 'wrong' as ActionId,
      approved: true,
    }),
  ).toEqual({ kind: 'rejected', reason: 'stale' });
  expect(continuations).toEqual([]);
  expect(controller.state().kind).toBe('awaiting_active_action');
});

it('rejects tool_approval resolution when active action is ask_user', async () => {
  const continuations: unknown[] = [];
  const controller = new QueueController({
    driver: {
      start: () => undefined,
      cancel: async () => undefined,
      continueAfterAction: () => {
        continuations.push('called');
      },
    },
    snapshotFactory: () => ({}),
    ids: {
      item: (() => {
        let n = 0;
        return () => `item-${++n}`;
      })(),
      execution: () => 'execution-1',
    },
  });

  await controller.command({ kind: 'submit', text: 'task' });
  await controller.event({
    kind: 'ask_user_requested',
    executionId: 'execution-1' as ExecutionId,
    actionId: 'au-1' as ActionId,
    question: {},
  });

  expect(
    await controller.command({
      kind: 'resolve_tool_approval',
      executionId: 'execution-1' as ExecutionId,
      actionId: 'au-1' as ActionId,
      approved: true,
    }),
  ).toEqual({ kind: 'rejected', reason: 'stale' });
  expect(continuations).toEqual([]);
});

it('handles ask_user_requested event and resolves with answer_ask_user', async () => {
  const continuations: Array<{ actionId: string; kind: string; resolution: unknown }> = [];
  const controller = new QueueController({
    driver: {
      start: () => undefined,
      cancel: async () => undefined,
      continueAfterAction: (_, pendingAction, resolution) => {
        continuations.push({ actionId: pendingAction.actionId, kind: pendingAction.kind, resolution });
      },
    },
    snapshotFactory: () => ({}),
    ids: {
      item: (() => {
        let n = 0;
        return () => `item-${++n}`;
      })(),
      execution: () => 'execution-1',
    },
  });

  await controller.command({ kind: 'submit', text: 'task' });
  await controller.event({
    kind: 'ask_user_requested',
    executionId: 'execution-1' as ExecutionId,
    actionId: 'au-1' as ActionId,
    question: { text: 'which file?' },
  });

  expect(controller.state().kind).toBe('awaiting_active_action');

  const result = await controller.command({
    kind: 'answer_ask_user',
    executionId: 'execution-1' as ExecutionId,
    actionId: 'au-1' as ActionId,
    value: 'file.txt',
  });
  expect(result).toEqual({ kind: 'accepted' });
  expect(controller.state().kind).toBe('running');
  expect(continuations).toEqual([{ actionId: 'au-1', kind: 'ask_user', resolution: { value: 'file.txt' } }]);
});

it('rejects answer_ask_user with mismatched IDs or wrong kind', async () => {
  const controller = new QueueController({
    driver: {
      start: () => undefined,
      cancel: async () => undefined,
      continueAfterAction: () => undefined,
    },
    snapshotFactory: () => ({}),
    ids: {
      item: (() => {
        let n = 0;
        return () => `item-${++n}`;
      })(),
      execution: () => 'execution-1',
    },
  });

  await controller.command({ kind: 'submit', text: 'task' });
  await controller.event({
    kind: 'ask_user_requested',
    executionId: 'execution-1' as ExecutionId,
    actionId: 'au-1' as ActionId,
    question: {},
  });

  expect(
    await controller.command({
      kind: 'answer_ask_user',
      executionId: 'wrong' as ExecutionId,
      actionId: 'au-1' as ActionId,
      value: 'x',
    }),
  ).toEqual({ kind: 'rejected', reason: 'stale' });
  expect(
    await controller.command({
      kind: 'answer_ask_user',
      executionId: 'execution-1' as ExecutionId,
      actionId: 'wrong' as ActionId,
      value: 'x',
    }),
  ).toEqual({ kind: 'rejected', reason: 'stale' });
});

it('rejects ask_user resolution when active action is tool_approval', async () => {
  const controller = new QueueController({
    driver: {
      start: () => undefined,
      cancel: async () => undefined,
    },
    snapshotFactory: () => ({}),
    ids: {
      item: (() => {
        let n = 0;
        return () => `item-${++n}`;
      })(),
      execution: () => 'execution-1',
    },
  });

  await controller.command({ kind: 'submit', text: 'task' });
  await controller.event({
    kind: 'tool_approval_requested',
    executionId: 'execution-1' as ExecutionId,
    actionId: 'ta-1' as ActionId,
    request: {},
  });

  expect(
    await controller.command({
      kind: 'answer_ask_user',
      executionId: 'execution-1' as ExecutionId,
      actionId: 'ta-1' as ActionId,
      value: 'x',
    }),
  ).toEqual({ kind: 'rejected', reason: 'stale' });
});

// ── Cancel from awaiting states ────────────────────────────────────

it('cancels from awaiting_preflight and pauses', async () => {
  const controller = new QueueController({
    driver: { start: () => undefined, cancel: async () => undefined },
    snapshotFactory: () => ({}),
    ids: {
      item: (() => {
        let n = 0;
        return () => `item-${++n}`;
      })(),
      execution: () => 'execution-1',
    },
    preflightEvaluator: () => ({ preflight: { actionId: 'pf-1' as ActionId, kind: 'input_surge' } }),
  });

  await controller.command({ kind: 'submit', text: 'large' });
  expect(await controller.command({ kind: 'cancel' })).toEqual({ kind: 'accepted' });
  expect(controller.state()).toMatchObject({ kind: 'paused', reason: 'manual', queue: [{ text: 'large' }] });
});

it('cancels from awaiting_active_action and pauses', async () => {
  let cancelled = false;
  const controller = new QueueController({
    driver: {
      start: () => undefined,
      cancel: async () => {
        cancelled = true;
      },
    },
    snapshotFactory: () => ({}),
    ids: {
      item: (() => {
        let n = 0;
        return () => `item-${++n}`;
      })(),
      execution: () => 'execution-1',
    },
  });

  await controller.command({ kind: 'submit', text: 'task' });
  await controller.event({
    kind: 'tool_approval_requested',
    executionId: 'execution-1' as ExecutionId,
    actionId: 'ta-1' as ActionId,
    request: {},
  });

  expect(await controller.command({ kind: 'cancel' })).toEqual({ kind: 'accepted' });
  expect(controller.state()).toMatchObject({ kind: 'paused', reason: 'manual' });
  expect(cancelled).toBe(true);
});

// ── Snapshot/capture behavior ──────────────────────────────────────

it('captures snapshot after preflight acceptance, not at enqueue time', async () => {
  const snapshots: Array<{ model: string }> = [];
  let model = 'model-a';
  const controller = new QueueController({
    driver: {
      start: (execution) => {
        snapshots.push(execution.snapshot);
      },
      cancel: async () => undefined,
    },
    snapshotFactory: () => ({ model }),
    ids: {
      item: (() => {
        let n = 0;
        return () => `item-${++n}`;
      })(),
      execution: () => 'execution-1',
    },
    preflightEvaluator: () => ({ preflight: { actionId: 'pf-1' as ActionId, kind: 'input_surge' } }),
  });

  await controller.command({ kind: 'submit', text: 'large' });
  model = 'model-b';
  await controller.command({
    kind: 'answer_preflight',
    itemId: 'item-1' as ItemId,
    actionId: 'pf-1' as ActionId,
    accepted: true,
  });

  expect(snapshots).toEqual([{ model: 'model-b' }]);
});

it('preserves active snapshot through active action continuation', async () => {
  const snapshots: unknown[] = [];
  let model = 'model-a';
  const controller = new QueueController({
    driver: {
      start: (execution) => {
        snapshots.push(execution.snapshot);
      },
      cancel: async () => undefined,
      continueAfterAction: (execution) => {
        snapshots.push(execution.snapshot);
      },
    },
    snapshotFactory: () => ({ model }),
    ids: {
      item: (() => {
        let n = 0;
        return () => `item-${++n}`;
      })(),
      execution: () => 'execution-1',
    },
  });

  await controller.command({ kind: 'submit', text: 'task' });
  model = 'model-b';
  await controller.event({
    kind: 'tool_approval_requested',
    executionId: 'execution-1' as ExecutionId,
    actionId: 'ta-1' as ActionId,
    request: {},
  });
  await controller.command({
    kind: 'resolve_tool_approval',
    executionId: 'execution-1' as ExecutionId,
    actionId: 'ta-1' as ActionId,
    approved: true,
  });

  expect(snapshots).toEqual([{ model: 'model-a' }, { model: 'model-a' }]);
});

// ── Queued item management alongside preflight ─────────────────────

it('removing the pending preflight head re-runs head selection', async () => {
  const starts: string[] = [];
  let callCount = 0;
  const controller = new QueueController({
    driver: {
      start: ({ executionId }) => {
        starts.push(String(executionId));
      },
      cancel: async () => undefined,
    },
    snapshotFactory: () => ({}),
    ids: {
      item: (() => {
        let n = 0;
        return () => `item-${++n}`;
      })(),
      execution: (() => {
        let n = 0;
        return () => `execution-${++n}`;
      })(),
    },
    preflightEvaluator: () => {
      callCount++;
      return callCount === 1 ? { preflight: { actionId: 'pf-1' as ActionId, kind: 'input_surge' } } : null;
    },
  });

  await controller.command({ kind: 'submit', text: 'large' });
  await controller.command({ kind: 'submit', text: 'normal' });
  expect(controller.state().kind).toBe('awaiting_preflight');

  const headId = controller.state().queue[0]!.id;
  await controller.command({ kind: 'remove_queued', itemId: headId });

  expect(starts).toEqual(['execution-1']);
  expect(controller.state().kind).toBe('running');
});

// ── Completion from awaiting_active_action ────────────────────────

it('completes from awaiting_active_action and dispatches next', async () => {
  const starts: string[] = [];
  const controller = new QueueController({
    driver: {
      start: ({ executionId }) => {
        starts.push(String(executionId));
      },
      cancel: async () => undefined,
    },
    snapshotFactory: () => ({}),
    ids: {
      item: (() => {
        let n = 0;
        return () => `item-${++n}`;
      })(),
      execution: (() => {
        let n = 0;
        return () => `execution-${++n}`;
      })(),
    },
  });

  await controller.command({ kind: 'submit', text: 'first' });
  await controller.command({ kind: 'submit', text: 'second' });
  await controller.event({
    kind: 'tool_approval_requested',
    executionId: 'execution-1' as ExecutionId,
    actionId: 'ta-1' as ActionId,
    request: {},
  });

  // Complete from awaiting_active_action
  await controller.event({ kind: 'completed', executionId: 'execution-1' as ExecutionId, terminal: {} });
  expect(starts).toEqual(['execution-1', 'execution-2']);
});

it('fails from awaiting_active_action and pauses', async () => {
  const controller = new QueueController({
    driver: { start: () => undefined, cancel: async () => undefined },
    snapshotFactory: () => ({}),
    ids: {
      item: (() => {
        let n = 0;
        return () => `item-${++n}`;
      })(),
      execution: () => 'execution-1',
    },
  });

  await controller.command({ kind: 'submit', text: 'first' });
  await controller.command({ kind: 'submit', text: 'second' });
  await controller.event({
    kind: 'tool_approval_requested',
    executionId: 'execution-1' as ExecutionId,
    actionId: 'ta-1' as ActionId,
    request: {},
  });

  await controller.event({ kind: 'failed', executionId: 'execution-1' as ExecutionId, failure: {} });
  expect(controller.state()).toMatchObject({ kind: 'paused', reason: 'failure', queue: [{ text: 'second' }] });
});

// ── Persistence: preflight and active action ───────────────────────

it('persists awaiting_preflight state and restores it', async () => {
  const records: unknown[] = [];
  const persistence: QueuePersistence = {
    load: () => records.at(-1) ?? null,
    replace: (record) => {
      records.push(record);
    },
  };

  const controller = new QueueController({
    driver: { start: () => undefined, cancel: async () => undefined },
    snapshotFactory: () => ({}),
    persistence,
    ids: {
      item: (() => {
        let n = 0;
        return () => `item-${++n}`;
      })(),
      execution: () => 'execution-1',
      action: () => 'act-1',
    },
    preflightEvaluator: () => ({ preflight: { actionId: 'pf-1' as ActionId, kind: 'input_surge' } }),
  });

  await controller.command({ kind: 'submit', text: 'large' });

  // Verify persisted record has preflight on queued item
  const lastRecord = records.at(-1) as PersistedQueueV1;
  expect(lastRecord.queue[0]?.preflight).toEqual({ actionId: 'pf-1', kind: 'input_surge' });
});

it('persists awaiting_active_action with pendingAction and restores as recovered_interrupted', async () => {
  const records: unknown[] = [];
  const persistence: QueuePersistence = {
    load: () => records.at(-1) ?? null,
    replace: (record) => {
      records.push(record);
    },
  };

  const controller1 = new QueueController({
    driver: { start: () => undefined, cancel: async () => undefined },
    snapshotFactory: () => ({}),
    persistence,
    ids: {
      item: (() => {
        let n = 0;
        return () => `item-${++n}`;
      })(),
      execution: () => 'execution-1',
    },
  });

  await controller1.command({ kind: 'submit', text: 'task' });
  await controller1.event({
    kind: 'tool_approval_requested',
    executionId: 'execution-1' as ExecutionId,
    actionId: 'ta-1' as ActionId,
    request: {},
  });

  // Verify persisted record has pendingAction
  const lastRecord = records.at(-1) as PersistedQueueV1;
  expect(lastRecord.active?.pendingAction).toEqual({ actionId: 'ta-1', kind: 'tool_approval' });
  expect(lastRecord.active?.phase).toBe('awaiting_active_action');
});

it('recovers persisted preflight with a fresh actionId', async () => {
  const records: unknown[] = [];
  const persistence: QueuePersistence = {
    load: () => records.at(-1) ?? null,
    replace: (record) => {
      records.push(record);
    },
  };

  // First controller: enqueue item that would get a preflight, but without
  // preflightEvaluator so it goes straight to running/dispatch
  const controller1 = new QueueController({
    driver: { start: () => undefined, cancel: async () => undefined },
    snapshotFactory: () => ({}),
    persistence,
    ids: { item: () => 'item-1', execution: () => 'execution-1', action: () => 'old-action-id' },
  });

  await controller1.command({ kind: 'submit', text: 'recovered' });

  // Manually create a persisted queue record with a preflight queued item
  const preflightRecord: PersistedQueueV1 = {
    version: 1,
    nextSequence: 2,
    queue: [
      {
        id: 'item-1',
        text: 'recovered',
        sequence: 1,
        submittedAt: '2026-01-01T00:00:00.000Z',
        preflight: { actionId: 'old-pf-id', kind: 'input_surge' as PreflightKind },
      },
    ],
    pause: { reason: 'recovered_interrupted' },
  };
  await persistence.replace(preflightRecord);

  const newActionCalls: string[] = [];
  const recovered = new QueueController({
    driver: { start: () => undefined, cancel: async () => undefined },
    snapshotFactory: () => ({}),
    persistence,
    ids: {
      item: () => 'unused',
      execution: () => 'execution-2',
      action: () => {
        const id = `fresh-action-${newActionCalls.length + 1}`;
        newActionCalls.push(id);
        return id;
      },
    },
  });

  expect(recovered.state()).toMatchObject({
    kind: 'paused',
    reason: 'recovered_interrupted',
  });

  // The queued item should have a fresh preflight actionId
  const queue = recovered.state().queue;
  expect(queue).toHaveLength(1);
  expect(queue[0]!.preflight?.actionId).toBe('fresh-action-1');
  expect(queue[0]!.preflight?.kind).toBe('input_surge');
  expect(queue[0]!.preflight?.actionId).not.toBe('old-pf-id');

  await recovered.command({ kind: 'resume_queue' });
  expect(recovered.state().kind).toBe('awaiting_preflight');
});

it('recovers interrupted active with pendingAction as recovered_interrupted', async () => {
  const persistedRecord: PersistedQueueV1 = {
    version: 1,
    nextSequence: 3,
    queue: [{ id: 'item-2', text: 'queued', sequence: 2, submittedAt: '2026-01-01T00:00:00.000Z' }],
    active: {
      executionId: 'execution-1' as ExecutionId,
      item: { id: 'item-1', text: 'interrupted', sequence: 1, submittedAt: '2026-01-01T00:00:00.000Z' },
      snapshot: { model: 'old' },
      phase: 'awaiting_active_action',
      pendingAction: { actionId: 'old-ta', kind: 'tool_approval' },
    },
  };

  const persistence: QueuePersistence = {
    load: () => persistedRecord,
    replace: () => undefined,
  };

  const controller = new QueueController({
    driver: { start: () => undefined, cancel: async () => undefined },
    snapshotFactory: () => ({ model: 'new' }),
    persistence,
    ids: { item: () => 'unused', execution: () => 'execution-2' },
  });

  expect(controller.state()).toMatchObject({
    kind: 'paused',
    reason: 'recovered_interrupted',
  });
  expect(controller.state().recovery).toEqual({
    kind: 'recovered_interrupted',
    interruptedExecutionId: 'execution-1',
  });

  // Stale event for the interrupted execution should be ignored
  await controller.event({
    kind: 'tool_approval_requested',
    executionId: 'execution-1' as ExecutionId,
    actionId: 'old-ta' as ActionId,
    request: {},
  });
  expect(controller.state().kind).toBe('paused');

  // Stale resolve for the interrupted execution should be rejected
  expect(
    await controller.command({
      kind: 'resolve_tool_approval',
      executionId: 'execution-1' as ExecutionId,
      actionId: 'old-ta' as ActionId,
      approved: true,
    }),
  ).toEqual({ kind: 'rejected', reason: 'stale' });

  // Must resume before dispatch
  await controller.command({ kind: 'resume_queue' });
  expect(controller.state().kind).toBe('running');
});

// ── settings commands ──────────────────────────────────────────────

it('accepts change_execution_settings and change_cosmetic_settings in every state', async () => {
  const controller = new QueueController({
    driver: { start: () => undefined, cancel: async () => undefined },
    snapshotFactory: () => ({}),
    ids: { item: () => 'item-1', execution: () => 'execution-1' },
  });

  expect(await controller.command({ kind: 'change_execution_settings', settings: { model: 'gpt-5' } })).toEqual({
    kind: 'accepted',
  });
  expect(await controller.command({ kind: 'change_cosmetic_settings', settings: { theme: 'dark' } })).toEqual({
    kind: 'accepted',
  });

  await controller.command({ kind: 'submit', text: 'task' });

  expect(await controller.command({ kind: 'change_execution_settings', settings: { model: 'gpt-5' } })).toEqual({
    kind: 'accepted',
  });
  expect(await controller.command({ kind: 'change_cosmetic_settings', settings: { theme: 'dark' } })).toEqual({
    kind: 'accepted',
  });
});

// ── Typed interaction isolation (per contract) ─────────────────────

it('rejects tool approval resolution while preflight is pending', async () => {
  const controller = new QueueController({
    driver: { start: () => undefined, cancel: async () => undefined },
    snapshotFactory: () => ({}),
    ids: {
      item: (() => {
        let n = 0;
        return () => `item-${++n}`;
      })(),
      execution: () => 'execution-1',
    },
    preflightEvaluator: () => ({ preflight: { actionId: 'pf-1' as ActionId, kind: 'input_surge' } }),
  });

  await controller.command({ kind: 'submit', text: 'large' });
  expect(
    await controller.command({
      kind: 'resolve_tool_approval',
      executionId: 'execution-1' as ExecutionId,
      actionId: 'pf-1' as ActionId,
      approved: true,
    }),
  ).toEqual({ kind: 'rejected', reason: 'stale' });
  expect(
    await controller.command({
      kind: 'answer_ask_user',
      executionId: 'execution-1' as ExecutionId,
      actionId: 'pf-1' as ActionId,
      value: 'x',
    }),
  ).toEqual({ kind: 'rejected', reason: 'stale' });
  expect(controller.state().kind).toBe('awaiting_preflight');
});

it('rejects preflight answer while active action is pending', async () => {
  const controller = new QueueController({
    driver: { start: () => undefined, cancel: async () => undefined },
    snapshotFactory: () => ({}),
    ids: {
      item: (() => {
        let n = 0;
        return () => `item-${++n}`;
      })(),
      execution: () => 'execution-1',
    },
  });

  await controller.command({ kind: 'submit', text: 'task' });
  await controller.event({
    kind: 'tool_approval_requested',
    executionId: 'execution-1' as ExecutionId,
    actionId: 'ta-1' as ActionId,
    request: {},
  });

  expect(
    await controller.command({
      kind: 'answer_preflight',
      itemId: 'item-1' as ItemId,
      actionId: 'ta-1' as ActionId,
      accepted: true,
    }),
  ).toEqual({ kind: 'rejected', reason: 'stale' });
  expect(controller.state().kind).toBe('awaiting_active_action');
});

// ── driver.continueAfterAction success/failure ─────────────────────

it('pauses on driver.continueAfterAction failure', async () => {
  const controller = new QueueController({
    driver: {
      start: () => undefined,
      cancel: async () => undefined,
      continueAfterAction: () => {
        throw new Error('continuation failed');
      },
    },
    snapshotFactory: () => ({}),
    ids: {
      item: (() => {
        let n = 0;
        return () => `item-${++n}`;
      })(),
      execution: () => 'execution-1',
    },
  });

  await controller.command({ kind: 'submit', text: 'task' });
  await controller.event({
    kind: 'ask_user_requested',
    executionId: 'execution-1' as ExecutionId,
    actionId: 'au-1' as ActionId,
    question: {},
  });

  const result = await controller.command({
    kind: 'answer_ask_user',
    executionId: 'execution-1' as ExecutionId,
    actionId: 'au-1' as ActionId,
    value: 'x',
  });
  expect(result).toEqual({ kind: 'accepted' });
  expect(controller.state()).toMatchObject({ kind: 'paused', reason: 'failure' });
});

// ── Multiple submits in awaiting_preflight ─────────────────────────

it('enqueues subsequent submits in awaiting_preflight state', async () => {
  const controller = new QueueController({
    driver: { start: () => undefined, cancel: async () => undefined },
    snapshotFactory: () => ({}),
    ids: {
      item: (() => {
        let n = 0;
        return () => `item-${++n}`;
      })(),
      execution: () => 'execution-1',
    },
    preflightEvaluator: () => ({ preflight: { actionId: 'pf-1' as ActionId, kind: 'input_surge' } }),
  });

  await controller.command({ kind: 'submit', text: 'first' });
  expect(controller.state().kind).toBe('awaiting_preflight');

  await controller.command({ kind: 'submit', text: 'second' });
  expect(controller.state().kind).toBe('awaiting_preflight');
  expect(controller.state().queue).toHaveLength(2);
});

// ── discard_queue preserves awaiting_preflight ─────────────────────

it('discards queue in awaiting_preflight state', async () => {
  const controller = new QueueController({
    driver: { start: () => undefined, cancel: async () => undefined },
    snapshotFactory: () => ({}),
    ids: {
      item: (() => {
        let n = 0;
        return () => `item-${++n}`;
      })(),
      execution: () => 'execution-1',
    },
    preflightEvaluator: () => ({ preflight: { actionId: 'pf-1' as ActionId, kind: 'input_surge' } }),
  });

  await controller.command({ kind: 'submit', text: 'first' });
  await controller.command({ kind: 'submit', text: 'second' });
  expect(await controller.command({ kind: 'discard_queue' })).toEqual({ kind: 'accepted' });
  expect(controller.state().queue).toHaveLength(0);
});
