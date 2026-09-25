import { it, describe, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as persistence from './conversation-persistence.js';
import { createConversationLogWriter } from '../logging/conversation-log-writer.js';
import type { SessionIndexWorkerClient } from './session-index/session-index-worker-client.js';
import {
  DEFAULT_RECENT_CONVERSATIONS_LIMIT,
  listRecentConversations,
  type RecentConversationsOptions,
} from './recent-conversations.js';

const stubLogger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
  getCorrelationId: () => undefined,
} as any;

let testDir = '';

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-recent-conversations-'));
  persistence.setConversationsDirForTest(testDir);
});

afterEach(() => {
  persistence.setConversationsDirForTest(null);
  fs.rmSync(testDir, { recursive: true, force: true });
  testDir = '';
});

type SessionOptions = {
  text?: string;
  sshHost?: string;
  model?: string;
  activeProfileId?: string;
  mtime?: Date;
};

async function writeSession(id: string, projectPath: string, options: SessionOptions = {}): Promise<void> {
  const writer = createConversationLogWriter({ sessionId: id, dir: testDir, logger: stubLogger });
  writer.init({
    id,
    createdAt: '2026-01-01T00:00:00.000Z',
    projectPath,
    ...(options.sshHost ? { sshHost: options.sshHost } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options.activeProfileId ? { activeProfileId: options.activeProfileId } : {}),
  });
  writer.append({
    type: 'user_message',
    message: { id: `${id}-u`, sender: 'user', text: options.text ?? 'first prompt' },
  });
  writer.append({
    type: 'assistant_turn',
    turn: { items: [{ type: 'assistant_text', text: 'response' }] },
    state: { previousResponseId: null },
  });
  await writer.close();
  if (options.mtime) {
    fs.utimesSync(path.join(testDir, `${id}.jsonl`), options.mtime, options.mtime);
  }
}

/**
 * A stand-in for the worker client: tests that need to prove which path ran
 * inject it, so no real worker thread is started.
 */
function fakeClient(overrides: {
  listConversationsInDirectory?: SessionIndexWorkerClient['listConversationsInDirectory'];
  close?: SessionIndexWorkerClient['close'];
}): SessionIndexWorkerClient {
  return {
    listConversationsInDirectory: overrides.listConversationsInDirectory ?? (async () => []),
    close: overrides.close ?? (async () => {}),
  } as unknown as SessionIndexWorkerClient;
}

describe('listConversationsInDirectory', () => {
  it.sequential('lists the given directory, independent of the process override', async () => {
    const overrideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-recent-override-'));
    const id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    try {
      await writeSession(id, '/workspace/p1', { text: 'primitive prompt' });
      persistence.setConversationsDirForTest(overrideDir);

      const entries = persistence.listConversationsInDirectory(testDir, '/workspace/p1');

      expect(entries.map((entry) => entry.id)).toEqual([id]);
      expect(entries[0]).toMatchObject({ projectPath: '/workspace/p1', firstUserMessage: 'primitive prompt' });
    } finally {
      persistence.setConversationsDirForTest(testDir);
      fs.rmSync(overrideDir, { recursive: true, force: true });
    }
  });

  it.sequential('returns an empty list for a missing directory', () => {
    expect(persistence.listConversationsInDirectory(path.join(testDir, 'does-not-exist'))).toEqual([]);
  });
});

