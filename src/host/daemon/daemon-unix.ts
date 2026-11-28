/**
 * Local-owner Unix Domain Socket NDJSON Server (`transport-unix.md` v1.0).
 *
 * Security & guard contracts:
 * - Binds with process `umask(0o077)` + `chmod(socketPath, 0o600)`.
 * - Incremental 4 MiB inbound line cap BEFORE `\n` (via `unix-framing.ts`).
 * - 5_000 ms pre-handshake timeout; only `protocol.hello` and idle `daemon.shutdown` allowed before welcome.
 * - Per-connection caps: 64 in-flight requests, 32 active subscriptions, 8 MiB outbound buffer, 10s drain timeout.
 * - Per-stream queue cap: 256 events (sheds transient `session.live` before emitting terminal `resync_required`).
 * - Monotonic non-reused `streamId`, FIFO silence after detach/terminal, EOF auto-detach without cancelling sessions.
 */
import fs from 'node:fs';
import net from 'node:net';
import {
  CLIENT_API_SCHEMAS,
  type ClientApiError,
  type DaemonDrainingEvent,
  type UnixEventFrame,
  type UnixResponseFrame,
} from '../../protocol/client-api/client-api-schema.js';
import {
  CLIENT_API_MIN_SUPPORTED_VERSION,
  CLIENT_API_VERSION,
  isClientApiVersionAtLeast,
  minimumClientApiVersion,
  negotiateCapabilities,
  negotiateProtocolVersion,
  requiredClientApiCapability,
} from '../../protocol/client-api/version-negotiation.js';
import type { Principal } from '../in-process-direct-types.js';
import { ClientApiRpcError, toClientApiError } from './daemon-errors.js';
import type { DaemonRpc } from './daemon-rpc.js';
import { buildSlowConsumerFrame, type StreamEventFrame } from './daemon-streams.js';
import {
  attachIncrementalLineReader,
  UNIX_DRAIN_TIMEOUT_MS,
  UNIX_MAX_INBOUND_LINE_BYTES,
  UNIX_MAX_OUTBOUND_BUFFER_BYTES,
  UNIX_MAX_OUTBOUND_FRAME_BYTES,
} from './unix-framing.js';

const PRE_HANDSHAKE_TIMEOUT_MS = 5_000;
const MAX_IN_FLIGHT_REQUESTS = 64;
const MAX_SUBSCRIPTIONS = 32;
const MAX_STREAM_QUEUE = 256;

const STREAM_OPEN_METHODS = new Set(['session.list.subscribe', 'session.attach', 'settings.subscribe']);
const STREAM_CLOSE_OPEN_MAP = new Map<string, string>([
  ['session.list.unsubscribe', 'session.list.subscribe'],
  ['session.detach', 'session.attach'],
  ['settings.unsubscribe', 'settings.subscribe'],
]);

type ActiveStream = {
  readonly streamId: string;
  readonly method: string;
  readonly sessionId?: string;
  readonly queue: StreamEventFrame[];
  closed: boolean;
  unsubscribe: () => void;
};

type ClientConnection = {
  readonly socket: net.Socket;
  negotiation?: { readonly version: string; readonly capabilities: ReadonlySet<string> };
  closed: boolean;
  inFlight: number;
  pendingStreams: number;
  nextStreamSeq: number;
  readonly streams: Map<string, ActiveStream>;
  stopReader: () => void;
  handshakeTimer: ReturnType<typeof setTimeout> | null;
  drainTimer: ReturnType<typeof setTimeout> | null;
  backpressured: boolean;
};

export type DaemonUnixServerOptions = {
  readonly rpc: DaemonRpc;
  readonly localOwnerPrincipal: Principal;
  readonly daemonId: string;
  readonly daemonVersion: string;
  readonly pid: number;
  readonly capabilities: readonly string[];
  readonly activeTurnCount: () => number;
  readonly preHandshakeTimeoutMs?: number;
  readonly maxInboundLineBytes?: number;
  readonly maxOutboundBufferBytes?: number;
  readonly drainTimeoutMs?: number;
  readonly maxStreamQueue?: number;
};

export class DaemonUnixServer {
  readonly #server: net.Server;
  readonly #clients = new Set<ClientConnection>();
  readonly #preHandshakeTimeoutMs: number;
  readonly #maxInboundLineBytes: number;
  readonly #maxOutboundBufferBytes: number;
  readonly #drainTimeoutMs: number;
  readonly #maxStreamQueue: number;
  #listening = false;

