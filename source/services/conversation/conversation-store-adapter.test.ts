import test from 'ava';
import type { AgentInputItem } from '@openai/agents';
import { ConversationStore } from './conversation-store.js';
import { ConversationStoreSessionAdapter } from './conversation-store-adapter.js';

test('getSessionId() returns the configured session ID', async (t) => {
  const store = new ConversationStore();
  const adapter = new ConversationStoreSessionAdapter(store, 'test-session-123');

  const sessionId = await adapter.getSessionId();
  t.is(sessionId, 'test-session-123');
});

test('getItems() returns empty when store is empty', async (t) => {
  const store = new ConversationStore();
  const adapter = new ConversationStoreSessionAdapter(store, 'test-session-id');

  const items = await adapter.getItems();
  t.deepEqual(items, []);
});

test('getItems() returns all items when no limit is specified', async (t) => {
  const store = new ConversationStore();
  store.addUserMessage('Hello 1');
  store.addUserMessage('Hello 2');
  const adapter = new ConversationStoreSessionAdapter(store, 'test-session-id');

  const items = await adapter.getItems();
  t.is(items.length, 2);
  t.is((items[0] as any).content, 'Hello 1');
  t.is((items[1] as any).content, 'Hello 2');
});

test('getItems() respects the limit parameter', async (t) => {
  const store = new ConversationStore();
  store.addUserMessage('Hello 1');
  store.addUserMessage('Hello 2');
  store.addUserMessage('Hello 3');
  const adapter = new ConversationStoreSessionAdapter(store, 'test-session-id');

  const itemsWithLimit = await adapter.getItems(2);
  t.is(itemsWithLimit.length, 2);
  t.is((itemsWithLimit[0] as any).content, 'Hello 2');
  t.is((itemsWithLimit[1] as any).content, 'Hello 3');

  const itemsWithZeroLimit = await adapter.getItems(0);
  t.deepEqual(itemsWithZeroLimit, []);

  const itemsWithNegativeLimit = await adapter.getItems(-1);
  t.deepEqual(itemsWithNegativeLimit, []);

  const itemsWithLargeLimit = await adapter.getItems(10);
  t.is(itemsWithLargeLimit.length, 3);
  t.is((itemsWithLargeLimit[0] as any).content, 'Hello 1');
});

test('addItems() appends items to the conversation store', async (t) => {
  const store = new ConversationStore();
  const adapter = new ConversationStoreSessionAdapter(store, 'test-session-id');

  const newItems: AgentInputItem[] = [
    { role: 'user', type: 'message', content: 'From adapter 1' },
    { role: 'assistant', type: 'message', status: 'completed', content: 'From adapter 2' } as any,
  ];

  await adapter.addItems(newItems);

  const storeHistory = store.getHistory();
  t.is(storeHistory.length, 2);
  t.is((storeHistory[0] as any).content, 'From adapter 1');
  t.is((storeHistory[1] as any).content, 'From adapter 2');
});

test('popItem() removes and returns the last item from the store', async (t) => {
  const store = new ConversationStore();
  store.addUserMessage('Item 1');
  store.addUserMessage('Item 2');
  const adapter = new ConversationStoreSessionAdapter(store, 'test-session-id');

  const popped = await adapter.popItem();
  t.is((popped as any)?.content, 'Item 2');

  const historyAfterPop = store.getHistory();
  t.is(historyAfterPop.length, 1);
  t.is((historyAfterPop[0] as any).content, 'Item 1');

  const popped2 = await adapter.popItem();
  t.is((popped2 as any)?.content, 'Item 1');

  const poppedEmpty = await adapter.popItem();
  t.is(poppedEmpty, undefined);
  t.is(store.getHistory().length, 0);
});

test('clearSession() clears the store history', async (t) => {
  const store = new ConversationStore();
  store.addUserMessage('Item');
  const adapter = new ConversationStoreSessionAdapter(store, 'test-session-id');

  t.is(store.getHistory().length, 1);
  await adapter.clearSession();
  t.is(store.getHistory().length, 0);
});

test('applyHistoryMutations() mutates and replaces function call history', async (t) => {
  const store = new ConversationStore();
  const initialCallItem: AgentInputItem = {
    role: 'assistant',
    type: 'function_call',
    callId: 'call_123',
    name: 'test_tool',
    arguments: '{"a": 1}',
  } as any;

  store.addImportedItem(initialCallItem);
  const adapter = new ConversationStoreSessionAdapter(store, 'test-session-id');

  const replacementItem: AgentInputItem = {
    role: 'assistant',
    type: 'function_call',
    callId: 'call_123',
    name: 'test_tool',
    arguments: '{"a": 2}',
  } as any;

  await adapter.applyHistoryMutations({
    mutations: [
      {
        type: 'replace_function_call',
        callId: 'call_123',
        replacement: replacementItem as any,
      },
    ],
  });

  const history = store.getHistory();
  t.is(history.length, 1);
  t.is((history[0] as any).arguments, '{"a": 2}');
});

test('applyHistoryMutations() with no mutations is a no-op', async (t) => {
  const store = new ConversationStore();
  store.addUserMessage('Item');
  const adapter = new ConversationStoreSessionAdapter(store, 'test-session-id');

  await adapter.applyHistoryMutations({ mutations: [] });
  t.is(store.getHistory().length, 1);
  t.is((store.getHistory()[0] as any).content, 'Item');
});
