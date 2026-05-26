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

test('updateFromResult() rejects reordered full-snapshot supersets', (t) => {
  const store = new ConversationStore();

  store.updateFromResult(
    {
      history: [
        { role: 'user', type: 'message', content: 'A' },
        { role: 'assistant', type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'B' }] },
      ] satisfies AgentInputItem[],
    },
    { historyKind: 'full_snapshot', authoritative: true },
  );

  store.updateFromResult(
    {
      history: [
        { role: 'assistant', type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'B' }] },
        { role: 'user', type: 'message', content: 'A' },
        { role: 'assistant', type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'C' }] },
      ] satisfies AgentInputItem[],
    },
    { historyKind: 'full_snapshot', authoritative: true },
  );

  const history = store.getHistory() as any[];
  t.is(history.length, 2);
  t.is(history[0].content, 'A');
  t.is(history[1].content[0].text, 'B');
});

test('updateFromResult() treats tool callId as stable across full-history replays with changed item ids', (t) => {
  const store = new ConversationStore();
  store.addUserMessage('Inspect the repo');

  store.updateFromResult({
    history: [
      { role: 'user', type: 'message', content: 'Inspect the repo' },
      { type: 'function_call', id: 'fc_1', callId: 'call-read', name: 'read_file', arguments: '{}' },
      { type: 'function_call_result', id: 'fcr_1', callId: 'call-read', output: { text: 'contents' } },
    ] as any,
  });

  store.updateFromResult({
    history: [
      { role: 'user', type: 'message', content: 'Inspect the repo' },
      { type: 'function_call', id: 'fc_1_replayed', callId: 'call-read', name: 'read_file', arguments: '{}' },
      { type: 'function_call_result', id: 'fcr_1_replayed', callId: 'call-read', output: { text: 'contents' } },
      { type: 'function_call', id: 'fc_2', callId: 'call-grep', name: 'grep', arguments: '{}' },
      { type: 'function_call_result', id: 'fcr_2', callId: 'call-grep', output: { text: 'matches' } },
    ] as any,
  });

  store.updateFromResult({
    history: [
      { role: 'user', type: 'message', content: 'Inspect the repo' },
      { type: 'function_call', id: 'fc_1_replayed_again', callId: 'call-read', name: 'read_file', arguments: '{}' },
      { type: 'function_call_result', id: 'fcr_1_replayed_again', callId: 'call-read', output: { text: 'contents' } },
      { type: 'function_call', id: 'fc_2_replayed', callId: 'call-grep', name: 'grep', arguments: '{}' },
      { type: 'function_call_result', id: 'fcr_2_replayed', callId: 'call-grep', output: { text: 'matches' } },
      { role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'Done' }] },
    ] as any,
  });

  const history = store.getHistory() as any[];
  t.is(history.length, 6);
  t.is(history.filter((item) => (item.rawItem ?? item).callId === 'call-read').length, 2);
  t.is(history.filter((item) => (item.rawItem ?? item).callId === 'call-grep').length, 2);
});

test('updateFromResult() collapses SDK replayed history prefixes', (t) => {
  const store = new ConversationStore();
  store.addUserMessage('Investigate upgrade');

  store.updateFromResult({
    history: [
      { role: 'user', type: 'message', content: 'Investigate upgrade' },
      { type: 'function_call', callId: 'call-search', name: 'web_search', arguments: '{}' },
      { type: 'function_call_result', callId: 'call-search', name: 'web_search', output: { text: 'search results' } },
      { role: 'user', type: 'message', content: 'Investigate upgrade' },
      { type: 'function_call', callId: 'call-search', name: 'web_search', arguments: '{}' },
      { type: 'function_call_result', callId: 'call-search', name: 'web_search', output: { text: 'search results' } },
      { type: 'function_call', callId: 'call-read', name: 'read_file', arguments: '{}' },
      { type: 'function_call_result', callId: 'call-read', name: 'read_file', output: { text: 'file contents' } },
      { role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'Done' }] },
    ] as any,
  });

  const history = store.getHistory() as any[];
  t.is(history.length, 6);
  t.is(history.filter((item) => (item.rawItem ?? item).callId === 'call-search').length, 2);
  t.is(history.filter((item) => (item.rawItem ?? item).callId === 'call-read').length, 2);
  t.is((history[0].rawItem ?? history[0]).content, 'Investigate upgrade');
  t.is((history[5].rawItem ?? history[5]).role, 'assistant');
});

test('updateFromResult() keeps repeated user text when it is not a tool replay', (t) => {
  const store = new ConversationStore();

  store.updateFromResult({
    history: [
      { role: 'user', type: 'message', content: 'again' },
      { role: 'assistant', type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'first' }] },
      { role: 'user', type: 'message', content: 'again' },
      { role: 'assistant', type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'second' }] },
    ] satisfies AgentInputItem[],
  });

  const history = store.getHistory();
  t.is(history.length, 4);
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

  t.is(result?.text, 'hi');
  t.is(result?.imageCount, 1);
  t.is(result?.images?.[0]?.data, 'AAAA');
  t.is(result?.images?.[0]?.mimeType, 'image/png');
  t.is(result?.images?.[0]?.byteSize, 3);
  t.is(result?.images?.[0]?.displayNumber, 1);
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

