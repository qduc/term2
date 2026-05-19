import test from 'ava';
import type { AgentInputItem } from '@openai/agents';
import { ConversationStore, SHELL_CONTEXT_PREFIX } from './conversation-store.js';

test('addUserMessage() appends a user message item', (t) => {
  const store = new ConversationStore();
  store.addUserMessage('Hello');

  const history = store.getHistory();
  t.is(history.length, 1);
  const item: any = history[0];
  t.is(item.role, 'user');
  t.is(item.type, 'message');
  t.is(item.content, 'Hello');
});

test('addUserTurn() appends a text-only user message item', (t) => {
  const store = new ConversationStore();
  store.addUserTurn({ text: 'Hello' });

  const history = store.getHistory();
  t.is(history.length, 1);
  const item: any = history[0];
  t.is(item.role, 'user');
  t.is(item.type, 'message');
  t.is(item.content, 'Hello');
});

test('addUserTurn() appends multimodal user message content', (t) => {
  const store = new ConversationStore();
  store.addUserTurn({
    text: 'Describe this',
    images: [{ id: 'img-1', data: 'abc123', mimeType: 'image/png', byteSize: 3, displayNumber: 1 }],
  });

  const history = store.getHistory();
  t.is(history.length, 1);
  const item: any = history[0];
  t.is(item.role, 'user');
  t.is(item.type, 'message');
  t.deepEqual(item.content, [
    { type: 'input_text', text: 'Describe this' },
    { type: 'input_image', image: 'data:image/png;base64,abc123', detail: 'auto' },
  ]);
});

test('getLastUserMessage() returns text from multimodal user content', (t) => {
  const store = new ConversationStore();
  store.addUserTurn({
    text: 'What is in this image?',
    images: [{ id: 'img-1', data: 'abc123', mimeType: 'image/png', byteSize: 3, displayNumber: 1 }],
  });

  t.is(store.getLastUserMessage(), 'What is in this image?');
});

test('getHistory() returns a copy (external mutation does not affect store)', (t) => {
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
  t.is(history2.length, 1);
  const item: any = history2[0];
  t.is(item.content, 'A');
});

test('getLastUserMessage() returns the most recent user message text', (t) => {
  const store = new ConversationStore();
  store.addUserMessage('First');
  store.addUserMessage('Second');

  t.is(store.getLastUserMessage(), 'Second');
});

test('updateFromResult() merges run history without duplicating overlap', (t) => {
  const store = new ConversationStore();
  store.addUserMessage('Hi');

  store.updateFromResult({
    history: [
      { role: 'user', type: 'message', content: 'Hi' },
      { role: 'assistant', type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'Hello!' }] },
    ] satisfies AgentInputItem[],
  });

  let history = store.getHistory();
  t.is(history.length, 2);
  let last: any = history[history.length - 1];
  t.is(last.role, 'assistant');
  t.is(last.content[0].text, 'Hello!');

  // Next turn: user message is already in store; incoming history contains it too.
  store.addUserMessage('How are you?');
  store.updateFromResult({
    history: [
      { role: 'user', type: 'message', content: 'How are you?' },
      {
        role: 'assistant',
        type: 'message',
        status: 'completed',
        content: [{ type: 'output_text', text: 'Doing great.' }],
      },
    ] satisfies AgentInputItem[],
  });

  history = store.getHistory();
  t.is(history.length, 4);
  last = history[history.length - 1];
  t.is(last.role, 'assistant');
  t.is(last.content[0].text, 'Doing great.');
});

test('updateFromResult() replaces history when incoming history is a superset', (t) => {
  const store = new ConversationStore();
  store.addUserMessage('One');
  store.updateFromResult({
    history: [
      { role: 'user', type: 'message', content: 'One' },
      { role: 'assistant', type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'Ack' }] },
    ] satisfies AgentInputItem[],
  });

  store.addUserMessage('Two');
  store.updateFromResult({
    history: [
      { role: 'user', type: 'message', content: 'One' },
      { role: 'assistant', type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'Ack' }] },
      { role: 'user', type: 'message', content: 'Two' },
      { role: 'assistant', type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'Ack2' }] },
    ] satisfies AgentInputItem[],
  });

  const history = store.getHistory();
  t.is(history.length, 4);
  const last: any = history[3];
  t.is(last.content[0].text, 'Ack2');
});

