import test from 'ava';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as persistenceModule from './conversation-persistence.js';

let testDir = '';

// Clean up all conversation files before and after each test
function cleanupAll() {
  if (testDir && fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

test.beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-conversations-test-'));
  persistenceModule.setConversationsDirForTest(testDir);
});
test.afterEach.always(cleanupAll);
test.afterEach.always(() => {
  persistenceModule.setConversationsDirForTest(null);
  testDir = '';
});

test('generateId: returns a valid UUID', (t) => {
  const id = persistenceModule.generateId();
  t.regex(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test('generateId: returns unique IDs', (t) => {
  const id1 = persistenceModule.generateId();
  const id2 = persistenceModule.generateId();
  t.not(id1, id2);
});

test('getResumeCommand: returns correct format', (t) => {
  const id = 'test-uuid-123';
  const cmd = persistenceModule.getResumeCommand(id);
  t.is(cmd, 'term2 --resume test-uuid-123');
});

test('saveConversation: creates file and last.json pointer', (t) => {
  const id = persistenceModule.generateId();
  const conversation: persistenceModule.SavedConversation = {
    id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    model: 'gpt-4o',
    previousResponseId: null,
    history: [{ role: 'user', content: 'hello' }],
    messages: [
      { id: 'msg-1', sender: 'user', text: 'hello' },
      { id: 'msg-2', sender: 'bot', text: 'hi there', status: 'finalized' },
    ],
  };

  const filePath = persistenceModule.saveConversation(conversation);
  t.true(fs.existsSync(filePath));

  // Verify last.json was created
  const lastPath = path.join(path.dirname(filePath), 'last.json');
  t.true(fs.existsSync(lastPath));

  const lastData = JSON.parse(fs.readFileSync(lastPath, 'utf-8'));
  t.is(lastData.id, id);

  // Cleanup
  fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
});

test('getConversationsDirForTest: uses isolated test override', (t) => {
  t.is(persistenceModule.getConversationsDirForTest(), testDir);
});

test('saveConversation: normalizes streaming bot messages to finalized', (t) => {
  const id = persistenceModule.generateId();
  const conversation: persistenceModule.SavedConversation = {
    id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    previousResponseId: null,
    history: [],
    messages: [
      { id: 'msg-1', sender: 'user', text: 'hello' },
      { id: 'msg-2', sender: 'bot', text: 'thinking...', status: 'streaming' },
    ],
  };

  const filePath = persistenceModule.saveConversation(conversation);
  const saved = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  t.is(saved.messages[1].status, 'finalized');

  // Cleanup
  fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
});

test('saveConversation: normalizes pending command messages to completed', (t) => {
  const id = persistenceModule.generateId();
  const conversation: persistenceModule.SavedConversation = {
    id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    previousResponseId: null,
    history: [],
    messages: [{ id: 'msg-1', sender: 'command', status: 'pending', command: 'ls', toolName: 'shell' }],
  };

  const filePath = persistenceModule.saveConversation(conversation);
  const saved = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  t.is(saved.messages[0].status, 'completed');
  t.is(saved.messages[0].success, false);

  // Cleanup
  fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
});

test('loadConversation: returns null for non-existent id', (t) => {
  const result = persistenceModule.loadConversation('non-existent-id');
  t.is(result, null);
});

test('loadConversation: returns saved conversation', (t) => {
  const id = persistenceModule.generateId();
  const conversation: persistenceModule.SavedConversation = {
    id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    model: 'gpt-4o',
    previousResponseId: 'resp-123',
    history: [{ role: 'user', content: 'hello' }],
    messages: [{ id: 'msg-1', sender: 'user', text: 'hello' }],
  };

  persistenceModule.saveConversation(conversation);
  const loaded = persistenceModule.loadConversation(id);

  t.truthy(loaded);
  t.is(loaded!.id, id);
  t.is(loaded!.model, 'gpt-4o');
  t.is(loaded!.previousResponseId, 'resp-123');
  t.is(loaded!.messages.length, 1);

  // Cleanup
  const filePath = path.join(persistenceModule.getConversationsDirForTest(), `${id}.json`);
  fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
});

test('loadLastConversation: returns null when no last.json exists', (t) => {
  const result = persistenceModule.loadLastConversation();
  t.is(result, null);
});

test('loadLastConversation: returns the last saved conversation', (t) => {
  const id1 = persistenceModule.generateId();
  const id2 = persistenceModule.generateId();

  const conv1: persistenceModule.SavedConversation = {
    id: id1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    previousResponseId: null,
    history: [],
    messages: [{ id: 'msg-1', sender: 'user', text: 'first' }],
  };

  const conv2: persistenceModule.SavedConversation = {
    id: id2,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    previousResponseId: null,
    history: [],
    messages: [{ id: 'msg-2', sender: 'user', text: 'second' }],
  };

  persistenceModule.saveConversation(conv1);
  persistenceModule.saveConversation(conv2);

  const last = persistenceModule.loadLastConversation();
  t.truthy(last);
  t.is(last!.id, id2);

  // Cleanup
  fs.rmSync(persistenceModule.getConversationsDirForTest(), { recursive: true, force: true });
});

test('deleteConversation: removes the conversation file', (t) => {
  const id = persistenceModule.generateId();
  const conversation: persistenceModule.SavedConversation = {
    id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    previousResponseId: null,
    history: [],
    messages: [],
  };

  persistenceModule.saveConversation(conversation);
  const result = persistenceModule.deleteConversation(id);

  t.true(result);
  t.is(persistenceModule.loadConversation(id), null);

  // Cleanup
  fs.rmSync(persistenceModule.getConversationsDirForTest(), { recursive: true, force: true });
});

test('deleteConversation: returns false for non-existent id', (t) => {
  const result = persistenceModule.deleteConversation('non-existent');
  t.false(result);
});

test('listConversations: returns empty array when no conversations exist', (t) => {
  // Ensure dir exists but is empty
  const dir = persistenceModule.getConversationsDirForTest();
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const list = persistenceModule.listConversations();
  t.deepEqual(list, []);
});

test('listConversations: returns conversations sorted by updatedAt descending', (t) => {
  const id1 = persistenceModule.generateId();
  const id2 = persistenceModule.generateId();

  const conv1: persistenceModule.SavedConversation = {
    id: id1,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    previousResponseId: null,
    history: [],
    messages: [],
  };

  const conv2: persistenceModule.SavedConversation = {
    id: id2,
    createdAt: '2024-01-02T00:00:00.000Z',
    updatedAt: '2024-01-02T00:00:00.000Z',
    previousResponseId: null,
    history: [],
    messages: [],
  };

  // Save conv1 first
  persistenceModule.saveConversation(conv1);

  // Wait a moment so updatedAt differs
  const start = Date.now();
  while (Date.now() - start < 10) {
    // busy wait for 10ms
  }

  // Save conv2 second (should have later updatedAt)
  persistenceModule.saveConversation(conv2);

  const list = persistenceModule.listConversations();
  t.is(list.length, 2);
  t.is(list[0].id, id2); // Most recently saved first
  t.is(list[1].id, id1);
});