test('addModeNotice() appends a persisted system message at the tail', (t) => {
  const store = new ConversationStore();
  store.addUserMessage('First');
  store.addModeNotice('Plan Mode ON');

  const history = store.getHistory();
  t.is(history.length, 2);
  t.is((history[0] as any).content, 'First');
  t.is((history[1] as any).role, 'user');
  t.is((history[1] as any).content, 'Plan Mode ON');
});

test('addModeNotice() preserves the existing prefix (append-only, never mid-history)', (t) => {
  const store = new ConversationStore();
  store.addUserMessage('First');
  store.addUserMessage('Second');
  const prefix = store.getHistory();

  store.addModeNotice('Plan Mode OFF');

  const history = store.getHistory();
  t.deepEqual(history.slice(0, prefix.length), prefix);
  t.is(history.length, prefix.length + 1);
  t.is((history[history.length - 1] as any).content, 'Plan Mode OFF');
});

test('addModeNotice() ignores blank text', (t) => {
  const store = new ConversationStore();
  store.addUserMessage('First');
  store.addModeNotice('   ');

  t.is(store.getHistory().length, 1);
});

test('updateFromResult() handles continued streams with interleaved tool calls where prefix-match fails', (t) => {
  const store = new ConversationStore();
  store.addUserMessage('Test interleaved stream');

  const historyPart1 = [
    { role: 'user', type: 'message', content: 'Test interleaved stream' },
    { role: 'assistant', type: 'message', content: 'Hello' },
    { type: 'function_call', id: 'fc_1', callId: 'call_1', name: 'shell', arguments: '{}' },
    { type: 'function_call_result', id: 'fcr_1', callId: 'call_1', output: 'ok' },
    { type: 'function_call', id: 'fc_2', callId: 'call_2', name: 'shell', arguments: '{}' },
    { type: 'function_call_result', id: 'fcr_2', callId: 'call_2', output: 'ok' },
  ] as any[];

  store.updateFromResult({ history: historyPart1 });

  // In the continuation, a new tool call `call_3` is inserted *between* fc_2 and fcr_2,
  // causing fcr_2 to shift position in the incoming history.
  const historyPart2 = [
    { role: 'user', type: 'message', content: 'Test interleaved stream' },
    { role: 'assistant', type: 'message', content: 'Hello' },
    { type: 'function_call', id: 'fc_1', callId: 'call_1', name: 'shell', arguments: '{}' },
    { type: 'function_call_result', id: 'fcr_1', callId: 'call_1', output: 'ok' },
    { type: 'function_call', id: 'fc_2', callId: 'call_2', name: 'shell', arguments: '{}' },
    { type: 'function_call', id: 'fc_3', callId: 'call_3', name: 'shell', arguments: '{}' },
    { type: 'function_call_result', id: 'fcr_2', callId: 'call_2', output: 'ok' },
    { type: 'function_call_result', id: 'fcr_3', callId: 'call_3', output: 'ok' },
  ] as any[];

  store.updateFromResult({ history: historyPart2 });

  const history = store.getHistory();
  // It should merge them and deduplicate. The result should contain exactly one copy of call_1, call_2, and call_3.
  const calls = history.filter((item: any) => item.type === 'function_call');
  const results = history.filter((item: any) => item.type === 'function_call_result');

  t.is(calls.length, 3);
  t.is(results.length, 3);
  t.deepEqual(
    calls.map((c: any) => c.callId),
    ['call_1', 'call_2', 'call_3'],
  );
  t.deepEqual(
    results.map((r: any) => r.callId),
    ['call_1', 'call_2', 'call_3'],
  );
});

test('updateFromResult() handles repeated identical user messages without false overlap', (t) => {
  const store = new ConversationStore();
  store.addUserMessage('ok');
  store.updateFromResult({
    history: [
      { role: 'user', type: 'message', content: 'ok' },
      {
        role: 'assistant',
        type: 'message',
        status: 'completed',
        content: [{ type: 'output_text', text: 'acknowledged' }],
      },
    ] satisfies AgentInputItem[],
  });

  // The user says 'ok' again.
  store.addUserMessage('ok');

  // The incoming history starts with 'ok' (the user message from the new turn).
  // Because 'ok' is low-confidence, we should NOT match it as an overlap with the first 'ok'
  // and instead match it with the second 'ok' at the tail of existing.
  store.updateFromResult({
    history: [
      { role: 'user', type: 'message', content: 'ok' },
      { role: 'assistant', type: 'message', status: 'completed', content: [{ type: 'output_text', text: 'done' }] },
    ] satisfies AgentInputItem[],
  });

  const history = store.getHistory();
  t.is(history.length, 4);
  t.is((history[0] as any).content, 'ok');
  t.is((history[1] as any).content[0].text, 'acknowledged');
  t.is((history[2] as any).content, 'ok');
  t.is((history[3] as any).content[0].text, 'done');
});

