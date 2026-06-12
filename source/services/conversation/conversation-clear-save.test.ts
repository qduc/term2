import test from 'ava';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as persistenceModule from './conversation-persistence.js';
import { createConversationLogWriter } from '../logging/conversation-log-writer.js';

const stubLogger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
  getCorrelationId: () => undefined,
} as any;

let testDir = '';

test.beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-cli-clear-test-'));
  persistenceModule.setConversationsDirForTest(testDir);
});

test.afterEach.always(() => {
  if (testDir && fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
  persistenceModule.setConversationsDirForTest(null);
  testDir = '';
});

test.serial('clear rotates writer: old session file remains, new file begins fresh', async (t) => {
  const oldId = persistenceModule.generateId();
  const writer = createConversationLogWriter({ sessionId: oldId, dir: testDir, logger: stubLogger });
  writer.init({ id: oldId, createdAt: '2026-05-26T00:00:00.000Z', projectPath: '/test/project' });
  writer.append({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'hello in old session' } });
  writer.append({
    type: 'assistant_turn',
    turn: { items: [{ type: 'assistant_text', text: 'reply' }] },
    state: { previousResponseId: 'r1' },
  });

  const oldPath = path.join(testDir, `${oldId}.jsonl`);
  t.true(fs.existsSync(oldPath));

  // Rotate (simulates /clear)
  const newId = persistenceModule.generateId();
  writer.append({ type: 'session_cleared' });
  writer.rotate(newId, { id: newId, createdAt: '2026-05-26T00:01:00.000Z' });

  const newPath = path.join(testDir, `${newId}.jsonl`);
  t.true(fs.existsSync(newPath));
  t.true(fs.existsSync(oldPath));

  // Old session is resumable
  const restored = persistenceModule.loadConversation(oldId);
  t.truthy(restored);
  t.is(restored!.previousResponseId, 'r1');

  // New file has no assistant turn yet → empty restored state
  const newRestored = persistenceModule.loadConversation(newId);
  t.is(newRestored!.previousResponseId, null);
  t.is(newRestored!.messages.length, 0);

  await writer.close();
});
