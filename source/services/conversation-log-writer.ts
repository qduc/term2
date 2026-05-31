import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ILoggingService } from './service-interfaces.js';
import {
  LOG_ENVELOPE_VERSION,
  type LogEnvelope,
  type LogEvent,
  type SessionInitEvent,
} from './conversation-log-events.js';
import { saveLastConversation } from './conversation-persistence.js';

const FSYNC_EVENTS = new Set<LogEvent['type']>(['user_message', 'assistant_turn', 'undo', 'session_init']);
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

interface WriterOptions {
  sessionId: string;
  dir: string;
  logger: ILoggingService;
}

function logPath(dir: string, sessionId: string): string {
  return path.join(dir, `${sessionId}.jsonl`);
}

function lockPath(dir: string, sessionId: string): string {
  return path.join(dir, `${sessionId}.lock`);
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function sanitizeSubagentResult(value: unknown): unknown {
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
    const obj = { ...value } as Record<string, any>;
    if ('nestedRunResult' in obj) {
      delete obj.nestedRunResult;
    }
    for (const key of Object.keys(obj)) {
      obj[key] = sanitizeSubagentResult(obj[key]);
    }
    return obj;
  }

  return value;
}

function truncateForLog(event: LogEvent): LogEvent {
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
  } as unknown as LogEvent;
}

function acquireLock(dir: string, sessionId: string): void {
  const lp = lockPath(dir, sessionId);
  const payload = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), host: os.hostname() });
  let fd: number;
  try {
    fd = fs.openSync(lp, 'wx');
  } catch (err: any) {
    if (err?.code === 'EEXIST') {
      let info: { pid: number; startedAt: string; host: string } | null = null;
      try {
        info = JSON.parse(fs.readFileSync(lp, 'utf-8'));
      } catch {
        info = null;
      }
      throw new LockConflictError(sessionId, lp, info);
    }
    throw err;
  }
  try {
    fs.writeSync(fd, payload);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function releaseLock(dir: string, sessionId: string): void {
  try {
    fs.unlinkSync(lockPath(dir, sessionId));
  } catch (err: any) {
    if (err?.code !== 'ENOENT') {
      // best-effort
    }
  }
}

class ConversationLogWriterImpl implements ConversationLogWriter {
  #sessionId: string;
  #dir: string;
  #logger: ILoggingService;
  #fd: number | null = null;
  #seq = 0;
  #closed = false;
  #writeErrorLogged = false;
  #projectPath: string | undefined;
  #sshHost: string | undefined;

  constructor(opts: WriterOptions) {
    this.#sessionId = opts.sessionId;
    this.#dir = opts.dir;
    this.#logger = opts.logger;
  }

  get sessionId(): string {
    return this.#sessionId;
  }

  init(meta: Omit<SessionInitEvent, 'type'>): void {
    this.#projectPath = meta.projectPath;
    this.#sshHost = meta.sshHost;
    ensureDir(this.#dir);
    acquireLock(this.#dir, this.#sessionId);
    this.#fd = fs.openSync(logPath(this.#dir, this.#sessionId), 'a');
    this.append({ type: 'session_init', ...meta });
  }

  append(event: LogEvent): void {
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
      fs.writeSync(this.#fd, line);
      if (FSYNC_EVENTS.has(sanitizedEvent.type)) {
        try {
          fs.fsyncSync(this.#fd);
        } catch {
          // ignore fsync errors; data is in kernel buffer
        }
        saveLastConversation(this.#sessionId, this.#projectPath, this.#sshHost);
      }
    } catch (err: any) {
      if (!this.#writeErrorLogged) {
        this.#writeErrorLogged = true;
        this.#logger.error('Conversation log write failed', {
          eventType: 'conversation_log.write_failed',
          category: 'persistence',
          sessionId: this.#sessionId,
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  rotate(newSessionId: string, meta: Omit<SessionInitEvent, 'type'>): void {
    if (this.#fd !== null) {
      try {
        fs.fsyncSync(this.#fd);
      } catch {
        // ignore
      }
      try {
        fs.closeSync(this.#fd);
      } catch {
        // ignore
      }
      this.#fd = null;
    }
    releaseLock(this.#dir, this.#sessionId);
    this.#sessionId = newSessionId;
    this.#seq = 0;
    this.#writeErrorLogged = false;
    this.init(meta);
  }

  async flush(): Promise<void> {
    if (this.#fd !== null) {
      try {
        fs.fsyncSync(this.#fd);
      } catch {
        // ignore
      }
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#fd !== null) {
      try {
        fs.fsyncSync(this.#fd);
      } catch {
        // ignore
      }
      try {
        fs.closeSync(this.#fd);
      } catch {
        // ignore
      }
      this.#fd = null;
    }
    saveLastConversation(this.#sessionId, this.#projectPath, this.#sshHost);
    releaseLock(this.#dir, this.#sessionId);
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