test('updateFromResult() preserves reasoning_details across overlap merges', (t) => {
  const store = new ConversationStore();

  // Initial transcript where the assistant message has no reasoning_details.
  store.updateFromResult({
    history: [
      { role: 'user', type: 'message', content: 'First' },
      { role: 'assistant', type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'Hello' }] },
    ] satisfies AgentInputItem[],
  });

  // Later, the SDK returns incremental history starting with the last assistant
  // message, now enriched with reasoning_details (common in tool flows).
  const reasoning_details = [{ type: 'text', text: 'thinking' }];
  store.updateFromResult({
    history: [
      {
        role: 'assistant',
        type: 'message',
        content: 'Hello',
        reasoning_details,
      },
      {
        type: 'function_call',
        id: 'call-1',
        name: 'bash',
        arguments: '{"cmd":"ls"}',
      },
      { type: 'function_call_result', callId: 'call-1', output: 'files\n' },
    ] as any,
  });

  const history: any[] = store.getHistory() as any;
  const assistantHello = history.find(
    (item) => (item?.rawItem ?? item)?.role === 'assistant' && (item?.rawItem ?? item)?.content === 'Hello',
  );
  t.truthy(assistantHello);
  t.deepEqual((assistantHello?.rawItem ?? assistantHello)?.reasoning_details, reasoning_details);
});

test('updateFromResult() preserves reasoning (reasoning tokens) across overlap merges', (t) => {
  const store = new ConversationStore();

  // Initial transcript where the assistant message has no reasoning field.
  store.updateFromResult({
    history: [
      { role: 'user', type: 'message', content: 'First' },
      { role: 'assistant', type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'Hello' }] },
    ] satisfies AgentInputItem[],
  });

  // Later, the SDK returns incremental history starting with the last assistant
  // message, now enriched with OpenRouter-style reasoning.
  store.updateFromResult({
    history: [
      {
        role: 'assistant',
        type: 'message',
        content: 'Hello',
        reasoning: 'Some hidden thinking',
      },
      { role: 'user', type: 'message', content: 'Next' },
    ] as any,
  });

  const history: any[] = store.getHistory() as any;
  const assistantHello = history.find(
    (item) => (item?.rawItem ?? item)?.role === 'assistant' && (item?.rawItem ?? item)?.content === 'Hello',
  );
  t.truthy(assistantHello);
  t.is((assistantHello?.rawItem ?? assistantHello)?.reasoning, 'Some hidden thinking');
});

test('clear() resets history', (t) => {
  const store = new ConversationStore();
  store.addUserMessage('Hello');
  t.is(store.getHistory().length, 1);

  store.clear();
  t.is(store.getHistory().length, 0);
  t.is(store.getLastUserMessage(), '');
});

test('addShellContext() appends shell history as user message', (t) => {
  const store = new ConversationStore();
  store.addUserMessage('Hello');

  const historyText = '[Previous Shell Session]\n$ ls\nExit: 0';
  store.addShellContext(historyText);

  const history = store.getHistory();
  t.is(history.length, 2);
  const item: any = history[1];
  t.is(item.role, 'user');
  t.is(item.type, 'message');
  t.is(item.content, historyText);
});

test('removeLastUserTurn() removes the last user message and everything after it', (t) => {
  const store = new ConversationStore();
  store.addUserMessage('First');
  store.updateFromResult({
    history: [
      { role: 'user', type: 'message', content: 'First' },
      { role: 'assistant', type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'Reply 1' }] },
    ] satisfies AgentInputItem[],
  });
  store.addUserMessage('Second');
  store.updateFromResult({
    history: [
      { role: 'user', type: 'message', content: 'Second' },
      { role: 'assistant', type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'Reply 2' }] },
    ] satisfies AgentInputItem[],
  });

  t.is(store.getHistory().length, 4);

  const result = store.removeLastUserTurn();

  t.deepEqual(result, { text: 'Second', imageCount: 0 });
  const history = store.getHistory();
  t.is(history.length, 2);
  t.is((history[0] as any).content, 'First');
  t.is((history[1] as any).content[0].text, 'Reply 1');
});

test('removeLastUserTurn() returns null when no user message exists', (t) => {
  const store = new ConversationStore();
  store.updateFromResult({
    history: [
      { role: 'assistant', type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'Hi' }] },
    ] satisfies AgentInputItem[],
  });

  const result = store.removeLastUserTurn();

  t.is(result, null);
  t.is(store.getHistory().length, 1);
});

test('removeLastUserTurn() clears history when only one user message exists', (t) => {
  const store = new ConversationStore();
  store.addUserMessage('Only');

  const result = store.removeLastUserTurn();

  t.deepEqual(result, { text: 'Only', imageCount: 0 });
  t.is(store.getHistory().length, 0);
  t.is(store.getLastUserMessage(), '');
});