  constructor(private readonly options: DaemonUnixServerOptions) {
    this.#preHandshakeTimeoutMs = options.preHandshakeTimeoutMs ?? PRE_HANDSHAKE_TIMEOUT_MS;
    this.#maxInboundLineBytes = options.maxInboundLineBytes ?? UNIX_MAX_INBOUND_LINE_BYTES;
    this.#maxOutboundBufferBytes = options.maxOutboundBufferBytes ?? UNIX_MAX_OUTBOUND_BUFFER_BYTES;
    this.#drainTimeoutMs = options.drainTimeoutMs ?? UNIX_DRAIN_TIMEOUT_MS;
    this.#maxStreamQueue = options.maxStreamQueue ?? MAX_STREAM_QUEUE;
    this.#server = net.createServer((socket) => this.#onConnection(socket));
  }

  attachedClientCount(): number {
    let count = 0;
    for (const client of this.#clients) if (!client.closed && client.negotiation) count += 1;
    return count;
  }

  async listen(socketPath: string): Promise<void> {
    if (this.#listening) return;
    const previousUmask = process.umask(0o077);
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          this.#server.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          this.#server.off('error', onError);
          resolve();
        };
        this.#server.once('error', onError);
        this.#server.once('listening', onListening);
        this.#server.listen(socketPath);
      });
      fs.chmodSync(socketPath, 0o600);
      this.#listening = true;
    } finally {
      process.umask(previousUmask);
    }
  }

  broadcastDraining(payload: DaemonDrainingEvent): void {
    const frame: UnixEventFrame = { kind: 'event', event: 'daemon.draining', payload };
    for (const client of [...this.#clients]) if (!client.closed && client.negotiation) this.#writeFrame(client, frame);
  }

  async close(): Promise<void> {
    for (const client of [...this.#clients]) {
      this.#cleanupClient(client);
      client.socket.destroy();
    }
    if (!this.#listening) return;
    this.#listening = false;
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  #onConnection(socket: net.Socket): void {
    const client: ClientConnection = {
      socket,
      closed: false,
      inFlight: 0,
      pendingStreams: 0,
      nextStreamSeq: 0,
      streams: new Map(),
      stopReader: () => undefined,
      handshakeTimer: null,
      drainTimer: null,
      backpressured: false,
    };
    this.#clients.add(client);
    client.handshakeTimer = setTimeout(() => {
      if (!client.negotiation && !client.closed) {
        this.#cleanupClient(client);
        socket.destroy();
      }
    }, this.#preHandshakeTimeoutMs);
    client.handshakeTimer.unref?.();
    client.stopReader = attachIncrementalLineReader(socket, {
      maxLineBytes: this.#maxInboundLineBytes,
      onLine: (line) => void this.#handleLine(client, line),
      onOverflow: () => {
        this.#cleanupClient(client);
        socket.destroy();
      },
    });

    socket.on('drain', () => {
      if (client.closed) return;
      client.backpressured = false;
      if (client.drainTimer) clearTimeout(client.drainTimer);
      client.drainTimer = null;
      this.#flushStreams(client);
    });

    const onEnd = () => this.#cleanupClient(client);
    socket.once('close', onEnd);
    socket.once('error', onEnd);
  }

  #cleanupClient(client: ClientConnection): void {
    if (client.closed) return;
    client.closed = true;
    this.#clients.delete(client);
    client.stopReader();
    if (client.handshakeTimer) clearTimeout(client.handshakeTimer);
    if (client.drainTimer) clearTimeout(client.drainTimer);
    client.handshakeTimer = null;
    client.drainTimer = null;
    for (const stream of [...client.streams.values()]) this.#retireStream(client, stream);
    client.streams.clear();
  }

  #retireStream(client: ClientConnection, stream: ActiveStream): void {
    if (stream.closed) return;
    stream.closed = true;
    stream.queue.length = 0;
    client.streams.delete(stream.streamId);
    try {
      stream.unsubscribe();
    } catch {
      // Unsubscribe cleanup must never crash the server.
    }
  }

  async #handleLine(client: ClientConnection, line: string): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      this.#sendError(client, 'invalid', { code: 'invalid_request', message: 'Malformed JSON frame.' });
      return;
    }
    const parsed = CLIENT_API_SCHEMAS.unixRequestFrame.safeParse(raw);
    if (!parsed.success) {
      const id =
        raw && typeof raw === 'object' && typeof (raw as { id?: unknown }).id === 'string'
          ? (raw as { id: string }).id
          : 'invalid';
      this.#sendError(client, id, {
        code: 'invalid_request',
        message: `Invalid request envelope: ${parsed.error.message}`,
      });
      return;
    }
    const { id, method, params } = parsed.data;
    if (client.inFlight >= MAX_IN_FLIGHT_REQUESTS) {
      this.#sendError(client, id, {
        code: 'busy',
        message: 'Too many concurrent in-flight requests on this connection.',
        retryable: true,
      });
      return;
    }

    client.inFlight += 1;
    try {
      if (!client.negotiation) {
        await this.#handlePreHandshake(client, id, method, params);
        return;
      }
      if (method === 'protocol.hello') {
        this.#sendError(client, id, {
          code: 'invalid_request',
          message: 'protocol.hello already completed on this connection.',
        });
        return;
      }
      const minVersion = minimumClientApiVersion(method);
      if (!isClientApiVersionAtLeast(client.negotiation.version, minVersion)) {
        throw new ClientApiRpcError(
          'invalid_request',
          `Method "${method}" requires Client API ${minVersion} (negotiated ${client.negotiation.version}).`,
        );
      }
      const requiredCap = requiredClientApiCapability(method);
      if (requiredCap && !client.negotiation.capabilities.has(requiredCap)) {
        throw new ClientApiRpcError('unavailable', `Capability "${requiredCap}" was not negotiated.`);
      }
      if (STREAM_OPEN_METHODS.has(method)) {
        await this.#handleStreamOpen(client, id, method, params);
        return;
      }
      const expectedOpen = STREAM_CLOSE_OPEN_MAP.get(method);
      if (expectedOpen) {
        this.#handleStreamClose(client, id, expectedOpen, params);
        return;
      }
      const result = await this.options.rpc.invoke(this.options.localOwnerPrincipal, method, params, {
        protocolVersion: client.negotiation.version,
      });
      if (!client.closed) this.#sendOk(client, id, result);
    } catch (error) {
      if (!client.closed) this.#sendError(client, id, toClientApiError(error));
    } finally {
      client.inFlight -= 1;
    }
  }

  async #handlePreHandshake(
    client: ClientConnection,
    id: string,
    method: string,
    params: Record<string, unknown> | undefined,
  ): Promise<void> {
    if (method === 'daemon.shutdown') {
      const parsed = CLIENT_API_SCHEMAS.daemonShutdownParams.safeParse(params ?? {});
      if (parsed.success && parsed.data.mode === 'graceful' && parsed.data.whenIdle === true) {
        const result = await this.options.rpc.invoke(this.options.localOwnerPrincipal, method, parsed.data);
        if (!client.closed) this.#sendOk(client, id, result);
        return;
      }
      this.#sendError(client, id, {
        code: 'invalid_request',
        message: 'Before protocol.hello, only daemon.shutdown({ mode: "graceful", whenIdle: true }) is allowed.',
      });
      return;
    }
    if (method !== 'protocol.hello') {
      this.#sendError(client, id, {
        code: 'invalid_request',
        message: 'protocol.hello is required before other methods.',
      });
      return;
    }

    const hello = CLIENT_API_SCHEMAS.protocolHelloParams.safeParse(params ?? {});
    if (!hello.success) {
      this.#sendError(client, id, {
        code: 'invalid_request',
        message: `Invalid protocol.hello: ${hello.error.message}`,
      });
      return;
    }

    const negotiated = negotiateProtocolVersion(hello.data.minSupportedVersion, hello.data.protocolVersion);
    if (!negotiated.ok) {
      this.#sendError(client, id, {
        code: 'protocol_incompatible',
        message: negotiated.reason,
        retryable: false,
        details: {
          daemonProtocolVersion: CLIENT_API_VERSION,
          daemonMinSupportedVersion: CLIENT_API_MIN_SUPPORTED_VERSION,
          daemonVersion: this.options.daemonVersion,
          activeTurnCount: this.options.activeTurnCount(),
        },
      });
      this.#cleanupClient(client);
      client.socket.end();
      return;
    }

    const capabilities = negotiateCapabilities(this.options.capabilities, hello.data.capabilities);
    client.negotiation = { version: negotiated.version, capabilities: new Set(capabilities) };
    if (client.handshakeTimer) clearTimeout(client.handshakeTimer);
    client.handshakeTimer = null;
    this.#sendOk(client, id, {
      protocolVersion: negotiated.version,
      daemonId: this.options.daemonId,
      daemonVersion: this.options.daemonVersion,
      pid: this.options.pid,
      capabilities,
    });
  }

  async #handleStreamOpen(
    client: ClientConnection,
    id: string,
    method: string,
    params: Record<string, unknown> | undefined,
  ): Promise<void> {
    if (client.streams.size + client.pendingStreams >= MAX_SUBSCRIPTIONS) {
      throw new ClientApiRpcError('busy', 'Maximum concurrent subscriptions reached on this connection.', {
        retryable: true,
      });
    }
    client.pendingStreams += 1;
    let registration: Awaited<ReturnType<DaemonRpc['openStream']>>;
    try {
      registration = await this.options.rpc.openStream(this.options.localOwnerPrincipal, method, params, {
        protocolVersion: client.negotiation?.version,
      });
    } finally {
      client.pendingStreams -= 1;
    }
    if (client.closed) {
      registration.start(() => undefined)();
      return;
    }
    const streamId = `sub-${++client.nextStreamSeq}`;
    const stream: ActiveStream = {
      streamId,
      method,
      ...(typeof params?.['sessionId'] === 'string' ? { sessionId: params['sessionId'] } : {}),
      queue: [],
      closed: false,
      unsubscribe: () => undefined,
    };
    client.streams.set(streamId, stream);
    this.#sendOk(client, id, { ...registration.result, streamId });
    if (registration.initialEvent) {
      this.#enqueueStreamEvent(client, stream, registration.initialEvent);
    }
    if (client.closed || stream.closed) {
      registration.start(() => undefined)();
      return;
    }
    stream.unsubscribe = registration.start((frame) => {
      this.#enqueueStreamEvent(client, stream, frame);
    });
  }

  #handleStreamClose(
    client: ClientConnection,
    id: string,
    expectedOpen: string,
    params: Record<string, unknown> | undefined,
  ): void {
    const parsed = CLIENT_API_SCHEMAS.unixStreamUnsubscribeParams.safeParse(params ?? {});
    if (!parsed.success) {
      throw new ClientApiRpcError('invalid_request', `Invalid unsubscribe params: ${parsed.error.message}`);
    }
    const stream = client.streams.get(parsed.data.streamId);
    if (stream && stream.method === expectedOpen) this.#retireStream(client, stream);
    this.#sendOk(client, id, {});
  }

  #enqueueStreamEvent(client: ClientConnection, stream: ActiveStream, frame: StreamEventFrame): void {
    if (client.closed || stream.closed) return;
    if (!client.backpressured && stream.queue.length === 0) {
      this.#sendEvent(client, stream, frame);
      return;
    }
    if (stream.queue.length >= this.#maxStreamQueue) {
      if (frame.transient) return;
      const transientIdx = stream.queue.findIndex((queued) => queued.transient === true);
      if (transientIdx !== -1) {
        stream.queue.splice(transientIdx, 1);
      } else {
        stream.queue.length = 0;
        this.#sendEvent(client, stream, buildSlowConsumerFrame(stream.method, stream.sessionId));
        return;
      }
    }
    stream.queue.push(frame);
  }

  #flushStreams(client: ClientConnection): void {
    if (client.closed || client.backpressured) return;
    let progress = true;
    while (progress && !client.closed && !client.backpressured) {
      progress = false;
      for (const stream of [...client.streams.values()]) {
        if (stream.closed || stream.queue.length === 0) continue;
        progress = true;
        this.#sendEvent(client, stream, stream.queue.shift()!);
        if (client.closed || client.backpressured) break;
      }
    }
  }

  #sendEvent(client: ClientConnection, stream: ActiveStream, frame: StreamEventFrame): void {
    this.#writeFrame(client, { kind: 'event', streamId: stream.streamId, event: frame.event, payload: frame.payload });
    if (frame.terminal) this.#retireStream(client, stream);
  }

  #sendOk(client: ClientConnection, id: string, result: Record<string, unknown>): void {
    this.#writeFrame(client, { kind: 'response', id, ok: true, result });
  }

  #sendError(client: ClientConnection, id: string, error: ClientApiError): void {
    this.#writeFrame(client, { kind: 'response', id, ok: false, error });
  }

  #writeFrame(client: ClientConnection, frame: UnixResponseFrame | UnixEventFrame): void {
    if (client.closed || client.socket.destroyed) return;
    const encoded = `${JSON.stringify(frame)}\n`;
    const byteLen = Buffer.byteLength(encoded, 'utf8');
    if (byteLen > UNIX_MAX_OUTBOUND_FRAME_BYTES) return;
    if (client.socket.writableLength + byteLen > this.#maxOutboundBufferBytes) {
      this.#cleanupClient(client);
      client.socket.destroy();
      return;
    }
    const ok = client.socket.write(encoded, 'utf8');
    if (!ok && !client.backpressured) {
      client.backpressured = true;
      client.drainTimer = setTimeout(() => {
        if (!client.closed && client.backpressured) {
          this.#cleanupClient(client);
          client.socket.destroy();
        }
      }, this.#drainTimeoutMs);
      client.drainTimer.unref?.();
    }
  }
}
