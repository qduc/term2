import WebSocket from 'ws';

export type WebSocketFactory = (url: string, options: { headers: Record<string, string> }) => WebSocket;

export type WebSocketCloseInfo = { code?: number; reason?: string };

function describeCloseInfo(info: WebSocketCloseInfo | null): string {
  if (!info) return '';
  const parts: string[] = [];
  if (typeof info.code === 'number') parts.push(`code=${info.code}`);
  if (info.reason) parts.push(`reason="${info.reason}"`);
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

function toCloseInfo(code?: number, reason?: WebSocket.RawData | Buffer | string): WebSocketCloseInfo {
  const info: WebSocketCloseInfo = {};
  if (typeof code === 'number') info.code = code;
  if (reason) {
    const text = typeof reason === 'string' ? reason : Buffer.isBuffer(reason) ? reason.toString() : String(reason);
    if (text) info.reason = text;
  }
  return info;
}

export class TimedWsConnection {
  private lastClose: WebSocketCloseInfo | null = null;

  private constructor(private readonly ws: WebSocket, private readonly idleTimeoutMs: number) {}

  getLastClose(): WebSocketCloseInfo | null {
    return this.lastClose;
  }

  static async connect(
    url: string,
    headers: Record<string, string>,
    opts: { connectTimeoutMs: number; idleTimeoutMs: number },
    signal?: AbortSignal,
    wsFactory: WebSocketFactory = (u, o) => new WebSocket(u, o),
  ): Promise<TimedWsConnection> {
    if (signal?.aborted) {
      throw new Error('Aborted');
    }

    const ws = wsFactory(url, { headers });

    if (signal?.aborted) {
      ws.terminate();
      throw new Error('Aborted');
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };

      const timeout = setTimeout(() => {
        settle(() => {
          ws.terminate();
          reject(new Error(`WebSocket open timed out after ${opts.connectTimeoutMs}ms`));
        });
      }, opts.connectTimeoutMs);

      const cleanup = () => {
        clearTimeout(timeout);
        ws.off('open', onOpen);
        ws.off('error', onError);
        ws.off('close', onClose);
        signal?.removeEventListener('abort', onAbort);
      };

      const onOpen = () => {
        settle(() => resolve());
      };

      const onError = (err: Error) => {
        settle(() => reject(err));
      };

      const onClose = (code?: number, reason?: Buffer) => {
        const info = toCloseInfo(code, reason);
        settle(() => reject(new Error(`WebSocket closed before opening${describeCloseInfo(info)}`)));
      };

      const onAbort = () => {
        settle(() => {
          ws.terminate();
          reject(new Error('Aborted'));
        });
      };

      if (signal?.aborted) {
        onAbort();
        return;
      }

      ws.once('open', onOpen);
      ws.once('error', onError);
      ws.once('close', onClose);
      signal?.addEventListener('abort', onAbort, { once: true });
    });

    return new TimedWsConnection(ws, opts.idleTimeoutMs);
  }

  async nextFrame(
    signal?: AbortSignal,
    override?: { timeoutMs: number; timeoutErrorMessage?: string },
  ): Promise<string | null> {
    if (signal?.aborted) {
      this.ws.terminate();
      throw new Error('Aborted');
    }

    const effectiveTimeoutMs = override?.timeoutMs ?? this.idleTimeoutMs;
    const timeoutErrorMessage = override?.timeoutErrorMessage ?? `WebSocket idle timeout after ${this.idleTimeoutMs}ms`;

    return await new Promise<string | null>((resolve, reject) => {
      let settled = false;

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };

      const timeout = setTimeout(() => {
        settle(() => {
          this.ws.terminate();
          reject(new Error(timeoutErrorMessage));
        });
      }, effectiveTimeoutMs);

      const cleanup = () => {
        clearTimeout(timeout);
        this.ws.off('message', onMessage);
        this.ws.off('error', onError);
        this.ws.off('close', onClose);
        signal?.removeEventListener('abort', onAbort);
      };

      const onMessage = (data: WebSocket.RawData) => {
        settle(() => {
          resolve(typeof data === 'string' ? data : data.toString());
        });
      };

      const onError = (err: Error) => {
        settle(() => reject(err));
      };

      const onClose = (code?: number, reason?: Buffer) => {
        this.lastClose = toCloseInfo(code, reason);
        settle(() => resolve(null));
      };

      const onAbort = () => {
        settle(() => {
          this.ws.terminate();
          reject(new Error('Aborted'));
        });
      };

      if (signal?.aborted) {
        onAbort();
        return;
      }

      this.ws.once('message', onMessage);
      this.ws.once('error', onError);
      this.ws.once('close', onClose);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  send(data: string) {
    this.ws.send(data);
  }

  async close() {
    this.ws.close();
  }
}