test('removeLastUserTurn() returns { text, imageCount: 0 } and removes turn + everything after it', (t) => {
  const store = new ConversationStore();
  store.addUserMessage('hello');
  store.updateFromResult({
    history: [
      { role: 'user', type: 'message', content: 'hello' },
      {
        role: 'assistant',
        type: 'message',
        status: 'completed',
        content: [{ type: 'output_text', text: 'world' }],
      },
    ] satisfies AgentInputItem[],
  });

  const result = store.removeLastUserTurn();

  t.deepEqual(result, { text: 'hello', imageCount: 0 });
  t.is(store.getHistory().length, 0);
});

test('removeLastUserTurn() skips trailing shell-context item and removes genuine user turn', (t) => {
  const store = new ConversationStore();
  store.addUserMessage('A');
  store.updateFromResult({
    history: [
      { role: 'user', type: 'message', content: 'A' },
      {
        role: 'assistant',
        type: 'message',
        status: 'completed',
        content: [{ type: 'output_text', text: 'reply' }],
      },
    ] satisfies AgentInputItem[],
  });
  store.addShellContext(`${SHELL_CONTEXT_PREFIX}\n\n$ ls\nExit: 0`);

  const result = store.removeLastUserTurn();

  t.deepEqual(result, { text: 'A', imageCount: 0 });
  t.is(store.getHistory().length, 0);
});

test('removeLastUserTurn() returns imageCount > 0 for multimodal turn', (t) => {
  const store = new ConversationStore();
  store.addUserTurn({
    text: 'hi',
    images: [{ id: 'img-1', data: 'AAAA', mimeType: 'image/png', byteSize: 3, displayNumber: 1 }],
  });

  const result = store.removeLastUserTurn();

  t.deepEqual(result, { text: 'hi', imageCount: 1 });
  t.is(store.getHistory().length, 0);
});

test('removeLastUserTurn() returns null when only a shell-context item is present', (t) => {
  const store = new ConversationStore();
  store.addShellContext(`${SHELL_CONTEXT_PREFIX}\n\n$ ls\nExit: 0`);

  const result = store.removeLastUserTurn();

  t.is(result, null);
  t.is(store.getHistory().length, 1);
});

// listUserTurns tests

test('listUserTurns() returns all genuine user turns with index and text', (t) => {
  const store = new ConversationStore();
  store.addUserMessage('First');
  store.updateFromResult({
    history: [
      { role: 'user', type: 'message', content: 'First' },
      { role: 'assistant', type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'Reply 1' }] },
    ] satisfies AgentInputItem[],
  });
  store.addUserMessage('Second');

  const turns = store.listUserTurns();

  t.is(turns.length, 2);
  t.is(turns[0].text, 'First');
  t.is(turns[1].text, 'Second');
});

test('listUserTurns() excludes shell context items', (t) => {
  const store = new ConversationStore();
  store.addShellContext(`${SHELL_CONTEXT_PREFIX}\n\n$ ls\nExit: 0`);
  store.addUserMessage('Hello');

  const turns = store.listUserTurns();

  t.is(turns.length, 1);
  t.is(turns[0].text, 'Hello');
});

test('listUserTurns() returns empty array when no user turns', (t) => {
  const store = new ConversationStore();
  store.updateFromResult({
    history: [
      { role: 'assistant', type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'Hi' }] },
    ] satisfies AgentInputItem[],
  });

  const turns = store.listUserTurns();

  t.is(turns.length, 0);
});

test('listUserTurns() includes imageCount for multimodal turns', (t) => {
  const store = new ConversationStore();
  store.addUserTurn({
    text: 'Describe this',
    images: [{ id: 'img-1', data: 'abc', mimeType: 'image/png', byteSize: 3, displayNumber: 1 }],
  });

  const turns = store.listUserTurns();

  t.is(turns.length, 1);
  t.is(turns[0].imageCount, 1);
  t.is(turns[0].text, 'Describe this');
});

// removeNLastUserTurns tests

test('removeNLastUserTurns(1) behaves the same as removeLastUserTurn()', (t) => {
  const store = new ConversationStore();
  store.addUserMessage('First');
  store.updateFromResult({
    history: [
      { role: 'user', type: 'message', content: 'First' },
      { role: 'assistant', type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'Reply 1' }] },
    ] satisfies AgentInputItem[],
  });
  store.addUserMessage('Second');
  store.updateFromResult({
    history: [
      { role: 'user', type: 'message', content: 'Second' },
      { role: 'assistant', type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'Reply 2' }] },
    ] satisfies AgentInputItem[],
  });

  const result = store.removeNLastUserTurns(1);

  t.deepEqual(result, { text: 'Second', imageCount: 0 });
  const history = store.getHistory();
  t.is(history.length, 2);
  t.is((history[0] as any).content, 'First');
  t.is((history[1] as any).content[0].text, 'Reply 1');
});

