import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ILoggingService } from '../service-interfaces.js';
import {
  LOG_ENVELOPE_VERSION,
  SIDECAR_EVENT_TYPES,
  deltaSidecarPathFor,
  type LogEnvelope,
  type LogEvent,
  type TruncatedLogEvent,
  type SessionInitEvent,
} from './conversation-log-events.js';
import { decodeLogEnvelope } from '../conversation/conversation-decoder.js';
import { isPidAlive, saveLastConversation } from '../conversation/conversation-persistence.js';

const FSYNC_EVENTS = new Set<LogEvent['type']>([
  'user_message',
  'assistant_turn',
  'undo',
  'session_init',
  // Critical recovery markers. Tool lifecycle and approval boundaries must
  // survive a crash; provider-backed journal items must not be replayed twice
  // by the next resumed request.
  'tool_started',
  'tool_result',
  'approval_required',
  'assistant_journal_item',
]);
const MAX_EVENT_BYTES = 256 * 1024;

export interface ConversationLogWriter {
  readonly sessionId: string;
  init(meta: Omit<SessionInitEvent, 'type'>): void;
  append(event: LogEvent): void;
  rotate(newSessionId: string, meta: Omit<SessionInitEvent, 'type'>): void;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export class LockConflictError extends Error {
  readonly sessionId: string;
  readonly lockPath: string;
  readonly lockInfo: { pid: number; startedAt: string; host: string } | null;
  constructor(sessionId: string, lockPath: string, lockInfo: { pid: number; startedAt: string; host: string } | null) {
    super(
      lockInfo
        ? `Conversation ${sessionId} is locked (pid ${lockInfo.pid}, started ${lockInfo.startedAt}, host ${lockInfo.host}).`
        : `Conversation ${sessionId} is locked.`,
    );
    this.name = 'LockConflictError';
    this.sessionId = sessionId;
    this.lockPath = lockPath;
    this.lockInfo = lockInfo;
  }
}

type WriterFileSystem = Pick<
  typeof fs,
  | 'existsSync'
  | 'mkdirSync'
  | 'openSync'
  | 'readFileSync'
  | 'readSync'
  | 'fstatSync'
  | 'writeSync'
  | 'fsyncSync'
  | 'closeSync'
  | 'unlinkSync'
>;

interface WriterOptions {
  sessionId: string;
  dir: string;
  logger: ILoggingService;
  fileSystem?: WriterFileSystem;
  saveLast?: typeof saveLastConversation;
  /**
   * Deterministic PID-liveness probe for the stale-lock liveness path.
   * Defaults to the production `process.kill(pid, 0)` probe; tests inject a
   * controlled predicate so proofs never probe real processes.
   */
  isPidAlive?: (pid: number) => boolean;
}

function logPath(dir: string, sessionId: string): string {
  return path.join(dir, `${sessionId}.jsonl`);
}

function deltaPath(dir: string, sessionId: string): string {
  return deltaSidecarPathFor(logPath(dir, sessionId));
}

/**
 * Event types that settle or discard the current user turn. Used to decide
 * whether the sidecar still holds deltas recovery would need.
 *
 * A structural "was the last event an `assistant_turn`" test does not work:
 * `conversationService.shutdown()` is awaited before `logWriter.close()` and
 * appends background-shell and subagent lifecycle events after the final turn,
 * so the sidecar would almost never be collected at close.
 */
const TURN_SETTLING_EVENTS = new Set<LogEvent['type']>(['assistant_turn', 'undo', 'session_cleared']);

function lockPath(dir: string, sessionId: string): string {
  return path.join(dir, `${sessionId}.lock`);
}

function ensureDir(fileSystem: WriterFileSystem, dir: string): void {
  if (!fileSystem.existsSync(dir)) {
    fileSystem.mkdirSync(dir, { recursive: true });
  }
}

const RECOVERY_CHUNK_BYTES = 64 * 1024;
const MAX_RECOVERY_LINE_BYTES = MAX_EVENT_BYTES * 2;

function decodeSequence(line: string): number | null {
  try {
    const envelope = decodeLogEnvelope(JSON.parse(line));
    return envelope && Number.isSafeInteger(envelope.seq) && envelope.seq > 0 ? envelope.seq : null;
  } catch {
    return null;
  }
}

function readLogTailState(
  fileSystem: WriterFileSystem,
  filePath: string,
  recoverSequence: boolean,
): { seq: number; needsLineBreak: boolean } {
  if (!fileSystem.existsSync(filePath)) return { seq: 0, needsLineBreak: false };

  const fd = fileSystem.openSync(filePath, 'r');
  try {
    const size = fileSystem.fstatSync(fd).size;
    if (size === 0) return { seq: 0, needsLineBreak: false };

    const finalByte = Buffer.allocUnsafe(1);
    fileSystem.readSync(fd, finalByte, 0, 1, size - 1);
    const needsLineBreak = finalByte[0] !== 0x0a;
    if (!recoverSequence) return { seq: 0, needsLineBreak };

    let position = size;
    let suffix = '';
    let discardOversizedLine = false;

    while (position > 0) {
      const length = Math.min(RECOVERY_CHUNK_BYTES, position);
      const start = position - length;
      const chunk = Buffer.allocUnsafe(length);
      const bytesRead = fileSystem.readSync(fd, chunk, 0, length, start);
      const parts = (chunk.subarray(0, bytesRead).toString('utf8') + suffix).split('\n');
      position = start;

      if (start > 0) {
        const prefix = parts.shift() ?? '';
        if (prefix.length > MAX_RECOVERY_LINE_BYTES) {
          suffix = '';
          discardOversizedLine = true;
        } else {
          suffix = prefix;
        }
      }
      if (discardOversizedLine && parts.length > 0) {
        parts.pop();
        discardOversizedLine = false;
      }
      for (let index = parts.length - 1; index >= 0; index -= 1) {
        const seq = decodeSequence(parts[index]!);
        if (seq !== null) return { seq, needsLineBreak };
      }
    }
    return { seq: 0, needsLineBreak };
  } finally {
    fileSystem.closeSync(fd);
  }
}

export function sanitizeSubagentResult(value: unknown): unknown {
  if (!value) {
    return value;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object') {
          const sanitized = sanitizeSubagentResult(parsed);
          return JSON.stringify(sanitized);
        }
      } catch {
        // Return original string
      }
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(sanitizeSubagentResult);
  }

  if (typeof value === 'object') {
    const obj = { ...value } as Record<string, unknown>;
    delete obj['nestedRunResult'];
    for (const key of Object.keys(obj)) {
      obj[key] = sanitizeSubagentResult(obj[key]);
    }
    return obj;
  }

  return value;
}

