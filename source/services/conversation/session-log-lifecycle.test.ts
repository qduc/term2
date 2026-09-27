import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { decodeLogEnvelope } from './conversation-decoder.js';
import { createConversationLogWriter } from '../logging/conversation-log-writer.js';
import { replayEvents } from './conversation-replay.js';
import { loadLastConversation, saveLastConversation, setConversationsDirForTest } from './conversation-persistence.js';
import { rotateSessionLog } from './session-log-lifecycle.js';

const dirs: string[] = [];
const logger = { error: vi.fn() } as never;

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-goal-rollover-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  setConversationsDirForTest(null);
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});

function readEvents(dir: string, id: string) {
  return fs
    .readFileSync(path.join(dir, `${id}.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .map((line) => decodeLogEnvelope(JSON.parse(line)))
    .filter((envelope) => envelope !== null);
}

it.each([{ status: 'active' as const }, { status: 'achieved' as const }, { status: 'abandoned' as const }])(
  'persists the $status goal in the successor before completing rotation',
  async ({ status }) => {
    const dir = tempDir();
    const sourceId = 'source-session';
    const successorId = 'successor-session';
    const goal = { id: `goal-${status}`, outcome: 'Durable objective', status };
    const writer = createConversationLogWriter({ sessionId: sourceId, dir, logger });
    writer.init({ id: sourceId, createdAt: '2026-09-27T00:00:00.000Z' });
    writer.append({ type: 'goal_changed', version: 1, goal });

    rotateSessionLog(
      writer,
      successorId,
      { id: successorId, createdAt: '2026-09-27T00:01:00.000Z', rolloverFrom: sourceId },
      goal,
    );
    await writer.close();

    const sourceEvents = readEvents(dir, sourceId);
    const successorEvents = readEvents(dir, successorId);
    expect(sourceEvents.map(({ event }) => event.type)).toEqual(['session_init', 'goal_changed', 'session_cleared']);
    expect(successorEvents.map(({ event }) => event.type)).toEqual(['session_init', 'goal_changed']);
    expect(successorEvents[0]?.event).toMatchObject({ id: successorId, rolloverFrom: sourceId });
    expect(replayEvents(successorEvents).goal).toEqual(goal);
  },
);

it('rejects failed goal transfer after rotation so caller cannot commit the successor', async () => {
  const dir = tempDir();
  const sourceId = 'source-failure';
  const successorId = 'successor-failure';
  const goal = { id: 'goal-failure', outcome: 'Do not lose me', status: 'active' as const };
  const writer = createConversationLogWriter({ sessionId: sourceId, dir, logger });
  writer.init({ id: sourceId, createdAt: '2026-09-27T00:00:00.000Z' });
  writer.append({ type: 'goal_changed', version: 1, goal });
  const failingWriter = {
    ...writer,
    append: writer.append.bind(writer),
    rotate: (
      newId: string,
      meta: Parameters<typeof writer.rotate>[1],
      initialEvents?: Parameters<typeof writer.rotate>[2],
    ) => {
      writer.rotate(newId, meta);
      if (initialEvents?.some((event) => event.type === 'goal_changed')) throw new Error('goal fsync failed');
    },
  };

  expect(() =>
    rotateSessionLog(
      failingWriter,
      successorId,
      { id: successorId, createdAt: '2026-09-27T00:01:00.000Z', rolloverFrom: sourceId },
      goal,
    ),
  ).toThrow('goal fsync failed');
  await writer.close();

  const sourceEvents = readEvents(dir, sourceId);
  const successorEvents = readEvents(dir, successorId);
  expect(sourceEvents.map(({ event }) => event.type)).toEqual(['session_init', 'goal_changed', 'session_cleared']);
  expect(successorEvents.map(({ event }) => event.type)).toEqual(['session_init']);
  expect(replayEvents(successorEvents).goal).toBeUndefined();
});

it('keeps default resume on the source when successor goal durability fails, including after close', async () => {
  const dir = tempDir();
  setConversationsDirForTest(dir);
  const sourceId = 'source-last-pointer';
  const successorId = 'successor-last-pointer';
  const goal = { id: 'goal-last-pointer', outcome: 'Resume must keep this', status: 'active' as const };
  const fsyncError = new Error('successor goal fsync failed');
  const saveLastCalls: string[] = [];
  let goalWritePending = false;
  const fileSystem = {
    ...fs,
    writeSync: ((...args: Parameters<typeof fs.writeSync>) => {
      if (
        typeof args[1] === 'string' &&
        args[1].includes(`"logId":"${successorId}"`) &&
        args[1].includes('goal_changed')
      ) {
        goalWritePending = true;
      }
      return (fs.writeSync as (...inner: Parameters<typeof fs.writeSync>) => number)(...args);
    }) as typeof fs.writeSync,
    fsyncSync(fd: number) {
      if (goalWritePending) {
        goalWritePending = false;
        throw fsyncError;
      }
      fs.fsyncSync(fd);
    },
  };
  const writer = createConversationLogWriter({
    sessionId: sourceId,
    dir,
    logger,
    fileSystem,
    saveLast: (id, projectPath, sshHost) => {
      saveLastCalls.push(id);
      saveLastConversation(id, projectPath, sshHost);
    },
  });
  writer.init({ id: sourceId, createdAt: '2026-09-27T00:00:00.000Z' });
  writer.append({ type: 'goal_changed', version: 1, goal });
  expect(loadLastConversation()?.id).toBe(sourceId);

  expect(() =>
    rotateSessionLog(
      writer,
      successorId,
      { id: successorId, createdAt: '2026-09-27T00:01:00.000Z', rolloverFrom: sourceId },
      goal,
    ),
  ).toThrow(fsyncError);
  expect(saveLastCalls).not.toContain(successorId);
  expect(loadLastConversation()?.id).toBe(sourceId);
  await expect(writer.close()).rejects.toBe(fsyncError);
  expect(saveLastCalls).not.toContain(successorId);
  expect(loadLastConversation()?.id).toBe(sourceId);
  expect(loadLastConversation()?.goal).toEqual(goal);
});
