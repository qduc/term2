import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { dirname } from 'node:path';
import { chmod, mkdir, unlink } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
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

export type GatewayPairingHandler = (input: {
  body: unknown;
  request: IncomingMessage;
  url: URL;
}) => Promise<GatewayRpcResult>;

export type GatewayTlsOptions = {
  certPath: string;
  keyPath: string;
  caPath?: string;
  requireClientCert: boolean;
};

type GatewayTransportOptions =
  | { socketPath: string; host?: never; port?: never; tls?: never }
  | { socketPath?: never; host?: string; port: number; tls: GatewayTlsOptions };

export type GatewayServerOptions = GatewayTransportOptions & {
  verifier: AssertionVerifier;
  handler: GatewayRpcHandler;
  pairingHandler?: GatewayPairingHandler;
  lifecycle?: GatewayLifecycle;
};

/** Private Unix-socket or TLS network control server. */
export class GatewayServer {
  readonly #socketPath?: string;
  readonly #host?: string;
  readonly #port?: number;
  readonly #tls?: { cert: Buffer; key: Buffer; ca?: Buffer; requireClientCert: boolean };
  readonly #verifier: AssertionVerifier;
  readonly #handler: GatewayRpcHandler;
  readonly #pairingHandler?: GatewayPairingHandler;
  readonly #pairingEnabled: boolean;
  readonly #lifecycle: GatewayLifecycle;
  #server?: Server;

  constructor(options: GatewayServerOptions) {
    if ('socketPath' in options) {
      if (!options.socketPath || !options.socketPath.startsWith('/'))
        throw new Error('gateway requires an absolute Unix socket path');
      this.#socketPath = options.socketPath;
    } else {
      if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65_535)
        throw new Error('gateway requires a valid network port');
      this.#host = options.host?.trim() || '127.0.0.1';
      const tls = options.tls;
      if (!tls.certPath || !tls.keyPath || typeof tls.requireClientCert !== 'boolean')
        throw new Error('gateway requires TLS certificate configuration');
      this.#port = options.port;
      this.#tls = {
        cert: readFileSync(tls.certPath),
        key: readFileSync(tls.keyPath),
        ...(tls.caPath ? { ca: readFileSync(tls.caPath) } : {}),
        requireClientCert: tls.requireClientCert,
      };
    }
    this.#verifier = options.verifier;
    this.#handler = options.handler;
    this.#pairingHandler = options.pairingHandler;
    this.#pairingEnabled = options.pairingHandler !== undefined;
    this.#lifecycle = options.lifecycle ?? new GatewayLifecycle();
  }

  get lifecycle(): GatewayLifecycle {
    return this.#lifecycle;
  }
  get listening(): boolean {
    return this.#server?.listening === true;
  }
  get address(): ReturnType<Server['address']> {
    return this.#server?.address() ?? null;
  }

  async start(): Promise<void> {
    if (this.#server) return;
    if (this.#socketPath) {
      await mkdir(dirname(this.#socketPath), { recursive: true });
      await unlink(this.#socketPath).catch(() => undefined);
      this.#server = createServer((request, response) => void this.#handle(request, response));
    } else {
      const tls = this.#tls!;
      this.#server = createHttpsServer(
        {
          cert: tls.cert,
          key: tls.key,
          ...(tls.ca ? { ca: tls.ca } : {}),
          requestCert: tls.requireClientCert,
          rejectUnauthorized: tls.requireClientCert,
        },
        (request, response) => void this.#handle(request, response),
      );
    }
    await new Promise<void>((resolve, reject) => {
      this.#server!.once('error', reject);
      const onListening = () => {
        this.#server!.removeListener('error', reject);
        if (this.#socketPath) void chmod(this.#socketPath, 0o660).then(resolve, reject);
        else resolve();
      };
      if (this.#socketPath) this.#server!.listen(this.#socketPath, onListening);
      else this.#server!.listen(this.#port!, this.#host!, onListening);
    });
  }

  async close(): Promise<void> {
    if (!this.#server) return;
    const server = this.#server;
    this.#server = undefined;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (this.#socketPath) await unlink(this.#socketPath).catch(() => undefined);
  }

  async shutdown(graceMs: number): Promise<void> {
    await this.close();
    await this.#lifecycle.shutdown(graceMs);
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestUrl = new URL(request.url ?? '/', 'http://gateway');
    if (request.method === 'POST' && requestUrl.pathname === '/private/agent/v1/pairing/register') {
      if (!this.#pairingHandler) return send(response, 404, errorBody('not_found', 'gateway route not found'));
      return this.#handlePairing(request, response, requestUrl);
    }
    const token = request.headers['x-term2-assertion'];
    if (typeof token !== 'string')
      return send(
        response,
        401,
        errorBody(this.#pairingEnabled ? 'pairing_required' : 'authentication_required', 'gateway assertion required'),
      );
    let claims: GatewayAssertionClaims;
    try {
      claims = this.#verifier.verify(token);
    } catch {
      return send(
        response,
        401,
        errorBody(this.#pairingEnabled ? 'pairing_required' : 'authentication_required', 'gateway assertion rejected'),
      );
    }
    const correlationHeader = request.headers['x-correlation-id'];
    if (
      correlationHeader !== undefined &&
      (typeof correlationHeader !== 'string' || !CORRELATION_ID_PATTERN.test(correlationHeader))
    )
      return send(response, 400, errorBody('validation_error', 'correlation ID is invalid'));
    if (request.method !== 'GET' && request.method !== 'POST' && request.method !== 'PUT')
      return send(response, 405, errorBody('protocol_conflict', 'gateway method is not supported'));
    if (
      request.method !== 'GET' &&
      request.headers['content-type'] &&
      !String(request.headers['content-type']).toLowerCase().startsWith('application/json')
    )
      return send(response, 415, errorBody('unsupported_media_type', 'gateway expects JSON'));
    let body = '';
    if (request.method !== 'GET') {
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
        url: requestUrl,
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

  async #handlePairing(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    if (
      request.headers['content-type'] &&
      !String(request.headers['content-type']).toLowerCase().startsWith('application/json')
    )
      return send(response, 415, errorBody('unsupported_media_type', 'gateway expects JSON'));
    let body = '';
    try {
      for await (const chunk of request) {
        body += String(chunk);
        if (Buffer.byteLength(body) > MAX_REQUEST_BYTES)
          return send(response, 413, errorBody('request_too_large', 'gateway request is too large'));
      }
    } catch {
      return send(response, 400, errorBody('validation_error', 'gateway request is invalid'));
    }
    let parsed: unknown = null;
    try {
      parsed = body ? JSON.parse(body) : null;
    } catch {
      return send(response, 400, errorBody('validation_error', 'gateway request is invalid'));
    }
    try {
      const result = await this.#pairingHandler!({ body: parsed, request, url });
      send(response, result.status, result.body, result.headers);
    } catch {
      send(response, 503, errorBody('gateway_unavailable', 'gateway unavailable', true));
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
