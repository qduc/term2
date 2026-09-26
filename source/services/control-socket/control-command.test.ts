import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ControlSocketServer, type ControlSessionPort } from './control-socket.js';
import { runControlCommand } from './control-command.js';

const roots: string[] = [];
const servers: ControlSocketServer[] = [];
const previousRuntimeDir = process.env.XDG_RUNTIME_DIR;

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  if (previousRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
  else process.env.XDG_RUNTIME_DIR = previousRuntimeDir;
});

function capture() {
  let stdout = '';
  let stderr = '';
  return {
    stdout: { write: (text: string) => (stdout += text) },
    stderr: { write: (text: string) => (stderr += text) },
    read: () => ({ stdout, stderr }),
  };
}

async function setup(
  port: ControlSessionPort = {
    status: () => ({ phase: 'idle', context: { contextWindow: 100 }, cost: { state: 'exact' } }),
    get: (topic: string) => ({ topic, value: 'ok' }),
    interrupt: async () => ({ accepted: false, reason: 'idle' }),
  },
) {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-control-cli-'));
  fs.chmodSync(runtimeDir, 0o700);
  roots.push(runtimeDir);
  process.env.XDG_RUNTIME_DIR = runtimeDir;
  const server = new ControlSocketServer({
    name: 'cli-worker',
    runtimeDir,
    sessionId: () => 'session',
    port,
  });
  servers.push(server);
  await server.listen();
  return server;
}

describe('control CLI', () => {
  it('lists advertisements, calls status/get after hello, and returns exit 0', async () => {
    await setup();
    const list = capture();
    expect(await runControlCommand(['list'], list.stdout, list.stderr)).toBe(0);
    expect(list.read().stdout).toContain('cli-worker');

    const listStatus = capture();
    expect(await runControlCommand(['list', '--status'], listStatus.stdout, listStatus.stderr)).toBe(0);
    expect(listStatus.read().stdout).toContain('"phase":"idle"');

    const status = capture();
    expect(await runControlCommand(['status', 'cli-worker', '--json'], status.stdout, status.stderr)).toBe(0);
    expect(JSON.parse(status.read().stdout)).toEqual({
      phase: 'idle',
      context: { contextWindow: 100 },
      cost: { state: 'exact' },
    });

    const readableStatus = capture();
    expect(await runControlCommand(['status', 'cli-worker'], readableStatus.stdout, readableStatus.stderr)).toBe(0);
    expect(readableStatus.read().stdout).toContain('context={"contextWindow":100}');
    expect(readableStatus.read().stdout).not.toContain('[object Object]');

    const interrupt = capture();
    expect(await runControlCommand(['interrupt', 'cli-worker', '--json'], interrupt.stdout, interrupt.stderr)).toBe(0);
    expect(JSON.parse(interrupt.read().stdout)).toEqual({ accepted: false, reason: 'idle' });

    const get = capture();
    expect(await runControlCommand(['get', 'cli-worker', 'model', '--json'], get.stdout, get.stderr)).toBe(0);
    expect(JSON.parse(get.read().stdout)).toEqual({ topic: 'model', value: 'ok' });
  });

  it('returns exit 1 for an unknown name, malformed arguments, server error, and connection failure', async () => {
    const server = await setup();
    const unknown = capture();
    expect(await runControlCommand(['status', 'missing'], unknown.stdout, unknown.stderr)).toBe(1);

    const invalid = capture();
    expect(await runControlCommand(['get', 'cli-worker', 'unknown'], invalid.stdout, invalid.stderr)).toBe(1);

    const badArgs = capture();
    expect(await runControlCommand(['get', 'cli-worker'], badArgs.stdout, badArgs.stderr)).toBe(1);

    fs.unlinkSync(server.socketPath);
    const disconnected = capture();
    expect(await runControlCommand(['status', 'cli-worker'], disconnected.stdout, disconnected.stderr)).toBe(1);
  });

  it('reads mutation text from stdin and rejects empty input before making a socket call', async () => {
    const status = vi.fn(() => ({ phase: 'idle' }));
    const received: unknown[] = [];
    await setup({
      status,
      get: (topic: string) => ({ topic }),
      submit: async (params) => {
        received.push({ text: params.text, clientRequestId: params.clientRequestId });
        return { messageId: 'message-submit', delivery: 'started' as const };
      },
      steer: async (params) => {
        received.push({ text: params.text, clientRequestId: params.clientRequestId });
        return { messageId: 'message-steer', delivery: 'steering' as const };
      },
      interrupt: async () => ({ accepted: false, reason: 'idle' }),
    });
    const emptyInput = async function* () {};
    const empty = capture();
    expect(
      await runControlCommand(
        ['submit', 'cli-worker', '--id', 'empty', '--json'],
        empty.stdout,
        empty.stderr,
        emptyInput(),
      ),
    ).toBe(1);
    expect(status).not.toHaveBeenCalled();
    expect(received).toHaveLength(0);

    const textInput = async function* () {
      yield Buffer.from('brief');
    };
    for (const [method, expectedMessage, delivery] of [
      ['submit', 'message-submit', 'started'],
      ['steer', 'message-steer', 'steering'],
    ] as const) {
      const output = capture();
      expect(
        await runControlCommand(
          [method, 'cli-worker', '--id', method, '--json'],
          output.stdout,
          output.stderr,
          textInput(),
        ),
      ).toBe(0);
      expect(JSON.parse(output.read().stdout)).toEqual({ messageId: expectedMessage, delivery });
    }
    expect(received).toEqual([
      { text: 'brief', clientRequestId: 'submit' },
      { text: 'brief', clientRequestId: 'steer' },
    ]);

    const interrupt = capture();
    expect(await runControlCommand(['interrupt', 'cli-worker', '--json'], interrupt.stdout, interrupt.stderr)).toBe(0);
    expect(JSON.parse(interrupt.read().stdout)).toEqual({ accepted: false, reason: 'idle' });
  });

  it('returns wait-turn timeout 2 and approval 3 from real socket status polls', async () => {
    let phase = 'working';
    const status = vi.fn(() => ({ phase, queue: [] }));
    await setup({ status, get: () => ({}) });

    const timeout = capture();
    expect(
      await runControlCommand(
        ['wait-turn', 'cli-worker', '--message-id', 'turn-1', '--timeout', '0', '--json'],
        timeout.stdout,
        timeout.stderr,
      ),
    ).toBe(2);
    expect(JSON.parse(timeout.read().stdout)).toEqual({ status: 'timeout', messageId: 'turn-1' });

    phase = 'awaiting_approval';
    const approval = capture();
    expect(
      await runControlCommand(
        ['wait-turn', 'cli-worker', '--message-id', 'turn-1', '--timeout', '0', '--json'],
        approval.stdout,
        approval.stderr,
      ),
    ).toBe(3);
    expect(JSON.parse(approval.read().stdout)).toEqual({ status: 'awaiting_approval', messageId: 'turn-1' });
    expect(status).toHaveBeenCalledTimes(2);
  });
});
