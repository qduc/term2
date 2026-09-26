import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ControlSocketServer } from './control-socket.js';
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

async function setup() {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-control-cli-'));
  fs.chmodSync(runtimeDir, 0o700);
  roots.push(runtimeDir);
  process.env.XDG_RUNTIME_DIR = runtimeDir;
  const server = new ControlSocketServer({
    name: 'cli-worker',
    runtimeDir,
    sessionId: () => 'session',
    port: { status: () => ({ phase: 'idle' }), get: (topic) => ({ topic, value: 'ok' }) },
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
    expect(JSON.parse(status.read().stdout)).toEqual({ phase: 'idle' });

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
});
