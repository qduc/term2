import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { decodeLogEnvelope } from './conversation-decoder.js';
import { createConversationLogWriter } from '../logging/conversation-log-writer.js';
import { replayEvents } from './conversation-replay.js';
import { rotateSessionLog } from './session-log-lifecycle.js';

const dirs: string[] = [];
const logger = { error: vi.fn() } as never;

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-goal-rollover-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
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
    append: (event: Parameters<typeof writer.append>[0]) => {
      if (event.type === 'goal_changed') throw new Error('goal fsync failed');
      writer.append(event);
    },
    rotate: writer.rotate.bind(writer),
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
