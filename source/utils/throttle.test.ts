import { it, expect } from 'vitest';
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

it('throttle batches updates and uses latest args', () => {
  const calls: string[] = [];
  const clock = createScheduler();
  const { throttled } = createThrottledFunction((value: string) => calls.push(value), 40, clock.scheduler);

  throttled('a');
  throttled('b');

  expect(calls).toEqual(['a']);

  clock.advance(60);

  expect(calls).toEqual(['a', 'b']);
});

it('flush emits pending call immediately', () => {
  const calls: string[] = [];
  const clock = createScheduler();
  const { throttled, flush } = createThrottledFunction((value: string) => calls.push(value), 100, clock.scheduler);

  throttled('a');
  throttled('b');
  flush();

  expect(calls).toEqual(['a', 'b']);

  clock.advance(120);
  expect(calls).toEqual(['a', 'b']);
});

it('cancel drops pending call', () => {
  const calls: string[] = [];
  const clock = createScheduler();
  const { throttled, cancel } = createThrottledFunction((value: string) => calls.push(value), 50, clock.scheduler);

  throttled('a');
  throttled('b');
  cancel();

  clock.advance(80);
  expect(calls).toEqual(['a']);
});
