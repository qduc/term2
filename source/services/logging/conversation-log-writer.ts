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
import { decodeLogEnvelope } from '../conversation/conversation-decoder.js';
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

/**
 * `provider_opaque` payloads over this size are redacted wholesale in the app
 * debug log rather than walked field-by-field; there is nothing safe to show
 * from an encrypted or otherwise opaque provider blob past this point.
 */
const OPAQUE_LOG_SIZE_THRESHOLD_BYTES = 512;

function byteLength(value: unknown): number {
  return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value ?? null), 'utf8');
}

function redactMarker(value: unknown): string {
  return `<redacted ${byteLength(value)} bytes>`;
}

/**
 * True when `value` contains a field this app must never print to a log:
 * `encrypted_content` (carried by both reasoning items and provider_opaque
 * compaction items — see `reasoningMetadata()` and `toTurnOutput()` in
 * `openai-responses-model.ts`) or a `provider_opaque` item's payload. Used as
 * a cheap gate so the debug echo below only walks events that actually need
 * redaction.
 */
function hasSensitiveOpaqueContent(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasSensitiveOpaqueContent);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (record.type === 'provider_opaque') return true;
    for (const [key, v] of Object.entries(record)) {
      if (key === 'encrypted_content' && typeof v === 'string') return true;
      if (hasSensitiveOpaqueContent(v)) return true;
    }
  }
  return false;
}

/**
 * Produces a copy of a conversation log event safe to echo to the app's
 * debug log. `encrypted_content` and any `provider_opaque` item payload over
 * {@link OPAQUE_LOG_SIZE_THRESHOLD_BYTES} are replaced with a `<redacted N
 * bytes>` marker.
 *
 * This is used **only** for the debug echo in `#traceOpaqueContent` below.
 * The JSONL line written for session persistence — replayed on resume — is
 * never passed through this function, so opaque items (including
 * `encrypted_content`) still round-trip in full through the actual
 * conversation log.
 */
export function redactOpaqueContentForLog(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactOpaqueContentForLog);
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(record)) {
      if (key === 'encrypted_content' && typeof v === 'string') {
        out[key] = redactMarker(v);
        continue;
      }
      if (key === 'item' && record.type === 'provider_opaque' && v && typeof v === 'object') {
        out[key] = byteLength(v) > OPAQUE_LOG_SIZE_THRESHOLD_BYTES ? redactMarker(v) : redactOpaqueContentForLog(v);
        continue;
      }
      out[key] = redactOpaqueContentForLog(v);
    }
    return out;
  }
  return value;
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
    this.#initialize(meta, true);
  }

  #initialize(meta: Omit<SessionInitEvent, 'type'>, recoverSequence: boolean): void {
    this.#projectPath = meta.projectPath;
    this.#sshHost = meta.sshHost;
    ensureDir(this.#fileSystem, this.#dir);
    acquireLock(this.#dir, this.#sessionId, this.#fileSystem);
    try {
      const filePath = logPath(this.#dir, this.#sessionId);
      const tailState = readLogTailState(this.#fileSystem, filePath, recoverSequence);
      this.#seq = tailState.seq;
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
    this.#traceOpaqueContent(sanitizedEvent);
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

  /**
   * Echoes a redacted view of an appended event to the app debug log. Only
   * `assistant_turn` and `assistant_journal_item` events can carry a
   * provider_opaque item or an `encrypted_content` field, and only those
   * that actually do incur the walk — see {@link hasSensitiveOpaqueContent}.
   * The unredacted event is still written to the JSONL line above; this is
   * a debug-only echo, not part of session persistence.
   */
  #traceOpaqueContent(event: LogEvent): void {
    if (event.type !== 'assistant_turn' && event.type !== 'assistant_journal_item') return;
    if (!hasSensitiveOpaqueContent(event)) return;
    this.#logger.debug('Conversation event carries opaque provider content', {
      eventType: `conversation_log.${event.type}`,
      category: 'persistence',
      sessionId: this.#sessionId,
      event: redactOpaqueContentForLog(event),
    });
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
