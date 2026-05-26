import test from 'ava';
import type { AgentInputItem } from '@openai/agents';

import { ConversationStore } from './conversation-store.js';

test('updateFromResult() matches replayed assistant messages by semantic content when ids change', (t) => {
  const store = new ConversationStore();

  store.updateFromResult(
    {
      history: [
        { role: 'user', type: 'message', content: 'Summarize' },
        {
          id: 'msg-old',
          role: 'assistant',
          type: 'message',
          status: 'completed',
          content: [{ type: 'output_text', text: 'Summary ready.' }],
        },
      ] as AgentInputItem[],
    },
    { historyKind: 'full_snapshot' },
  );

  store.updateFromResult(
    {
      history: [
        { role: 'user', type: 'message', content: 'Summarize' },
        {
          id: 'msg-new',
          role: 'assistant',
          type: 'message',
          status: 'completed',
          content: [{ type: 'output_text', text: 'Summary ready.' }],
        },
        {
          role: 'assistant',
          type: 'message',
          status: 'completed',
          content: [{ type: 'output_text', text: 'Next step.' }],
        },
      ] as AgentInputItem[],
    },
    { historyKind: 'partial_replay' },
  );

  const history = store.getHistory() as any[];
  t.is(history.length, 3);
  t.is(history[1].content[0].text, 'Summary ready.');
  t.is(history[2].content[0].text, 'Next step.');
});

test('updateFromResult() refuses zero-overlap full snapshots by default', (t) => {
  const store = new ConversationStore();

  store.updateFromResult(
    {
      history: [
        { role: 'user', type: 'message', content: 'Original question' },
        { role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'Original answer' }] },
      ] as AgentInputItem[],
    },
    { historyKind: 'full_snapshot' },
  );

  store.updateFromResult(
    {
      history: [
        { role: 'user', type: 'message', content: 'Different question' },
        { role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'Different answer' }] },
      ] as AgentInputItem[],
    },
    { historyKind: 'full_snapshot' },
  );

  const history = store.getHistory() as any[];
  t.is(history.length, 2);
  t.is(history[0].content, 'Original question');
  t.is(history[1].content[0].text, 'Original answer');
});

test('updateFromResult() allows authoritative full snapshots to replace on zero overlap', (t) => {
  const store = new ConversationStore();

  store.updateFromResult(
    {
      history: [
        { role: 'user', type: 'message', content: 'Original question' },
        { role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'Original answer' }] },
      ] as AgentInputItem[],
    },
    { historyKind: 'full_snapshot' },
  );

  store.updateFromResult(
    {
      history: [
        { role: 'user', type: 'message', content: 'Replacement question' },
        { role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'Replacement answer' }] },
      ] as AgentInputItem[],
    },
    { historyKind: 'full_snapshot', authoritative: true },
  );

  const history = store.getHistory() as any[];
  t.is(history.length, 2);
  t.is(history[0].content, 'Replacement question');
  t.is(history[1].content[0].text, 'Replacement answer');
});

test('updateFromResult() merges single-item overlaps when anchored by tool callId', (t) => {
  const store = new ConversationStore();

  store.updateFromResult(
    {
      history: [
        { role: 'user', type: 'message', content: 'Inspect' },
        { type: 'function_call', callId: 'call-1', name: 'read_file', arguments: '{}' },
      ] as any,
    },
    { historyKind: 'delta' },
  );

  store.updateFromResult(
    {
      history: [
        { type: 'function_call', callId: 'call-1', name: 'read_file', arguments: '{}' },
        { type: 'function_call_result', callId: 'call-1', output: { text: 'contents' } },
      ] as any,
    },
    { historyKind: 'partial_replay' },
  );

  const history = store.getHistory() as any[];
  t.is(history.length, 3);
  t.is(history.filter((item) => (item.rawItem ?? item).callId === 'call-1').length, 2);
});

test('updateFromResult() relaxed overlap for low-confidence signature', (t) => {
  const store = new ConversationStore();

  store.updateFromResult(
    {
      history: [
        { role: 'user', type: 'message', content: 'hello' },
        { role: 'assistant', type: 'message', content: 'ok' },
      ] as AgentInputItem[],
    },
    { historyKind: 'full_snapshot' },
  );

  // Incoming starts with 'ok' (low-confidence assistant message) and continues.
  // Because strict overlap fails on low-confidence 'ok', relaxed overlap should find it.
  store.updateFromResult(
    {
      history: [
        { role: 'assistant', type: 'message', content: 'ok' },
        { role: 'user', type: 'message', content: 'next question' },
      ] as AgentInputItem[],
    },
    { historyKind: 'partial_replay' },
  );

  const history = store.getHistory() as any[];
  t.is(history.length, 3);
  t.is(history[0].content, 'hello');
  t.is(history[1].content, 'ok');
  t.is(history[2].content, 'next question');
});

test('updateFromResult() full_snapshot same conversation fallback replaces history', (t) => {
  const store = new ConversationStore();

  store.updateFromResult(
    {
      history: [
        { role: 'user', type: 'message', content: 'original conversation query' },
        { role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'response' }] },
      ] as AgentInputItem[],
    },
    { historyKind: 'full_snapshot' },
  );

  // Incoming has zero suffix-prefix overlap, but has the same first user turn text.
  // This means it is the same conversation but with mismatching/divergent IDs or attributes.
  // It should replace the history.
  store.updateFromResult(
    {
      history: [
        { role: 'user', type: 'message', content: 'original conversation query' },
        { role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'response with different id' }] },
        { role: 'user', type: 'message', content: 'follow-up' },
      ] as AgentInputItem[],
    },
    { historyKind: 'full_snapshot' },
  );

  const history = store.getHistory() as any[];
  t.is(history.length, 3);
  t.is(history[0].content, 'original conversation query');
  t.is(history[1].content[0].text, 'response with different id');
  t.is(history[2].content, 'follow-up');
});

test('updateFromResult() partial_replay same conversation fallback appends history', (t) => {
  const store = new ConversationStore();

  store.updateFromResult(
    {
      history: [
        { role: 'user', type: 'message', content: 'query' },
        { role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'first response' }] },
      ] as AgentInputItem[],
    },
    { historyKind: 'full_snapshot' },
  );

  // Partial replay has zero overlap due to some signature mismatch, but shares the 'query' user turn.
  // It should append the new items.
  store.updateFromResult(
    {
      history: [
        { role: 'user', type: 'message', content: 'query' },
        { role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'new response' }] },
      ] as AgentInputItem[],
    },
    { historyKind: 'partial_replay' },
  );

  const history = store.getHistory() as any[];
  t.true(history.length > 2);
});
