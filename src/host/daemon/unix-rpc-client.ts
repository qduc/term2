/**
 * Multiplexed NDJSON Unix Domain Socket Client (`transport-unix.md` v1.0).
 *
 * Wraps an already-handshaken `net.Socket` (from `connectOrStartDaemon`),
 * multiplexing unary `request`/`response` calls, `streamId`-keyed subscriptions,
 * and connection-level notifications (`daemon.draining`, `protocol.heartbeat`).
 */
import type net from 'node:net';
import {
  CLIENT_API_SCHEMAS,
  type UnixEventFrame,
  type UnixResponseFrame,
} from '../../protocol/client-api/client-api-schema.js';
import { ClientApiRpcError } from './daemon-errors.js';
import { attachIncrementalLineReader, UNIX_MAX_OUTBOUND_FRAME_BYTES } from './unix-framing.js';

const DEFAULT_RPC_TIMEOUT_MS = 30_000;

type PendingRequest = {
  readonly method: string;
  readonly resolve: (result: Record<string, unknown>) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout> | null;
  readonly onStreamId?: (streamId: string) => void;
};

export type UnixStreamHandlers = {
  readonly onEvent: (frame: UnixEventFrame) => void;
  readonly onClose?: (error?: Error) => void;
};

export type UnixStreamHandle = {
  readonly streamId: string;
  readonly result: Record<string, unknown>;
  /** Retire local handler; caller sends method-specific unsubscribe/detach RPC if needed. */
  retireLocal: () => void;
};

const TERMINAL_STREAM_EVENTS = new Set(['session.closed', 'session.resync_required', 'session.list.resync_required']);

export class UnixRpcClient {
  #nextId = 0;
  #closed = false;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #streams = new Map<string, UnixStreamHandlers>();
  readonly #connectionEventListeners = new Set<(frame: UnixEventFrame) => void>();
  readonly #closeListeners = new Set<(error?: Error) => void>();
  readonly #stopReader: () => void;

