import { describe, it, expect } from 'vitest';
import type { Message } from '../../types/message.js';
import { appendMessagesCapped, insertBeforeStreamingTail } from './message-buffer.js';

const makeMessages = (count: number, prefix = 'm') =>
  Array.from({ length: count }, (_, i) => ({ id: i, text: `${prefix}${i}` }));

it('appendMessagesCapped keeps only the newest messages up to the cap', () => {
  const prev = makeMessages(3);
  const next = makeMessages(3, 'n');

  const result = appendMessagesCapped(prev, next, 4);

  expect(result.length).toBe(4);
  expect(result.map((m) => m.text)).toEqual(['m2', 'n0', 'n1', 'n2']);
});

it('appendMessagesCapped returns additions when cap is small', () => {
  const prev = makeMessages(2);
  const next = makeMessages(2, 'n');

  const result = appendMessagesCapped(prev, next, 2);

  expect(result.map((m) => m.text)).toEqual(['n0', 'n1']);
});

describe('insertBeforeStreamingTail', () => {
  const settled = (id: string): Message => ({ id, sender: 'system', text: id });
  const streaming = (id: string, sender: 'bot' | 'reasoning' = 'bot'): Message =>
    ({ id, sender, status: 'streaming', text: id } as Message);

  it('appends when nothing is streaming', () => {
    const result = insertBeforeStreamingTail([settled('a')], [settled('b')], 10);
    expect(result.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('splices above the whole trailing run of live slots', () => {
    const existing = [settled('a'), streaming('r', 'reasoning'), streaming('b')];
    const result = insertBeforeStreamingTail(existing, [settled('note')], 10);
    expect(result.map((m) => m.id)).toEqual(['a', 'note', 'r', 'b']);
  });

  it('ignores finalized bot text before the live tail', () => {
    const existing = [{ id: 'done', sender: 'bot', status: 'finalized', text: 'done' } as Message, streaming('b')];
    const result = insertBeforeStreamingTail(existing, [settled('note')], 10);
    expect(result.map((m) => m.id)).toEqual(['done', 'note', 'b']);
  });

  it('still honours the message cap', () => {
    const existing = [settled('a'), settled('b'), streaming('live')];
    const result = insertBeforeStreamingTail(existing, [settled('note')], 2);
    expect(result.map((m) => m.id)).toEqual(['note', 'live']);
  });
});
