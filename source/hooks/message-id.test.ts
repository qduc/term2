import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createMessageIdFactory } from './message-id.js';

it('createMessageIdFactory generates unique ids within the same millisecond', () => {
  const nextId = createMessageIdFactory(() => 1000);

  expect(nextId()).toBe('1000-0');
  expect(nextId()).toBe('1000-1');
  expect(nextId()).toBe('1000-2');
});

it('createMessageIdFactory resets the sequence when time advances', () => {
  const timestamps = [1000, 1000, 1001, 1001];
  const nextId = createMessageIdFactory(() => timestamps.shift() ?? 1001);

  expect(nextId()).toBe('1000-0');
  expect(nextId()).toBe('1000-1');
  expect(nextId()).toBe('1001-0');
  expect(nextId()).toBe('1001-1');
});
