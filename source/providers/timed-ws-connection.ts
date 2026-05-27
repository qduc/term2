import WebSocket from 'ws';

export type WebSocketFactory = (url: string, options: { headers: Record<string, string> }) => WebSocket;

export class TimedWsConnection {
  private constructor(private readonly ws: WebSocket, private readonly idleTimeoutMs: number) {}

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

      const onClose = () => {
        settle(() => reject(new Error('WebSocket closed before opening')));
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

  async nextFrame(signal?: AbortSignal): Promise<string | null> {
    if (signal?.aborted) {
      this.ws.terminate();
      throw new Error('Aborted');
    }

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
          reject(new Error(`WebSocket idle timeout after ${this.idleTimeoutMs}ms`));
        });
      }, this.idleTimeoutMs);

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

      const onClose = () => {
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
