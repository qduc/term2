import { connect, createServer, type Server, type Socket } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { createHash } from 'node:crypto';

export const CONTROL_PROTOCOL_VERSION = 1;
export const CONTROL_MAX_FRAME_BYTES = 256 * 1024;
export const CONTROL_MAX_CONNECTIONS = 8;
export const CONTROL_TOPICS = ['session', 'model', 'usage', 'pending', 'tools', 'background'] as const;
export type ControlTopic = (typeof CONTROL_TOPICS)[number];
export type ControlPhase = 'idle' | 'working' | 'awaiting_approval';

export function projectControlPhase(input: {
  foregroundToolName?: string | null;
  hasNestedApproval: boolean;
  activeTurn: boolean;
  queueOwnsSubmissions: boolean;
  queueActive: boolean;
}): { phase: ControlPhase; waitKind: 'question' | 'approval' | 'nested_approval' | null } {
  if (input.foregroundToolName === 'ask_user') return { phase: 'awaiting_approval', waitKind: 'question' };
  if (input.foregroundToolName) return { phase: 'awaiting_approval', waitKind: 'approval' };
  if (input.hasNestedApproval) return { phase: 'awaiting_approval', waitKind: 'nested_approval' };
  if (input.activeTurn || input.queueOwnsSubmissions || input.queueActive) return { phase: 'working', waitKind: null };
  return { phase: 'idle', waitKind: null };
}
export type ControlErrorCode =
  | 'unsupported_version'
  | 'unknown_method'
  | 'invalid_request'
  | 'payload_too_large'
  | 'unauthorized'
  | 'not_ready'
  | 'conflict'
  | 'rejected'
  | 'unavailable'
  | 'internal';

export interface ControlSessionPort {
  status(): unknown;
  get(topic: ControlTopic): unknown;
  submit?(params: {
    text: string;
    clientRequestId: string;
    origin?: unknown;
    onSteerSettled?: () => void;
  }): Promise<ControlMutationReceipt>;
  steer?(params: {
    text: string;
    clientRequestId: string;
    origin?: unknown;
    onSteerSettled?: () => void;
  }): Promise<ControlMutationReceipt>;
  interrupt?(): Promise<{ accepted: boolean; reason?: string }>;
}

export interface ControlMutationReceipt {
  messageId?: string;
  delivery: 'started' | 'queued' | 'steering' | 'rejected';
  reason?: string;
  replayed?: boolean;
}

/** FIFO admission primitive shared by future state-changing methods. */
export class ControlAdmissionLock {
  #tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.#tail.then(operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export interface ControlReceiptEntry<T> {
  bodyHash: string;
  receipt: T;
  pending: boolean;
}

/** Process-local replay table; a live pending operation is never evicted. */
export class ControlIdempotencyMap<T> {
  readonly #entries = new Map<string, ControlReceiptEntry<T>>();
  readonly #capacity: number;

  constructor(capacity = 256) {
    this.#capacity = capacity;
  }

  canStore(): boolean {
    return this.#entries.size < this.#capacity || [...this.#entries.values()].some((entry) => !entry.pending);
  }

  get(
    clientRequestId: string,
    body: unknown,
  ): { kind: 'missing' } | { kind: 'conflict' } | { kind: 'replay'; receipt: T } {
    const entry = this.#entries.get(clientRequestId);
    if (!entry) return { kind: 'missing' };
    if (entry.bodyHash !== hashBody(body)) return { kind: 'conflict' };
    return { kind: 'replay', receipt: entry.receipt };
  }

