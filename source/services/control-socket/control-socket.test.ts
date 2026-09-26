import { afterEach, describe, expect, it } from 'vitest';
import { connect, createServer, type Socket } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import {
  CONTROL_TOPICS,
  ControlAdmissionLock,
  ControlIdempotencyMap,
  ControlSocketServer,
  isControlSocketName,
  listControlAdvertisements,
  parseProcStartTime,
  projectControlPhase,
  reapControlDirectory,
  type ControlSessionPort,
} from './control-socket.js';

const roots: string[] = [];
const servers: ControlSocketServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function runtimeDirectory(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-control-'));
  fs.chmodSync(root, 0o700);
  roots.push(root);
  return root;
}

async function request(socket: Socket, value: unknown): Promise<any> {
  socket.write(`${JSON.stringify(value)}\n`);
  const chunks: Buffer[] = [];
  while (true) {
    const [chunk] = (await once(socket, 'data')) as [Buffer];
    chunks.push(chunk);
    const combined = Buffer.concat(chunks).toString('utf8');
    const newline = combined.indexOf('\n');
    if (newline >= 0) return JSON.parse(combined.slice(0, newline));
  }
}

function fakePort(): ControlSessionPort {
  return {
    status: () => ({ phase: 'idle' }),
    get: (topic) => ({ topic }),
  };
}

