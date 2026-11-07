/** Private v1 framing/auth/process lifecycle with session-scoped direct mutation replay.
 * No Session execution or persistence authority is implemented by this server.
 */
import { createServer, type Server, type Socket } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import {
  CONTROL_MAX_FRAME_BYTES,
  CONTROL_MAX_CONNECTIONS,
  ControlAdmissionLock,
  isControlSocketName,
  controlDirectory,
  readProcStartTime,
  reapControlDirectory,
  type ControlAdvertisement,
} from '../control-socket/control-socket.js';
import type { ControlSessionPort, ControlSocketOptions } from './control-transport-types.js';
import {
  ControlMutationUnavailable,
  isSocketAcceptingConnections,
  ensurePrivateDirectory,
  readAdvertisement,
  isLiveAdvertisement,
  atomicWriteJson,
} from './control-transport-files.js';
import { ControlRequests } from './control-requests.js';

export class ControlSocketServer {
  readonly name: string;
  readonly directory: string;
  readonly socketPath: string;
  readonly advertisementPath: string;
  readonly #options: ControlSocketOptions;
  readonly #server: Server;
  readonly #connections = new Set<Socket>();
  readonly #admissionLock = new ControlAdmissionLock();
  readonly #requests: ControlRequests;
  #port: ControlSessionPort | null;
  #interruptHandler:
    | (() => Promise<{ accepted: boolean; reason?: string }> | { accepted: boolean; reason?: string })
    | null = null;
  #startedAt = '';
  #closed = false;
  #mutationsPaused = false;
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
    this.#requests = new ControlRequests({
      port: () => this.#port,
      sessionId: options.sessionId,
      startedAt: () => this.#startedAt,
      discordInput: options.discordInput === true,
      runMutation: (operation) => this.#runMutation(operation),
      interruptHandler: () => this.#interruptHandler,
    });
  }

  /** Current process-bound identity, read at invocation so rollover cannot reuse a stale session ID. */
  get binding(): { socketPath: string; sessionId: string; startedAt: string } {
    return { socketPath: this.socketPath, sessionId: this.#options.sessionId(), startedAt: this.#startedAt };
  }

  get startedAt(): string {
    return this.#startedAt;
  }

  /** Whether this process explicitly opted this socket into human Discord input. */
  get discordInputEnabled(): boolean {
    return this.#options.discordInput === true;
  }

  /** Outbound authority exists only on a live, attached, unpaused opted-in server. */
  get discordSendEnabled(): boolean {
    return (
      this.discordInputEnabled &&
      !this.#closed &&
      !this.#mutationsPaused &&
      this.#server.listening &&
      this.#ownsAdvertisement &&
      this.#port !== null
    );
  }

  refreshAdvertisement(): void {
    if (this.#closed || !this.#ownsAdvertisement || !this.#startedAt)
      throw new Error('Control advertisement is not active');
    const current = readAdvertisement(this.advertisementPath);
    if (
      current?.pid !== (this.#options.pid ?? process.pid) ||
      current.startedAt !== this.#startedAt ||
      current.socketPath !== this.socketPath
    )
      throw new Error('Control advertisement ownership changed');
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
        ...(this.#options.discordInput === true ? { discordInput: true } : {}),
      };
      atomicWriteJson(this.advertisementPath, advertisement, 0o600);
      this.#ownsAdvertisement = true;
    } catch (cause) {
      await this.close();
      throw cause;
    }
  }

  /** Refuse new mutations, drain already entered admission (not model completion), and allow reversible preflight. */
  pauseMutations(): { drained: Promise<void>; release: () => void } {
    if (this.#closed || this.#mutationsPaused) throw new Error('Control admission is already closed or paused.');
    this.#mutationsPaused = true;
    let released = false;
    return {
      drained: this.#admissionLock.run(() => undefined),
      release: () => {
        if (released) return;
        released = true;
        this.#mutationsPaused = false;
      },
    };
  }

  #runMutation<T>(operation: () => T | Promise<T>): Promise<T> {
    return this.#admissionLock.run(() => {
      if (this.#closed || this.#mutationsPaused) {
        throw new ControlMutationUnavailable('Restart is being prepared; mutation was not admitted.');
      }
      return operation();
    });
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
    let closed = false;
    socket.on('error', () => {
      closed = true;
      socket.destroy();
    });
    socket.on('close', () => {
      closed = true;
      this.#connections.delete(socket);
    });
    if (this.#connections.size >= CONTROL_MAX_CONNECTIONS) {
      socket.end(
        `${JSON.stringify({
          v: 1,
          id: '',
          ok: false,
          error: { code: 'unavailable', message: 'Connection limit reached' },
        })}\n`,
      );
      return;
    }
    this.#connections.add(socket);
    let buffer = Buffer.alloc(0);
    let helloSeen = false;
    const inFlight = new Set<string>();
    let requests = Promise.resolve();
    socket.on('data', (chunk) => {
      if (closed || socket.destroyed || socket.writableEnded) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > CONTROL_MAX_FRAME_BYTES && !buffer.includes(0x0a)) {
        socket.destroy();
        return;
      }
      let newline: number;
      while (!closed && (newline = buffer.indexOf(0x0a)) >= 0) {
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
          if (closed || socket.destroyed || socket.writableEnded) return;
          helloSeen = await this.#requests.dispatch(socket, request, helloSeen, inFlight);
          if (socket.destroyed || socket.writableEnded) closed = true;
        });
      }
    });
  }
}
