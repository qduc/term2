import test from 'ava';
import { GenerationGuard } from './generation-guard.js';

test('capture returns a token and increments generation', (t) => {
  const guard = new GenerationGuard();
  const token = guard.capture();
  t.is(token, 1);
  t.is(guard.currentGeneration, 1);
});

test('isCurrent returns true for the latest token', (t) => {
  const guard = new GenerationGuard();
  const token = guard.capture();
  t.true(guard.isCurrent(token));
});

test('isCurrent returns false for an older token', (t) => {
  const guard = new GenerationGuard();
  const token1 = guard.capture();
  guard.capture();
  t.false(guard.isCurrent(token1));
});

test('isCurrent returns true for zero token when generation is zero', (t) => {
  const guard = new GenerationGuard();
  t.true(guard.isCurrent(0));
});

test('invalidate bumps generation and invalidates prior tokens', (t) => {
  const guard = new GenerationGuard();
  const token1 = guard.capture();
  guard.invalidate();
  t.false(guard.isCurrent(token1));
  t.is(guard.currentGeneration, 2);
});

test('runIfCurrent executes mutation when token is current', (t) => {
  const guard = new GenerationGuard();
  const token = guard.capture();
  let called = false;
  const result = guard.runIfCurrent(token, () => {
    called = true;
    return 'ok';
  });
  t.true(called);
  t.is(result, true);
});

test('runIfCurrent skips mutation when token is stale', (t) => {
  const guard = new GenerationGuard();
  const token = guard.capture();
  guard.invalidate();
  let called = false;
  const result = guard.runIfCurrent(token, () => {
    called = true;
  });
  t.false(called);
  t.is(result, false);
});
