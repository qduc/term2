import test from 'ava';
import { createStreamingUpdateCoordinator } from '../../dist/utils/streaming-updater.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('coalesces rapid updates and uses latest value', async (t) => {
  const calls = [];
  const updater = createStreamingUpdateCoordinator((value) => calls.push(value), 40);

  updater.push('a');
  updater.push('b');

  t.deepEqual(calls, ['a']);

  await wait(60);

  t.deepEqual(calls, ['a', 'b']);
});

test('skips duplicate updates', async (t) => {
  const calls = [];
  const updater = createStreamingUpdateCoordinator((value) => calls.push(value), 20);

  updater.push('same');
  updater.push('same');

  await wait(30);

  t.deepEqual(calls, ['same']);
});

test('flush emits pending update immediately', async (t) => {
  const calls = [];
  const updater = createStreamingUpdateCoordinator((value) => calls.push(value), 100);

  updater.push('a');
  updater.push('b');
  updater.flush();

  t.deepEqual(calls, ['a', 'b']);

  await wait(120);
  t.deepEqual(calls, ['a', 'b']);
});

test('cancel drops pending update', async (t) => {
  const calls = [];
  const updater = createStreamingUpdateCoordinator((value) => calls.push(value), 50);

  updater.push('a');
  updater.push('b');
  updater.cancel();

  await wait(80);
  t.deepEqual(calls, ['a']);
});