  constructor(private readonly socket: net.Socket) {
    this.#stopReader = attachIncrementalLineReader(socket, {
      maxLineBytes: UNIX_MAX_OUTBOUND_FRAME_BYTES,
      onLine: (line) => this.#handleLine(line),
      onOverflow: () => {
        this.#failClose(
          new ClientApiRpcError('internal_error', 'Daemon frame exceeded 16 MiB outbound limit.', {
            retryable: false,
          }),
        );
      },
    });
    const onEnd = () => {
      this.#failClose(new ClientApiRpcError('closed', 'Daemon Unix socket closed.', { retryable: true }));
    };
    const onError = (error: Error) => {
      this.#failClose(
        new ClientApiRpcError('closed', `Daemon Unix socket error: ${error.message}`, { retryable: true }),
      );
    };
    socket.once('close', onEnd);
    socket.once('error', onError);
  }

  get closed(): boolean {
    return this.#closed;
  }

  onConnectionEvent(listener: (frame: UnixEventFrame) => void): () => void {
    this.#connectionEventListeners.add(listener);
    return () => {
      this.#connectionEventListeners.delete(listener);
    };
  }

  onClose(listener: (error?: Error) => void): () => void {
    if (this.#closed) {
      listener();
      return () => undefined;
    }
    this.#closeListeners.add(listener);
    return () => {
      this.#closeListeners.delete(listener);
    };
  }

  request<T extends Record<string, unknown> = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = DEFAULT_RPC_TIMEOUT_MS,
  ): Promise<T> {
    return this.#sendRequest<T>(method, params, timeoutMs);
  }

  async subscribe(
    method: string,
    params: Record<string, unknown> | undefined,
    handlers: UnixStreamHandlers,
    timeoutMs = DEFAULT_RPC_TIMEOUT_MS,
  ): Promise<UnixStreamHandle> {
    let registeredStreamId: string | null = null;
    const result = await this.#sendRequest<Record<string, unknown>>(method, params, timeoutMs, (streamId) => {
      // Register synchronously inside the response handler before the next NDJSON line is read
      // so initial snapshot/event frames on the same socket chunk are never missed.
      registeredStreamId = streamId;
      this.#streams.set(streamId, handlers);
    });
    const streamId = registeredStreamId ?? (typeof result['streamId'] === 'string' ? result['streamId'] : '');
    if (!streamId) {
      throw new ClientApiRpcError('internal_error', `Stream method "${method}" did not return a streamId.`);
    }
    return {
      streamId,
      result,
      retireLocal: () => {
        this.#streams.delete(streamId);
      },
    };
  }

  close(): void {
    if (this.#closed) return;
    this.#failClose(undefined);
  }

  #sendRequest<T extends Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> | undefined,
    timeoutMs: number,
    onStreamId?: (streamId: string) => void,
  ): Promise<T> {
    if (this.#closed || this.socket.destroyed) {
      return Promise.reject(
        new ClientApiRpcError('closed', `Daemon client is closed (calling ${method}).`, { retryable: true }),
      );
    }
    const id = `req-${++this.#nextId}`;
    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              if (!this.#pending.delete(id)) return;
              reject(
                new ClientApiRpcError('unavailable', `Timed out waiting for daemon response to ${method}.`, {
                  retryable: true,
                }),
              );
            }, timeoutMs)
          : null;
      timer?.unref?.();
      this.#pending.set(id, {
        method,
        resolve: resolve as (result: Record<string, unknown>) => void,
        reject,
        timer,
        onStreamId,
      });
      const payload = `${JSON.stringify({ kind: 'request', id, method, ...(params ? { params } : {}) })}\n`;
      this.socket.write(payload, 'utf8');
    });
  }

  #handleLine(line: string): void {
    if (this.#closed) return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return;
    }
    const parsed = CLIENT_API_SCHEMAS.unixFrame.safeParse(raw);
    if (!parsed.success) return;
    const frame = parsed.data;
    if (frame.kind === 'response') {
      this.#handleResponse(frame);
      return;
    }
    if (frame.kind === 'event') {
      this.#handleEvent(frame);
    }
  }

  #handleResponse(frame: UnixResponseFrame): void {
    const pending = this.#pending.get(frame.id);
    if (!pending) return;
    this.#pending.delete(frame.id);
    if (pending.timer) clearTimeout(pending.timer);
    if (!frame.ok) {
      pending.reject(
        new ClientApiRpcError(frame.error.code, frame.error.message, {
          retryable: frame.error.retryable,
          details: frame.error.details,
        }),
      );
      return;
    }
    const streamId = frame.result['streamId'];
    if (pending.onStreamId && typeof streamId === 'string' && streamId.length > 0) {
      pending.onStreamId(streamId);
    }
    pending.resolve(frame.result);
  }

  #handleEvent(frame: UnixEventFrame): void {
    if (frame.streamId) {
      const handler = this.#streams.get(frame.streamId);
      if (!handler) return;
      if (TERMINAL_STREAM_EVENTS.has(frame.event)) {
        this.#streams.delete(frame.streamId);
      }
      handler.onEvent(frame);
      return;
    }
    for (const listener of [...this.#connectionEventListeners]) {
      listener(frame);
    }
  }

  #failClose(error: Error | undefined): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#stopReader();
    const pendingError = error ?? new ClientApiRpcError('closed', 'Daemon Unix client closed.', { retryable: true });
    for (const [, pending] of this.#pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(pendingError);
    }
    this.#pending.clear();
    for (const [, stream] of this.#streams) {
      stream.onClose?.(error);
    }
    this.#streams.clear();
    for (const listener of [...this.#closeListeners]) {
      listener(error);
    }
    this.#closeListeners.clear();
    this.#connectionEventListeners.clear();
    if (!this.socket.destroyed) this.socket.destroy();
  }
}
