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

function readSeqs(filePath: string): number[] {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return decodeLogEnvelope(JSON.parse(line));
      } catch {
        return null;
      }
    })
    .filter((envelope) => envelope !== null)
    .map((envelope) => envelope.seq);
}

function readEventTypes(filePath: string): string[] {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return decodeLogEnvelope(JSON.parse(line))?.event?.type ?? null;
      } catch {
        return null;
      }
    })
    .filter((type): type is string => type !== null);
}

describe('ConversationLogWriter delta sidecar', () => {
  it('keeps streaming deltas out of the canonical log and drops the sidecar on a settled close', async () => {
    const dir = tempDir();
    const sessionId = 'settled-session';
    const writer = createConversationLogWriter({ sessionId, dir, logger, saveLast: vi.fn() });

    writer.init({ id: sessionId, createdAt: '2026-06-01T00:00:00.000Z' });
    writer.append({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'hello' } });
    writer.append({ type: 'assistant_journal_delta', turnId: 't1', seq: 1, kind: 'text', delta: 'partial ' });
    writer.append({ type: 'assistant_journal_delta', turnId: 't1', seq: 2, kind: 'text', delta: 'answer' });
    writer.append({ type: 'assistant_turn', turn: { items: [{ type: 'assistant_text', text: 'partial answer' }] } });

    // Mirrors real shutdown: conversationService.shutdown() appends background
    // shell / subagent settlement events after the final turn, before close().
    writer.append({ type: 'background_shell_completed', jobId: 'j1', exitCode: 0 } as never);
    await writer.close();

    const canonical = path.join(dir, `${sessionId}.jsonl`);
    expect(readEventTypes(canonical)).not.toContain('assistant_journal_delta');
    expect(fs.existsSync(path.join(dir, `${sessionId}.deltas`))).toBe(false);
  });

  it('retains the sidecar when the session closes with an unsettled turn', async () => {
    const dir = tempDir();
    const sessionId = 'interrupted-session';
    const writer = createConversationLogWriter({ sessionId, dir, logger, saveLast: vi.fn() });

    writer.init({ id: sessionId, createdAt: '2026-06-01T00:00:00.000Z' });
    writer.append({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'hello' } });
    writer.append({ type: 'assistant_journal_delta', turnId: 't1', seq: 1, kind: 'text', delta: 'half-w' });
    await writer.close();

    const sidecar = path.join(dir, `${sessionId}.deltas`);
    expect(fs.existsSync(sidecar)).toBe(true);
    expect(readEventTypes(sidecar)).toEqual(['assistant_journal_delta']);
  });

  it('creates no sidecar for a session that never streams a delta', async () => {
    const dir = tempDir();
    const sessionId = 'quiet-session';
    const writer = createConversationLogWriter({ sessionId, dir, logger, saveLast: vi.fn() });

    writer.init({ id: sessionId, createdAt: '2026-06-01T00:00:00.000Z' });
    writer.append({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'hello' } });
    writer.append({ type: 'assistant_turn', turn: { items: [{ type: 'assistant_text', text: 'hi' }] } });
    await writer.close();

    expect(fs.existsSync(path.join(dir, `${sessionId}.deltas`))).toBe(false);
  });

  it('uses a sidecar name that the conversations *.jsonl glob does not match', async () => {
    const dir = tempDir();
    const sessionId = 'glob-session';
    const writer = createConversationLogWriter({ sessionId, dir, logger, saveLast: vi.fn() });

    writer.init({ id: sessionId, createdAt: '2026-06-01T00:00:00.000Z' });
    writer.append({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'hello' } });
    writer.append({ type: 'assistant_journal_delta', turnId: 't1', seq: 1, kind: 'text', delta: 'x' });
    await writer.close();

    // listConversations enumerates with readdirSync(...).filter(f => f.endsWith('.jsonl')).
    // A sidecar caught by that glob would appear as a phantom conversation.
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'))).toEqual([`${sessionId}.jsonl`]);
  });

  it('resumes sequence numbering past a sidecar-dominant tail after a crash', async () => {
    const dir = tempDir();
    const sessionId = 'crashed-session';
    const first = createConversationLogWriter({ sessionId, dir, logger, saveLast: vi.fn() });

    first.init({ id: sessionId, createdAt: '2026-06-01T00:00:00.000Z' });
    first.append({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'hello' } });
    // Deltas dominate, so the high-water sequence number lives in the sidecar.
    for (let i = 0; i < 5; i++) {
      first.append({ type: 'assistant_journal_delta', turnId: 't1', seq: i, kind: 'text', delta: `d${i}` });
    }
    await first.close();

    const sidecar = path.join(dir, `${sessionId}.deltas`);
    const highestDeltaSeq = Math.max(...readSeqs(sidecar));
    expect(highestDeltaSeq).toBeGreaterThan(Math.max(...readSeqs(path.join(dir, `${sessionId}.jsonl`))));

    const seqsBeforeResume = readSeqs(path.join(dir, `${sessionId}.jsonl`));

    const resumed = createConversationLogWriter({ sessionId, dir, logger, saveLast: vi.fn() });
    resumed.init({ id: sessionId, createdAt: '2026-06-01T00:01:00.000Z' });
    resumed.append({ type: 'assistant_turn', turn: { items: [{ type: 'assistant_text', text: 'done' }] } });
    await resumed.close();

    // Every newly issued number must clear the sidecar's high-water mark, or
    // the seq-ordered merge on read would interleave incorrectly.
    const newSeqs = readSeqs(path.join(dir, `${sessionId}.jsonl`)).slice(seqsBeforeResume.length);
    expect(newSeqs.length).toBeGreaterThan(0);
    expect(Math.min(...newSeqs)).toBeGreaterThan(highestDeltaSeq);
  });

  it('binds the sidecar to the new session id on rotate', async () => {
    const dir = tempDir();
    const writer = createConversationLogWriter({ sessionId: 'first', dir, logger, saveLast: vi.fn() });

    writer.init({ id: 'first', createdAt: '2026-06-01T00:00:00.000Z' });
    writer.append({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'hello' } });
    writer.append({ type: 'assistant_journal_delta', turnId: 't1', seq: 1, kind: 'text', delta: 'stale' });
    writer.rotate('second', { id: 'second', createdAt: '2026-06-01T00:02:00.000Z' });
    writer.append({ type: 'assistant_journal_delta', turnId: 't2', seq: 1, kind: 'text', delta: 'fresh' });
    await writer.close();

    // The first session ended unsettled, so its sidecar is retained; the new
    // session's deltas must not have appended to it.
    expect(fs.readFileSync(path.join(dir, 'first.deltas'), 'utf8')).toContain('stale');
    expect(fs.readFileSync(path.join(dir, 'first.deltas'), 'utf8')).not.toContain('fresh');
    expect(fs.readFileSync(path.join(dir, 'second.deltas'), 'utf8')).toContain('fresh');
  });
});

