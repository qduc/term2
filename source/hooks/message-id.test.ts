import test from 'ava';
import { createMessageIdFactory } from './message-id.js';

test('createMessageIdFactory generates unique ids within the same millisecond', (t) => {
  const nextId = createMessageIdFactory(() => 1000);

  t.is(nextId(), '1000-0');
  t.is(nextId(), '1000-1');
  t.is(nextId(), '1000-2');
});

test('createMessageIdFactory resets the sequence when time advances', (t) => {
  const timestamps = [1000, 1000, 1001, 1001];
  const nextId = createMessageIdFactory(() => timestamps.shift() ?? 1001);

  t.is(nextId(), '1000-0');
  t.is(nextId(), '1000-1');
  t.is(nextId(), '1001-0');
  t.is(nextId(), '1001-1');
});
