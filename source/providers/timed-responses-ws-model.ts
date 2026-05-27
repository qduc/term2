import { Model, ModelRequest, ModelResponse, getCurrentTrace, withTrace } from '@openai/agents-core';
import { OpenAIResponsesWSModel } from '@openai/agents-openai';
import { WebSocketFactory } from './timed-ws-connection.js';
import WebSocket from 'ws';
import { AsyncLocalStorage } from 'node:async_hooks';

export type TimedWsOptions = {
  connectTimeoutMs: number;
  idleTimeoutMs: number;
  firstFrameTimeoutMs?: number;
  reuseConnection?: boolean;
};

const OriginalWebSocket = globalThis.WebSocket;

const wsContextStorage = new AsyncLocalStorage<{
  options: TimedWsOptions;
  wsFactory: WebSocketFactory;
  activeSocketRef: { socket: any | null };
}>();

class TimedWebSocketProxy {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  private readonly rawSocket: any;
  private timer: NodeJS.Timeout | null = null;
  private readonly listeners: Record<string, Set<any>> = {};

  isClosed = false;
  lastCloseCode: number | null = null;
  lastCloseReason: string | null = null;
  closeError: Error | null = null;

  constructor(url: string, initOptions?: any) {
    const context = wsContextStorage.getStore();
    const wsFactory = context?.wsFactory || ((u, o) => new (OriginalWebSocket as any)(u, o));
    const options = context?.options || { connectTimeoutMs: 0, idleTimeoutMs: 0 };

    if (context?.activeSocketRef) {
      context.activeSocketRef.socket = this;
    }

    this.rawSocket = wsFactory(url, initOptions);

    let connectTimer: NodeJS.Timeout | null = null;
    if (options.connectTimeoutMs > 0) {
      connectTimer = setTimeout(() => {
        if (this.readyState === this.CONNECTING) {
          const err = new Error(`WebSocket open timed out after ${options.connectTimeoutMs}ms`);
          this.closeError = err;
          this.emitError(err);
          this.close(4000, err.message);
        }
      }, options.connectTimeoutMs);
    }

    const forwardEvent = (type: string, event: any) => {
      const callbacks = this.listeners[type];
      if (callbacks) {
        let mappedEvent = event;
        if (
          type === 'message' &&
          (typeof event === 'string' || (event && typeof event === 'object' && !('data' in event)))
        ) {
          mappedEvent = { data: event };
        }
        for (const cb of callbacks) {
          try {
            cb(mappedEvent);
          } catch (e) {
            // ignore
          }
        }
      }
    };

    if (typeof this.rawSocket.addEventListener === 'function') {
      this.rawSocket.addEventListener('open', (e: any) => {
        if (connectTimer) clearTimeout(connectTimer);
        this.startTimer(options, true);
        forwardEvent('open', e);
      });
      this.rawSocket.addEventListener('message', (e: any) => {
        this.startTimer(options, false);
        forwardEvent('message', e);
      });
      this.rawSocket.addEventListener('close', (e: any) => {
        if (connectTimer) clearTimeout(connectTimer);
        this.clearTimer();
        if (this.isClosed) return;
        this.isClosed = true;
        this.lastCloseCode = e?.code;
        this.lastCloseReason = e?.reason;
        forwardEvent('close', e);
      });
      this.rawSocket.addEventListener('error', (e: any) => {
        if (connectTimer) clearTimeout(connectTimer);
        this.clearTimer();
        forwardEvent('error', e);
      });
    } else if (typeof this.rawSocket.on === 'function') {
      this.rawSocket.on('open', (e: any) => {
        if (connectTimer) clearTimeout(connectTimer);
        this.startTimer(options, true);
        forwardEvent('open', e);
      });
      this.rawSocket.on('message', (e: any) => {
        this.startTimer(options, false);
        forwardEvent('message', e);
      });
      this.rawSocket.on('close', (code: any, reason: any) => {
        if (connectTimer) clearTimeout(connectTimer);
        this.clearTimer();
        if (this.isClosed) return;
        this.isClosed = true;
        this.lastCloseCode = code;
        this.lastCloseReason = reason?.toString();
        forwardEvent('close', { code, reason: reason?.toString(), wasClean: true });
      });
      this.rawSocket.on('error', (e: any) => {
        if (connectTimer) clearTimeout(connectTimer);
        this.clearTimer();
        forwardEvent('error', e);
      });
    }
  }

