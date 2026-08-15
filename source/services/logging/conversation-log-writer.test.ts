import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeLogEnvelope } from '../conversation/conversation-decoder.js';
import { replayEvents } from '../conversation/conversation-replay.js';
import type { LogEvent } from './conversation-log-events.js';
import { createConversationLogWriter, LockConflictError } from './conversation-log-writer.js';

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

  it('session_cleared settles in-flight turn and removes delta sidecar on close', async () => {
    const dir = tempDir();
    const sessionId = 'session-cleared-settle';
    const writer = createConversationLogWriter({ sessionId, dir, logger, saveLast: vi.fn() });
    writer.init({ id: sessionId, createdAt: '2026-06-01T00:00:00.000Z' });
    writer.append({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'start' } });
    writer.append({ type: 'assistant_journal_delta', turnId: 't1', seq: 1, kind: 'text', delta: 'streaming' });
    expect(fs.existsSync(path.join(dir, `${sessionId}.deltas`))).toBe(true);

    // Appending session_cleared marks turn as settled
    writer.append({ type: 'session_cleared' });
    await writer.close();

    // Sidecar must be unlinked upon close because session_cleared settled the turn
    expect(fs.existsSync(path.join(dir, `${sessionId}.deltas`))).toBe(false);
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

  it('resumes sequence numbering past a retained sidecar-dominant tail after an unsettled orderly close', async () => {
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

describe('ConversationLogWriter stale lock recovery', () => {
  it('init reclaims a same-host lock whose PID is demonstrably dead', async () => {
    const dir = tempDir();
    const sessionId = 'stale-lock-session';
    fs.writeFileSync(
      path.join(dir, `${sessionId}.lock`),
      JSON.stringify({ pid: 424242, startedAt: '2026-06-01T00:00:00.000Z', host: os.hostname() }),
      'utf-8',
    );

    // Deterministic liveness control: an injected check reports every PID dead,
    // so this proof never probes a real process.
    const writer = createConversationLogWriter({
      sessionId,
      dir,
      logger,
      saveLast: vi.fn(),
      isPidAlive: () => false,
    });

    expect(() => writer.init({ id: sessionId, createdAt: '2026-06-01T00:00:00.000Z' })).not.toThrow();

    // The reclaimed lock now names the live writer process.
    const lockPayload = JSON.parse(fs.readFileSync(path.join(dir, `${sessionId}.lock`), 'utf-8')) as {
      pid: number;
      host: string;
    };
    expect(lockPayload.pid).toBe(process.pid);
    expect(lockPayload.host).toBe(os.hostname());
    await writer.close();
  });

  it('init reclaims a same-host lock whose PID was reaped, through the production liveness path', async () => {
    const dir = tempDir();
    const sessionId = 'stale-lock-reaped-session';
    // Spawn and fully reap a real child so the lock records a PID that is
    // provably dead; the production default liveness probe signals only this
    // controlled PID.
    const child = spawn(process.execPath, ['-e', '']);
    const deadPid = child.pid!;
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', () => resolve());
    });
    fs.writeFileSync(
      path.join(dir, `${sessionId}.lock`),
      JSON.stringify({ pid: deadPid, startedAt: '2026-06-01T00:00:00.000Z', host: os.hostname() }),
      'utf-8',
    );

    const writer = createConversationLogWriter({ sessionId, dir, logger, saveLast: vi.fn() });
    expect(() => writer.init({ id: sessionId, createdAt: '2026-06-01T00:00:00.000Z' })).not.toThrow();

    const lockPayload = JSON.parse(fs.readFileSync(path.join(dir, `${sessionId}.lock`), 'utf-8')) as {
      pid: number;
      host: string;
    };
    expect(lockPayload.pid).toBe(process.pid);
    expect(lockPayload.host).toBe(os.hostname());
    await writer.close();
  });

  it('init still throws LockConflictError for a same-host lock whose PID is alive', async () => {
    const dir = tempDir();
    const sessionId = 'live-lock-session';
    fs.writeFileSync(
      path.join(dir, `${sessionId}.lock`),
      JSON.stringify({ pid: process.pid, startedAt: '2026-06-01T00:00:00.000Z', host: os.hostname() }),
      'utf-8',
    );

    const writer = createConversationLogWriter({ sessionId, dir, logger, saveLast: vi.fn() });
    expect(() => writer.init({ id: sessionId, createdAt: '2026-06-01T00:00:00.000Z' })).toThrow(LockConflictError);
  });
});

describe('ConversationLogWriter post-close policy', () => {
  it('append after close silently drops events, writes nothing to disk, and does not invoke saveLast', async () => {
    const dir = tempDir();
    const sessionId = 'closed-session';
    const saveLastMock = vi.fn();
    const writer = createConversationLogWriter({ sessionId, dir, logger, saveLast: saveLastMock });
    writer.init({ id: sessionId, createdAt: '2026-06-01T00:00:00.000Z' });
    writer.append({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'initial message' } });
    await writer.close();

    const saveLastCallsAfterClose = saveLastMock.mock.calls.length;
    const dirEntriesBefore = fs.readdirSync(dir).sort();
    const contentsBefore = dirEntriesBefore.map((f) => ({
      file: f,
      data: fs.readFileSync(path.join(dir, f), 'utf-8'),
    }));

    // Appending after close must silently drop
    expect(() => {
      writer.append({ type: 'user_message', message: { id: 'u2', sender: 'user', text: 'dropped message' } });
    }).not.toThrow();

    const dirEntriesAfter = fs.readdirSync(dir).sort();
    expect(dirEntriesAfter).toEqual(dirEntriesBefore);
    for (const before of contentsBefore) {
      expect(fs.readFileSync(path.join(dir, before.file), 'utf-8')).toBe(before.data);
    }
    expect(saveLastMock).toHaveBeenCalledTimes(saveLastCallsAfterClose);
  });

  it('successful writer close is idempotent and triggers no redundant saveLast or mutations on second close', async () => {
    const dir = tempDir();
    const sessionId = 'idempotent-close-session';
    const saveLastMock = vi.fn();
    const writer = createConversationLogWriter({ sessionId, dir, logger, saveLast: saveLastMock });
    writer.init({ id: sessionId, createdAt: '2026-06-01T00:00:00.000Z' });
    writer.append({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'hello' } });

    await expect(writer.close()).resolves.toBeUndefined();
    const saveLastCalls = saveLastMock.mock.calls.length;
    const dirEntries = fs.readdirSync(dir).sort();
    const dirContents = dirEntries.map((f) => fs.readFileSync(path.join(dir, f), 'utf-8'));

    // Second close must also resolve without double-releasing or extra saveLast/disk writes
    await expect(writer.close()).resolves.toBeUndefined();
    expect(saveLastMock).toHaveBeenCalledTimes(saveLastCalls);
    expect(fs.readdirSync(dir).sort()).toEqual(dirEntries);
    expect(dirEntries.map((f) => fs.readFileSync(path.join(dir, f), 'utf-8'))).toEqual(dirContents);
  });
});

