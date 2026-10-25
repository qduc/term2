import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { connect, createServer, type Socket } from 'node:net';
import { readProcStartTime, CONTROL_MAX_FRAME_BYTES } from '../control-socket/control-socket.js';

export interface DiscordBinding {
  socketPath: string;
  sessionId: string;
  startedAt: string;
}
export type DiscordSendInput =
  | { action: 'send'; requestId: string; text: string }
  | { action: 'status'; requestId: string };
export interface DiscordSendResult {
  requestId: string;
  delivery: 'queued' | 'sent' | 'uncertain' | 'rejected' | 'missing' | 'unavailable' | 'unknown';
  reason?: string;
  capacity?: { kind: 'pending' | 'journal_bytes'; used: number; limit: number };
  channelId?: string;
  senderAlias?: string;
  chunks?: { queued: number; sent: number; uncertain: number };
}
interface Advertisement {
  v: 1;
  socketPath: string;
  pid: number;
  startedAt: string;
  fingerprint: string;
  channelId: string;
}
export type DiscordSend = (input: DiscordSendInput) => Promise<DiscordSendResult>;

function privateDirectory(directory: string, create = false): void {
  if (create) fs.mkdirSync(directory, { mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700)
    throw new Error('Unsafe Discord runtime directory');
}
function directoryFor(runtime: string, create = false): string {
  if (!path.isAbsolute(runtime)) throw new Error('Invalid Discord runtime');
  privateDirectory(runtime);
  const directory = path.join(runtime, 'term2-discord');
  privateDirectory(directory, create && !fs.existsSync(directory));
  return directory;
}
function readAdvertisement(file: string): Advertisement {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size > CONTROL_MAX_FRAME_BYTES
    )
      throw new Error('Unsafe Discord advertisement');
    const ad = JSON.parse(fs.readFileSync(fd, 'utf8')) as Advertisement;
    if (
      ad.v !== 1 ||
      !Number.isInteger(ad.pid) ||
      typeof ad.startedAt !== 'string' ||
      ad.socketPath !== file.replace(/\.json$/, '.sock')
    )
      throw new Error('Invalid Discord advertisement');
    return ad;
  } finally {
    fs.closeSync(fd);
  }
}
export function sameDiscordBinding(a: DiscordBinding, b: DiscordBinding): boolean {
  return a.socketPath === b.socketPath && a.sessionId === b.sessionId && a.startedAt === b.startedAt;
}

