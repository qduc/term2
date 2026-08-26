const WEBSOCKET_CONNECTING = 0;
const WEBSOCKET_OPEN = 1;
const WEBSOCKET_CLOSING = 2;
const WEBSOCKET_CLOSED = 3;

export type ResponsesWebSocketLike = {
  close(): void;
  socket?: { readyState?: number };
  on?(event: 'error', listener: () => void): unknown;
};

export type ResponsesWebSocketRelease = {
  keepAlive: boolean;
};

type SessionSocket<T extends ResponsesWebSocketLike> = {
  socket: T;
  fingerprint: string;
  inFlight: number;
  openedAt: number;
};

// The Codex WebSocket endpoint force-closes connections at ~60 minutes. A
// retained idle socket must be retired before that lifetime expires, or the
// next turn is handed a socket the server is about to kill mid-flight.
const MAX_RETAINED_SOCKET_AGE_MS = 50 * 60 * 1000;

/**
 * One Responses WebSocket per logical agent/session. A later acquire must not
 * close a sibling that is still connecting or in flight — that is how parallel
 * nested Codex explorers used to die with "WebSocket was closed before the
 * connection was established".
 */
export class ResponsesWebSocketSessions<T extends ResponsesWebSocketLike = ResponsesWebSocketLike> {
  #slots = new Map<string, Array<SessionSocket<T>>>();

  constructor(private readonly createSocket: (headers?: Record<string, string>) => T) {}

  acquire(headers?: Record<string, string>): T {
    const key = responsesWebSocketSessionKey(headers);
    const fingerprint = connectionFingerprint(headers);
    const retained: Array<SessionSocket<T>> = [];
    for (const slot of this.#slots.get(key) ?? []) {
      if (!isLive(slot.socket)) {
        this.#closeSocket(slot.socket);
        continue;
      }
      if (slot.inFlight === 0 && Date.now() - slot.openedAt >= MAX_RETAINED_SOCKET_AGE_MS) {
        this.#closeSocket(slot.socket);
        continue;
      }
      if (slot.inFlight === 0 && slot.fingerprint !== fingerprint) {
        this.#closeSocket(slot.socket);
        continue;
      }
      retained.push(slot);
    }

    const reusable = retained.find(
      (slot) => slot.fingerprint === fingerprint && slot.inFlight === 0 && isLive(slot.socket),
    );
    if (reusable) {
      reusable.inFlight += 1;
      this.#slots.set(key, retained);
      return reusable.socket;
    }

    const socket = this.createSocket(headers);
    // The SDK turns an unlistened socket error into a bare `Promise.reject`,
    // which crashes the process when an idle retained socket is closed by
    // the server (e.g. its 60-minute lifetime cap). Active streams attach
    // their own listener and still receive the same emitted event.
    socket.on?.('error', () => {});
    retained.push({ socket, fingerprint, inFlight: 1, openedAt: Date.now() });
    this.#slots.set(key, retained);
    return socket;
  }

  release(socket: T, options: ResponsesWebSocketRelease): void {
    for (const [key, list] of this.#slots) {
      const index = list.findIndex((slot) => slot.socket === socket);
      if (index < 0) continue;
      const slot = list[index]!;
      slot.inFlight = Math.max(0, slot.inFlight - 1);
      const withinLifetime = Date.now() - slot.openedAt < MAX_RETAINED_SOCKET_AGE_MS;
      if (options.keepAlive && withinLifetime && isLive(socket) && slot.inFlight === 0) {
        return;
      }
      this.#closeSocket(socket);
      list.splice(index, 1);
      if (list.length === 0) this.#slots.delete(key);
      return;
    }
    this.#closeSocket(socket);
  }

  close(): void {
    for (const list of this.#slots.values()) {
      for (const slot of list) {
        this.#closeSocket(slot.socket);
      }
    }
    this.#slots.clear();
  }

  #closeSocket(socket: T): void {
    try {
      socket.close();
    } catch {
      /* best effort */
    }
  }
}

export function responsesWebSocketSessionKey(headers?: Record<string, string>): string {
  if (!headers) return '';
  return headers['session-id'] ?? headers['session_id'] ?? headers['thread-id'] ?? '';
}

function connectionFingerprint(headers?: Record<string, string>): string {
  if (!headers) return '';
  const filtered: Record<string, string> = {};
  for (const key of Object.keys(headers).sort()) {
    if (key === 'x-codex-turn-metadata') continue;
    filtered[key] = headers[key]!;
  }
  return JSON.stringify(filtered);
}

function isLive(socket: ResponsesWebSocketLike): boolean {
  const readyState = socket.socket?.readyState;
  if (readyState === WEBSOCKET_CLOSING || readyState === WEBSOCKET_CLOSED) return false;
  if (readyState === WEBSOCKET_CONNECTING || readyState === WEBSOCKET_OPEN) return true;
  return readyState === undefined;
}
