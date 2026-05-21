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

function waitForDistinctTimestamp() {
  const start = Date.now();
  while (Date.now() - start < 10) {
    // busy wait for 10ms
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

test.serial('generateId: returns a valid UUID', (t) => {
  const id = persistenceModule.generateId();
  t.regex(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test.serial('generateId: returns unique IDs', (t) => {
  const id1 = persistenceModule.generateId();
  const id2 = persistenceModule.generateId();
  t.not(id1, id2);
});

test.serial('getResumeCommand: returns correct format', (t) => {
  const id = 'test-uuid-123';
  const cmd = persistenceModule.getResumeCommand(id);
  t.is(cmd, 'term2 --resume test-uuid-123');
});

test.serial('saveConversation: creates file and last.json pointer', (t) => {
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

test.serial('getConversationsDirForTest: uses isolated test override', (t) => {
  t.is(persistenceModule.getConversationsDirForTest(), testDir);
});

test.serial('saveConversation: normalizes streaming bot messages to finalized', (t) => {
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

test.serial('saveConversation: normalizes pending command messages to completed', (t) => {
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

test.serial('loadConversation: returns null for non-existent id', (t) => {
  const result = persistenceModule.loadConversation('non-existent-id');
  t.is(result, null);
});

test.serial('loadConversation: returns saved conversation', (t) => {
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

test.serial('loadConversation: preserves saved app mode settings', (t) => {
  const id = persistenceModule.generateId();
  const conversation: persistenceModule.SavedConversation = {
    id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    appMode: {
      liteMode: false,
      mentorMode: true,
      planMode: true,
      orchestratorMode: false,
    },
    previousResponseId: null,
    history: [],
    messages: [{ id: 'msg-1', sender: 'user', text: 'hello' }],
  };

  persistenceModule.saveConversation(conversation);
  const loaded = persistenceModule.loadConversation(id);

  t.deepEqual(loaded?.appMode, {
    liteMode: false,
    mentorMode: true,
    planMode: true,
    orchestratorMode: false,
  });
});

test.serial('loadConversation: returns null when saved project path differs from expected path', (t) => {
  const id = persistenceModule.generateId();
  const conversation: persistenceModule.SavedConversation = {
    id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    projectPath: '/workspace/alpha',
    previousResponseId: null,
    history: [],
    messages: [{ id: 'msg-1', sender: 'user', text: 'hello' }],
  };

  persistenceModule.saveConversation(conversation);
  const loaded = persistenceModule.loadConversation(id, '/workspace/beta');

  t.is(loaded, null);
});

test.serial('loadConversationForProject: reports project mismatch for existing conversation in another path', (t) => {
  const id = persistenceModule.generateId();
  const conversation: persistenceModule.SavedConversation = {
    id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    projectPath: '/workspace/alpha',
    previousResponseId: null,
    history: [],
    messages: [{ id: 'msg-1', sender: 'user', text: 'hello' }],
  };

  persistenceModule.saveConversation(conversation);
  const result = persistenceModule.loadConversationForProject(id, '/workspace/beta');

  t.is(result.status, 'project_mismatch');
  if (result.status !== 'project_mismatch') {
    t.fail('expected project_mismatch');
    return;
  }
  t.is(result.conversation.id, id);
});

test.serial('loadConversationForProject: reports not_found for missing conversation', (t) => {
  const result = persistenceModule.loadConversationForProject('missing-id', '/workspace/beta');

  t.is(result.status, 'not_found');
});

test.serial('loadConversation: returns saved conversation when expected project path matches', (t) => {
  const id = persistenceModule.generateId();
  const conversation: persistenceModule.SavedConversation = {
    id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    projectPath: '/workspace/alpha',
    previousResponseId: null,
    history: [],
    messages: [{ id: 'msg-1', sender: 'user', text: 'hello' }],
  };

  persistenceModule.saveConversation(conversation);
  const loaded = persistenceModule.loadConversation(id, '/workspace/alpha');

  t.truthy(loaded);
  t.is(loaded!.id, id);
});

test.serial('loadConversation: unscoped loads keep backward-compatible behavior', (t) => {
  const id = persistenceModule.generateId();
  const conversation: persistenceModule.SavedConversation = {
    id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    projectPath: '/workspace/alpha',
    previousResponseId: null,
    history: [],
    messages: [{ id: 'msg-1', sender: 'user', text: 'hello' }],
  };

  persistenceModule.saveConversation(conversation);
  const loaded = persistenceModule.loadConversation(id);

  t.truthy(loaded);
  t.is(loaded!.id, id);
});

test.serial('loadLastConversation: returns null when no last.json exists', (t) => {
  const result = persistenceModule.loadLastConversation();
  t.is(result, null);
});

test.serial('loadLastConversation: returns the last saved conversation', (t) => {
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

test.serial('loadLastConversation: returns most recent conversation for expected project path', (t) => {
  const projectAOlder = persistenceModule.generateId();
  const projectANewer = persistenceModule.generateId();
  const projectBNewer = persistenceModule.generateId();

  persistenceModule.saveConversation({
    id: projectAOlder,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    projectPath: '/workspace/alpha',
    previousResponseId: null,
    history: [],
    messages: [{ id: 'msg-1', sender: 'user', text: 'alpha older' }],
  });
  waitForDistinctTimestamp();
  persistenceModule.saveConversation({
    id: projectANewer,
    createdAt: '2024-01-02T00:00:00.000Z',
    updatedAt: '2024-01-02T00:00:00.000Z',
    projectPath: '/workspace/alpha',
    previousResponseId: null,
    history: [],
    messages: [{ id: 'msg-2', sender: 'user', text: 'alpha newer' }],
  });
  waitForDistinctTimestamp();
  persistenceModule.saveConversation({
    id: projectBNewer,
    createdAt: '2024-01-03T00:00:00.000Z',
    updatedAt: '2024-01-03T00:00:00.000Z',
    projectPath: '/workspace/beta',
    previousResponseId: null,
    history: [],
    messages: [{ id: 'msg-3', sender: 'user', text: 'beta newer' }],
  });

  const last = persistenceModule.loadLastConversation('/workspace/alpha');

  t.truthy(last);
  t.is(last!.id, projectANewer);
});

test.serial('loadLastConversation: returns null when no conversation matches expected project path', (t) => {
  persistenceModule.saveConversation({
    id: persistenceModule.generateId(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    projectPath: '/workspace/alpha',
    previousResponseId: null,
    history: [],
    messages: [{ id: 'msg-1', sender: 'user', text: 'alpha' }],
  });

  const last = persistenceModule.loadLastConversation('/workspace/beta');

  t.is(last, null);
});

test.serial('deleteConversation: removes the conversation file', (t) => {
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

test.serial('deleteConversation: returns false for non-existent id', (t) => {
  const result = persistenceModule.deleteConversation('non-existent');
  t.false(result);
});

test.serial('listConversations: returns empty array when no conversations exist', (t) => {
  // Ensure dir exists but is empty
  const dir = persistenceModule.getConversationsDirForTest();
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const list = persistenceModule.listConversations();
  t.deepEqual(list, []);
});

test.serial('loadConversation: old save without orchestratorMode — resolves to false, no error', (t) => {
  const id = persistenceModule.generateId();
  // Write a raw JSON file that looks like an old save (missing orchestratorMode)
  const dir = persistenceModule.getConversationsDirForTest();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const rawData = {
    id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    appMode: {
      mentorMode: false,
      liteMode: false,
      planMode: false,
      // orchestratorMode is intentionally absent (old format)
    },
    previousResponseId: null,
    history: [],
    messages: [],
  };
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(rawData, null, 2), 'utf-8');

  // loadConversation should not throw — it returns null on error
  const loaded = persistenceModule.loadConversation(id);
  t.truthy(loaded);
  // orchestratorMode should be absent or false-y, not throw
  const orchestratorMode = loaded?.appMode?.orchestratorMode;
  t.falsy(orchestratorMode, 'orchestratorMode missing from old save should not be truthy');
});

test.serial('loadConversation: save with orchestratorMode: true is correctly restored', (t) => {
  const id = persistenceModule.generateId();
  const conversation: persistenceModule.SavedConversation = {
    id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    appMode: {
      mentorMode: false,
      liteMode: false,
      planMode: false,
      orchestratorMode: true,
    },
    previousResponseId: null,
    history: [],
    messages: [],
  };

  persistenceModule.saveConversation(conversation);
  const loaded = persistenceModule.loadConversation(id);

  t.truthy(loaded);
  t.is(loaded?.appMode?.orchestratorMode, true);
});

test.serial('listConversations: returns conversations sorted by updatedAt descending', (t) => {
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
  waitForDistinctTimestamp();

  // Save conv2 second (should have later updatedAt)
  persistenceModule.saveConversation(conv2);

  const list = persistenceModule.listConversations();
  t.is(list.length, 2);
  t.is(list[0].id, id2); // Most recently saved first
  t.is(list[1].id, id1);
});