  set(clientRequestId: string, body: unknown, receipt: T, pending = false): void {
    this.#entries.delete(clientRequestId);
    this.#entries.set(clientRequestId, { bodyHash: hashBody(body), receipt, pending });
    while (this.#entries.size > this.#capacity) {
      const oldestCompleted = [...this.#entries].find(([, entry]) => !entry.pending)?.[0];
      if (oldestCompleted === undefined) break;
      this.#entries.delete(oldestCompleted);
    }
  }

  settle(clientRequestId: string): void {
    const entry = this.#entries.get(clientRequestId);
    if (entry) entry.pending = false;
    while (this.#entries.size > this.#capacity) {
      const oldestCompleted = [...this.#entries].find(([, item]) => !item.pending)?.[0];
      if (oldestCompleted === undefined) break;
      this.#entries.delete(oldestCompleted);
    }
  }
}

function hashBody(body: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(body) ?? 'undefined')
    .digest('hex');
}

export interface ControlAdvertisement {
  v: 1;
  name: string;
  pid: number;
  startedAt: string;
  sessionId: string;
  socketPath: string;
  cwd: string;
  host: string;
}

export function isControlSocketName(name: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(name);
}

export function controlDirectory(runtimeDir: string): string {
  return path.join(runtimeDir, 'term2', 'control');
}

export function parseProcStartTime(stat: string): string | null {
  const close = stat.lastIndexOf(')');
  if (close < 0) return null;
  const fields = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  return fields.length >= 20 ? fields[19] : null;
}

export function readProcStartTime(pid: number): string | null {
  try {
    return parseProcStartTime(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return null;
  }
}

function error(code: ControlErrorCode, message: string): { code: ControlErrorCode; message: string } {
  return { code, message };
}

function send(socket: Socket, value: unknown): void {
  if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`);
}

function isSocketAcceptingConnections(socketPath: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', (cause: NodeJS.ErrnoException) => {
      if (cause.code === 'ECONNREFUSED' || cause.code === 'ENOENT') resolve(false);
      else reject(cause);
    });
  });
}

export interface ControlSocketOptions {
  name: string;
  sessionId: () => string;
  port?: ControlSessionPort | null;
  runtimeDir?: string;
  pid?: number;
  cwd?: string;
  host?: string;
  startTime?: () => string | null;
  isPidAlive?: (pid: number) => boolean;
  setSocketMode?: (socketPath: string) => void;
  socketIsLive?: (socketPath: string) => Promise<boolean>;
}

/** Owns socket framing, discovery files, connection admission, and the read-only v1 wire. */
export class ControlSocketServer {
  readonly name: string;
  readonly directory: string;
  readonly socketPath: string;
  readonly advertisementPath: string;
  readonly #options: ControlSocketOptions;
  readonly #server: Server;
  readonly #connections = new Set<Socket>();
  readonly #admissionLock = new ControlAdmissionLock();
  readonly #idempotency = new ControlIdempotencyMap<ControlMutationReceipt>();
  #port: ControlSessionPort | null;
  #interruptHandler:
    | (() => Promise<{ accepted: boolean; reason?: string }> | { accepted: boolean; reason?: string })
    | null = null;
  #startedAt = '';
  #closed = false;
  #ownedSocket: { dev: bigint; ino: bigint; ctimeNs: bigint } | null = null;
  #ownsAdvertisement = false;

  constructor(options: ControlSocketOptions) {
    if (!isControlSocketName(options.name)) throw new Error('Invalid control socket name');
    this.#options = options;
    this.name = options.name;
    const runtimeDir = options.runtimeDir ?? process.env.XDG_RUNTIME_DIR;
    if (!runtimeDir || !path.isAbsolute(runtimeDir)) throw new Error('XDG_RUNTIME_DIR must be present and absolute');
    this.directory = controlDirectory(runtimeDir);
    this.socketPath = path.join(this.directory, `${this.name}.sock`);
    this.advertisementPath = path.join(this.directory, `${this.name}.json`);
    this.#port = options.port ?? null;
    this.#server = createServer((socket) => this.#accept(socket));
  }

  get startedAt(): string {
    return this.#startedAt;
  }

  refreshAdvertisement(): void {
    if (!this.#ownsAdvertisement || !this.#startedAt) return;
    const current = readAdvertisement(this.advertisementPath);
    if (
      current?.pid !== (this.#options.pid ?? process.pid) ||
      current.startedAt !== this.#startedAt ||
      current.socketPath !== this.socketPath
    )
      return;
    atomicWriteJson(this.advertisementPath, { ...current, sessionId: this.#options.sessionId() }, 0o600);
  }

  bind(port: ControlSessionPort): void {
    this.#port = port;
  }

  unbind(port: ControlSessionPort): void {
    if (this.#port === port) this.#port = null;
  }

  bindInterruptHandler(
    handler: () => Promise<{ accepted: boolean; reason?: string }> | { accepted: boolean; reason?: string },
  ): void {
    this.#interruptHandler = handler;
  }

  unbindInterruptHandler(
    handler: () => Promise<{ accepted: boolean; reason?: string }> | { accepted: boolean; reason?: string },
  ): void {
    if (this.#interruptHandler === handler) this.#interruptHandler = null;
  }

  async listen(): Promise<void> {
    const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
    const runtimeDir = this.#options.runtimeDir ?? process.env.XDG_RUNTIME_DIR;
    if (!runtimeDir) throw new Error('XDG_RUNTIME_DIR is not set');
    const runtimeStat = fs.statSync(runtimeDir);
    if (!runtimeStat.isDirectory() || runtimeStat.uid !== uid || (runtimeStat.mode & 0o777) !== 0o700) {
      throw new Error('XDG_RUNTIME_DIR must be owned by this user and mode 0700');
    }
    ensurePrivateDirectory(path.dirname(this.directory), uid);
    ensurePrivateDirectory(this.directory, uid);
    const dirStat = fs.statSync(this.directory);
    if (dirStat.uid !== uid || (dirStat.mode & 0o777) !== 0o700)
      throw new Error('Control directory must be owned by this user and mode 0700');
    reapControlDirectory(
      this.directory,
      this.#options.host ?? os.hostname(),
      this.#options.isPidAlive,
      this.#options.startTime ? () => this.#options.startTime!() : readProcStartTime,
    );
    if (fs.existsSync(this.advertisementPath)) {
      const holder = readAdvertisement(this.advertisementPath);
      if (
        holder &&
        isLiveAdvertisement(
          holder,
          this.#options.host ?? os.hostname(),
          this.#options.isPidAlive,
          this.#options.startTime,
        )
      ) {
        throw new Error(`Control socket name ${this.name} is held by pid ${holder.pid}`);
      }
    }
    if (fs.existsSync(this.socketPath)) {
      if (!fs.lstatSync(this.socketPath).isSocket()) throw new Error('Control socket path exists and is not a socket');
      const live = await (this.#options.socketIsLive ?? isSocketAcceptingConnections)(this.socketPath);
      if (live) throw new Error(`Control socket path ${this.socketPath} is already accepting connections`);
      fs.unlinkSync(this.socketPath);
    }
    await new Promise<void>((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(this.socketPath, () => {
        this.#server.off('error', reject);
        resolve();
      });
    });
    try {
      const boundSocketStat = fs.lstatSync(this.socketPath, { bigint: true });
      this.#ownedSocket = {
        dev: boundSocketStat.dev,
        ino: boundSocketStat.ino,
        ctimeNs: boundSocketStat.ctimeNs,
      };
      if (this.#options.setSocketMode) this.#options.setSocketMode(this.socketPath);
      else fs.chmodSync(this.socketPath, 0o600);
      const socketStat = fs.statSync(this.socketPath);
      if (!socketStat.isSocket() || socketStat.uid !== uid || (socketStat.mode & 0o077) !== 0) {
        throw new Error('Control socket must be owned by this user and mode 0600');
      }
      this.#startedAt =
        (this.#options.startTime ?? (() => readProcStartTime(this.#options.pid ?? process.pid)))() ?? '';
      const advertisement: ControlAdvertisement = {
        v: 1,
        name: this.name,
        pid: this.#options.pid ?? process.pid,
        startedAt: this.#startedAt,
        sessionId: this.#options.sessionId(),
        socketPath: this.socketPath,
        cwd: this.#options.cwd ?? process.cwd(),
        host: this.#options.host ?? os.hostname(),
      };
      atomicWriteJson(this.advertisementPath, advertisement, 0o600);
      this.#ownsAdvertisement = true;
    } catch (cause) {
      await this.close();
      throw cause;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const socket of this.#connections) socket.destroy();
    if (this.#server.listening) await new Promise<void>((resolve) => this.#server.close(() => resolve()));
    if (this.#ownsAdvertisement) {
      const current = readAdvertisement(this.advertisementPath);
      if (
        current?.pid === (this.#options.pid ?? process.pid) &&
        current.startedAt === this.#startedAt &&
        current.socketPath === this.socketPath
      ) {
        try {
          fs.unlinkSync(this.advertisementPath);
        } catch {
          /* already gone */
        }
      }
    }
    if (this.#ownedSocket) {
      try {
        const current = fs.lstatSync(this.socketPath, { bigint: true });
        if (
          current.isSocket() &&
          current.dev === this.#ownedSocket.dev &&
          current.ino === this.#ownedSocket.ino &&
          current.ctimeNs === this.#ownedSocket.ctimeNs
        ) {
          fs.unlinkSync(this.socketPath);
        }
      } catch {
        /* already gone */
      }
    }
  }

  #accept(socket: Socket): void {
    if (this.#connections.size >= CONTROL_MAX_CONNECTIONS) {
      socket.end(
        `${JSON.stringify({ v: 1, id: '', ok: false, error: error('unavailable', 'Connection limit reached') })}\n`,
      );
      return;
    }
    this.#connections.add(socket);
    let buffer = Buffer.alloc(0);
    let helloSeen = false;
    const inFlight = new Set<string>();
    let requests = Promise.resolve();
    socket.on('close', () => this.#connections.delete(socket));
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > CONTROL_MAX_FRAME_BYTES && !buffer.includes(0x0a)) {
        socket.destroy();
        return;
      }
      let newline: number;
      while ((newline = buffer.indexOf(0x0a)) >= 0) {
        const frame = buffer.subarray(0, newline);
        buffer = buffer.subarray(newline + 1);
        if (frame.length > CONTROL_MAX_FRAME_BYTES) {
          socket.destroy();
          return;
        }
        let request: any;
        try {
          request = JSON.parse(frame.toString('utf8'));
        } catch {
          socket.destroy();
          return;
        }
        requests = requests.then(async () => {
          helloSeen = await this.#request(socket, request, helloSeen, inFlight);
        });
      }
    });
  }

  async #request(socket: Socket, request: any, helloSeen: boolean, inFlight: Set<string>): Promise<boolean> {
    const id = typeof request?.id === 'string' ? request.id : '';
    const reply = (ok: boolean, result?: unknown, code?: ControlErrorCode, message?: string) =>
      send(socket, {
        v: 1,
        id,
        ok,
        ...(ok ? { result } : { error: error(code ?? 'internal', message ?? 'Request failed') }),
      });
    if (
      !request ||
      typeof request !== 'object' ||
      Array.isArray(request) ||
      typeof request.id !== 'string' ||
      !request.id ||
      typeof request.method !== 'string'
    ) {
      reply(false, undefined, 'invalid_request', 'Expected request with id and method');
      return helloSeen;
    }
    if (request.v !== 1) {
      reply(false, undefined, 'unsupported_version', 'Only protocol version 1 is supported');
      socket.end();
      return helloSeen;
    }
    if (inFlight.has(id)) {
      reply(false, undefined, 'invalid_request', 'Request id is already in flight');
      return helloSeen;
    }
    inFlight.add(id);
    try {
      if (!helloSeen && request.method !== 'hello') {
        reply(false, undefined, 'unauthorized', 'hello must be the first request');
        socket.end();
        return helloSeen;
      }
      if (request.method === 'hello') {
        if (helloSeen) {
          reply(false, undefined, 'invalid_request', 'hello may only be sent once');
          return helloSeen;
        }
        reply(true, { v: 1, capabilities: ['submit', 'steer', 'interrupt'], topics: [...CONTROL_TOPICS] });
        return true;
      }
      if (!['status', 'get', 'submit', 'steer', 'interrupt'].includes(request.method)) {
        reply(false, undefined, 'unknown_method', `Unknown method: ${request.method}`);
        return helloSeen;
      }
      const port = this.#port;
      if (!port) {
        reply(false, undefined, 'not_ready', 'Interactive session is not ready');
        return helloSeen;
      }
      if (request.method === 'submit' || request.method === 'steer') {
        const params = request.params;
        if (
          !params ||
          typeof params !== 'object' ||
          Array.isArray(params) ||
          Object.keys(params).some((key) => !['text', 'clientRequestId', 'origin'].includes(key)) ||
          typeof params.text !== 'string' ||
          params.text.length < 1 ||
          params.text.length > 128_000 ||
          !params.text.trim() ||
          typeof params.clientRequestId !== 'string' ||
          !/^[A-Za-z0-9_-]{1,256}$/.test(params.clientRequestId) ||
          (params.origin !== undefined &&
            (!params.origin ||
              typeof params.origin !== 'object' ||
              Array.isArray(params.origin) ||
              Object.keys(params.origin).some((key) => key !== 'kind') ||
              !['orchestrator', 'peer'].includes(params.origin.kind)))
        ) {
          reply(false, undefined, 'invalid_request', 'Expected text and an opaque clientRequestId');
          return helloSeen;
        }
        if (params.origin?.kind === 'peer') {
          reply(false, undefined, 'unavailable', 'Peer-originated messages are unavailable in milestone 1');
          return helloSeen;
        }
        const body = { text: params.text };
        const mutate = request.method === 'submit' ? port.submit : port.steer;
        if (!mutate) {
          reply(false, undefined, 'unavailable', 'Mutation is not available');
          return helloSeen;
        }
        const result = await this.#admissionLock
          .run(async () => {
            const prior = this.#idempotency.get(params.clientRequestId, body);
            if (prior.kind === 'conflict')
              throw Object.assign(new Error('clientRequestId was already used with a different body'), {
                code: 'conflict',
              });
            if (prior.kind === 'replay') return { ...prior.receipt, replayed: true };
            if (!this.#idempotency.canStore()) {
              return { delivery: 'rejected', reason: 'idempotency_capacity' } as ControlMutationReceipt;
            }
            const receipt = await mutate.call(port, {
              ...params,
              onSteerSettled: () => this.#idempotency.settle(params.clientRequestId),
            });
            this.#idempotency.set(params.clientRequestId, body, receipt, receipt.delivery === 'steering');
            if (receipt.delivery !== 'steering') this.#idempotency.settle(params.clientRequestId);
            return receipt;
          })
          .catch((cause: any) => {
            if (cause?.code === 'conflict') {
              reply(false, undefined, 'conflict', cause.message);
              return null;
            }
            throw cause;
          });
        if (!result) return helloSeen;
        reply(true, result);
        return helloSeen;
      }
      if (request.method === 'interrupt') {
        if (!port.interrupt) {
          reply(false, undefined, 'unavailable', 'Interrupt is not available');
          return helloSeen;
        }
        reply(
          true,
          await this.#admissionLock.run(() => (this.#interruptHandler ? this.#interruptHandler() : port.interrupt!())),
        );
        return helloSeen;
      }
      if (request.method === 'status') {
        reply(true, port.status());
        return helloSeen;
      }
      const params = request.params;
      if (params?.topic === 'transcript') {
        reply(false, undefined, 'unavailable', 'Transcript reads are not available in protocol v1 milestone 1');
        return helloSeen;
      }
      if (
        !params ||
        typeof params !== 'object' ||
        typeof params.topic !== 'string' ||
        !CONTROL_TOPICS.includes(params.topic)
      ) {
        reply(false, undefined, 'invalid_request', 'Unknown or invalid topic');
        return helloSeen;
      }
      if (params.limit !== undefined || params.before !== undefined) {
        reply(false, undefined, 'invalid_request', 'limit and before are only supported for transcript');
        return helloSeen;
      }
      reply(true, port.get(params.topic));
      return helloSeen;
    } catch {
      reply(false, undefined, 'internal', 'Control request failed');
      return helloSeen;
    } finally {
      inFlight.delete(id);
    }
  }
}

function atomicWriteJson(file: string, value: unknown, mode: number): void {
  const temp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode, flag: 'wx' });
    fs.chmodSync(temp, mode);
    fs.renameSync(temp, file);
  } finally {
    try {
      fs.unlinkSync(temp);
    } catch {
      /* renamed or already removed */
    }
  }
}

function ensurePrivateDirectory(directory: string, uid: number): void {
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
  }
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== uid) {
    throw new Error('Control directories must be real directories owned by this user');
  }
  fs.chmodSync(directory, 0o700);
}

function readAdvertisement(file: string): ControlAdvertisement | null {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (
      value?.v !== 1 ||
      typeof value.name !== 'string' ||
      typeof value.pid !== 'number' ||
      typeof value.startedAt !== 'string' ||
      typeof value.socketPath !== 'string' ||
      typeof value.host !== 'string'
    )
      return null;
    return value as ControlAdvertisement;
  } catch {
    return null;
  }
}

function isLiveAdvertisement(
  ad: ControlAdvertisement,
  host: string,
  isPidAlive = defaultPidAlive,
  startTime = readProcStartTime,
): boolean {
  if (ad.host !== host || !isPidAlive(ad.pid)) return false;
  const current = startTime(ad.pid);
  return current === null || current === ad.startedAt;
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function reapControlDirectory(
  directory: string,
  host = os.hostname(),
  isPidAlive = defaultPidAlive,
  startTime = readProcStartTime,
): void {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const advertisementPath = path.join(directory, entry.name);
    const ad = readAdvertisement(advertisementPath);
    if (!ad || ad.host !== host) continue;
    if (isPidAlive(ad.pid)) {
      const currentStartTime = startTime(ad.pid);
      if (currentStartTime === null || currentStartTime === ad.startedAt) continue;
    }
    try {
      fs.unlinkSync(advertisementPath);
    } catch {
      /* concurrent reaper */
    }
    try {
      const socketPath = path.resolve(ad.socketPath);
      if (path.dirname(socketPath) === path.resolve(directory) && fs.lstatSync(socketPath).isSocket())
        fs.unlinkSync(socketPath);
    } catch {
      /* missing or non-socket path */
    }
  }
}

export function listControlAdvertisements(runtimeDir: string, host = os.hostname()): ControlAdvertisement[] {
  const directory = controlDirectory(runtimeDir);
  reapControlDirectory(directory, host);
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .flatMap((name) => {
      const ad = readAdvertisement(path.join(directory, name));
      return ad && isLiveAdvertisement(ad, host) ? [ad] : [];
    });
}