function truncateForLog(event: LogEvent): LogEvent | TruncatedLogEvent {
  const serialized = JSON.stringify(event);
  if (serialized.length <= MAX_EVENT_BYTES) {
    return event;
  }
  const truncate = (value: unknown): unknown => {
    if (typeof value === 'string' && value.length > 1024) {
      return value.slice(0, 1024) + '…[truncated for log]';
    }
    if (Array.isArray(value)) {
      return value.map(truncate);
    }
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = truncate(v);
      }
      return out;
    }
    return value;
  };
  const truncated = truncate(event) as LogEvent;
  const reserialized = JSON.stringify(truncated);
  if (reserialized.length <= MAX_EVENT_BYTES) {
    return truncated;
  }
  return {
    type: event.type,
    truncated: true,
    originalSize: serialized.length,
  };
}

function acquireLock(
  dir: string,
  sessionId: string,
  fileSystem: WriterFileSystem = fs,
  isPidAliveFn: (pid: number) => boolean = isPidAlive,
): void {
  const lp = lockPath(dir, sessionId);
  const payload = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), host: os.hostname() });
  let fd: number;
  try {
    fd = fileSystem.openSync(lp, 'wx');
  } catch (err: unknown) {
    const errorObj = err as { code?: string };
    if (errorObj?.code === 'EEXIST') {
      let info: { pid: number; startedAt: string; host: string } | null = null;
      try {
        info = JSON.parse(fileSystem.readFileSync(lp, 'utf-8'));
      } catch {
        info = null;
      }
      // Owner-decided liveness path: a lock from this host whose PID is
      // demonstrably dead is stale and is reclaimed. Corrupt payloads, live
      // PIDs, and foreign-host locks still raise LockConflictError.
      if (info !== null && info.host === os.hostname() && !isPidAliveFn(info.pid)) {
        try {
          fileSystem.unlinkSync(lp);
        } catch {
          // Fall through to a conflict if the stale lock cannot be removed.
        }
        try {
          fd = fileSystem.openSync(lp, 'wx');
        } catch (err2: unknown) {
          const errorObj2 = err2 as { code?: string };
          if (errorObj2?.code === 'EEXIST') {
            throw new LockConflictError(sessionId, lp, info);
          }
          throw err2;
        }
      } else {
        throw new LockConflictError(sessionId, lp, info);
      }
    } else {
      throw err;
    }
  }
  try {
    fileSystem.writeSync(fd, payload);
    fileSystem.fsyncSync(fd);
  } finally {
    fileSystem.closeSync(fd);
  }
}