describe('ConversationLogWriter event fsync classification', () => {
  it('exact FSYNC_EVENTS classification: only specified critical events trigger fsyncSync and saveLast', () => {
    const dir = tempDir();
    const sessionId = 'fsync-classification-session';
    const saveLastMock = vi.fn();
    let fsyncCount = 0;
    const fileSystem = {
      ...fs,
      fsyncSync(fd: number) {
        fsyncCount += 1;
        return fs.fsyncSync(fd);
      },
    };
    const writer = createConversationLogWriter({
      sessionId,
      dir,
      logger,
      fileSystem,
      saveLast: saveLastMock,
    });

    // init() issues acquireLock (1 fsync) + session_init (1 fsync + 1 saveLast)
    writer.init({ id: sessionId, createdAt: '2026-06-01T00:00:00.000Z' });
    expect(fsyncCount).toBe(2);
    expect(saveLastMock).toHaveBeenCalledTimes(1);

    // Table of critical events that MUST trigger fsyncSync and saveLast
    const criticalEvents: LogEvent[] = [
      { type: 'user_message', message: { id: 'u1', sender: 'user', text: 'hi' } },
      { type: 'assistant_turn', turn: { items: [{ type: 'assistant_text', text: 'reply' }] } },
      { type: 'undo', removedUserTurns: 1, snapshot: { history: [], previousResponseId: null, toolLedger: [] } },
      { type: 'tool_started', toolCallId: 'c1', toolName: 'read_file', arguments: {} },
      { type: 'tool_result', callId: 'c1', toolName: 'read_file', status: 'completed', output: 'ok' },
      {
        type: 'approval_required',
        approval: { callId: 'c2', toolName: 'bash', argumentsText: '{}', agentName: 'root' },
      },
      { type: 'assistant_journal_item', turnId: 't1', seq: 10, item: { type: 'assistant_text', text: 'journal' } },
    ];

    for (const event of criticalEvents) {
      const prevFsync = fsyncCount;
      const prevSaveLast = saveLastMock.mock.calls.length;
      writer.append(event);
      expect(fsyncCount).toBe(prevFsync + 1);
      expect(saveLastMock).toHaveBeenCalledTimes(prevSaveLast + 1);
    }

    // Non-fsync events MUST NOT trigger fsyncSync or saveLast
    const nonFsyncEvents: LogEvent[] = [
      { type: 'approval_resolved', answer: 'y' },
      { type: 'settings_changed', key: 'model', value: 'gpt-5' },
      { type: 'assistant_journal_delta', turnId: 't2', seq: 20, kind: 'text', delta: 'chunk' },
    ];

    for (const event of nonFsyncEvents) {
      const prevFsync = fsyncCount;
      const prevSaveLast = saveLastMock.mock.calls.length;
      writer.append(event);
      expect(fsyncCount).toBe(prevFsync);
      expect(saveLastMock).toHaveBeenCalledTimes(prevSaveLast);
    }
  });
});

