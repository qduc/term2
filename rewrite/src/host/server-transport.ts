/** Private Unix-socket / TLS HTTP framing only; no Session, admission writer or legacy runtime. */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createConnection } from 'node:net';
import { readFileSync } from 'node:fs';
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ServerAuthentication } from './server-auth.js';
import type { ServerRequest, ServerResult, ServerTransportOptions } from './server-contracts.js';
import { mapServerError, publicError, ServerHttpError as HttpIngressError } from './server-errors.js';

const MAX_REQUEST_BYTES = 1024 * 1024;
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
export type DirectServerTransportOptions = ServerTransportOptions & {
  authentication: ServerAuthentication;
  handler(input: ServerRequest): Promise<ServerResult>;
};
/** start/stop own only network attachments. The app separately disposes Host and auth storage. */
export class DirectServerTransport {
  readonly #options: DirectServerTransportOptions;
  readonly #responses = new Set<ServerResponse>();
  #server?: Server;
  #ownsSocket = false;
  #starting?: Promise<void>;
  constructor(options: DirectServerTransportOptions) {
    if (options.socketPath !== undefined) {
      if (!options.socketPath.startsWith('/') || options.socketPath.includes('\0'))
        throw new Error('gateway requires an absolute Unix socket path');
    } else if (
      !Number.isSafeInteger(options.port) ||
      options.port < 0 ||
      options.port > 65_535 ||
      !options.tls?.certPath ||
      !options.tls.keyPath ||
      typeof options.tls.requireClientCert !== 'boolean'
    ) {
      throw new Error('gateway requires a valid port and TLS certificate configuration');
    }
    this.#options = options;
  }
  get listening(): boolean {
    return this.#server?.listening === true;
  }
  get address(): ReturnType<Server['address']> {
    return this.#server?.address() ?? null;
  }
  async start(): Promise<void> {
    if (this.#starting) return this.#starting;
    if (this.listening) return;
    this.#starting = this.#start();
    try {
      await this.#starting;
    } finally {
      this.#starting = undefined;
    }
  }
  async #start(): Promise<void> {
    const options = this.#options;
    if (options.socketPath !== undefined) {
      await mkdir(dirname(options.socketPath), { recursive: true });
      await prepareSocket(options.socketPath);
      this.#server = createServer((request, response) => void this.#handle(request, response));
    } else {
      const tls = options.tls;
      this.#server = createHttpsServer(
        {
          cert: readFileSync(tls.certPath),
          key: readFileSync(tls.keyPath),
          ...(tls.caPath ? { ca: readFileSync(tls.caPath) } : {}),
          requestCert: tls.requireClientCert,
          rejectUnauthorized: tls.requireClientCert,
        },
        (request, response) => void this.#handle(request, response),
      );
    }
    const server = this.#server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        const ready = () => {
          server.off('error', reject);
          resolve();
        };
        if (options.socketPath !== undefined) server.listen(options.socketPath, ready);
        else server.listen(options.port, options.host?.trim() || '127.0.0.1', ready);
      });
      if (options.socketPath !== undefined) {
        this.#ownsSocket = true;
        await chmod(options.socketPath, 0o660);
      }
    } catch (error) {
      await this.stop();
      throw error;
    }
  }
  async stop(): Promise<void> {
    const server = this.#server;
    if (!server) return;
    this.#server = undefined;
    for (const response of this.#responses) response.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
        else resolve();
      }),
    );
    if (this.#ownsSocket && this.#options.socketPath !== undefined) {
      this.#ownsSocket = false;
      await unlink(this.#options.socketPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }
  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.#responses.add(response);
    response.once('close', () => this.#responses.delete(response));
    let result: ServerResult | undefined;
    try {
      const url = new URL(request.url ?? '/', 'http://gateway');
      const auth = this.#options.authentication;
      if (request.method === 'POST' && url.pathname === '/private/agent/v1/pairing/register') {
        result = auth.register
          ? await auth.register(await readBody(request))
          : publicError(404, 'not_found', 'gateway route not found');
      } else {
        const token = request.headers['x-term2-assertion'];
        const authError = () =>
          publicError(
            401,
            auth.register ? 'pairing_required' : 'authentication_required',
            'gateway assertion required',
          );
        if (typeof token !== 'string') {
          send(response, authError());
          return;
        }
        let claims;
        try {
          claims = auth.verify(token);
        } catch {
          send(response, {
            ...authError(),
            body: {
              error: {
                code: auth.register ? 'pairing_required' : 'authentication_required',
                message: 'gateway assertion rejected',
              },
            },
          });
          return;
        }
        const correlationId = request.headers['x-correlation-id'];
        if (
          correlationId !== undefined &&
          (typeof correlationId !== 'string' || !CORRELATION_ID_PATTERN.test(correlationId))
        ) {
          send(response, publicError(400, 'validation_error', 'correlation ID is invalid'));
          return;
        }
        if (!['GET', 'POST', 'PUT', 'DELETE'].includes(request.method ?? '')) {
          send(response, publicError(405, 'protocol_conflict', 'gateway method is not supported'));
          return;
        }
        result = await this.#options.handler({
          claims,
          body: await readBody(request),
          request,
          url,
          ...(typeof correlationId === 'string' ? { correlationId } : {}),
        });
      }
      if (response.destroyed) return;
      if (result.stream) {
        response.writeHead(result.status, result.headers);
        await result.stream.start(response, request);
      } else send(response, result);
    } catch (error) {
      if (!response.headersSent && !response.destroyed) send(response, mapServerError(error));
      else response.destroy();
    } finally {
      result?.stream?.close();
    }
  }
}

/** A live peer is never unlinked: in particular, do not displace the separately running old CLI. */
async function prepareSocket(socketPath: string): Promise<void> {
  const existing = await lstat(socketPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!existing) return;
  if (!existing.isSocket()) throw new Error('gateway socket path exists and is not a socket');
  const stale = await new Promise<boolean>((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') resolve(true);
      else reject(error);
    });
  });
  if (!stale) throw new Error('gateway socket is already in use');
  await unlink(socketPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
}
async function readBody(request: IncomingMessage): Promise<unknown> {
  if (request.method === 'GET') return null;
  const type = request.headers['content-type'];
  if (type && !String(type).toLowerCase().startsWith('application/json'))
    throw new HttpIngressError(415, 'unsupported_media_type', 'gateway expects JSON');
  // Do not break a request's async iterator at the cap: that destroys its socket before the
  // 413 can be sent. Stop collecting and drain the rejected upload without retaining bytes.
  const body = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const cleanup = () => {
      request.off('data', data);
      request.off('end', end);
      request.off('error', failed);
      request.off('aborted', failed);
    };
    const failed = () => {
      cleanup();
      reject(new HttpIngressError(400, 'validation_error', 'gateway request is invalid'));
    };
    const data = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_REQUEST_BYTES) {
        cleanup();
        request.resume();
        reject(new HttpIngressError(413, 'request_too_large', 'gateway request is too large'));
      } else chunks.push(buffer);
    };
    const end = () => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    request.on('data', data);
    request.once('end', end);
    request.once('error', failed);
    request.once('aborted', failed);
    if (request.aborted) failed();
  });
  try {
    return body.length ? JSON.parse(body.toString('utf8')) : null;
  } catch {
    throw new HttpIngressError(400, 'validation_error', 'gateway request is invalid');
  }
}

function send(response: ServerResponse, result: ServerResult): void {
  response.statusCode = result.status;
  response.setHeader('content-type', 'application/json');
  for (const [key, value] of Object.entries(result.headers ?? {})) response.setHeader(key, value);
  response.end(JSON.stringify(result.body));
}
