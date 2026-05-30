import test from 'ava';
import { ToolExecutionLimiter } from './tool-execution-limiter.js';

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test('ToolExecutionLimiter limits concurrency and queues overflow in FIFO order', async (t) => {
  let limit = 2;
  const limiter = new ToolExecutionLimiter(() => limit);
  const started: number[] = [];
  const activeCounts: number[] = [];
  let active = 0;

  const blockers = Array.from({ length: 4 }, () => createDeferred<void>());
  const tasks = [1, 2, 3, 4].map((id, index) =>
    limiter.run(async () => {
      started.push(id);
      active += 1;
      activeCounts.push(active);

      try {
        await blockers[index]!.promise;
        return id;
      } finally {
        active -= 1;
      }
    }),
  );

  t.deepEqual(started, [1, 2]);
  t.is(Math.max(...activeCounts), 2);

  blockers[0]!.resolve();
  await flush();
  t.deepEqual(started, [1, 2, 3]);

  blockers[1]!.resolve();
  await flush();
  t.deepEqual(started, [1, 2, 3, 4]);

  blockers[2]!.resolve();
  blockers[3]!.resolve();
  t.deepEqual(await Promise.all(tasks), [1, 2, 3, 4]);
  t.is(Math.max(...activeCounts), 2);
});

test('ToolExecutionLimiter starts queued work after a limit increase notification', async (t) => {
  let limit = 1;
  const limiter = new ToolExecutionLimiter(() => limit);
  const started: number[] = [];
  const gate1 = createDeferred<void>();
  const gate2 = createDeferred<void>();

  const task1 = limiter.run(async () => {
    started.push(1);
    await gate1.promise;
    return 1;
  });

  const task2 = limiter.run(async () => {
    started.push(2);
    await gate2.promise;
    return 2;
  });

  t.deepEqual(started, [1]);

  limit = 2;
  limiter.notifyLimitChanged();
  await flush();
  t.deepEqual(started, [1, 2]);

  gate1.resolve();
  gate2.resolve();
  t.deepEqual(await Promise.all([task1, task2]), [1, 2]);
});
