/**
 * Browser-side SSE reader for the Client API `session.list` stream (`GET /api/agent/sessions/events`).
 * Reuses `sse.ts` framing and keeps reconnect backoff AbortSignal-safe for React StrictMode.
 */
import type { HttpResponse } from '../../http';
import { Term2ApiError, validateSessionItem } from '../../api/term2';
import { decodeSseText } from '../sse';
import type { SessionListItem } from '../types';

const BACKOFF_BASE_MS = 500;
const MAX_BACKOFF_MS = 10_000;
const OPAQUE_ID = /^[A-Za-z0-9_-]{1,256}$/u;

export interface SessionListStream {
  start(): void;
  stop(): void;
}

export type SessionListStreamDeps = {
  open(signal: AbortSignal): Promise<HttpResponse<Response>>;
  onSnapshot(sessions: SessionListItem[], nextCursor: string | null): void;
  onUpsert(session: SessionListItem): void;
  onRemove(sessionId: string, reason?: string): void;
  onDraining?(gracePeriodMs?: number): void;
};

function isTerminalError(error: unknown): boolean {
  if (!(error instanceof Term2ApiError)) return false;
  return error.status === 401 || error.status === 403 || error.code === 'protocol_incompatible';
}

function waitForDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function parseJsonObject(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Malformed session-list SSE payload');
  }
  return parsed as Record<string, unknown>;
}

export function createSessionListStream(deps: SessionListStreamDeps): SessionListStream {
  let controller: AbortController | null = null;
  let generation = 0;

  async function run(signal: AbortSignal, runGeneration: number): Promise<void> {
    let delayMs = BACKOFF_BASE_MS;
    while (!signal.aborted && runGeneration === generation) {
      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      let forceImmediateReconnect = false;
      try {
        const res = await deps.open(signal);
        const body = res.data?.body;
        if (!body) throw new Error('Session-list SSE response has no body');
        reader = body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (!signal.aborted && runGeneration === generation) {
          const chunk = await reader.read();
          if (chunk.done) break;
          const decoded = decodeSseText(buffer + decoder.decode(chunk.value, { stream: true }));
          buffer = decoded.carry;
          for (const frame of decoded.frames) {
            if (signal.aborted || runGeneration !== generation) break;
            if (frame.event === 'session.list.snapshot') {
              const payload = parseJsonObject(frame.data);
              if (!Array.isArray(payload.sessions)) throw new Error('Invalid session.list.snapshot');
              const sessions = payload.sessions.map(validateSessionItem);
              const nextCursor = typeof payload.nextCursor === 'string' ? payload.nextCursor : null;
              deps.onSnapshot(sessions, nextCursor);
              delayMs = BACKOFF_BASE_MS;
            } else if (frame.event === 'session.list.upsert') {
              const payload = parseJsonObject(frame.data);
              const session = validateSessionItem(payload.session);
              deps.onUpsert(session);
              delayMs = BACKOFF_BASE_MS;
            } else if (frame.event === 'session.list.remove') {
              const payload = parseJsonObject(frame.data);
              if (typeof payload.sessionId !== 'string' || !OPAQUE_ID.test(payload.sessionId)) {
                throw new Error('Invalid session.list.remove');
              }
              const reason = typeof payload.reason === 'string' ? payload.reason : undefined;
              deps.onRemove(payload.sessionId, reason);
              delayMs = BACKOFF_BASE_MS;
            } else if (frame.event === 'session.list.resync_required') {
              forceImmediateReconnect = true;
              break;
            } else if (frame.event === 'daemon.draining') {
              const payload = parseJsonObject(frame.data);
              const gracePeriodMs = typeof payload.gracePeriodMs === 'number' ? payload.gracePeriodMs : undefined;
              deps.onDraining?.(gracePeriodMs);
            }
            // Unknown event names are ignored for minor-version forward compatibility (client-api.md §3.2).
          }
          if (forceImmediateReconnect) break;
        }
      } catch (error) {
        if (signal.aborted || runGeneration !== generation) return;
        if (isTerminalError(error)) return;
      } finally {
        if (reader) {
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
      }
      if (signal.aborted || runGeneration !== generation) return;
      if (forceImmediateReconnect) {
        delayMs = BACKOFF_BASE_MS;
        continue;
      }
      await waitForDelay(delayMs, signal);
      delayMs = Math.min(MAX_BACKOFF_MS, delayMs * 2);
    }
  }

  return {
    start() {
      if (controller !== null) return;
      controller = new AbortController();
      const current = ++generation;
      void run(controller.signal, current);
    },
    stop() {
      generation += 1;
      controller?.abort();
      controller = null;
    },
  };
}
