import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ILoggingService } from '../service-interfaces.js';
import {
  LOG_ENVELOPE_VERSION,
  type LogEnvelope,
  type LogEvent,
  type TruncatedLogEvent,
  type SessionInitEvent,
} from './conversation-log-events.js';
import { saveLastConversation } from '../conversation/conversation-persistence.js';

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
  'existsSync' | 'mkdirSync' | 'openSync' | 'readFileSync' | 'writeSync' | 'fsyncSync' | 'closeSync' | 'unlinkSync'
>;

interface WriterOptions {
  sessionId: string;
  dir: string;
  logger: ILoggingService;
  fileSystem?: WriterFileSystem;
  saveLast?: typeof saveLastConversation;
}

function logPath(dir: string, sessionId: string): string {
  return path.join(dir, `${sessionId}.jsonl`);
}

function lockPath(dir: string, sessionId: string): string {
  return path.join(dir, `${sessionId}.lock`);
}

function ensureDir(fileSystem: WriterFileSystem, dir: string): void {
  if (!fileSystem.existsSync(dir)) {
    fileSystem.mkdirSync(dir, { recursive: true });
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

function acquireLock(dir: string, sessionId: string, fileSystem: WriterFileSystem = fs): void {
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
      throw new LockConflictError(sessionId, lp, info);
    }
    throw err;
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
  #seq = 0;
  #closed = false;
  #failure: unknown = null;
  #writeErrorLogged = false;
  #projectPath: string | undefined;
  #sshHost: string | undefined;

  constructor(opts: WriterOptions) {
    this.#sessionId = opts.sessionId;
    this.#dir = opts.dir;
    this.#logger = opts.logger;
    this.#fileSystem = opts.fileSystem ?? fs;
    this.#saveLast = opts.saveLast ?? saveLastConversation;
  }

  get sessionId(): string {
    return this.#sessionId;
  }

  init(meta: Omit<SessionInitEvent, 'type'>): void {
    this.#projectPath = meta.projectPath;
    this.#sshHost = meta.sshHost;
    ensureDir(this.#fileSystem, this.#dir);
    acquireLock(this.#dir, this.#sessionId, this.#fileSystem);
    this.#fd = this.#fileSystem.openSync(logPath(this.#dir, this.#sessionId), 'a');
    this.append({ type: 'session_init', ...meta });
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
    releaseLock(this.#dir, this.#sessionId, this.#fileSystem);
    if (rotateFailure !== null) {
      this.#recordFailure(rotateFailure);
      throw rotateFailure;
    }
    this.#sessionId = newSessionId;
    this.#seq = 0;
    this.#writeErrorLogged = false;
    this.init(meta);
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