/** Bridge-owned private RPC. Journal ownership must precede listen; close removes only owned artifacts. */
export class DiscordOutboundServer {
  readonly #connections = new Set<Socket>();
  readonly #server;
  readonly #file: string;
  readonly #ad: Advertisement;
  #owned = false;
  constructor(
    runtime: string,
    stateDir: string,
    metadata: Pick<Advertisement, 'fingerprint' | 'channelId'>,
    handle: (method: string, params: unknown) => DiscordSendResult,
  ) {
    const directory = directoryFor(runtime, true);
    const name = createHash('sha256').update(stateDir).digest('hex').slice(0, 20);
    this.#file = path.join(directory, `${name}.json`);
    this.#ad = {
      v: 1,
      ...metadata,
      socketPath: path.join(directory, `${name}.sock`),
      pid: process.pid,
      startedAt: readProcStartTime(process.pid)!,
    };
    this.#server = createServer((socket) => {
      if (this.#connections.size >= 16) {
        socket.destroy();
        return;
      }
      this.#connections.add(socket);
      socket.on('close', () => this.#connections.delete(socket));
      socket.on('error', () => {});
      socket.setTimeout(10_000, () => socket.destroy());
      let bytes = Buffer.alloc(0);
      let hello = false;
      let called = false;
      socket.on('data', (chunk) => {
        bytes = Buffer.concat([bytes, chunk]);
        if (bytes.length > CONTROL_MAX_FRAME_BYTES) {
          socket.destroy();
          return;
        }
        let newline: number;
        while ((newline = bytes.indexOf(10)) >= 0) {
          const line = bytes.subarray(0, newline).toString('utf8');
          bytes = bytes.subarray(newline + 1);
          try {
            const request = JSON.parse(line);
            if (
              request.v !== 1 ||
              typeof request.id !== 'string' ||
              Object.keys(request).some((k) => !['v', 'id', 'method', 'params'].includes(k))
            )
              throw new Error();
            if (!hello) {
              if (request.method !== 'hello' || request.params !== undefined) throw new Error();
              hello = true;
              socket.write(
                JSON.stringify({
                  v: 1,
                  id: request.id,
                  ok: true,
                  result: { protocol: 'discord-outbound', version: 1 },
                }) + '\n',
              );
            } else {
              if (called) throw new Error();
              called = true;
              const result = handle(request.method, request.params);
              socket.end(JSON.stringify({ v: 1, id: request.id, ok: true, result }) + '\n');
            }
          } catch {
            socket.destroy();
            return;
          }
        }
      });
    });
  }
  async listen(): Promise<void> {
    if (fs.existsSync(this.#file)) {
      const old = readAdvertisement(this.#file);
      const start = readProcStartTime(old.pid);
      if (!start) {
        try {
          process.kill(old.pid, 0);
          throw new Error('Unverifiable Discord owner');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      } else if (start === old.startedAt) throw new Error('Live Discord endpoint collision');
      fs.unlinkSync(this.#file);
      if (fs.existsSync(this.#ad.socketPath)) fs.unlinkSync(this.#ad.socketPath);
    } else if (fs.existsSync(this.#ad.socketPath)) throw new Error('Unadvertised Discord socket; reconcile manually');
    await new Promise<void>((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(this.#ad.socketPath, () => {
        this.#server.off('error', reject);
        resolve();
      });
    });
    this.#owned = true;
    try {
      fs.chmodSync(this.#ad.socketPath, 0o600);
      const temporary = `${this.#file}.${process.pid}.tmp`;
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify(this.#ad));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      try {
        fs.renameSync(temporary, this.#file);
      } finally {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
      }
    } catch (error) {
      this.close();
      throw error;
    }
  }
  close(): void {
    for (const socket of this.#connections) socket.destroy();
    this.#server.close();
    if (this.#owned) {
      try {
        const ad = readAdvertisement(this.#file);
        if (ad.pid === this.#ad.pid && ad.startedAt === this.#ad.startedAt) fs.unlinkSync(this.#file);
      } catch {
        /* never remove another owner's advertisement */
      }
      this.#owned = false;
    }
  }
}

/** Discover the unique live bridge; it validates the sender identity. */
export async function sendDiscord(
  runtime: string,
  binding: DiscordBinding,
  input: DiscordSendInput,
): Promise<DiscordSendResult> {
  const unavailable: DiscordSendResult = { requestId: input.requestId, delivery: 'unavailable' };
  let ad: Advertisement;
  try {
    const directory = directoryFor(runtime);
    const matches = fs
      .readdirSync(directory)
      .filter((name) => /^[a-f0-9]{20}\.json$/.test(name))
      .flatMap((name) => {
        const candidate = readAdvertisement(path.join(directory, name));
        return readProcStartTime(candidate.pid) === candidate.startedAt ? [candidate] : [];
      });
    if (matches.length !== 1) return { ...unavailable, reason: matches.length ? 'ambiguous' : 'not_mapped' };
    ad = matches[0]!;
    const stat = fs.lstatSync(ad.socketPath);
    if (!stat.isSocket() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600) return unavailable;
  } catch {
    return unavailable;
  }
  return new Promise((resolve) => {
    const socket = connect(ad.socketPath);
    let attempted = false,
      finished = false,
      hello = false;
    let bytes = Buffer.alloc(0);
    const finish = (value?: DiscordSendResult) => {
      if (finished) return;
      finished = true;
      socket.destroy();
      resolve(
        value ?? {
          requestId: input.requestId,
          delivery: attempted && input.action === 'send' ? 'unknown' : 'unavailable',
        },
      );
    };
    socket.setTimeout(10_000, () => finish());
    socket.on('error', () => finish());
    socket.on('close', () => finish());
    socket.on('connect', () => socket.write(JSON.stringify({ v: 1, id: 'hello', method: 'hello' }) + '\n'));
    socket.on('data', (chunk) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > CONTROL_MAX_FRAME_BYTES) {
        finish();
        return;
      }
      let newline: number;
      while ((newline = bytes.indexOf(10)) >= 0) {
        const line = bytes.subarray(0, newline).toString('utf8');
        bytes = bytes.subarray(newline + 1);
        try {
          const response = JSON.parse(line);
          if (response.v !== 1 || !response.ok || response.id !== (hello ? 'call' : 'hello')) throw new Error();
          if (!hello) {
            if (response.result?.protocol !== 'discord-outbound' || response.result?.version !== 1) throw new Error();
            hello = true;
            attempted = true;
            socket.write(
              JSON.stringify({
                v: 1,
                id: 'call',
                method: input.action === 'send' ? 'discord_send' : 'discord_send_status',
                params: {
                  binding,
                  requestId: input.requestId,
                  ...(input.action === 'send' ? { text: input.text } : {}),
                },
              }) + '\n',
            );
          } else {
            const result = response.result;
            if (
              result?.requestId !== input.requestId ||
              !['queued', 'sent', 'uncertain', 'rejected', 'missing', 'unavailable', 'unknown'].includes(
                result.delivery,
              )
            )
              throw new Error();
            finish(result);
          }
        } catch {
          finish();
        }
      }
    });
  });
}
