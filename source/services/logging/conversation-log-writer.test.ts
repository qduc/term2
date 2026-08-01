import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
