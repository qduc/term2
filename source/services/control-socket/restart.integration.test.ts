import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import { expect, it } from 'vitest';
import { ControlSocketServer, type ControlMutationReceipt } from './control-socket.js';

it('pauses real socket mutations at the existing admission FIFO, drains entered receipts and keeps reads available', async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'term2-restart-socket-'));
  let finish!: (receipt: ControlMutationReceipt) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let calls = 0;
  const server = new ControlSocketServer({
    name: 'restart',
    runtimeDir,
    sessionId: () => 'session',
    port: {
      status: () => ({ sessionId: 'session' }),
      get: () => ({}),
      submit: () => {
        calls++;
        entered();
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
      interrupt: async () => ({ accepted: true }),
    },
  });
  let socket: ReturnType<typeof connect> | undefined;
  let reader: ReturnType<typeof connect> | undefined;
  try {
    await server.listen();
    socket = connect(server.binding.socketPath);
    const pending = new Map<string, (reply: any) => void>();
    const receive = (transport: ReturnType<typeof connect>) => {
      let buffer = '';
      transport.on('data', (chunk) => {
        buffer += String(chunk);
        for (;;) {
          const newline = buffer.indexOf('\n');
          if (newline < 0) break;
          const reply = JSON.parse(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          pending.get(reply.id)?.(reply);
          pending.delete(reply.id);
        }
      });
    };
    receive(socket);
    reader = connect(server.binding.socketPath);
    receive(reader);
    let id = 0;
    const request = (method: string, params?: unknown, transport = socket!) =>
      new Promise<any>((resolve) => {
        const requestId = String(++id);
        pending.set(requestId, resolve);
        transport.write(JSON.stringify({ v: 1, id: requestId, method, ...(params ? { params } : {}) }) + '\n');
      });
    expect((await request('hello')).ok).toBe(true);
    expect((await request('hello', undefined, reader)).ok).toBe(true);
    const admitted = request('submit', { text: 'retained', clientRequestId: 'first' });
    await started;
    const paused = server.pauseMutations();
    let drained = false;
    void paused.drained.then(() => {
      drained = true;
    });
    const late = request('submit', { text: 'rejected', clientRequestId: 'late' });
    const interrupt = request('interrupt');
    expect((await request('status', undefined, reader)).ok).toBe(true);
    expect(drained).toBe(false);
    finish({ messageId: 'retained', delivery: 'queued' });
    expect((await admitted).ok).toBe(true);
    await paused.drained;
    expect((await late).error.code).toBe('unavailable');
    expect((await interrupt).error.code).toBe('unavailable');
    expect(calls).toBe(1);
    paused.release();
    paused.release();
    expect((await request('interrupt')).result.accepted).toBe(true);
  } finally {
    socket?.destroy();
    reader?.destroy();
    await server.close();
    await rm(runtimeDir, { recursive: true, force: true });
  }
});
