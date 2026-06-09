import test from 'ava';
import { createThrottledFunction, type ThrottleScheduler } from './throttle.js';

const createScheduler = () => {
  let now = 1000;
  let nextId = 1;
  const timers = new Map();

  return {
    scheduler: {
      now: () => now,
      setTimeout: (callback: () => void, delayMs: number) => {
        const id = nextId++;
        timers.set(id, { callback, dueAt: now + delayMs });
        return id as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: (id: ReturnType<typeof setTimeout>) => {
        timers.delete(id as unknown as number);
      },
    } satisfies ThrottleScheduler,
    advance: (ms: number) => {
      now += ms;
      const ready = [...timers.entries()]
        .filter(([, timer]) => timer.dueAt <= now)
        .sort((a, b) => a[1].dueAt - b[1].dueAt);
      for (const [id, timer] of ready) {
        if (!timers.has(id)) continue;
        timers.delete(id);
        timer.callback();
      }
    },
  };
};

test('throttle batches updates and uses latest args', (t) => {
  const calls: string[] = [];
  const clock = createScheduler();
  const { throttled } = createThrottledFunction((value: string) => calls.push(value), 40, clock.scheduler);

  throttled('a');
  throttled('b');

  t.deepEqual(calls, ['a']);

  clock.advance(60);

  t.deepEqual(calls, ['a', 'b']);
});

test('flush emits pending call immediately', (t) => {
  const calls: string[] = [];
  const clock = createScheduler();
  const { throttled, flush } = createThrottledFunction((value: string) => calls.push(value), 100, clock.scheduler);

  throttled('a');
  throttled('b');
  flush();

  t.deepEqual(calls, ['a', 'b']);

  clock.advance(120);
  t.deepEqual(calls, ['a', 'b']);
});

test('cancel drops pending call', (t) => {
  const calls: string[] = [];
  const clock = createScheduler();
  const { throttled, cancel } = createThrottledFunction((value: string) => calls.push(value), 50, clock.scheduler);

  throttled('a');
  throttled('b');
  cancel();

  clock.advance(80);
  t.deepEqual(calls, ['a']);
});