function releaseLock(dir: string, sessionId: string, fileSystem: WriterFileSystem = fs): void {
  try {
    fileSystem.unlinkSync(lockPath(dir, sessionId));
  } catch (err: unknown) {
    const errorObj = err as { code?: string };
    if (errorObj?.code !== 'ENOENT') {
      // best-effort
    }
  }
}

class ConversationLogWriterImpl implements ConversationLogWriter {
  #sessionId: string;
  #dir: string;
  #logger: ILoggingService;
  #fileSystem: WriterFileSystem;
  #saveLast: typeof saveLastConversation;
  #fd: number | null = null;
  /** Lazily opened on the first delta, so quiet sessions create no sidecar. */
  #deltaFd: number | null = null;
  #hasUnsettledTurn = false;
  #seq = 0;
  #closed = false;
  #failure: unknown = null;
  #writeErrorLogged = false;
  #projectPath: string | undefined;
  #sshHost: string | undefined;
  #isPidAlive: (pid: number) => boolean;

  constructor(opts: WriterOptions) {
    this.#sessionId = opts.sessionId;
    this.#dir = opts.dir;
    this.#logger = opts.logger;
    this.#fileSystem = opts.fileSystem ?? fs;
    this.#saveLast = opts.saveLast ?? saveLastConversation;
    this.#isPidAlive = opts.isPidAlive ?? isPidAlive;
  }

  get sessionId(): string {
    return this.#sessionId;
  }

  init(meta: Omit<SessionInitEvent, 'type'>): void {
    this.#initialize(meta, true);
  }

