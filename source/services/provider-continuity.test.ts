import test from 'ava';
import { ProviderContinuity } from './provider-continuity.js';

test('initial state is clear', (t) => {
  const pc = new ProviderContinuity();
  t.is(pc.previousResponseId, null);
  t.false(pc.chainingBroken);
  t.false(pc.isChainingAvailable(2));
  t.true(pc.isChainingAvailable(1));
});

test('update sets previousResponseId', (t) => {
  const pc = new ProviderContinuity();
  pc.update('resp-1');
  t.is(pc.previousResponseId, 'resp-1');
  t.false(pc.chainingBroken);
});

test('clear resets previousResponseId', (t) => {
  const pc = new ProviderContinuity();
  pc.update('resp-1');
  pc.clear();
  t.is(pc.previousResponseId, null);
});

test('breakChaining marks chaining broken and clears previousResponseId', (t) => {
  const pc = new ProviderContinuity();
  pc.update('resp-1');
  pc.breakChaining();
  t.is(pc.previousResponseId, null);
  t.true(pc.chainingBroken);
});

test('isChainingAvailable requires previousResponseId or short history and unbroken chaining', (t) => {
  const pc = new ProviderContinuity();
  t.false(pc.isChainingAvailable(2));
  t.true(pc.isChainingAvailable(1));
  pc.update('resp-1');
  t.true(pc.isChainingAvailable(2));
  pc.breakChaining();
  t.false(pc.isChainingAvailable(1));
  t.false(pc.isChainingAvailable(2));
});

test('update after breakChaining keeps chaining broken', (t) => {
  const pc = new ProviderContinuity();
  pc.breakChaining();
  pc.update('resp-2');
  t.is(pc.previousResponseId, 'resp-2');
  t.true(pc.chainingBroken);
  t.false(pc.isChainingAvailable());
});
