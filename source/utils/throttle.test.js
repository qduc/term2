import test from 'ava';
import { createThrottledFunction } from '../../dist/utils/throttle.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('throttle batches updates and uses latest args', async (t) => {
  const calls = [];
  const { throttled } = createThrottledFunction((value) => calls.push(value), 40);

  throttled('a');
  throttled('b');

  t.deepEqual(calls, ['a']);

  await wait(60);

  t.deepEqual(calls, ['a', 'b']);
});

test('flush emits pending call immediately', async (t) => {
  const calls = [];
  const { throttled, flush } = createThrottledFunction((value) => calls.push(value), 100);

  throttled('a');
  throttled('b');
  flush();

  t.deepEqual(calls, ['a', 'b']);

  await wait(120);
  t.deepEqual(calls, ['a', 'b']);
});

test('cancel drops pending call', async (t) => {
  const calls = [];
  const { throttled, cancel } = createThrottledFunction((value) => calls.push(value), 50);

  throttled('a');
  throttled('b');
  cancel();

  await wait(80);
  t.deepEqual(calls, ['a']);
});