test('updateFromResult() handles image-only messages and same text with different images', (t) => {
  const store = new ConversationStore();

  // Turn 1: user sends image A
  store.addUserTurn({
    text: 'describe this',
    images: [{ id: 'img-a', data: 'AAAA', mimeType: 'image/png', byteSize: 3, displayNumber: 1 }],
  });

  store.updateFromResult({
    history: [
      {
        role: 'user',
        type: 'message',
        content: [
          { type: 'input_text', text: 'describe this' },
          { type: 'input_image', image: 'data:image/png;base64,AAAA', detail: 'auto' },
        ],
      },
      { role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'an image of A' }] },
    ] as any,
  });

  // Turn 2: user sends image B with the same text
  store.addUserTurn({
    text: 'describe this',
    images: [{ id: 'img-b', data: 'BBBB', mimeType: 'image/png', byteSize: 3, displayNumber: 1 }],
  });

  // We receive a new run result.
  // Because the image content hashes are different, the signatures are different.
  // This prevents false prefix matches or false overlap matches.
  store.updateFromResult({
    history: [
      {
        role: 'user',
        type: 'message',
        content: [
          { type: 'input_text', text: 'describe this' },
          { type: 'input_image', image: 'data:image/png;base64,BBBB', detail: 'auto' },
        ],
      },
      { role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'an image of B' }] },
    ] as any,
  });

  const history = store.getHistory();
  t.is(history.length, 4);
  t.is((history[1] as any).content[0].text, 'an image of A');
  t.is((history[3] as any).content[0].text, 'an image of B');
});

test('updateFromResult() reject divergent full transcript replacement when signatures differ', (t) => {
  const store = new ConversationStore();
  store.addUserTurn({
    text: 'analyze',
    images: [{ id: 'img-a', data: 'AAAA', mimeType: 'image/png', byteSize: 3, displayNumber: 1 }],
  });

  // Incoming has different image but same text. Should not match as prefix.
  store.updateFromResult({
    history: [
      {
        role: 'user',
        type: 'message',
        content: [
          { type: 'input_text', text: 'analyze' },
          { type: 'input_image', image: 'data:image/png;base64,BBBB', detail: 'auto' },
        ],
      },
      { role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'reply' }] },
    ] as any,
  });

  // Since it was divergent, they are appended rather than replacing.
  const history = store.getHistory();
  t.is(history.length, 3);
});

test('updateFromResult() supports suffix-prefix overlap search beyond 50 items', (t) => {
  const store = new ConversationStore();

  // Build a long history of 60 items in the store
  for (let i = 1; i <= 60; i++) {
    store.addUserMessage(`message-${i}`);
  }

  // The incoming result contains the last 15 items plus 5 new ones.
  // The overlap is 15 items, which is > 50 if maxWindow existed.
  const incomingHistory: AgentInputItem[] = [];
  for (let i = 46; i <= 60; i++) {
    incomingHistory.push({ role: 'user', type: 'message', content: `message-${i}` });
  }
  for (let i = 61; i <= 65; i++) {
    incomingHistory.push({ role: 'user', type: 'message', content: `message-${i}` });
  }

  store.updateFromResult({ history: incomingHistory });

  const history = store.getHistory();
  // It should correctly merge the overlap and result in 65 items total.
  t.is(history.length, 65);
  t.is((history[64] as any).content, 'message-65');
});

test('updateFromResult() collapses exact prefix duplicates only when tool calls are present', (t) => {
  const store = new ConversationStore();

  // Tool call present: should collapse duplicate prefix
  store.updateFromResult({
    history: [
      { role: 'user', type: 'message', content: 'again' },
      { type: 'function_call', callId: 'call-1', name: 'ls', arguments: '{}' },
      { type: 'function_call_result', callId: 'call-1', output: 'ok' },
      { role: 'user', type: 'message', content: 'again' },
      { type: 'function_call', callId: 'call-1', name: 'ls', arguments: '{}' },
      { type: 'function_call_result', callId: 'call-1', output: 'ok' },
      { role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'done' }] },
    ] as any,
  });

  t.is(store.getHistory().length, 4);

  store.clear();

  // No tool calls: should NOT collapse
  store.updateFromResult({
    history: [
      { role: 'user', type: 'message', content: 'again' },
      { role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'first' }] },
      { role: 'user', type: 'message', content: 'again' },
      { role: 'assistant', type: 'message', content: [{ type: 'output_text', text: 'first' }] },
    ] as any,
  });

  t.is(store.getHistory().length, 4);
});