  get readyState() {
    return this.rawSocket.readyState;
  }

  send(data: any) {
    const context = wsContextStorage.getStore();
    const options = context?.options || { connectTimeoutMs: 0, idleTimeoutMs: 0 };
    this.startTimer(options, true);
    return this.rawSocket.send(data);
  }

  close(code?: number, reason?: string) {
    this.clearTimer();
    if (this.isClosed) return;
    this.isClosed = true;
    this.lastCloseCode = code ?? null;
    this.lastCloseReason = reason ?? null;

    const closeEvent = { code: code ?? 1000, reason: reason ?? '', wasClean: true };
    const callbacks = this.listeners['close'];
    if (callbacks) {
      for (const cb of callbacks) {
        try {
          cb(closeEvent);
        } catch (e) {
          // ignore
        }
      }
    }

    if (typeof this.rawSocket.close === 'function') {
      try {
        return this.rawSocket.close(code, reason);
      } catch (e) {
        // ignore
      }
    }
  }

  terminate() {
    this.clearTimer();
    if (this.isClosed) return;
    this.isClosed = true;
    this.lastCloseCode = 1006;
    this.lastCloseReason = 'terminate';

    const closeEvent = { code: 1006, reason: 'terminate', wasClean: false };
    const callbacks = this.listeners['close'];
    if (callbacks) {
      for (const cb of callbacks) {
        try {
          cb(closeEvent);
        } catch (e) {
          // ignore
        }
      }
    }

    if (typeof this.rawSocket.terminate === 'function') {
      try {
        return this.rawSocket.terminate();
      } catch (e) {
        // ignore
      }
    } else if (typeof this.rawSocket.close === 'function') {
      try {
        return this.rawSocket.close();
      } catch (e) {
        // ignore
      }
    }
  }

  ping() {
    if (typeof this.rawSocket.ping === 'function') {
      return this.rawSocket.ping();
    }
  }

  addEventListener(type: string, callback: any, _opts?: any) {
    if (!this.listeners[type]) {
      this.listeners[type] = new Set();
    }
    this.listeners[type].add(callback);
  }

  removeEventListener(type: string, callback: any, _opts?: any) {
    if (this.listeners[type]) {
      this.listeners[type].delete(callback);
    }
  }

  on(type: string, callback: any) {
    this.addEventListener(type, callback);
  }

  off(type: string, callback: any) {
    this.removeEventListener(type, callback);
  }

  private emitError(err: Error) {
    const event = Object.assign(err, {
      error: err,
      message: err.message,
    });

    const callbacks = this.listeners['error'];
    if (callbacks) {
      for (const cb of callbacks) {
        try {
          cb(event);
        } catch (e) {
          // ignore
        }
      }
    }
  }

  private startTimer(options: TimedWsOptions, waitingForFirstFrame: boolean) {
    this.clearTimer();

    const timeoutMs =
      waitingForFirstFrame && typeof options.firstFrameTimeoutMs === 'number'
        ? options.firstFrameTimeoutMs
        : options.idleTimeoutMs;

    const timeoutMessage =
      waitingForFirstFrame && typeof options.firstFrameTimeoutMs === 'number'
        ? `WebSocket first frame timeout after ${options.firstFrameTimeoutMs}ms`
        : `WebSocket idle timeout after ${options.idleTimeoutMs}ms`;

    if (timeoutMs > 0) {
      this.timer = setTimeout(() => {
        const err = new Error(timeoutMessage);
        this.closeError = err;
        this.emitError(err);
        this.close(4001, err.message);
      }, timeoutMs);
    }
  }

