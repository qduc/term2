import { it, expect } from 'vitest';
import type { AgentInputItem } from '@openai/agents';
import { ConversationStore, SHELL_CONTEXT_PREFIX } from './conversation-store.js';

const addLegacyModeNotice = (store: ConversationStore, text: string) => {
  store.addImportedItem({
    role: 'user',
    type: 'message',
    content: `[Mode Notice] ${text}`,
  } as AgentInputItem);
};

it('addUserMessage() appends a user message item', () => {
  const store = new ConversationStore();
  store.addUserMessage('Hello');

  const history = store.getHistory();
  expect(history.length).toBe(1);
  const item: any = history[0];
  expect(item.role).toBe('user');
  expect(item.type).toBe('message');
  expect(item.content).toBe('Hello');
});

it('addUserTurn() appends a text-only user message item', () => {
  const store = new ConversationStore();
  store.addUserTurn({ text: 'Hello' });

  const history = store.getHistory();
  expect(history.length).toBe(1);
  const item: any = history[0];
  expect(item.role).toBe('user');
  expect(item.type).toBe('message');
  expect(item.content).toBe('Hello');
});

it('addUserTurn() appends multimodal user message content', () => {
  const store = new ConversationStore();
  store.addUserTurn({
    text: 'Describe this',
    images: [{ id: 'img-1', data: 'abc123', mimeType: 'image/png', byteSize: 3, displayNumber: 1 }],
  });

  const history = store.getHistory();
  expect(history.length).toBe(1);
  const item: any = history[0];
  expect(item.role).toBe('user');
  expect(item.type).toBe('message');
  expect(item.content).toEqual([
    { type: 'input_text', text: 'Describe this' },
    { type: 'input_image', image: 'data:image/png;base64,abc123', detail: 'auto' },
  ]);
});

it('getLastUserMessage() returns text from multimodal user content', () => {
  const store = new ConversationStore();
  store.addUserTurn({
    text: 'What is in this image?',
    images: [{ id: 'img-1', data: 'abc123', mimeType: 'image/png', byteSize: 3, displayNumber: 1 }],
  });

  expect(store.getLastUserMessage()).toBe('What is in this image?');
});

it('getHistory() returns a copy (external mutation does not affect store)', () => {
  const store = new ConversationStore();
  store.addUserMessage('A');

  const history1 = store.getHistory();
  history1.push({
    role: 'assistant',
    type: 'message',
    status: 'completed',
    content: [{ type: 'output_text', text: 'Injected' }],
  } as AgentInputItem);

  const history2 = store.getHistory();
  expect(history2.length).toBe(1);
  const item: any = history2[0];
  expect(item.content).toBe('A');
});

it('getLastUserMessage() returns the most recent user message text', () => {
  const store = new ConversationStore();
  store.addUserMessage('First');
  store.addUserMessage('Second');

  expect(store.getLastUserMessage()).toBe('Second');
});

it('appendOutput() appends items to existing history', () => {
  const store = new ConversationStore();
  store.addUserMessage('Hi');

  store.appendOutput([
    { role: 'assistant', type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'Hello!' }] },
  ] satisfies AgentInputItem[]);

  const history = store.getHistory();
  expect(history.length).toBe(2);
  const last: any = history[history.length - 1];
  expect(last.role).toBe('assistant');
  expect(last.content[0].text).toBe('Hello!');

  store.addUserMessage('How are you?');
  store.appendOutput([
    {
      role: 'assistant',
      type: 'message',
      status: 'completed',
      content: [{ type: 'output_text', text: 'Doing great.' }],
    },
  ] satisfies AgentInputItem[]);

  expect(store.getHistory().length).toBe(4);
});

it('replaceHistory() overwrites the store with a full transcript', () => {
  const store = new ConversationStore();
  store.addUserMessage('Old');

  store.replaceHistory([
    { role: 'user', type: 'message', content: 'New Q' },
    { role: 'assistant', type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'New A' }] },
  ] satisfies AgentInputItem[]);

  const history = store.getHistory();
  expect(history.length).toBe(2);
  expect((history[0] as any).content).toBe('New Q');
  expect((history[1] as any).content[0].text).toBe('New A');
});

it('appendOutput() is a no-op on empty or non-array input', () => {
  const store = new ConversationStore();
  store.addUserMessage('A');
  store.appendOutput([] as any);
  store.appendOutput(null as any);
  store.appendOutput(undefined as any);
  expect(store.getHistory().length).toBe(1);
});

it('replaceHistory() is a no-op on empty or non-array input', () => {
  const store = new ConversationStore();
  store.addUserMessage('A');
  store.replaceHistory([] as any);
  store.replaceHistory(null as any);
  expect(store.getHistory().length).toBe(1);
  expect((store.getHistory()[0] as any).content).toBe('A');
});

