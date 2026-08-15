import fs from 'fs';
import os from 'os';
import path from 'path';
import { expect, it } from 'vitest';
import type { PersistedQueueV1 } from '../queue/queue-controller.js';
import { getConversationsDirForTest, setConversationsDirForTest } from './conversation-persistence.js';
import { createSessionQueuePersistence } from './queue-persistence.js';

const record: PersistedQueueV1<{ model: string }> = {
  version: 1,
  nextSequence: 2,
  queue: [{ id: 'queued-1', text: 'retained', sequence: 1, submittedAt: '2026-01-01T00:00:00.000Z' }],
  pause: { reason: 'manual' },
};

function withIsolatedConversationsDir<T>(run: (directory: string) => T): T {
  const previousDirectory = getConversationsDirForTest();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-queue-persistence-test-'));
  setConversationsDirForTest(directory);
  try {
    return run(directory);
  } finally {
    setConversationsDirForTest(previousDirectory);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

it.sequential('load returns null when the session queue sidecar is absent', () => {
  withIsolatedConversationsDir(() => {
    const persistence = createSessionQueuePersistence<{ model: string }>('missing-session');

    expect(persistence.load()).toBeNull();
  });
});

it.sequential('replace atomically writes the complete record and cleans its temporary file', () => {
  withIsolatedConversationsDir((directory) => {
    const sessionId = 'session-1';
    const persistence = createSessionQueuePersistence<{ model: string }>(sessionId);

    persistence.replace(record);

    expect(persistence.load()).toEqual(record);
    expect(fs.readFileSync(path.join(directory, `${sessionId}.queue.json`), 'utf8')).toBe(JSON.stringify(record));
    expect(fs.readdirSync(directory).filter((file) => file.endsWith('.tmp'))).toEqual([]);
  });
});

it.sequential('quarantine moves the live sidecar off the load path', () => {
  withIsolatedConversationsDir((directory) => {
    const sessionId = 'session-2';
    const persistence = createSessionQueuePersistence<{ model: string }>(sessionId);
    persistence.replace(record);

    persistence.quarantine?.();

    expect(persistence.load()).toBeNull();
    expect(fs.readdirSync(directory)).toEqual([expect.stringMatching(/^session-2\.queue\.json\.invalid-/)]);
  });
});
