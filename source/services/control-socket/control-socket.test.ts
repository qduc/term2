import { afterEach, describe, expect, it } from 'vitest';
import { connect, type Socket } from 'node:net';
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
  parseProcStartTime,
  projectControlPhase,
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
      capabilities: [],
      topics: [...CONTROL_TOPICS],
    });
    expect((await request(socket, { v: 1, id: 's', method: 'status' })).result).toEqual({ phase: 'idle' });
    for (const [index, topic] of CONTROL_TOPICS.entries()) {
      expect((await request(socket, { v: 1, id: `g${index}`, method: 'get', params: { topic } })).result).toEqual({
        topic,
      });
    }
    expect(await request(socket, { v: 1, id: 'm', method: 'submit' })).toMatchObject({
      ok: false,
      error: { code: 'unknown_method' },
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
