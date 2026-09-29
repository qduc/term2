import assert from 'node:assert/strict';
import test from 'node:test';
import { attachAbortCleanup } from './request-guards.js';

test('abort cleanup subscribes before an in-flight operation can complete', () => {
  const controller = new AbortController();
  let destroyed = false;
  attachAbortCleanup(controller.signal, () => {
    destroyed = true;
  });
  controller.abort();
  assert.equal(destroyed, true);
});

test('abort cleanup destroys immediately when already aborted', () => {
  const controller = new AbortController();
  controller.abort();
  let destroyed = false;
  attachAbortCleanup(controller.signal, () => {
    destroyed = true;
  });
  assert.equal(destroyed, true);
});