it('appendOutput() returns deep clones (external mutation does not affect store)', () => {
  const store = new ConversationStore();
  const items: AgentInputItem[] = [
    { role: 'assistant', type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'Original' }] },
  ];
  store.appendOutput(items);
  (items[0] as any).content[0].text = 'Mutated';
  const history = store.getHistory();
  expect((history[0] as any).content[0].text).toBe('Original');
});
it('clear() resets history', () => {
  const store = new ConversationStore();
  store.addUserMessage('Hello');
  expect(store.getHistory().length).toBe(1);

  store.clear();
  expect(store.getHistory().length).toBe(0);
  expect(store.getLastUserMessage()).toBe('');
});

it('addShellContext() appends shell history as user message', () => {
  const store = new ConversationStore();
  store.addUserMessage('Hello');

  const historyText = '[Previous Shell Session]\n$ ls\nExit: 0';
  store.addShellContext(historyText);

  const history = store.getHistory();
  expect(history.length).toBe(2);
  const item: any = history[1];
  expect(item.role).toBe('user');
  expect(item.type).toBe('message');
  expect(item.content).toBe(historyText);
});

it('removeLastUserTurn() removes the last user message and everything after it', () => {
  const store = new ConversationStore();
  store.addUserMessage('First');
  store.appendOutput([
    { role: 'assistant', type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'Reply 1' }] },
  ] satisfies AgentInputItem[]);
  store.addUserMessage('Second');
  store.appendOutput([
    { role: 'assistant', type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'Reply 2' }] },
  ] satisfies AgentInputItem[]);

  expect(store.getHistory().length).toBe(4);

  const result = store.removeLastUserTurn();

  expect(result).toEqual({ text: 'Second', imageCount: 0 });
  const history = store.getHistory();
  expect(history.length).toBe(2);
  expect((history[0] as any).content).toBe('First');
  expect((history[1] as any).content[0].text).toBe('Reply 1');
});

it('removeAfterLastToolOutput() removes trailing assistant text but keeps the last tool output', () => {
  const store = new ConversationStore();
  store.addUserMessage('First');
  store.appendOutput([
    { type: 'function_call', callId: 'call-1', name: 'shell', arguments: '{"command":"date"}' } as AgentInputItem,
    {
      type: 'function_call_result',
      callId: 'call-1',
      name: 'shell',
      output: 'Mon Jan 01 00:00:00 UTC 2024',
    } as AgentInputItem,
    { role: 'assistant', type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'Done.' }] },
  ] satisfies AgentInputItem[]);

  const result = store.removeAfterLastToolOutput();

  expect(result).toEqual({
    index: 2,
    itemType: 'function_call_result',
    callId: 'call-1',
    toolName: 'shell',
    output: 'Mon Jan 01 00:00:00 UTC 2024',
  });
  expect(store.getHistory().map((item: any) => item.type)).toEqual(['user', 'function_call', 'function_call_result']);
});

it('peekLastToolOutput() returns the last tool output without trimming history', () => {
  const store = new ConversationStore();
  store.appendOutput([
    { type: 'function_call', callId: 'call-1', name: 'shell', arguments: '{"command":"date"}' } as AgentInputItem,
    { type: 'function_call_result', callId: 'call-1', name: 'shell', output: 'done' } as AgentInputItem,
  ] satisfies AgentInputItem[]);

  expect(store.peekLastToolOutput()).toEqual({
    index: 1,
    itemType: 'function_call_result',
    callId: 'call-1',
    toolName: 'shell',
    output: 'done',
  });
  expect(store.getHistory().map((item: any) => item.type)).toEqual(['function_call', 'function_call_result']);
});

it('removeLastUserTurn() returns null when no user message exists', () => {
  const store = new ConversationStore();
  store.appendOutput([
    { role: 'assistant', type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'Hi' }] },
  ] satisfies AgentInputItem[]);

  const result = store.removeLastUserTurn();

  expect(result).toBe(null);
  expect(store.getHistory().length).toBe(1);
});

it('removeLastUserTurn() clears history when only one user message exists', () => {
  const store = new ConversationStore();
  store.addUserMessage('Only');

  const result = store.removeLastUserTurn();

  expect(result).toEqual({ text: 'Only', imageCount: 0 });
  expect(store.getHistory().length).toBe(0);
  expect(store.getLastUserMessage()).toBe('');
});

