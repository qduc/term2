import { it, expect } from 'vitest';
import { AskUserAnswerStore } from './ask-user-answer-store.js';

it('set and consume stores and retrieves an answer', () => {
  const store = new AskUserAnswerStore();
  store.set('call-1', 'yes');
  expect(store.consume('call-1')).toBe('yes');
});

it('consume deletes the answer after reading', () => {
  const store = new AskUserAnswerStore();
  store.set('call-1', 'yes');
  store.consume('call-1');
  expect(store.consume('call-1')).toBe(undefined);
});

it('consume returns undefined for unknown callId', () => {
  const store = new AskUserAnswerStore();
  expect(store.consume('unknown')).toBe(undefined);
});

it('peek reads without deleting', () => {
  const store = new AskUserAnswerStore();
  store.set('call-1', 'yes');
  expect(store.peek('call-1')).toBe('yes');
  expect(store.peek('call-1')).toBe('yes');
});

it('peek returns undefined for unknown callId', () => {
  const store = new AskUserAnswerStore();
  expect(store.peek('unknown')).toBe(undefined);
});

it('set overwrites a previous answer', () => {
  const store = new AskUserAnswerStore();
  store.set('call-1', 'first');
  store.set('call-1', 'second');
  expect(store.consume('call-1')).toBe('second');
});

it('multiple entries are independent', () => {
  const store = new AskUserAnswerStore();
  store.set('call-1', 'answer-1');
  store.set('call-2', 'answer-2');
  store.consume('call-1');
  expect(store.consume('call-2')).toBe('answer-2');
});
