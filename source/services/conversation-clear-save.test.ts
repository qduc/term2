import test from 'ava';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as persistenceModule from './conversation-persistence.js';
import { hasConversationContent } from '../app.js';
import type { Message } from '../hooks/use-conversation.js';

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

test.serial(
  'CLI clear behavior: saves old conversation, starts new in-memory, avoids empty save on exit',
  async (t) => {
    // 1. Initial State
    let effectiveSessionId = 'session-old';
    let effectiveCreatedAt = new Date().toISOString();
    let pendingMessages: Message[] = [{ id: '1', sender: 'user', text: 'hello in old session' }];

    const savedSessionIds = new Set<string>();

    const saveAndPrintResume = async (messages: Message[], overrideSessionId?: string, overrideCreatedAt?: string) => {
      const sessionIdToSave = overrideSessionId || effectiveSessionId;
      const createdAtToSave = overrideCreatedAt || effectiveCreatedAt;

      if (savedSessionIds.has(sessionIdToSave)) {
        return;
      }

      if (!hasConversationContent(messages)) {
        return;
      }
      savedSessionIds.add(sessionIdToSave);

      persistenceModule.saveConversation({
        id: sessionIdToSave,
        createdAt: createdAtToSave,
        updatedAt: new Date().toISOString(),
        projectPath: '/test/project',
        model: 'gpt-4o',
        provider: 'openai',
        previousResponseId: null,
        history: [],
        messages: messages as any[],
      });
    };

    // 2. Perform Clear Action
    // Simulating: onClear / handleClearConversation
    if (hasConversationContent(pendingMessages)) {
      await saveAndPrintResume(pendingMessages, effectiveSessionId, effectiveCreatedAt);
    }

    // Verify old session is saved to disk
    const oldSessionFile = path.join(testDir, 'session-old.json');
    t.true(fs.existsSync(oldSessionFile));
    t.true(savedSessionIds.has('session-old'));

    // Simulate parent onSessionIdChange callback
    const onSessionIdChange = (newId: string, createdAt: string) => {
      effectiveSessionId = newId;
      effectiveCreatedAt = createdAt;
      pendingMessages = []; // Reset pending messages immediately!
    };

    const newId = 'session-new';
    const newCreatedAt = new Date().toISOString();
    onSessionIdChange(newId, newCreatedAt);

    // 3. Verify new session is only in-memory (not written to disk yet)
    const newSessionFile = path.join(testDir, 'session-new.json');
    t.false(fs.existsSync(newSessionFile));
    t.is(effectiveSessionId, 'session-new');
    t.deepEqual(pendingMessages, []);

    // 4. Simulate exit without sending messages in new session
    await saveAndPrintResume(pendingMessages);

    // Verify new session file STILL does not exist (not saved because empty)
    t.false(fs.existsSync(newSessionFile));
    t.false(savedSessionIds.has('session-new'));

    // 5. Send message in new session
    pendingMessages = [{ id: '2', sender: 'user', text: 'first message in new session' }];

    // Simulate exit now that new session has content
    await saveAndPrintResume(pendingMessages);

    // Verify new session is saved to disk
    t.true(fs.existsSync(newSessionFile));
    t.true(savedSessionIds.has('session-new'));

    const savedData = JSON.parse(fs.readFileSync(newSessionFile, 'utf-8'));
    t.is(savedData.messages[0].text, 'first message in new session');
  },
);