describe('control socket', () => {
  it('never evicts pending steer receipts and refuses overflow when every slot is pending', () => {
    const map = new ControlIdempotencyMap<{ messageId: string }>(2);
    map.set('one', 'one', { messageId: '1' }, true);
    map.set('two', 'two', { messageId: '2' }, true);
    expect(map.canStore()).toBe(false);
    expect(map.get('one', 'one')).toMatchObject({ kind: 'replay', receipt: { messageId: '1' } });
    map.settle('one');
    expect(map.canStore()).toBe(true);
  });

  it('requires hello then serves status, every M1 read topic, and no mutation methods', async () => {
    const server = new ControlSocketServer({
      name: 'worker_1',
      runtimeDir: runtimeDirectory(),
      sessionId: () => 'session-1',
      port: fakePort(),
      startTime: () => '12345',
      isPidAlive: () => false,
    });
    servers.push(server);
    await server.listen();
    const socket = connect(server.socketPath);
    await once(socket, 'connect');
    expect((await request(socket, { v: 1, id: 'h', method: 'hello' })).result).toEqual({
      v: 1,
      capabilities: ['submit', 'steer', 'interrupt'],
      topics: [...CONTROL_TOPICS],
    });
    expect((await request(socket, { v: 1, id: 's', method: 'status' })).result).toEqual({ phase: 'idle' });
    for (const [index, topic] of CONTROL_TOPICS.entries()) {
      expect((await request(socket, { v: 1, id: `g${index}`, method: 'get', params: { topic } })).result).toEqual({
        topic,
      });
    }
    expect(
      await request(socket, {
        v: 1,
        id: 'm',
        method: 'submit',
        params: { text: 'hello', clientRequestId: 'request-1' },
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'unavailable' },
    });
    expect(
      await request(socket, { v: 1, id: 'future-topic', method: 'get', params: { topic: 'transcript' } }),
    ).toMatchObject({
      ok: false,
      error: { code: 'unavailable' },
    });
    socket.destroy();
  });

  it('gates session reads until the hook binds a port and accepts pipelined hello/status', async () => {
    const server = new ControlSocketServer({
      name: 'pending',
      runtimeDir: runtimeDirectory(),
      sessionId: () => 'session-1',
      startTime: () => '12345',
      isPidAlive: () => false,
    });
    servers.push(server);
    await server.listen();
    const socket = connect(server.socketPath);
    await once(socket, 'connect');
    socket.write('{"v":1,"id":"h","method":"hello"}\n{"v":1,"id":"s","method":"status"}\n');
    const lines: any[] = [];
    while (lines.length < 2) {
      const [chunk] = (await once(socket, 'data')) as [Buffer];
      for (const line of chunk.toString('utf8').trim().split('\n')) lines.push(JSON.parse(line));
    }
    expect(lines.map((line) => line.id)).toEqual(['h', 's']);
    expect(lines[1]).toMatchObject({ ok: false, error: { code: 'not_ready' } });
    socket.destroy();
  });

  it('validates, replays, conflicts, and refuses peer-origin mutations without duplicate calls', async () => {
    const received: unknown[] = [];
    const port: ControlSessionPort = {
      ...fakePort(),
      submit: async (params) => {
        received.push(params);
        return { messageId: 'message-1', delivery: 'started' };
      },
      steer: async (params) => {
        received.push(params);
        return { messageId: 'message-2', delivery: 'steering' };
      },
      interrupt: async () => ({ accepted: false, reason: 'idle' }),
    };
    const server = new ControlSocketServer({
      name: 'mutations',
      runtimeDir: runtimeDirectory(),
      sessionId: () => 'session-1',
      port,
      startTime: () => '12345',
      isPidAlive: () => false,
    });
    servers.push(server);
    await server.listen();
    const socket = connect(server.socketPath);
    await once(socket, 'connect');
    expect((await request(socket, { v: 1, id: 'h', method: 'hello' })).result.capabilities).toEqual([
      'submit',
      'steer',
      'interrupt',
    ]);
    const submit = { v: 1, id: 's1', method: 'submit', params: { clientRequestId: 'request-1', text: 'hello' } };
    expect((await request(socket, submit)).result).toMatchObject({ messageId: 'message-1', delivery: 'started' });
    expect((await request(socket, { ...submit, id: 's2' })).result).toMatchObject({ replayed: true });
    expect(
      await request(socket, { ...submit, id: 's3', params: { ...submit.params, text: 'different' } }),
    ).toMatchObject({
      ok: false,
      error: { code: 'conflict' },
    });
    expect(
      await request(socket, {
        ...submit,
        id: 'peer',
        params: { ...submit.params, clientRequestId: 'request-2', origin: { kind: 'peer' } },
      }),
    ).toMatchObject({ ok: false, error: { code: 'unavailable' } });
    expect(
      await request(socket, {
        ...submit,
        id: 'bad',
        params: { ...submit.params, clientRequestId: 'request-3', attachment: 'no' },
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    expect(received).toHaveLength(1);
    expect(
      await request(socket, {
        v: 1,
        id: 'whitespace',
        method: 'submit',
        params: { text: '  \n  ', clientRequestId: 'request-whitespace' },
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    expect(
      (
        await request(socket, {
          v: 1,
          id: 'after-whitespace',
          method: 'submit',
          params: { text: 'still works', clientRequestId: 'request-after-whitespace' },
        })
      ).result,
    ).toMatchObject({ messageId: 'message-1', delivery: 'started' });
    expect(received).toHaveLength(2);
    expect((await request(socket, { v: 1, id: 'i', method: 'interrupt' })).result).toEqual({
      accepted: false,
      reason: 'idle',
    });
    socket.destroy();
  });

  it('releases the admission lock after a port reports not_admitted', async () => {
    let calls = 0;
    const server = new ControlSocketServer({
      name: 'recovery',
      runtimeDir: runtimeDirectory(),
      sessionId: () => 'session-1',
      port: {
        ...fakePort(),
        submit: async () => {
          calls += 1;
          return calls === 1
            ? { delivery: 'rejected', reason: 'not_admitted' }
            : { messageId: 'message-2', delivery: 'started' };
        },
      },
      startTime: () => '12345',
      isPidAlive: () => false,
    });
    servers.push(server);
    await server.listen();
    const socket = connect(server.socketPath);
    await once(socket, 'connect');
    await request(socket, { v: 1, id: 'h', method: 'hello' });
    expect(
      (
        await request(socket, {
          v: 1,
          id: 'first',
          method: 'submit',
          params: { text: 'first', clientRequestId: 'first' },
        })
      ).result,
    ).toEqual({ delivery: 'rejected', reason: 'not_admitted' });
    expect(
      (
        await request(socket, {
          v: 1,
          id: 'second',
          method: 'submit',
          params: { text: 'second', clientRequestId: 'second' },
        })
      ).result,
    ).toEqual({ messageId: 'message-2', delivery: 'started' });
    socket.destroy();
  });

  it('routes socket interrupt to the App-bound handler instead of the port fallback', async () => {
    const server = new ControlSocketServer({
      name: 'app-interrupt',
      runtimeDir: runtimeDirectory(),
      sessionId: () => 'session-1',
      port: {
        ...fakePort(),
        interrupt: async () => ({ accepted: false, reason: 'idle' }),
      },
      startTime: () => '12345',
      isPidAlive: () => false,
    });
    servers.push(server);
    const appInterrupt = async () => ({ accepted: true });
    server.bindInterruptHandler(appInterrupt);
    await server.listen();
    const socket = connect(server.socketPath);
    await once(socket, 'connect');
    await request(socket, { v: 1, id: 'h', method: 'hello' });
    expect((await request(socket, { v: 1, id: 'i', method: 'interrupt' })).result).toEqual({ accepted: true });
    socket.destroy();
  });

  it('leaves the live holder socket and advertisement untouched when another instance refuses the name', async () => {
    const runtimeDir = runtimeDirectory();
    const first = new ControlSocketServer({
      name: 'held',
      runtimeDir,
      sessionId: () => 'session-live',
      port: fakePort(),
      pid: 4242,
      host: 'host-test',
      startTime: () => 'start-live',
      isPidAlive: () => true,
    });
    servers.push(first);
    await first.listen();
    const before = fs.readFileSync(first.advertisementPath, 'utf8');

    const second = new ControlSocketServer({
      name: 'held',
      runtimeDir,
      sessionId: () => 'session-other',
      pid: 4242,
      host: 'host-test',
      startTime: () => 'start-live',
      isPidAlive: () => true,
    });
    await expect(second.listen()).rejects.toThrow('held by pid 4242');
    await second.close(); // mirrors cli.tsx cleanup after the refused listen

    expect(fs.readFileSync(first.advertisementPath, 'utf8')).toBe(before);
    const socket = connect(first.socketPath);
    await once(socket, 'connect');
    expect((await request(socket, { v: 1, id: 'h', method: 'hello' })).ok).toBe(true);
    socket.destroy();
  });

  it('does not remove an occupied non-socket path or its advertisement on refusal cleanup', async () => {
    const runtimeDir = runtimeDirectory();
    const server = new ControlSocketServer({
      name: 'occupied',
      runtimeDir,
      sessionId: () => 'session-new',
      pid: 5151,
      host: 'host-test',
      startTime: () => 'start-new',
      isPidAlive: () => false,
    });
    fs.mkdirSync(server.directory, { recursive: true, mode: 0o700 });
    const marker = 'do not remove';
    fs.writeFileSync(server.socketPath, marker);
    const advertisement = JSON.stringify({
      v: 1,
      name: server.name,
      pid: 7777,
      startedAt: 'foreign-start',
      sessionId: 'foreign-session',
      socketPath: server.socketPath,
      cwd: '/tmp',
      host: 'other-host',
    });
    fs.writeFileSync(server.advertisementPath, advertisement);

    await expect(server.listen()).rejects.toThrow('not a socket');
    await server.close();

    expect(fs.readFileSync(server.socketPath, 'utf8')).toBe(marker);
    expect(fs.readFileSync(server.advertisementPath, 'utf8')).toBe(advertisement);
  });

  it('replaces an orphaned socket when no advertisement owns the name', async () => {
    const runtimeDir = runtimeDirectory();
    const socketPath = path.join(runtimeDir, 'term2', 'control', 'orphan.sock');
    fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
    const staleListener = createServer();
    staleListener.listen(socketPath);
    await once(staleListener, 'listening');
    const parkedSocketPath = `${socketPath}.parked`;
    fs.renameSync(socketPath, parkedSocketPath);
    await new Promise<void>((resolve) => staleListener.close(() => resolve()));
    fs.renameSync(parkedSocketPath, socketPath); // model the crash window's leftover socket inode
    expect(fs.lstatSync(socketPath).isSocket()).toBe(true);

    const replacement = new ControlSocketServer({
      name: 'orphan',
      runtimeDir,
      sessionId: () => 'new-session',
      port: fakePort(),
      startTime: () => 'new-start',
      isPidAlive: () => false,
    });
    servers.push(replacement);
    await replacement.listen();
    const socket = connect(replacement.socketPath);
    await once(socket, 'connect');
    expect((await request(socket, { v: 1, id: 'h', method: 'hello' })).ok).toBe(true);
    socket.destroy();
  });

  it('atomically refreshes the advertisement session id without changing the socket endpoint', async () => {
    const runtimeDir = runtimeDirectory();
    let sessionId = 'session-before';
    const server = new ControlSocketServer({
      name: 'rollover',
      runtimeDir,
      sessionId: () => sessionId,
      port: fakePort(),
    });
    servers.push(server);
    await server.listen();
    const socketPath = server.socketPath;
    const socketIdentityBefore = fs.lstatSync(socketPath, { bigint: true });
    sessionId = 'session-after';
    server.refreshAdvertisement();
    const advertisement = JSON.parse(fs.readFileSync(server.advertisementPath, 'utf8'));
    expect(advertisement.sessionId).toBe('session-after');
    const socketIdentityAfter = fs.lstatSync(socketPath, { bigint: true });
    expect(socketIdentityAfter.ino).toBe(socketIdentityBefore.ino);
    expect(fs.statSync(server.advertisementPath).mode & 0o777).toBe(0o600);
  });

  it('closes malformed and oversized frames, returns unsupported_version, and rejects requests before hello', async () => {
    const server = new ControlSocketServer({
      name: 'framing',
      runtimeDir: runtimeDirectory(),
      sessionId: () => 'session',
      port: fakePort(),
      startTime: () => 'token',
      isPidAlive: () => false,
    });
    servers.push(server);
    await server.listen();

    const malformed = connect(server.socketPath);
    await once(malformed, 'connect');
    malformed.write('{bad json}\n');
    await once(malformed, 'close');

    const oversized = connect(server.socketPath);
    await once(oversized, 'connect');
    oversized.write(`${'x'.repeat(256 * 1024 + 1)}\n`);
    await once(oversized, 'close');

    const mismatch = connect(server.socketPath);
    await once(mismatch, 'connect');
    const wrongVersion = await request(mismatch, { v: 2, id: 'v', method: 'hello' });
    expect(wrongVersion).toMatchObject({ ok: false, error: { code: 'unsupported_version' } });
    mismatch.destroy();

    const unauthorized = connect(server.socketPath);
    await once(unauthorized, 'connect');
    const beforeHello = await request(unauthorized, { v: 1, id: 's', method: 'status' });
    expect(beforeHello).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
    unauthorized.destroy();
  });

  it('refuses unsafe runtime and socket modes without leaving a serving socket', async () => {
    const runtimeDir = runtimeDirectory();
    fs.chmodSync(runtimeDir, 0o755);
    const badRuntime = new ControlSocketServer({
      name: 'bad-runtime',
      runtimeDir,
      sessionId: () => 'session',
      startTime: () => 'token',
      isPidAlive: () => false,
    });
    await expect(badRuntime.listen()).rejects.toThrow('XDG_RUNTIME_DIR');
    await badRuntime.close();

    fs.chmodSync(runtimeDir, 0o700);
    const badSocketMode = new ControlSocketServer({
      name: 'bad-socket-mode',
      runtimeDir,
      sessionId: () => 'session',
      startTime: () => 'token',
      isPidAlive: () => false,
      setSocketMode: () => {},
    });
    await expect(badSocketMode.listen()).rejects.toThrow('mode 0600');
    await badSocketMode.close();
    expect(fs.existsSync(badSocketMode.socketPath)).toBe(false);
    expect(fs.existsSync(badSocketMode.advertisementPath)).toBe(false);
  });

  it('refuses a ninth concurrent connection', async () => {
    const server = new ControlSocketServer({
      name: 'capped',
      runtimeDir: runtimeDirectory(),
      sessionId: () => 'session',
      startTime: () => 'token',
      isPidAlive: () => false,
    });
    servers.push(server);
    await server.listen();
    const sockets = Array.from({ length: 9 }, () => connect(server.socketPath));
    await Promise.all(sockets.map((socket) => once(socket, 'connect')));
    const response = once(sockets[8]!, 'data') as Promise<[Buffer]>;
    const ended = once(sockets[8]!, 'end');
    const [chunk] = await response;
    await ended;
    expect(JSON.parse(chunk.toString('utf8'))).toMatchObject({ ok: false, error: { code: 'unavailable' } });
    expect(sockets[8]!.readableEnded).toBe(true);
    for (const socket of sockets) socket.destroy();
  });

  it('reaps dead and reused pids, preserves live pids with unreadable tokens, and lists live records', async () => {
    const runtimeDir = runtimeDirectory();
    const directory = path.join(runtimeDir, 'term2', 'control');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const makeRecord = (name: string, pid: number, startedAt: string) => {
      const socketPath = path.join(directory, `${name}.sock`);
      const advertisementPath = path.join(directory, `${name}.json`);
      fs.writeFileSync(socketPath, 'socket fake');
      fs.writeFileSync(
        advertisementPath,
        JSON.stringify({
          v: 1,
          name,
          pid,
          startedAt,
          sessionId: 's',
          socketPath,
          cwd: '/tmp',
          host: 'host-test',
        }),
      );
      return { socketPath, advertisementPath };
    };
    const dead = makeRecord('dead', 101, 'old');
    const reused = makeRecord('reused', 102, 'old');
    const unreadable = makeRecord('unreadable', 103, 'old');
    const live = makeRecord('live', 104, 'same');

    reapControlDirectory(
      directory,
      'host-test',
      (pid) => pid !== 101,
      (pid) => {
        if (pid === 102) return 'new';
        if (pid === 103) return null;
        return 'same';
      },
    );

    expect(fs.existsSync(dead.advertisementPath)).toBe(false);
    expect(fs.existsSync(reused.advertisementPath)).toBe(false);
    expect(fs.existsSync(unreadable.advertisementPath)).toBe(true);
    expect(fs.existsSync(live.advertisementPath)).toBe(true);
    expect(fs.existsSync(dead.socketPath)).toBe(true); // regular files are never reaped as sockets
    expect(listControlAdvertisements(runtimeDir, 'host-test')).toEqual([]);
  });

  it('validates names and parses proc starttime after the last closing parenthesis', () => {
    expect(isControlSocketName('worker-1_a')).toBe(true);
    expect(isControlSocketName('../worker')).toBe(false);
    expect(parseProcStartTime('10 (name with ) parens) R 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 987654 22')).toBe(
      '987654',
    );
  });

  it('projects phase using pending and queue signals, not queue state labels', () => {
    expect(
      projectControlPhase({
        hasNestedApproval: false,
        activeTurn: false,
        queueOwnsSubmissions: false,
        queueActive: false,
      }),
    ).toEqual({ phase: 'idle', waitKind: null });
    expect(
      projectControlPhase({
        foregroundToolName: 'ask_user',
        hasNestedApproval: true,
        activeTurn: true,
        queueOwnsSubmissions: false,
        queueActive: false,
      }),
    ).toEqual({ phase: 'awaiting_approval', waitKind: 'question' });
    expect(
      projectControlPhase({
        foregroundToolName: 'shell',
        hasNestedApproval: true,
        activeTurn: true,
        queueOwnsSubmissions: false,
        queueActive: false,
      }),
    ).toEqual({ phase: 'awaiting_approval', waitKind: 'approval' });
    expect(
      projectControlPhase({
        hasNestedApproval: true,
        activeTurn: false,
        queueOwnsSubmissions: false,
        queueActive: false,
      }),
    ).toEqual({ phase: 'awaiting_approval', waitKind: 'nested_approval' });
    expect(
      projectControlPhase({
        hasNestedApproval: false,
        activeTurn: false,
        queueOwnsSubmissions: true,
        queueActive: false,
      }),
    ).toEqual({ phase: 'working', waitKind: null });
  });

  it('keeps FIFO admission and protects pending idempotency entries from eviction', async () => {
    const lock = new ControlAdmissionLock();
    const order: number[] = [];
    await Promise.all(
      [1, 2, 3].map((value) =>
        lock.run(async () => {
          order.push(value);
        }),
      ),
    );
    expect(order).toEqual([1, 2, 3]);

    const entries = new ControlIdempotencyMap<string>(2);
    entries.set('pending', { text: 'a' }, 'receipt-pending', true);
    entries.set('done-1', { text: 'b' }, 'receipt-1');
    entries.set('done-2', { text: 'c' }, 'receipt-2');
    expect(entries.get('pending', { text: 'a' })).toEqual({ kind: 'replay', receipt: 'receipt-pending' });
    expect(entries.get('pending', { text: 'changed' })).toEqual({ kind: 'conflict' });
    expect(entries.get('done-1', { text: 'b' })).toEqual({ kind: 'missing' });
    entries.set('done-3', { text: 'd' }, 'receipt-3');
    expect(entries.get('pending', { text: 'a' })).toEqual({ kind: 'replay', receipt: 'receipt-pending' });
  });
});