  private clearTimer() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

export class TimedResponsesWSModel extends OpenAIResponsesWSModel implements Model {
  constructor(
    client: any,
    model: string,
    private readonly options: TimedWsOptions,
    private readonly wsFactory: WebSocketFactory = (url, opts) => new WebSocket(url, opts as any),
  ) {
    super(client, model, {
      reuseConnection: options.reuseConnection,
    });
  }

  override async getResponse(request: ModelRequest): Promise<ModelResponse> {
    const currentTrace = getCurrentTrace();
    if (currentTrace) {
      return super.getResponse(request);
    }
    return withTrace('timed-responses-ws-model-trace', () => super.getResponse(request));
  }

  protected override async _fetchResponse(request: ModelRequest, stream: boolean): Promise<any> {
    const originalWebSocket = globalThis.WebSocket;
    const socketRef = { socket: null as any };
    const superFetch = (req: ModelRequest, str: boolean) => super._fetchResponse(req, str as false);

    const handleFetchError = (err: any) => {
      if (
        err &&
        (err.name === 'APIUserAbortError' || err.message === 'Request was aborted.' || request.signal?.aborted)
      ) {
        throw new Error('Aborted');
      }

      const socket = socketRef.socket;
      if (socket) {
        if (socket.closeError) {
          throw socket.closeError;
        }
        if (socket.isClosed) {
          const parts: string[] = [];
          if (typeof socket.lastCloseCode === 'number') parts.push(`code=${socket.lastCloseCode}`);
          if (socket.lastCloseReason) parts.push(`reason="${socket.lastCloseReason}"`);
          const suffix = parts.length > 0 ? ` (${parts.join(', ')})` : '';
          throw new Error(`WebSocket connection closed before response completed${suffix}`);
        }
      }
      throw err;
    };

    if (!stream) {
      try {
        globalThis.WebSocket = TimedWebSocketProxy as any;
        return await wsContextStorage.run(
          { options: this.options, wsFactory: this.wsFactory, activeSocketRef: socketRef },
          () => superFetch(request, false),
        );
      } catch (err: any) {
        handleFetchError(err);
      } finally {
        globalThis.WebSocket = originalWebSocket;
      }
    }

    // Stream is true: we return a wrapped async generator
    const generatorPromise = wsContextStorage.run(
      { options: this.options, wsFactory: this.wsFactory, activeSocketRef: socketRef },
      () => {
        globalThis.WebSocket = TimedWebSocketProxy as any;
        return superFetch(request, true);
      },
    );

    const self = this;
    const wrappedGenerator = async function* () {
      const generator = await generatorPromise;
      try {
        while (true) {
          globalThis.WebSocket = TimedWebSocketProxy as any;
          const result = await wsContextStorage.run(
            { options: self.options, wsFactory: self.wsFactory, activeSocketRef: socketRef },
            () => (generator as any).next(),
          );
          globalThis.WebSocket = originalWebSocket;
          if (result.done) {
            break;
          }
          yield result.value;
        }
      } catch (err) {
        handleFetchError(err);
      } finally {
        globalThis.WebSocket = originalWebSocket;
      }
    };

    return wrappedGenerator();
  }

  override getRetryAdvice(args: any): any {
    const err = args.error;
    if (err instanceof Error) {
      const msg = err.message.toLowerCase();
      if (
        msg.includes('open timed out') ||
        msg.includes('closed before opening') ||
        msg.includes('timed out before opening') ||
        msg.includes('connection timed out') ||
        msg.includes('first frame timeout') ||
        msg.includes('aborted')
      ) {
        return {
          suggested: true,
          replaySafety: 'safe',
          reason: err.message,
        };
      }
      if (msg.includes('idle timeout') || msg.includes('closed before response completed')) {
        return {
          suggested: false,
          replaySafety: 'unsafe',
          reason: err.message,
        };
      }
    }
    return super.getRetryAdvice(args);
  }
}