test('removeNLastUserTurns(2) removes last 2 user turns and their responses', (t) => {
  const store = new ConversationStore();
  store.addUserMessage('First');
  store.updateFromResult({
    history: [
      { role: 'user', type: 'message', content: 'First' },
      { role: 'assistant', type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'Reply 1' }] },
    ] satisfies AgentInputItem[],
  });
  store.addUserMessage('Second');
  store.updateFromResult({
    history: [
      { role: 'user', type: 'message', content: 'Second' },
      { role: 'assistant', type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'Reply 2' }] },
    ] satisfies AgentInputItem[],
  });
  store.addUserMessage('Third');
  store.updateFromResult({
    history: [
      { role: 'user', type: 'message', content: 'Third' },
      { role: 'assistant', type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'Reply 3' }] },
    ] satisfies AgentInputItem[],
  });

  const result = store.removeNLastUserTurns(2);

  t.deepEqual(result, { text: 'Second', imageCount: 0 });
  const history = store.getHistory();
  t.is(history.length, 2);
  t.is((history[0] as any).content, 'First');
  t.is((history[1] as any).content[0].text, 'Reply 1');
});

test('removeNLastUserTurns(3) removes all when fewer than n turns exist', (t) => {
  const store = new ConversationStore();
  store.addUserMessage('Only');
  store.updateFromResult({
    history: [
      { role: 'user', type: 'message', content: 'Only' },
      { role: 'assistant', type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'Reply' }] },
    ] satisfies AgentInputItem[],
  });

  const result = store.removeNLastUserTurns(3);

  t.deepEqual(result, { text: 'Only', imageCount: 0 });
  t.is(store.getHistory().length, 0);
});

test('removeNLastUserTurns(0) returns null', (t) => {
  const store = new ConversationStore();
  store.addUserMessage('Hello');

  const result = store.removeNLastUserTurns(0);

  t.is(result, null);
  t.is(store.getHistory().length, 1);
});

test('removeNLastUserTurns() returns null when no user turns exist', (t) => {
  const store = new ConversationStore();

  const result = store.removeNLastUserTurns(1);

  t.is(result, null);
});

test('removeNLastUserTurns() skips shell context items', (t) => {
  const store = new ConversationStore();
  store.addUserMessage('A');
  store.updateFromResult({
    history: [
      { role: 'user', type: 'message', content: 'A' },
      { role: 'assistant', type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'reply' }] },
    ] satisfies AgentInputItem[],
  });
  store.addShellContext(`${SHELL_CONTEXT_PREFIX}\n\n$ ls\nExit: 0`);
  store.addUserMessage('B');
  store.updateFromResult({
    history: [
      { role: 'user', type: 'message', content: 'B' },
      { role: 'assistant', type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'reply2' }] },
    ] satisfies AgentInputItem[],
  });

  // Remove both user turns (skipping shell context)
  const result = store.removeNLastUserTurns(2);

  t.deepEqual(result, { text: 'A', imageCount: 0 });
  // Only the shell context item should remain
  // (it's before the first user turn anchor, but the anchor is at user turn A, so everything from A onward is removed)
  const history = store.getHistory();
  t.is(history.length, 0);
});

test('insertSystemMessageBeforeLastUserTurn() places system message before final user message', (t) => {
  const store = new ConversationStore();
  store.addUserMessage('First');
  store.addUserMessage('Second');

  store.insertSystemMessageBeforeLastUserTurn('System Notice');

  const history = store.getHistory();
  t.is(history.length, 3);
  t.is((history[0] as any).content, 'First');
  t.is((history[1] as any).content, 'System Notice');
  t.is((history[1] as any).role, 'system');
  t.is((history[2] as any).content, 'Second');
});

test('insertSystemMessageBeforeLastUserTurn() inserts before genuine user turn, skipping trailing shell context', (t) => {
  const store = new ConversationStore();
  store.addUserMessage('First');
  store.addUserMessage('Second');
  store.addShellContext(`${SHELL_CONTEXT_PREFIX}\n\n$ ls\nExit: 0`);

  store.insertSystemMessageBeforeLastUserTurn('System Notice');

  const history = store.getHistory();
  t.is(history.length, 4);
  t.is((history[0] as any).content, 'First');
  t.is((history[1] as any).content, 'System Notice');
  t.is((history[1] as any).role, 'system');
  t.is((history[2] as any).content, 'Second');
  t.true((history[3] as any).content.startsWith(SHELL_CONTEXT_PREFIX));
});

test('insertSystemMessageBeforeLastUserTurn() appends to end if history is empty', (t) => {
  const store = new ConversationStore();
  store.insertSystemMessageBeforeLastUserTurn('System Notice');

  const history = store.getHistory();
  t.is(history.length, 1);
  t.is((history[0] as any).content, 'System Notice');
  t.is((history[0] as any).role, 'system');
});
