import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeLogEnvelope } from '../conversation/conversation-decoder.js';
import { replayEvents } from '../conversation/conversation-replay.js';
import { createConversationLogWriter } from './conversation-log-writer.js';

const dirs: string[] = [];
const logger = { error: vi.fn() } as never;

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-writer-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.clearAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('ConversationLogWriter sequence continuity', () => {
  it('continues sequence numbers when reopening a log with legacy and malformed trailing records', async () => {
    const dir = tempDir();
    const sessionId = 'resumed-session';
    const filePath = path.join(dir, `${sessionId}.jsonl`);
    const firstWriter = createConversationLogWriter({ sessionId, dir, logger, saveLast: vi.fn() });

    firstWriter.init({ id: sessionId, createdAt: '2026-06-01T00:00:00.000Z' });
    firstWriter.append({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'before resume' } });
    await firstWriter.close();
    fs.appendFileSync(
      filePath,
      `${JSON.stringify({ event: { type: 'settings_changed', key: 'legacy', value: true } })}\n{"v":3,"seq":999`,
    );

    const resumedWriter = createConversationLogWriter({ sessionId, dir, logger, saveLast: vi.fn() });
    resumedWriter.init({ id: sessionId, createdAt: '2026-06-01T00:01:00.000Z' });
    resumedWriter.append({ type: 'settings_changed', key: 'agent.model', value: 'gpt-5' });
    await resumedWriter.close();

    const envelopes = fs
      .readFileSync(filePath, 'utf8')
      .split('\n')
      .map((line) => {
        try {
          return decodeLogEnvelope(JSON.parse(line));
        } catch {
          return null;
        }
      })
      .filter((envelope) => envelope !== null);
    const sequenced = envelopes.map((envelope) => envelope.seq).filter((seq) => seq > 0);

    expect(sequenced).toEqual([1, 2, 3, 4]);
    expect(sequenced.every((seq, index) => index === 0 || seq > sequenced[index - 1]!)).toBe(true);
    expect(replayEvents(envelopes).messages[0]).toMatchObject({ id: 'u1', text: 'before resume' });
  });
});

describe('ConversationLogWriter durability failures', () => {
  it('surfaces a critical fsync failure, latches it, and does not advance last conversation', async () => {
    const durabilityError = new Error('disk fsync failed');
    let fsyncCalls = 0;
    const fileSystem = {
      ...fs,
      fsyncSync(fd: number) {
        fsyncCalls += 1;
        if (fsyncCalls === 3) throw durabilityError;
        fs.fsyncSync(fd);
      },
    };
    const saveLast = vi.fn();
    const writer = createConversationLogWriter({
      sessionId: 'failed-session',
      dir: tempDir(),
      logger,
      fileSystem,
      saveLast,
    });

    writer.init({ id: 'failed-session', createdAt: '2026-06-01T00:00:00.000Z' });
    expect(() => writer.append({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'hello' } })).toThrow(
      durabilityError,
    );
    expect(saveLast).toHaveBeenCalledTimes(1);

    expect(() => writer.append({ type: 'settings_changed', key: 'agent.model', value: 'gpt-5' })).toThrow(
      durabilityError,
    );
    await expect(writer.flush()).rejects.toBe(durabilityError);
    await expect(writer.close()).rejects.toBe(durabilityError);
    expect(saveLast).toHaveBeenCalledTimes(1);
  });

  it('rotate cleans up and latches an fsync failure without starting the new session', async () => {
    const rotateError = new Error('rotate fsync failed');
    const dir = tempDir();
    let fsyncCalls = 0;
    let closeCalls = 0;
    const fileSystem = {
      ...fs,
      fsyncSync(fd: number) {
        fsyncCalls += 1;
        if (fsyncCalls === 3) throw rotateError;
        fs.fsyncSync(fd);
      },
      closeSync(fd: number) {
        closeCalls += 1;
        fs.closeSync(fd);
      },
    };
    const writer = createConversationLogWriter({
      sessionId: 'old-session',
      dir,
      logger,
      fileSystem,
      saveLast: vi.fn(),
    });
    writer.init({ id: 'old-session', createdAt: '2026-06-01T00:00:00.000Z' });
    const closesBeforeRotate = closeCalls;

    expect(() => writer.rotate('new-session', { id: 'new-session', createdAt: '2026-06-02T00:00:00.000Z' })).toThrow(
      rotateError,
    );

    expect(closeCalls).toBe(closesBeforeRotate + 1);
    expect(fs.existsSync(path.join(dir, 'old-session.lock'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'new-session.jsonl'))).toBe(false);
    expect(writer.sessionId).toBe('old-session');
    expect(() => writer.append({ type: 'settings_changed', key: 'agent.model', value: 'gpt-5' })).toThrow(rotateError);
    await expect(writer.flush()).rejects.toBe(rotateError);
    await expect(writer.close()).rejects.toBe(rotateError);
  });

  it('rotate latches a close failure after releasing the old lock without starting the new session', async () => {
    const rotateError = new Error('rotate close failed');
    const dir = tempDir();
    let closeCalls = 0;
    const fileSystem = {
      ...fs,
      closeSync(fd: number) {
        closeCalls += 1;
        if (closeCalls === 2) throw rotateError;
        fs.closeSync(fd);
      },
    };
    const writer = createConversationLogWriter({
      sessionId: 'old-session',
      dir,
      logger,
      fileSystem,
      saveLast: vi.fn(),
    });
    writer.init({ id: 'old-session', createdAt: '2026-06-01T00:00:00.000Z' });

    expect(() => writer.rotate('new-session', { id: 'new-session', createdAt: '2026-06-02T00:00:00.000Z' })).toThrow(
      rotateError,
    );

    expect(fs.existsSync(path.join(dir, 'old-session.lock'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'new-session.jsonl'))).toBe(false);
    expect(writer.sessionId).toBe('old-session');
    expect(() => writer.append({ type: 'settings_changed', key: 'agent.model', value: 'gpt-5' })).toThrow(rotateError);
    await expect(writer.flush()).rejects.toBe(rotateError);
    await expect(writer.close()).rejects.toBe(rotateError);
  });

  it('preserves a critical write failure when close cleanup also fails', async () => {
    const writeError = new Error('disk write failed');
    const cleanupError = new Error('close failed');
    let logWrites = 0;
    const fileSystem = {
      ...fs,
      writeSync: ((...args: Parameters<typeof fs.writeSync>) => {
        if (typeof args[1] === 'string' && args[1].includes('"type":"user_message"')) {
          logWrites += 1;
          throw writeError;
        }
        return (fs.writeSync as (...inner: Parameters<typeof fs.writeSync>) => number)(...args);
      }) as typeof fs.writeSync,
      closeSync(fd: number) {
        if (logWrites > 0) throw cleanupError;
        fs.closeSync(fd);
      },
    };
    const writer = createConversationLogWriter({
      sessionId: 'write-failure',
      dir: tempDir(),
      logger,
      fileSystem,
      saveLast: vi.fn(),
    });

    writer.init({ id: 'write-failure', createdAt: '2026-06-01T00:00:00.000Z' });
    expect(() => writer.append({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'hello' } })).toThrow(
      writeError,
    );
    await expect(writer.close()).rejects.toBe(writeError);
  });
});
