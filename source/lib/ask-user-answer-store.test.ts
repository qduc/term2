import test from 'ava';
import { AskUserAnswerStore } from './ask-user-answer-store.js';

test('set and consume stores and retrieves an answer', (t) => {
  const store = new AskUserAnswerStore();
  store.set('call-1', 'yes');
  t.is(store.consume('call-1'), 'yes');
});

test('consume deletes the answer after reading', (t) => {
  const store = new AskUserAnswerStore();
  store.set('call-1', 'yes');
  store.consume('call-1');
  t.is(store.consume('call-1'), undefined);
});

test('consume returns undefined for unknown callId', (t) => {
  const store = new AskUserAnswerStore();
  t.is(store.consume('unknown'), undefined);
});

test('peek reads without deleting', (t) => {
  const store = new AskUserAnswerStore();
  store.set('call-1', 'yes');
  t.is(store.peek('call-1'), 'yes');
  t.is(store.peek('call-1'), 'yes');
});

test('peek returns undefined for unknown callId', (t) => {
  const store = new AskUserAnswerStore();
  t.is(store.peek('unknown'), undefined);
});

test('set overwrites a previous answer', (t) => {
  const store = new AskUserAnswerStore();
  store.set('call-1', 'first');
  store.set('call-1', 'second');
  t.is(store.consume('call-1'), 'second');
});

test('multiple entries are independent', (t) => {
  const store = new AskUserAnswerStore();
  store.set('call-1', 'answer-1');
  store.set('call-2', 'answer-2');
  store.consume('call-1');
  t.is(store.consume('call-2'), 'answer-2');
});
