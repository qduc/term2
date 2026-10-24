import assert from 'node:assert/strict';
import fc from 'fast-check';
import { QueueController } from '../../source/services/queue/queue-controller.ts';

// A serial reference model for the public follow-up queue lane: FIFO dispatch,
// failure pauses retained work; removing/discarding all retained work releases
// the pause (see #cancel and #restore's explicit empty-pause invariant).
const action = fc.oneof(
  fc.record({
    kind: fc.constant('submit'),
    text: fc.string({ minLength: 1, maxLength: 30 }).filter((s) => !!s.trim()),
  }),
  fc.record({
    kind: fc.constantFrom('complete', 'fail', 'remove', 'edit', 'resume', 'discard', 'stale'),
    index: fc.nat(30),
  }),
);
export const queueProperties = [
  {
    name: 'queue.serial-actions',
    property: fc.asyncProperty(fc.array(action, { maxLength: 30 }), async (actions) => {
      let next = 0;
      const starts = [];
      const controller = new QueueController({
        driver: {
          start: (execution) => {
            starts.push(execution.item.id);
          },
          cancel: () => true,
        },
        snapshotFactory: (item) => ({ text: item.text }),
        ids: { item: () => `item-${++next}`, execution: () => `execution-${next}` },
        now: () => '2026-01-01T00:00:00.000Z',
        capacity: 100,
      });
      const model = { active: null, queue: [], paused: false, starts: [] };
      const dispatch = () => {
        if (!model.active && !model.paused && model.queue.length) {
          model.active = model.queue.shift();
          model.starts.push(model.active.id);
        }
      };
      for (const [step, action] of actions.entries()) {
        const state = controller.state();
        switch (action.kind) {
          case 'submit': {
            assert.equal((await controller.command({ kind: 'submit', text: action.text })).kind, 'accepted');
            model.queue.push({ id: `item-${next}`, text: action.text });
            dispatch();
            break;
          }
          case 'complete':
          case 'fail':
            if (model.active) {
              await controller.event({
                kind: action.kind === 'complete' ? 'completed' : 'failed',
                executionId: state.active.executionId,
                terminal: {},
                failure: 'generated',
              });
              model.active = null;
              model.paused = action.kind === 'fail' && model.queue.length > 0;
              dispatch();
            }
            break;
          case 'remove':
          case 'edit':
            if (model.queue.length) {
              const index = action.index % model.queue.length;
              await controller.command({
                kind: action.kind === 'remove' ? 'remove_queued' : 'edit_queued',
                itemId: model.queue[index].id,
                text: 'edited',
              });
              if (action.kind === 'remove') model.queue.splice(index, 1);
              else model.queue[index].text = 'edited';
              if (!model.queue.length) model.paused = false;
            }
            break;
          case 'resume':
            await controller.command({ kind: 'resume_queue' });
            model.paused = false;
            dispatch();
            break;
          case 'discard':
            await controller.command({ kind: 'discard_queue' });
            model.queue = [];
            model.paused = false;
            break;
          case 'stale':
            await controller.event({ kind: 'completed', executionId: 'never-issued', terminal: {} });
            break;
        }
        const actual = controller.state();
        assert.deepEqual(
          actual.queue.map(({ id, text }) => ({ id, text })),
          model.queue,
          `queue at step ${step}`,
        );
        assert.deepEqual(
          actual.active ? { id: actual.active.item.id, text: actual.active.item.text } : null,
          model.active,
          `active at step ${step}`,
        );
        assert.equal(actual.kind, model.active ? 'running' : model.paused ? 'paused' : 'idle', `phase at step ${step}`);
        assert.deepEqual(starts, model.starts, `dispatch at step ${step}`);
      }
    }),
  },
];