it('removeLastUserTurn() returns { text, imageCount: 0 } and removes turn + everything after it', () => {
  const store = new ConversationStore();
  store.addUserMessage('hello');
  store.appendOutput([
    {
      role: 'assistant',
      type: 'message',
      status: 'completed',
      content: [{ type: 'output_text', text: 'world' }],
    },
  ] satisfies AgentInputItem[]);

  const result = store.removeLastUserTurn();

  expect(result).toEqual({ text: 'hello', imageCount: 0 });
  expect(store.getHistory().length).toBe(0);
});

it('removeLastUserTurn() skips trailing shell-context item and removes genuine user turn', () => {
  const store = new ConversationStore();
  store.addUserMessage('A');
  store.appendOutput([
    {
      role: 'assistant',
      type: 'message',
      status: 'completed',
      content: [{ type: 'output_text', text: 'reply' }],
    },
  ] satisfies AgentInputItem[]);
  store.addShellContext(`${SHELL_CONTEXT_PREFIX}\n\n$ ls\nExit: 0`);

  const result = store.removeLastUserTurn();

  expect(result).toEqual({ text: 'A', imageCount: 0 });
  expect(store.getHistory().length).toBe(0);
});

it('removeLastUserTurn() returns imageCount > 0 for multimodal turn', () => {
  const store = new ConversationStore();
  store.addUserTurn({
    text: 'hi',
    images: [{ id: 'img-1', data: 'AAAA', mimeType: 'image/png', byteSize: 3, displayNumber: 1 }],
  });

  const result = store.removeLastUserTurn();

  expect(result?.text).toBe('hi');
  expect(result?.imageCount).toBe(1);
  expect(result?.images?.[0]?.data).toBe('AAAA');
  expect(result?.images?.[0]?.mimeType).toBe('image/png');
  expect(result?.images?.[0]?.byteSize).toBe(3);
  expect(result?.images?.[0]?.displayNumber).toBe(1);
  expect(store.getHistory().length).toBe(0);
});

it('removeLastUserTurn() returns null when only a shell-context item is present', () => {
  const store = new ConversationStore();
  store.addShellContext(`${SHELL_CONTEXT_PREFIX}\n\n$ ls\nExit: 0`);

  const result = store.removeLastUserTurn();

  expect(result).toBe(null);
  expect(store.getHistory().length).toBe(1);
});

// listUserTurns tests

it('listUserTurns() returns all genuine user turns with index and text', () => {
  const store = new ConversationStore();
  store.addUserMessage('First');
  store.appendOutput([
    { role: 'assistant', type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'Reply 1' }] },
  ] satisfies AgentInputItem[]);
  store.addUserMessage('Second');

  const turns = store.listUserTurns();

  expect(turns.length).toBe(2);
  expect(turns[0].text).toBe('First');
  expect(turns[1].text).toBe('Second');
});

it('listUserTurns() excludes shell context items', () => {
  const store = new ConversationStore();
  store.addShellContext(`${SHELL_CONTEXT_PREFIX}\n\n$ ls\nExit: 0`);
  store.addUserMessage('Hello');

  const turns = store.listUserTurns();

  expect(turns.length).toBe(1);
  expect(turns[0].text).toBe('Hello');
});

it('listUserTurns() returns empty array when no user turns', () => {
  const store = new ConversationStore();
  store.appendOutput([
    { role: 'assistant', type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'Hi' }] },
  ] satisfies AgentInputItem[]);

  const turns = store.listUserTurns();

  expect(turns.length).toBe(0);
});

it('listUserTurns() includes imageCount for multimodal turns', () => {
  const store = new ConversationStore();
  store.addUserTurn({
    text: 'Describe this',
    images: [{ id: 'img-1', data: 'abc', mimeType: 'image/png', byteSize: 3, displayNumber: 1 }],
  });

  const turns = store.listUserTurns();

  expect(turns.length).toBe(1);
  expect(turns[0].imageCount).toBe(1);
  expect(turns[0].text).toBe('Describe this');
});

// removeNLastUserTurns tests

it('removeNLastUserTurns(1) behaves the same as removeLastUserTurn()', () => {
  const store = new ConversationStore();
  store.addUserMessage('First');
  store.appendOutput([
    { role: 'assistant', type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'Reply 1' }] },
  ] satisfies AgentInputItem[]);
  store.addUserMessage('Second');
  store.appendOutput([
    { role: 'assistant', type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'Reply 2' }] },
  ] satisfies AgentInputItem[]);

  const result = store.removeNLastUserTurns(1);

  expect(result).toEqual({ text: 'Second', imageCount: 0 });
  const history = store.getHistory();
  expect(history.length).toBe(2);
  expect((history[0] as any).content).toBe('First');
  expect((history[1] as any).content[0].text).toBe('Reply 1');
});