describe('ConversationLogWriter sequence continuity', () => {
  it('preserves a large tool result retrieval reference through replay', async () => {
    const dir = tempDir();
    const sessionId = 'large-tool-result';
    const filePath = path.join(dir, `${sessionId}.jsonl`);
    const writer = createConversationLogWriter({ sessionId, dir, logger, saveLast: vi.fn() });
    const output = `${'x'.repeat(300_000)}\nFull output: /tmp/tool-result-artifact.txt`;

    writer.init({ id: sessionId, createdAt: '2026-06-01T00:00:00.000Z' });
    writer.append({ type: 'tool_result', callId: 'call-1', toolName: 'read_file', status: 'completed', output });
    await writer.close();

    const envelopes = fs
      .readFileSync(filePath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => decodeLogEnvelope(JSON.parse(line)))
      .filter((envelope) => envelope !== null);
    const restored = replayEvents(envelopes);

    expect(restored.toolLedger.find((entry) => entry.callId === 'call-1')?.output).toContain(
      'Full output: /tmp/tool-result-artifact.txt',
    );
  });

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

  it('bounds recovery reads for a large log whose final sequenced envelope is near the tail', async () => {
    const dir = tempDir();
    const sessionId = 'large-session';
    const filePath = path.join(dir, `${sessionId}.jsonl`);
    const padding = `${JSON.stringify({
      event: { type: 'settings_changed', key: 'legacy', value: 'x'.repeat(1024) },
    })}\n`;
    const finalEnvelope = JSON.stringify({
      v: 3,
      seq: 7000,
      ts: '2026-06-01T00:00:00.000Z',
      event: { type: 'settings_changed', key: 'agent.model', value: 'gpt-4o' },
    });
    fs.writeFileSync(filePath, padding.repeat(3000) + finalEnvelope + '\n');
    let recoveryBytesRead = 0;
    let largestRead = 0;
    const fileSystem = {
      ...fs,
      readSync: ((fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
        recoveryBytesRead += length;
        largestRead = Math.max(largestRead, length);
        return fs.readSync(fd, buffer, offset, length, position);
      }) as unknown as typeof fs.readSync,
    };

    const writer = createConversationLogWriter({ sessionId, dir, logger, fileSystem, saveLast: vi.fn() });
    writer.init({ id: sessionId, createdAt: '2026-06-01T00:01:00.000Z' });
    await writer.close();

    expect(largestRead).toBeGreaterThan(0);
    expect(largestRead).toBeLessThanOrEqual(64 * 1024);
    expect(recoveryBytesRead).toBeLessThan(128 * 1024);
    const lastEnvelope = decodeLogEnvelope(JSON.parse(fs.readFileSync(filePath, 'utf8').trim().split('\n').at(-1)!));
    expect(lastEnvelope?.seq).toBe(7001);
  });

  it('releases the lock and recovery descriptor when reading the existing log fails', async () => {
    const dir = tempDir();
    const sessionId = 'read-failure-session';
    const filePath = path.join(dir, `${sessionId}.jsonl`);
    fs.writeFileSync(filePath, '{"existing":true}\n');
    const readError = new Error('recovery read failed');
    const fileSystem = {
      ...fs,
      readSync: (() => {
        throw readError;
      }) as typeof fs.readSync,
    };
    const failedWriter = createConversationLogWriter({ sessionId, dir, logger, fileSystem, saveLast: vi.fn() });

    expect(() => failedWriter.init({ id: sessionId, createdAt: '2026-06-01T00:00:00.000Z' })).toThrow(readError);
    expect(fs.existsSync(path.join(dir, `${sessionId}.lock`))).toBe(false);

    const secondWriter = createConversationLogWriter({ sessionId, dir, logger, saveLast: vi.fn() });
    expect(() => secondWriter.init({ id: sessionId, createdAt: '2026-06-01T00:01:00.000Z' })).not.toThrow();
    await secondWriter.close();
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

// Step 2 of docs/plans/openai-context-compaction.md: encrypted_content and
// provider_opaque payloads must never reach the app log. The conversation
// JSONL is not the app log — see conversation-persistence.test.ts for that
// round trip — so the guarantee here is a negative one: appending an event
// carrying either must produce no call to any app-logger method that
// contains the value, while the JSONL line itself keeps it in full.
describe('ConversationLogWriter never echoes opaque content to the app log', () => {
  function fullLogger() {
    return {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      security: vi.fn(),
    } as never;
  }

  it('passes encrypted_content and a provider_opaque item to no logger method, while the JSONL line keeps them in full', async () => {
    const dir = tempDir();
    const logger = fullLogger();
    const writer = createConversationLogWriter({ sessionId: 'opaque-session', dir, logger, saveLast: vi.fn() });
    writer.init({ id: 'opaque-session', createdAt: '2026-06-01T00:00:00.000Z' });

    const encryptedContent = 'ciphertext-'.repeat(50);
    writer.append({
      type: 'assistant_turn',
      turn: {
        items: [
          { type: 'assistant_text', text: 'Continuing.' },
          {
            type: 'provider_opaque',
            provider: 'openai',
            item: { type: 'compaction', encrypted_content: encryptedContent },
          },
        ],
      },
    });
    await writer.close();

    const calls = Object.values(logger as Record<string, ReturnType<typeof vi.fn>>).flatMap((fn) => fn.mock.calls);
    const loggedText = JSON.stringify(calls);
    expect(loggedText).not.toContain(encryptedContent);
    expect(loggedText).not.toContain('provider_opaque');

    // The actual persisted JSONL line — what replay reads back on resume —
    // keeps the full, unredacted value.
    const line = fs.readFileSync(path.join(dir, 'opaque-session.jsonl'), 'utf-8');
    expect(line).toContain(encryptedContent);
  });
});