  #initialize(meta: Omit<SessionInitEvent, 'type'>, recoverSequence: boolean): void {
    this.#projectPath = meta.projectPath;
    this.#sshHost = meta.sshHost;
    ensureDir(this.#fileSystem, this.#dir);
    acquireLock(this.#dir, this.#sessionId, this.#fileSystem, this.#isPidAlive);
    try {
      const filePath = logPath(this.#dir, this.#sessionId);
      const tailState = readLogTailState(this.#fileSystem, filePath, recoverSequence);
      // Sequence numbers are shared across both files so recovery can merge
      // them by `seq`. Deltas outnumber everything else ~10:1, so after a crash
      // the high-water mark usually lives in the sidecar; resuming from the
      // canonical tail alone would reissue sequence numbers.
      const deltaTailState = recoverSequence
        ? readLogTailState(this.#fileSystem, deltaPath(this.#dir, this.#sessionId), true)
        : { seq: 0, needsLineBreak: false };
      this.#seq = Math.max(tailState.seq, deltaTailState.seq);
      this.#fd = this.#fileSystem.openSync(filePath, 'a');
      if (tailState.needsLineBreak) {
        try {
          this.#fileSystem.writeSync(this.#fd, '\n');
        } catch (err: unknown) {
          this.#recordFailure(err);
          throw err;
        }
      }
      this.append({ type: 'session_init', ...meta });
    } catch (err: unknown) {
      if (this.#fd !== null) {
        try {
          this.#fileSystem.closeSync(this.#fd);
        } catch {
          // Preserve the initialization failure.
        }
        this.#fd = null;
      }
      releaseLock(this.#dir, this.#sessionId, this.#fileSystem);
      throw err;
    }
  }

  append(event: LogEvent): void {
    this.#throwIfFailed();
    if (this.#closed || this.#fd === null) {
      return;
    }
    const sanitizedEvent = sanitizeSubagentResult(event) as LogEvent;
    const envelope: LogEnvelope = {
      v: LOG_ENVELOPE_VERSION,
      seq: ++this.#seq,
      ts: new Date().toISOString(),
      event: sanitizedEvent,
    };
    const line = JSON.stringify(envelope) + '\n';

    if (SIDECAR_EVENT_TYPES.has(sanitizedEvent.type)) {
      this.#appendDelta(line);
      return;
    }

    if (sanitizedEvent.type === 'user_message') {
      this.#hasUnsettledTurn = true;
    } else if (TURN_SETTLING_EVENTS.has(sanitizedEvent.type)) {
      this.#hasUnsettledTurn = false;
    }

    try {
      this.#fileSystem.writeSync(this.#fd, line);
      if (FSYNC_EVENTS.has(sanitizedEvent.type)) {
        this.#fileSystem.fsyncSync(this.#fd);
        this.#saveLast(this.#sessionId, this.#projectPath, this.#sshHost);
      }
    } catch (err: unknown) {
      if (FSYNC_EVENTS.has(sanitizedEvent.type)) {
        this.#recordFailure(err);
        throw err;
      }
      this.#logWriteFailure(err);
    }
  }

  /**
   * Deltas are non-critical: never fsync'd, and a write failure is logged
   * rather than raised. Losing the sidecar tail degrades a recovered partial
   * turn; it can never corrupt a settled one.
   */
  #appendDelta(line: string): void {
    // A delta is itself evidence that a turn is streaming. Deriving the flag
    // from the delta rather than only from the preceding `user_message` means
    // any sidecar content keeps the sidecar alive until a turn settles it.
    this.#hasUnsettledTurn = true;
    try {
      const fd = this.#ensureDeltaFd();
      if (fd === null) return;
      this.#fileSystem.writeSync(fd, line);
    } catch (err: unknown) {
      this.#logWriteFailure(err);
    }
  }

  #ensureDeltaFd(): number | null {
    if (this.#deltaFd !== null) return this.#deltaFd;
    const filePath = deltaPath(this.#dir, this.#sessionId);
    // A sidecar can already exist when resuming a crashed session; repair a
    // torn final line the same way the canonical log does.
    const tailState = readLogTailState(this.#fileSystem, filePath, false);
    const fd = this.#fileSystem.openSync(filePath, 'a');
    this.#deltaFd = fd;
    if (tailState.needsLineBreak) {
      this.#fileSystem.writeSync(fd, '\n');
    }
    return fd;
  }

  /** Close the sidecar fd, returning any failure rather than throwing. */
  #closeDeltaFd(): unknown {
    if (this.#deltaFd === null) return null;
    let failure: unknown = null;
    try {
      this.#fileSystem.closeSync(this.#deltaFd);
    } catch (err: unknown) {
      failure = err;
    }
    this.#deltaFd = null;
    return failure;
  }

  /**
   * Drop the sidecar when no turn is left unsettled. Safe against a late
   * append because `append()` no-ops once `#closed` is set, so the flag read
   * and the unlink observe the same state.
   */
  #dropDeltaSidecarIfSettled(): void {
    if (this.#hasUnsettledTurn) return;
    try {
      this.#fileSystem.unlinkSync(deltaPath(this.#dir, this.#sessionId));
    } catch (err: unknown) {
      const errorObj = err as { code?: string };
      if (errorObj?.code !== 'ENOENT') {
        this.#logWriteFailure(err);
      }
    }
  }

  rotate(newSessionId: string, meta: Omit<SessionInitEvent, 'type'>): void {
    this.#throwIfFailed();
    let rotateFailure: unknown = null;
    if (this.#fd !== null) {
      try {
        this.#fileSystem.fsyncSync(this.#fd);
      } catch (err: unknown) {
        rotateFailure = err;
      }
      try {
        this.#fileSystem.closeSync(this.#fd);
      } catch (err: unknown) {
        rotateFailure ??= err;
      }
      this.#fd = null;
    }
    rotateFailure ??= this.#closeDeltaFd();
    // Drop before releasing the lock, so a crash mid-rotate cannot leave an
    // orphan the startup GC is unable to distinguish from a live sidecar.
    this.#dropDeltaSidecarIfSettled();
    releaseLock(this.#dir, this.#sessionId, this.#fileSystem);
    if (rotateFailure !== null) {
      this.#recordFailure(rotateFailure);
      throw rotateFailure;
    }
    this.#sessionId = newSessionId;
    this.#seq = 0;
    this.#hasUnsettledTurn = false;
    this.#writeErrorLogged = false;
    this.#initialize(meta, false);
  }

  async flush(): Promise<void> {
    this.#throwIfFailed();
    if (this.#fd !== null) {
      try {
        this.#fileSystem.fsyncSync(this.#fd);
      } catch (err: unknown) {
        this.#recordFailure(err);
        throw err;
      }
    }
  }

  async close(): Promise<void> {
    if (this.#closed) {
      this.#throwIfFailed();
      return;
    }
    this.#closed = true;
    const primaryFailure = this.#failure;
    let cleanupFailure: unknown = null;
    if (this.#fd !== null) {
      try {
        this.#fileSystem.fsyncSync(this.#fd);
      } catch (err: unknown) {
        cleanupFailure = err;
      }
      try {
        this.#fileSystem.closeSync(this.#fd);
      } catch (err: unknown) {
        cleanupFailure ??= err;
      }
      this.#fd = null;
    }
    cleanupFailure ??= this.#closeDeltaFd();
    // Unlink before releasing the lock: a crash in between would otherwise
    // leave a sidecar with no lock, indistinguishable from a live one.
    this.#dropDeltaSidecarIfSettled();
    if (primaryFailure === null && cleanupFailure === null) {
      this.#saveLast(this.#sessionId, this.#projectPath, this.#sshHost);
    }
    releaseLock(this.#dir, this.#sessionId, this.#fileSystem);
    if (primaryFailure !== null) throw primaryFailure;
    if (cleanupFailure !== null) {
      this.#recordFailure(cleanupFailure);
      throw cleanupFailure;
    }
  }

  #throwIfFailed(): void {
    if (this.#failure !== null) throw this.#failure;
  }

  #recordFailure(err: unknown): void {
    this.#failure ??= err;
    this.#logWriteFailure(err);
  }

  #logWriteFailure(err: unknown): void {
    if (this.#writeErrorLogged) return;
    this.#writeErrorLogged = true;
    this.#logger.error('Conversation log write failed', {
      eventType: 'conversation_log.write_failed',
      category: 'persistence',
      sessionId: this.#sessionId,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }
}

export function createConversationLogWriter(opts: WriterOptions): ConversationLogWriter {
  return new ConversationLogWriterImpl(opts);
}

export const __testing = {
  truncateForLog,
  acquireLock,
  releaseLock,
};