it('removeNLastUserTurns(2) removes last 2 user turns and their responses', () => {
  const store = new ConversationStore();
  store.addUserMessage('First');
  store.appendOutput([
    { role: 'assistant', type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'Reply 1' }] },
  ] satisfies AgentInputItem[]);
  store.addUserMessage('Second');
  store.appendOutput([
    { role: 'assistant', type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'Reply 2' }] },
  ] satisfies AgentInputItem[]);
  store.addUserMessage('Third');
  store.appendOutput([
    { role: 'assistant', type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'Reply 3' }] },
  ] satisfies AgentInputItem[]);

  const result = store.removeNLastUserTurns(2);

  expect(result).toEqual({ text: 'Second', imageCount: 0 });
  const history = store.getHistory();
  expect(history.length).toBe(2);
  expect((history[0] as any).content).toBe('First');
  expect((history[1] as any).content[0].text).toBe('Reply 1');
});

it('removeNLastUserTurns(3) removes all when fewer than n turns exist', () => {
  const store = new ConversationStore();
  store.addUserMessage('Only');
  store.appendOutput([
    { role: 'assistant', type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'Reply' }] },
  ] satisfies AgentInputItem[]);

  const result = store.removeNLastUserTurns(3);

  expect(result).toEqual({ text: 'Only', imageCount: 0 });
  expect(store.getHistory().length).toBe(0);
});

it('removeNLastUserTurns(0) returns null', () => {
  const store = new ConversationStore();
  store.addUserMessage('Hello');

  const result = store.removeNLastUserTurns(0);

  expect(result).toBe(null);
  expect(store.getHistory().length).toBe(1);
});

it('removeNLastUserTurns() returns null when no user turns exist', () => {
  const store = new ConversationStore();

  const result = store.removeNLastUserTurns(1);

  expect(result).toBe(null);
});

it('removeNLastUserTurns() skips shell context items', () => {
  const store = new ConversationStore();
  store.addUserMessage('A');
  store.appendOutput([
    { role: 'assistant', type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'reply' }] },
  ] satisfies AgentInputItem[]);
  store.addShellContext(`${SHELL_CONTEXT_PREFIX}\n\n$ ls\nExit: 0`);
  store.addUserMessage('B');
  store.appendOutput([
    { role: 'assistant', type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'reply2' }] },
  ] satisfies AgentInputItem[]);

  // Remove both user turns (skipping shell context)
  const result = store.removeNLastUserTurns(2);

  expect(result).toEqual({ text: 'A', imageCount: 0 });
  // Only the shell context item should remain
  // (it's before the first user turn anchor, but the anchor is at user turn A, so everything from A onward is removed)
  const history = store.getHistory();
  expect(history.length).toBe(0);
});

it('removeLastUserTurn() skips trailing legacy mode-notice item', () => {
  const store = new ConversationStore();
  store.addUserMessage('A');
  store.appendOutput([
    {
      role: 'assistant',
      type: 'message',
      status: 'completed',
      content: [{ type: 'output_text', text: 'reply' }],
    },
  ] satisfies AgentInputItem[]);
  addLegacyModeNotice(store, 'Plan Mode ON');

  const result = store.removeLastUserTurn();

  expect(result).toEqual({ text: 'A', imageCount: 0 });
  expect(store.getHistory().length).toBe(0);
});

it('removeLastUserTurn() returns null when only a legacy mode-notice item is present', () => {
  const store = new ConversationStore();
  addLegacyModeNotice(store, 'Plan Mode ON');

  const result = store.removeLastUserTurn();

  expect(result).toBeNull();
  expect(store.getHistory().length).toBe(1);
});

it('listUserTurns() excludes legacy mode notice items', () => {
  const store = new ConversationStore();
  addLegacyModeNotice(store, 'Plan Mode ON');
  store.addUserMessage('Hello');

  const turns = store.listUserTurns();

  expect(turns.length).toBe(1);
  expect(turns[0].text).toBe('Hello');
});

it('removeNLastUserTurns() skips legacy mode notice items', () => {
  const store = new ConversationStore();
  store.addUserMessage('A');
  store.appendOutput([
    { role: 'assistant', type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'reply' }] },
  ] satisfies AgentInputItem[]);
  addLegacyModeNotice(store, 'Plan Mode ON');
  store.addUserMessage('B');
  store.appendOutput([
    { role: 'assistant', type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'reply2' }] },
  ] satisfies AgentInputItem[]);

  // Remove both user turns (skipping legacy mode notice)
  const result = store.removeNLastUserTurns(2);

  expect(result).toEqual({ text: 'A', imageCount: 0 });
  const history = store.getHistory();
  expect(history.length).toBe(0);
});