describe('ConversationLogWriter observability', () => {
  it('emits structured conversation_log.write_failed once with category persistence and sessionId on critical write error', () => {
    const dir = tempDir();
    const sessionId = 'obs-failed-session';
    const mockLogger = { error: vi.fn() };
    const writeError = new Error('EIO: write failure');
    let writeCalls = 0;
    const fileSystem = {
      ...fs,
      writeSync(fd: number, buffer: unknown, ...args: unknown[]) {
        writeCalls += 1;
        // The first write is acquireLock payload. Throw on subsequent log append.
        if (writeCalls >= 2) throw writeError;
        return (fs.writeSync as (...a: unknown[]) => number)(fd, buffer, ...args);
      },
    };
    const writer = createConversationLogWriter({
      sessionId,
      dir,
      logger: mockLogger as never,
      fileSystem,
      saveLast: vi.fn(),
    });

    expect(() => writer.init({ id: sessionId, createdAt: '2026-06-01T00:00:00.000Z' })).toThrow(writeError);

    // Subsequent append rethrows the latched failure without logging a second error
    expect(() =>
      writer.append({ type: 'user_message', message: { id: 'u1', sender: 'user', text: 'second attempt' } }),
    ).toThrow(writeError);

    // Verify structured logging was called exactly once
    expect(mockLogger.error).toHaveBeenCalledTimes(1);
    expect(mockLogger.error).toHaveBeenCalledWith(
      'Conversation log write failed',
      expect.objectContaining({
        eventType: 'conversation_log.write_failed',
        category: 'persistence',
        sessionId,
      }),
    );
  });
});