describe('listRecentConversations', () => {
  it.sequential('matches listConversations for project/SSH scope, ordering, shortRefs, and metadata', async () => {
    const alpha = '11111111-1111-4111-8111-111111111111';
    const beta = '22222222-2222-4222-8222-222222222222';
    const gamma = '33333333-3333-4333-8333-333333333333';
    await writeSession(alpha, '/workspace/p1', {
      text: 'alpha opener',
      model: 'model-a',
      activeProfileId: 'builtin:mentor',
      mtime: new Date('2026-01-01T00:00:00.000Z'),
    });
    await writeSession(beta, '/workspace/p1', {
      text: 'beta opener',
      sshHost: 'host1',
      mtime: new Date('2026-02-01T00:00:00.000Z'),
    });
    await writeSession(gamma, '/workspace/p2', {
      text: 'gamma opener',
      mtime: new Date('2026-03-01T00:00:00.000Z'),
    });

    // Unscoped, scoped, and SSH-scoped listings must carry the exact entries,
    // ordering, shortRefs, and metadata the synchronous API produces.
    expect(await listRecentConversations(undefined, undefined, 100)).toEqual(persistence.listConversations());
    expect(await listRecentConversations('/workspace/p1', undefined, 100)).toEqual(
      persistence.listConversations('/workspace/p1'),
    );
    expect(await listRecentConversations('/workspace/p1', 'host1', 100)).toEqual(
      persistence.listConversations('/workspace/p1', 'host1'),
    );

    // Ordering and metadata survive the round trip (most recent first).
    const all = await listRecentConversations(undefined, undefined, 100);
    expect(all.map((entry) => entry.id)).toEqual([gamma, beta, alpha]);
    expect(all[0]).toMatchObject({ id: gamma, projectPath: '/workspace/p2' });
    expect(all[1]).toMatchObject({ id: beta, sshHost: 'host1' });
    expect(all[2]).toMatchObject({ id: alpha, activeProfileId: 'builtin:mentor', model: 'model-a' });
    expect(all.every((entry) => typeof entry.shortRef === 'string' && entry.shortRef.length > 0)).toBe(true);
  });

  it.sequential('respects an explicit limit as a prefix of the full canonical listing', async () => {
    const first = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const second = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    await writeSession(first, '/workspace/p1', { mtime: new Date('2026-01-01T00:00:00.000Z') });
    await writeSession(second, '/workspace/p1', { mtime: new Date('2026-02-01T00:00:00.000Z') });

    const limited = await listRecentConversations('/workspace/p1', undefined, 1);
    expect(limited).toEqual(persistence.listConversations('/workspace/p1').slice(0, 1));
    expect(limited.map((entry) => entry.id)).toEqual([second]);
  });

  it.sequential('resolves through the off-main-thread worker client by default', async () => {
    const sentinel = [{ id: 'sentinel', updatedAt: '2026-01-01T00:00:00.000Z' }];
    let closed = false;
    const options: RecentConversationsOptions = {
      createClient: () =>
        fakeClient({
          listConversationsInDirectory: async () => sentinel,
          close: async () => {
            closed = true;
          },
        }),
    };

    const result = await listRecentConversations('/workspace/p1', undefined, 5, options);

    expect(result).toEqual(sentinel);
    expect(closed).toBe(true);
  });

  it.sequential('caps the result at the default limit when no limit is given', async () => {
    const many = Array.from({ length: DEFAULT_RECENT_CONVERSATIONS_LIMIT + 3 }, (_, index) => ({
      id: `session-${index}`,
      updatedAt: '2026-01-01T00:00:00.000Z',
    }));
    const listInWorker = vi.fn(async () => many);
    const options: RecentConversationsOptions = {
      createClient: () => fakeClient({ listConversationsInDirectory: listInWorker }),
    };

    const result = await listRecentConversations('/workspace/p1', undefined, undefined, options);

    expect(DEFAULT_RECENT_CONVERSATIONS_LIMIT).toBe(10);
    expect(result).toHaveLength(DEFAULT_RECENT_CONVERSATIONS_LIMIT);
    expect(result).toEqual(many.slice(0, DEFAULT_RECENT_CONVERSATIONS_LIMIT));
    expect(listInWorker).toHaveBeenCalledWith(testDir, '/workspace/p1', undefined, DEFAULT_RECENT_CONVERSATIONS_LIMIT);
  });

  it.sequential('migrates legacy logs before listing through the worker', async () => {
    const dbDir = path.join(testDir, 'data');
    const logDir = path.join(testDir, 'legacy');
    fs.mkdirSync(logDir);
    const oldDb = process.env['TERM2_TEST_DB_DIR'];
    const oldLog = process.env['TERM2_TEST_LOG_DIR'];
    const oldConversations = process.env['TERM2_CONVERSATIONS_DIR'];
    const id = 'abababab-abab-4aba-8aba-abababababab';
    await writeSession(id, '/workspace/p1');
    fs.renameSync(path.join(testDir, `${id}.jsonl`), path.join(logDir, `${id}.jsonl`));
    persistence.setConversationsDirForTest(null);
    process.env['TERM2_TEST_DB_DIR'] = dbDir;
    process.env['TERM2_TEST_LOG_DIR'] = logDir;
    process.env['TERM2_CONVERSATIONS_DIR'] = dbDir;
    try {
      const listed = await listRecentConversations('/workspace/p1');
      expect(listed.map((entry) => entry.id)).toEqual([id]);
      expect(fs.existsSync(path.join(dbDir, '.migrated-from-log'))).toBe(true);
    } finally {
      persistence.setConversationsDirForTest(testDir);
      for (const [key, oldValue] of [
        ['TERM2_TEST_DB_DIR', oldDb],
        ['TERM2_TEST_LOG_DIR', oldLog],
        ['TERM2_CONVERSATIONS_DIR', oldConversations],
      ] as const) {
        if (oldValue === undefined) delete process.env[key];
        else process.env[key] = oldValue;
      }
    }
  });

  it.sequential('falls back to in-process canonical listing when the worker is unavailable', async () => {
    const id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    await writeSession(id, '/workspace/p1', { text: 'fallback prompt' });
    const expected = persistence.listConversations('/workspace/p1');

    const whenFactoryThrows = await listRecentConversations('/workspace/p1', undefined, 100, {
      createClient: () => {
        throw new Error('worker threads unavailable');
      },
    });
    expect(whenFactoryThrows).toEqual(expected);

    let forcedClose = false;
    const whenRequestRejects = await listRecentConversations('/workspace/p1', undefined, 100, {
      createClient: () =>
        fakeClient({
          listConversationsInDirectory: async () => {
            throw new Error('worker request failed');
          },
          close: async (options) => {
            forcedClose = options?.force === true;
          },
        }),
    });
    expect(whenRequestRejects).toEqual(expected);
    expect(forcedClose).toBe(true);
  });
});
