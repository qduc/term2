import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { dirname } from 'node:path';
import { chmod, mkdir, unlink } from 'node:fs/promises';
import type { AssertionVerifier } from './assertion.js';
import type { GatewayAssertionClaims } from './contracts.js';
import type { ReplayLiveSubscription } from './persistence/contracts.js';
import { GatewayLifecycle } from './lifecycle.js';

const MAX_REQUEST_BYTES = 1024 * 1024;
export const GATEWAY_EVENT_STREAM_CONTENT_TYPE = 'text/event-stream';
export const GATEWAY_EVENT_HEARTBEAT_INTERVAL_MS = 15_000;
export const GATEWAY_EVENT_STREAM_HEARTBEAT = ': heartbeat';
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export type GatewayEventStream = {
  start(response: ServerResponse, request: IncomingMessage): Promise<void>;
};

export type GatewayRpcResult = {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  stream?: GatewayEventStream;
};

export type GatewayRpcHandler = (input: {
  claims: GatewayAssertionClaims;
  body: unknown;
  request: IncomingMessage;
  url: URL;
  correlationId?: string;
}) => Promise<GatewayRpcResult>;

export type GatewayServerOptions = {
  socketPath: string;
  verifier: AssertionVerifier;
  handler: GatewayRpcHandler;
  lifecycle?: GatewayLifecycle;
};

/** Private Unix-socket control server. It intentionally has no TCP mode. */
export class GatewayServer {
  readonly #socketPath: string;
  readonly #verifier: AssertionVerifier;
  readonly #handler: GatewayRpcHandler;
  readonly #lifecycle: GatewayLifecycle;
  #server?: Server;

  constructor(options: GatewayServerOptions) {
    if (!options.socketPath || !options.socketPath.startsWith('/'))
      throw new Error('gateway requires an absolute Unix socket path');
    this.#socketPath = options.socketPath;
    this.#verifier = options.verifier;
    this.#handler = options.handler;
    this.#lifecycle = options.lifecycle ?? new GatewayLifecycle();
  }

  get lifecycle(): GatewayLifecycle {
    return this.#lifecycle;
  }
  get listening(): boolean {
    return this.#server?.listening === true;
  }

  async start(): Promise<void> {
    if (this.#server) return;
    await mkdir(dirname(this.#socketPath), { recursive: true });
    await unlink(this.#socketPath).catch(() => undefined);
    this.#server = createServer((request, response) => void this.#handle(request, response));
    await new Promise<void>((resolve, reject) => {
      this.#server!.once('error', reject);
      this.#server!.listen(this.#socketPath, () => {
        this.#server!.removeListener('error', reject);
        void chmod(this.#socketPath, 0o660).then(resolve, reject);
      });
    });
  }

  async close(): Promise<void> {
    if (!this.#server) return;
    const server = this.#server;
    this.#server = undefined;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await unlink(this.#socketPath).catch(() => undefined);
  }

  async shutdown(graceMs: number): Promise<void> {
    await this.close();
    await this.#lifecycle.shutdown(graceMs);
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const token = request.headers['x-term2-assertion'];
    if (typeof token !== 'string')
      return send(response, 401, errorBody('authentication_required', 'gateway assertion required'));
    let claims: GatewayAssertionClaims;
    try {
      claims = this.#verifier.verify(token);
    } catch {
      return send(response, 401, errorBody('authentication_required', 'gateway assertion rejected'));
    }
    const correlationHeader = request.headers['x-correlation-id'];
    if (
      correlationHeader !== undefined &&
      (typeof correlationHeader !== 'string' || !CORRELATION_ID_PATTERN.test(correlationHeader))
    )
      return send(response, 400, errorBody('validation_error', 'correlation ID is invalid'));
    if (request.method !== 'GET' && request.method !== 'POST')
      return send(response, 405, errorBody('protocol_conflict', 'gateway method is not supported'));
    if (
      request.method === 'POST' &&
      request.headers['content-type'] &&
      !String(request.headers['content-type']).toLowerCase().startsWith('application/json')
    )
      return send(response, 415, errorBody('unsupported_media_type', 'gateway expects JSON'));
    let body = '';
    if (request.method === 'POST') {
      for await (const chunk of request) {
        body += String(chunk);
        if (Buffer.byteLength(body) > MAX_REQUEST_BYTES)
          return send(response, 413, errorBody('request_too_large', 'gateway request is too large'));
      }
    }
    let parsed: unknown = null;
    try {
      parsed = body ? JSON.parse(body) : null;
    } catch {
      return send(response, 400, errorBody('validation_error', 'gateway request is invalid'));
    }
    try {
      const result = await this.#handler({
        claims,
        body: parsed,
        request,
        url: new URL(request.url ?? '/', 'http://gateway'),
        ...(typeof correlationHeader === 'string' ? { correlationId: correlationHeader } : {}),
      });
      if (result.stream) {
        response.writeHead(result.status, result.headers);
        await result.stream.start(response, request);
        return;
      }
      send(response, result.status, result.body, result.headers);
    } catch {
      if (!response.headersSent) send(response, 503, errorBody('gateway_unavailable', 'gateway unavailable', true));
      else response.end();
    }
  }
}

function errorBody(code: string, message: string, retryable?: boolean): unknown {
  return { error: { code, message, ...(retryable === undefined ? {} : { retryable }) } };
}

function send(response: ServerResponse, status: number, body: unknown, headers?: Record<string, string>): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  for (const [key, value] of Object.entries(headers ?? {})) response.setHeader(key, value);
  response.end(JSON.stringify(body));
}

export type { ReplayLiveSubscription };
