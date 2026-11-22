import type { FixtureRecorder } from './fixture-recorder.js';
import { scrubHeaders, scrubUrlPath, scrubWebSocketMessage, type ScrubReport } from './wire-identity-scrubber.js';

/**
 * WebSocket capture adapter for recordings (plan D6, adapter 2).
 *
 * Seam: the OpenAI SDK's `ResponsesWS.prototype._createSocket(url, authHeaders)`, the one method through
 * which both `CodexResponsesTransport` and the OpenAI Responses WebSocket model open a socket
 * (`openai/resources/responses/ws`). The recorder wraps it **in the recording process only**; product code
 * is not changed and has no recording branch. The wrapper calls the original, then:
 *
 * - records the handshake (path and query, the SDK's auth headers merged with the caller's headers, as the
 *   SDK merges them) and the server's handshake status from the raw socket's `upgrade` event;
 * - wraps the returned adapter's `send` to record every outbound message (the SDK funnels both direct and
 *   queued sends through it);
 * - adds a `message` listener and a `close` listener to the raw `ws` socket. Adding listeners for these
 *   events does not change `ws` behaviour (unlike `unexpected-response`, which this deliberately does not
 *   listen to: a listener there would stop `ws` from failing the handshake itself).
 *
 * Every value is scrubbed by `wire-identity-scrubber.ts` as it is captured. Frames are kept per socket and
 * written one turn per socket, in the order the sockets were opened, so concurrent sockets never
 * interleave in one turn.
 *
 * `_createSocket` is an SDK-internal (protected) method. If an SDK upgrade renames it, `install` throws, and
 * a recording that opens no socket fails `assertCaptured`; the WebSocket self-validation in the provider
 * black-box tier (`websocket-recorder.test.ts`) exercises this seam on every run, so the break shows there
 * before anyone spends a live recording on it.
 */

type CapturedFrame =
  | { kind: 'ws-open'; urlPath: string; headers: Record<string, string>; status?: number }
  | { kind: 'ws-message'; direction: 'send' | 'receive'; data: unknown }
  | { kind: 'ws-close'; code: number; reason: string };

type CapturedSession = { frames: CapturedFrame[]; closed: boolean; open: CapturedFrame & { kind: 'ws-open' } };

type RawSocket = {
  on(event: string, listener: (...args: any[]) => void): unknown;
};
type SocketAdapter = { send(data: unknown): void; platformSocket?: RawSocket; _ws?: RawSocket };

export type WebSocketCapture = {
  readonly report: ScrubReport;
  /** Number of sockets the seam saw. */
  sessionCount(): number;
  /** Throws when the seam was never reached: the recording would otherwise be silently empty. */
  assertCaptured(): void;
  /** Waits (bounded) for every captured socket to report its close, so the close frame is recorded. */
  settle(timeoutMs?: number): Promise<void>;
  /** Appends one turn per captured socket to the recorder. */
  recordInto(recorder: FixtureRecorder): void;
  uninstall(): void;
};

export function installResponsesWebSocketCapture(ResponsesWSClass: { prototype: object }): WebSocketCapture {
  const prototype = ResponsesWSClass.prototype as { _createSocket?: (...args: any[]) => SocketAdapter };
  const original = prototype._createSocket;
  if (typeof original !== 'function')
    throw new Error(
      'WebSocket capture seam missing: ResponsesWS.prototype._createSocket is not a function in the installed openai SDK. ' +
        'Update scripts/provider-black-box/websocket-capture.ts for the new SDK before recording.',
    );
  const sessions: CapturedSession[] = [];
  const report: ScrubReport = [];
  const waiters = new Set<() => void>();
  const notify = () => {
    for (const waiter of waiters) waiter();
  };

  prototype._createSocket = function capturedCreateSocket(
    this: { _wsOptions?: { headers?: Record<string, unknown> } },
    url: URL,
    authHeaders: Record<string, string>,
  ): SocketAdapter {
    const adapter = original.call(this, url, authHeaders);
    const index = sessions.length;
    const path = `sessions[${index}]`;
    const open: CapturedSession['open'] = {
      kind: 'ws-open',
      urlPath: scrubUrlPath(url, `${path}.urlPath`, report),
      headers: scrubHeaders({ ...authHeaders, ...this._wsOptions?.headers }, `${path}.headers`, report),
    };
    const session: CapturedSession = { frames: [open], closed: false, open };
    sessions.push(session);
    const raw = adapter.platformSocket ?? adapter._ws;
    if (!raw) throw new Error('WebSocket capture seam: the SDK socket adapter exposes no platform socket.');
    let messageIndex = 0;
    raw.on('upgrade', (response: { statusCode?: number }) => {
      if (typeof response?.statusCode === 'number') open.status = response.statusCode;
    });
    raw.on('message', (data: unknown, isBinary: boolean) => {
      session.frames.push({
        kind: 'ws-message',
        direction: 'receive',
        data: scrubWebSocketMessage(data, isBinary, `${path}.messages[${messageIndex++}]`, report),
      });
    });
    raw.on('close', (code: number, reason: Buffer | string) => {
      session.frames.push({ kind: 'ws-close', code, reason: String(reason ?? '') });
      session.closed = true;
      notify();
    });
    const send = adapter.send.bind(adapter);
    adapter.send = (data: unknown) => {
      session.frames.push({
        kind: 'ws-message',
        direction: 'send',
        data: scrubWebSocketMessage(data, Buffer.isBuffer(data), `${path}.messages[${messageIndex++}]`, report),
      });
      send(data);
    };
    return adapter;
  };

  return {
    report,
    sessionCount: () => sessions.length,
    assertCaptured: () => {
      if (!sessions.length)
        throw new Error(
          'WebSocket capture recorded no socket: the request did not go through ResponsesWS (a WebSocket-to-HTTP fallback, or an SDK change to the capture seam).',
        );
    },
    settle: async (timeoutMs = 5_000) => {
      if (sessions.every((session) => session.closed)) return;
      await new Promise<void>((resolve) => {
        const waiter = () => {
          if (!sessions.every((session) => session.closed)) return;
          clearTimeout(timer);
          waiters.delete(waiter);
          resolve();
        };
        const timer = setTimeout(() => {
          waiters.delete(waiter);
          resolve();
        }, timeoutMs);
        waiters.add(waiter);
      });
    },
    recordInto: (recorder) => {
      for (const session of sessions) {
        recorder.startTurn();
        for (const frame of session.frames) {
          if (frame.kind === 'ws-open') recorder.recordWsOpen({ ...frame });
          else if (frame.kind === 'ws-close') recorder.recordWsClose({ ...frame });
          else recorder.recordWsMessage({ ...frame });
        }
      }
    },
    uninstall: () => {
      prototype._createSocket = original;
    },
  };
}
