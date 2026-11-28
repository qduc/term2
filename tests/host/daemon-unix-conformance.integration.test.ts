/**
 * Conformance & security integration suite for the Term2 singleton Unix daemon
 * (`docs/plans/daemon/spec/transport-unix.md` & `client-api.md` v1.0).
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CLIENT_API_SCHEMAS,
  type UnixEventFrame,
  type UnixFrame,
  type UnixResponseFrame,
} from '../../src/protocol/client-api/client-api-schema.js';
import { startTerm2Daemon, type Term2DaemonHandle } from '../../src/app/daemon/daemon.js';
import { connectOrStartDaemon } from '../../src/app/daemon/daemon-bootstrap.js';
import { prepareSocketForBind } from '../../src/app/daemon/daemon-paths.js';
import { integrationCliPath } from '../helpers/integration-cli.js';
import { controlDirectory } from '../../src/clients/control-socket/control-socket.js';

const execFileAsync = promisify(execFile);

class TestUnixRpcClient {
  #nextId = 0;
  #buffer = '';
  readonly #pending = new Map<string, { resolve: (frame: UnixResponseFrame) => void; reject: (err: Error) => void }>();
  readonly events: UnixEventFrame[] = [];
  readonly #eventWaiters: Array<(frame: UnixEventFrame) => boolean> = [];
  closed = false;

  constructor(readonly socket: net.Socket) {
    socket.on('data', (chunk: Buffer) => {
      this.#buffer += chunk.toString('utf8');
      for (;;) {
        const nl = this.#buffer.indexOf('\n');
        if (nl === -1) break;
        const line = this.#buffer.slice(0, nl);
        this.#buffer = this.#buffer.slice(nl + 1);
        if (!line) continue;
        const frame = CLIENT_API_SCHEMAS.unixFrame.parse(JSON.parse(line)) as UnixFrame;
        if (frame.kind === 'response') {
          const waiter = this.#pending.get(frame.id);
          if (waiter) {
            this.#pending.delete(frame.id);
            waiter.resolve(frame);
          }
        } else if (frame.kind === 'event') {
          this.events.push(frame);
          for (let i = this.#eventWaiters.length - 1; i >= 0; i -= 1) {
            if (this.#eventWaiters[i]!(frame)) this.#eventWaiters.splice(i, 1);
          }
        }
      }
    });
    const onClose = () => {
      this.closed = true;
      for (const [, waiter] of this.#pending) waiter.reject(new Error('Socket closed'));
      this.#pending.clear();
    };
    socket.once('close', onClose);
    socket.once('error', onClose);
  }

  request(method: string, params?: Record<string, unknown>): Promise<UnixResponseFrame> {
    const id = `req-${++this.#nextId}`;
    return new Promise<UnixResponseFrame>((resolve, reject) => {
      if (this.closed) {
        reject(new Error('Socket already closed'));
        return;
      }
      this.#pending.set(id, { resolve, reject });
      this.socket.write(`${JSON.stringify({ kind: 'request', id, method, ...(params ? { params } : {}) })}\n`, 'utf8');
    });
  }

  waitForEvent(predicate: (frame: UnixEventFrame) => boolean, timeoutMs = 5_000): Promise<UnixEventFrame> {
    const existing = this.events.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise<UnixEventFrame>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for Unix event frame')), timeoutMs);
      const check = (frame: UnixEventFrame): boolean => {
        if (!predicate(frame)) return false;
        clearTimeout(timer);
        resolve(frame);
        return true;
      };
      this.#eventWaiters.push(check);
    });
  }

  close(): void {
    this.socket.destroy();
  }
}

async function connectRaw(socketPath: string): Promise<net.Socket> {
  return await new Promise<net.Socket>((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.off('error', reject);
      resolve(socket);
    });
  });
}

async function startMockOpenAiProvider(replyText: string): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url?.includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'daemon-test-model' }] }));
      return;
    }
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        [
          `data: ${JSON.stringify({
            id: 'chatcmpl-d',
            choices: [{ delta: { role: 'assistant', content: replyText } }],
          })}`,
          '',
          'data: {"id":"chatcmpl-d","choices":[{"delta":{},"finish_reason":"stop"}]}',
          '',
          'data: [DONE]',
          '',
        ].join('\n'),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** One request on a control socket's private v1 wire, after its `hello`. */
async function controlSocketRequest(
  socketPath: string,
  method: string,
  params: Record<string, unknown>,
): Promise<{ ok: boolean; error?: { code: string } }> {
  const socket = await connectRaw(socketPath);
  try {
    const replies: Array<{ id: string; ok: boolean; error?: { code: string } }> = [];
    let buffer = '';
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
        replies.push(JSON.parse(buffer.slice(0, nl)));
        buffer = buffer.slice(nl + 1);
      }
    });
    const next = (id: string) =>
      new Promise<{ ok: boolean; error?: { code: string } }>((resolve, reject) => {
        const check = () => {
          const found = replies.find((reply) => reply.id === id);
          if (found) resolve(found);
          else if (socket.destroyed) reject(new Error('control socket closed'));
          else setTimeout(check, 10);
        };
        check();
      });
    socket.write(`${JSON.stringify({ v: 1, id: 'hello', method: 'hello' })}\n`);
    expect((await next('hello')).ok).toBe(true);
    socket.write(`${JSON.stringify({ v: 1, id: 'call', method, params })}\n`);
    return await next('call');
  } finally {
    socket.destroy();
  }
}

describe('Singleton Unix Daemon Conformance (Client API v1.0)', () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      try {
        await cleanups.pop()!();
      } catch {
        // Best-effort cleanup.
      }
    }
  });

  function makeSandboxRoot(): {
    root: string;
    stateDir: string;
    runtimeDir: string;
    socketPath: string;
    workspace: string;
  } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 't2-dmn-'));
    const stateDir = path.join(root, 'state');
    const runtimeDir = path.join(root, 'run');
    const socketPath = path.join(runtimeDir, 'daemon.sock');
    const workspace = path.join(root, 'ws');
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'hello.txt'), 'world\n');
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    return { root, stateDir, runtimeDir, socketPath, workspace };
  }

  it('enforces 0700/0600 permissions, singleton lock, stale socket guard, handshake rules, and 4 MiB line cap', async () => {
    const { stateDir, runtimeDir, socketPath, workspace } = makeSandboxRoot();
    const conversationsDir = path.join(stateDir, 'conversations');

    // Refuses to unlink a non-socket file at socketPath.
    fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(socketPath, 'not-a-socket');
    await expect(prepareSocketForBind(socketPath)).rejects.toThrow(/non-socket/);
    fs.unlinkSync(socketPath);

    const env = { ...process.env, TERM2_DAEMON_DIR: runtimeDir, TERM2_CONVERSATIONS_DIR: conversationsDir };
    const started = await startTerm2Daemon({ stateDir, conversationsDir, socketPath, env });
    expect(started.kind).toBe('started');
    if (started.kind !== 'started') return;
    cleanups.push(() => started.shutdown({ mode: 'immediate' }));

    // Verify mandatory 0700 dir and 0600 socket + daemon.json permissions.
    expect(fs.lstatSync(runtimeDir).mode & 0o777).toBe(0o700);
    expect(fs.lstatSync(socketPath).mode & 0o777).toBe(0o600);
    expect(fs.lstatSync(started.paths.advertisementPath).mode & 0o777).toBe(0o600);
    const ad = JSON.parse(fs.readFileSync(started.paths.advertisementPath, 'utf8'));
    expect(ad.daemonId).toBe(started.daemonId);
    expect(ad.pid).toBe(process.pid);
    expect(ad.protocolVersion).toBe('1.1');

    // Second daemon candidate detects live peer and yields cleanly.
    const second = await startTerm2Daemon({ stateDir, conversationsDir, socketPath, env });
    expect(second.kind).toBe('already_running');

    // Pre-handshake method rejection.
    const rawPre = new TestUnixRpcClient(await connectRaw(socketPath));
    cleanups.push(() => rawPre.close());
    const rejectedBeforeHello = await rawPre.request('session.list', {});
    expect(rejectedBeforeHello.ok).toBe(false);
    if (!rejectedBeforeHello.ok) expect(rejectedBeforeHello.error.code).toBe('invalid_request');

    // Pre-handshake non-idle shutdown rejected.
    const badShutdown = await rawPre.request('daemon.shutdown', { mode: 'immediate' });
    expect(badShutdown.ok).toBe(false);
    if (!badShutdown.ok) expect(badShutdown.error.code).toBe('invalid_request');
    rawPre.close();

    // Protocol mismatch returns protocol_incompatible with activeTurnCount and closes socket.
    const incompatibleSock = await connectRaw(socketPath);
    const incompatibleClient = new TestUnixRpcClient(incompatibleSock);
    const closePromise = new Promise<void>((resolve) => incompatibleSock.once('close', () => resolve()));
    const badHello = await incompatibleClient.request('protocol.hello', {
      protocolVersion: '2.0',
      minSupportedVersion: '2.0',
      clientKind: 'test',
      clientVersion: '9.9.9',
    });
    expect(badHello.ok).toBe(false);
    if (!badHello.ok) {
      expect(badHello.error.code).toBe('protocol_incompatible');
      expect(badHello.error.details?.['daemonProtocolVersion']).toBe('1.1');
      expect(badHello.error.details?.['daemonMinSupportedVersion']).toBe('1.0');
      expect(badHello.error.details?.['activeTurnCount']).toBe(0);
    }
    await closePromise;

    // Incremental 4 MiB inbound line cap closes offending connection without disturbing sibling client.
    const healthySock = await connectRaw(socketPath);
    const healthy = new TestUnixRpcClient(healthySock);
    cleanups.push(() => healthy.close());
    const welcome = await healthy.request('protocol.hello', {
      protocolVersion: '1.0',
      minSupportedVersion: '1.0',
      clientKind: 'test',
      clientVersion: '1.0.0',
    });
    expect(welcome.ok).toBe(true);
    if (welcome.ok) CLIENT_API_SCHEMAS.protocolWelcomeResult.parse(welcome.result);

    const abusiveSock = await connectRaw(socketPath);
    abusiveSock.on('error', () => undefined);
    const abusiveClosed = new Promise<void>((resolve) => abusiveSock.once('close', () => resolve()));
    // Send > 4 MiB without a newline.
    const chunk = Buffer.alloc(512 * 1024, 0x61);
    for (let i = 0; i < 9; i += 1) {
      if (abusiveSock.destroyed) break;
      abusiveSock.write(chunk);
    }
    await abusiveClosed;

    // Healthy client is completely unaffected and can create a session (while workspaceId+cwd is rejected).
    const badCreate = await healthy.request('session.create', { cwd: workspace, workspaceId: 'ws-1' });
    expect(badCreate.ok).toBe(false);
    if (!badCreate.ok) expect(badCreate.error.code).toBe('invalid_request');

    const ping = await healthy.request('protocol.ping');
    expect(ping.ok).toBe(true);

    // Graceful shutdown returns {}, refuses new turn/session admissions with closed, broadcasts daemon.draining,
    // and removes daemon.sock + daemon.json before unlocking.
    const drainingPromise = healthy.waitForEvent((e) => e.event === 'daemon.draining');
    const shutdownRes = await healthy.request('daemon.shutdown', { mode: 'graceful', timeoutMs: 2_000 });
    expect(shutdownRes.ok).toBe(true);
    if (shutdownRes.ok) expect(shutdownRes.result).toEqual({});
    const whileDraining = await healthy.request('session.create', { cwd: workspace }).catch(() => null);
    if (whileDraining) {
      expect(whileDraining.ok).toBe(false);
      if (!whileDraining.ok) expect(whileDraining.error.code).toBe('closed');
    }
    const draining = await drainingPromise;
    CLIENT_API_SCHEMAS.daemonDrainingEvent.parse(draining.payload);
    await started.closed;
    expect(fs.existsSync(socketPath)).toBe(false);
    expect(fs.existsSync(started.paths.advertisementPath)).toBe(false);
  });

  it('multiplexes session.list.subscribe, multi-client session.attach, cursor replay, EOF detach, and settings.subscribe', async () => {
    const { stateDir, runtimeDir, socketPath, workspace, root } = makeSandboxRoot();
    const conversationsDir = path.join(stateDir, 'conversations');
    const settingsDir = path.join(root, 'settings');
    fs.mkdirSync(settingsDir, { recursive: true, mode: 0o700 });

    const mock = await startMockOpenAiProvider('hello from singleton daemon');
    cleanups.push(() => mock.close());

    fs.writeFileSync(
      path.join(settingsDir, 'settings.json'),
      JSON.stringify({
        agent: {
          modelSelection: { provider: 'mock-daemon', model: 'daemon-test-model' },
        },
        providers: [
          {
            name: 'mock-daemon',
            type: 'openai-compatible',
            baseUrl: mock.baseUrl,
            apiKey: 'test-key',
          },
        ],
      }),
    );

    const prevSettingsDir = process.env['TERM2_SETTINGS_DIR'];
    const prevApiKey = process.env['MOCK_DAEMON_API_KEY'];
    process.env['TERM2_SETTINGS_DIR'] = settingsDir;
    process.env['MOCK_DAEMON_API_KEY'] = 'test-key';
    cleanups.push(() => {
      if (prevSettingsDir === undefined) delete process.env['TERM2_SETTINGS_DIR'];
      else process.env['TERM2_SETTINGS_DIR'] = prevSettingsDir;
      if (prevApiKey === undefined) delete process.env['MOCK_DAEMON_API_KEY'];
      else process.env['MOCK_DAEMON_API_KEY'] = prevApiKey;
    });

    const env = {
      ...process.env,
      TERM2_DAEMON_DIR: runtimeDir,
      TERM2_CONVERSATIONS_DIR: conversationsDir,
      TERM2_SETTINGS_DIR: settingsDir,
    };
    const started: Term2DaemonHandle = await startTerm2Daemon({ stateDir, conversationsDir, socketPath, env });
    expect(started.kind).toBe('started');
    if (started.kind !== 'started') return;
    cleanups.push(() => started.shutdown({ mode: 'immediate' }));

    const clientA = new TestUnixRpcClient(await connectRaw(socketPath));
    const clientB = new TestUnixRpcClient(await connectRaw(socketPath));
    cleanups.push(() => clientA.close());
    cleanups.push(() => clientB.close());

    for (const [label, client] of [
      ['tui', clientA],
      ['headless', clientB],
    ] as const) {
      const w = await client.request('protocol.hello', {
        protocolVersion: '1.0',
        minSupportedVersion: '1.0',
        clientKind: label,
        clientVersion: '1.0.0',
      });
      expect(w.ok).toBe(true);
    }

    // Subscribe to session list on Client A.
    const listSub = await clientA.request('session.list.subscribe', {});
    expect(listSub.ok).toBe(true);
    if (!listSub.ok) return;
    const listStreamId = listSub.result['streamId'] as string;
    const listSnap = await clientA.waitForEvent(
      (e) => e.streamId === listStreamId && e.event === 'session.list.snapshot',
    );
    CLIENT_API_SCHEMAS.sessionListSnapshotEvent.parse(listSnap.payload);

    // Create a session on Client A; Client A receives live session.list.upsert.
    const created = await clientA.request('session.create', { cwd: workspace });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const createdParsed = CLIENT_API_SCHEMAS.sessionCreateResult.parse(created.result);
    const sessionId = createdParsed.session.id;

    const upsert = await clientA.waitForEvent(
      (e) =>
        e.streamId === listStreamId &&
        e.event === 'session.list.upsert' &&
        (e.payload['session'] as { id?: string } | undefined)?.id === sessionId,
    );
    CLIENT_API_SCHEMAS.sessionListUpsertEvent.parse(upsert.payload);

    // Both Client A and Client B attach concurrently to the same session.
    const attachA = await clientA.request('session.attach', { sessionId });
    const attachB = await clientB.request('session.attach', { sessionId });
    expect(attachA.ok && attachB.ok).toBe(true);
    if (!attachA.ok || !attachB.ok) return;
    const streamA = CLIENT_API_SCHEMAS.unixSessionAttachResult.parse(attachA.result).streamId;
    const streamB = CLIENT_API_SCHEMAS.unixSessionAttachResult.parse(attachB.result).streamId;

    const snapA = await clientA.waitForEvent((e) => e.streamId === streamA && e.event === 'session.snapshot');
    const snapB = await clientB.waitForEvent((e) => e.streamId === streamB && e.event === 'session.snapshot');
    CLIENT_API_SCHEMAS.sessionSnapshotEvent.parse(snapA.payload);
    CLIENT_API_SCHEMAS.sessionSnapshotEvent.parse(snapB.payload);

    // Submit a real turn from Client A and verify BOTH Client A and Client B observe turn_ended!
    const submitted = await clientA.request('session.command', {
      sessionId,
      command: {
        type: 'submit',
        requestId: 'req-daemon-turn-1',
        text: 'Say hello',
        origin: { kind: 'cli' },
      },
    });
    expect(submitted.ok).toBe(true);

    const hasTurnEnded = (frame: UnixEventFrame) =>
      frame.event === 'session.accepted' &&
      Array.isArray(frame.payload['events']) &&
      (frame.payload['events'] as Array<{ type?: string }>).some((ev) => ev.type === 'turn_ended');

    const [endedA, endedB] = await Promise.all([
      clientA.waitForEvent((e) => e.streamId === streamA && hasTurnEnded(e), 10_000),
      clientB.waitForEvent((e) => e.streamId === streamB && hasTurnEnded(e), 10_000),
    ]);
    CLIENT_API_SCHEMAS.sessionAcceptedEvent.parse(endedA.payload);
    CLIENT_API_SCHEMAS.sessionAcceptedEvent.parse(endedB.payload);

    // Client B disconnects abruptly (EOF); session stays alive and Client A can still query & replay it!
    clientB.close();

    // Cursor replay from fromSeq: 0 replays accepted frames; wrong sessionEpoch returns cursor_out_of_range.
    const badEpoch = await clientA.request('session.attach', { sessionId, fromSeq: 0, sessionEpoch: 'wrong-epoch' });
    expect(badEpoch.ok).toBe(false);
    if (!badEpoch.ok) expect(badEpoch.error.code).toBe('cursor_out_of_range');

    const replayAttach = await clientA.request('session.attach', { sessionId, fromSeq: 0, sessionEpoch: sessionId });
    expect(replayAttach.ok).toBe(true);
    if (!replayAttach.ok) return;
    const replayInfo = CLIENT_API_SCHEMAS.unixSessionAttachResult.parse(replayAttach.result);
    expect(replayInfo.mode).toBe('replay');
    expect(replayInfo.streamId).not.toBe(streamA);
    await clientA.waitForEvent((e) => e.streamId === replayInfo.streamId && hasTurnEnded(e), 5_000);

    // Detach returns {} and stops future events.
    const detached = await clientA.request('session.detach', { streamId: replayInfo.streamId });
    expect(detached.ok).toBe(true);

    // settings.subscribe emits settings.snapshot and settings.changed; stale revision fails with stale_revision.
    const setSub = await clientA.request('settings.subscribe', {});
    expect(setSub.ok).toBe(true);
    if (!setSub.ok) return;
    const setStreamId = setSub.result['streamId'] as string;
    const setSnap = await clientA.waitForEvent((e) => e.streamId === setStreamId && e.event === 'settings.snapshot');
    const parsedSetSnap = CLIENT_API_SCHEMAS.settingsStateEvent.parse(setSnap.payload);

    const staleWrite = await clientA.request('settings.update', {
      expectedRevision: 'stale-rev-0',
      changes: [{ key: 'agent.maxTurns', value: 42 }],
    });
    expect(staleWrite.ok).toBe(false);
    if (!staleWrite.ok) expect(staleWrite.error.code).toBe('stale_revision');

    const okWrite = await clientA.request('settings.update', {
      expectedRevision: parsedSetSnap.revision,
      changes: [{ key: 'agent.maxTurns', value: 42 }],
    });
    expect(okWrite.ok).toBe(true);
    const setChanged = await clientA.waitForEvent((e) => e.streamId === setStreamId && e.event === 'settings.changed');
    CLIENT_API_SCHEMAS.settingsStateEvent.parse(setChanged.payload);

    // Connection-scoped capability enforcement: a client that does not negotiate a capability gets `unavailable`.
    const limitedClient = new TestUnixRpcClient(await connectRaw(socketPath));
    cleanups.push(() => limitedClient.close());
    const limitedHello = await limitedClient.request('protocol.hello', {
      protocolVersion: '1.0',
      minSupportedVersion: '1.0',
      clientKind: 'tui',
      clientVersion: '1.0.0',
      capabilities: ['daemon_control'],
    });
    expect(limitedHello.ok).toBe(true);
    if (limitedHello.ok) {
      expect(limitedHello.result['capabilities']).toEqual(['daemon_control']);
    }
    expect(await limitedClient.request('daemon.status')).toMatchObject({ ok: true });
    expect(await limitedClient.request('mcp.status')).toMatchObject({ ok: false, error: { code: 'unavailable' } });
    expect(await limitedClient.request('settings.subscribe')).toMatchObject({
      ok: false,
      error: { code: 'unavailable' },
    });
    expect(await limitedClient.request('session.list.subscribe')).toMatchObject({
      ok: false,
      error: { code: 'unavailable' },
    });

    // Mismatched stream close (`session.detach` on a `session.list.subscribe` streamId) must not retire the list stream.
    const listSubRes = await clientA.request('session.list.subscribe');
    expect(listSubRes.ok).toBe(true);
    const listSubId = listSubRes.ok ? String(listSubRes.result['streamId']) : '';
    await clientA.waitForEvent((e) => e.streamId === listSubId && e.event === 'session.list.snapshot');
    expect(await clientA.request('session.detach', { streamId: listSubId })).toMatchObject({ ok: true });
    const afterDetachCreate = await clientA.request('session.create', { cwd: workspace });
    expect(afterDetachCreate.ok).toBe(true);
    const afterDetachUpsert = await clientA.waitForEvent(
      (e) => e.streamId === listSubId && e.event === 'session.list.upsert',
    );
    expect(afterDetachUpsert.event).toBe('session.list.upsert');
    expect(await clientA.request('session.list.unsubscribe', { streamId: listSubId })).toMatchObject({ ok: true });
  });

  it('auto-starts one singleton daemon across concurrent clients and stops cleanly via CLI subcommands', async () => {
    const cliPath = integrationCliPath();
    const { stateDir, runtimeDir, socketPath, root } = makeSandboxRoot();
    const conversationsDir = path.join(stateDir, 'conversations');
    const settingsDir = path.join(root, 'settings');
    fs.mkdirSync(settingsDir, { recursive: true, mode: 0o700 });

    const env = {
      ...process.env,
      TERM2_DAEMON_DIR: runtimeDir,
      TERM2_DAEMON_SOCKET: socketPath,
      TERM2_CONVERSATIONS_DIR: conversationsDir,
      TERM2_SETTINGS_DIR: settingsDir,
    };

    // Race two concurrent connectOrStartDaemon calls when NO daemon is running.
    const [c1, c2] = await Promise.all([
      connectOrStartDaemon({
        clientKind: 'tui',
        socketPath,
        conversationsDir,
        stateDir,
        cliEntrypoint: cliPath,
        env,
      }),
      connectOrStartDaemon({
        clientKind: 'headless',
        socketPath,
        conversationsDir,
        stateDir,
        cliEntrypoint: cliPath,
        env,
      }),
    ]);
    cleanups.push(() => {
      c1.socket.destroy();
      c2.socket.destroy();
    });

    // Both clients must land on the EXACT same singleton daemon!
    expect(c1.welcome.daemonId).toBe(c2.welcome.daemonId);
    expect(c1.welcome.pid).toBe(c2.welcome.pid);
    expect(c1.welcome.protocolVersion).toBe('1.1');

    // `term2 daemon status` reports the live daemon with 2 attached clients.
    const statusOut = await execFileAsync(
      process.execPath,
      [cliPath, 'daemon', 'status', '--socket', socketPath, '--state-dir', stateDir],
      { env },
    );
    const statusJson = CLIENT_API_SCHEMAS.daemonStatusResult.parse(JSON.parse(statusOut.stdout));
    expect(statusJson.daemonId).toBe(c1.welcome.daemonId);
    expect(statusJson.attachedClientCount).toBeGreaterThanOrEqual(2);

    c1.socket.destroy();
    c2.socket.destroy();

    // `term2 daemon stop` shuts the spawned daemon down cleanly and removes socket + daemon.json.
    await execFileAsync(
      process.execPath,
      [cliPath, 'daemon', 'stop', '--socket', socketPath, '--state-dir', stateDir],
      { env },
    );
    await expect.poll(() => fs.existsSync(socketPath), { timeout: 5_000 }).toBe(false);
  });

  it('negotiates Client API v1.0 vs v1.1 strictly, gates v1.1 methods/fields, and runs v1.1 launch/settings/provider/model flows', async () => {
    const { root, stateDir, runtimeDir, socketPath } = makeSandboxRoot();
    const conversationsDir = path.join(stateDir, 'conversations');
    const settingsDir = path.join(root, 'settings');
    const wsA = path.join(root, 'ws-a');
    const wsB = path.join(root, 'ws-b');
    fs.mkdirSync(settingsDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(wsA, { recursive: true });
    fs.mkdirSync(wsB, { recursive: true });

    const mock = await startMockOpenAiProvider('v11 reply');
    cleanups.push(() => mock.close());

    const SENTINEL_SECRET = 'sk-sentinel-never-leak-v11-998877';
    const URL_SECRET = 'https://user:pass-sentinel@firecrawl.example.test/v1?token=url-secret-1#frag-secret';
    fs.writeFileSync(
      path.join(settingsDir, 'settings.json'),
      JSON.stringify({
        agent: { modelSelection: { provider: 'mock-v11', model: 'daemon-test-model' } },
        webSearch: { firecrawl: { baseUrl: URL_SECRET } },
        providers: [
          {
            name: 'mock-v11',
            type: 'openai-compatible',
            baseUrl: mock.baseUrl,
            apiKey: SENTINEL_SECRET,
          },
          {
            name: 'mock-v11-alt',
            type: 'openai-compatible',
            baseUrl: mock.baseUrl,
            apiKey: SENTINEL_SECRET,
          },
        ],
        sandbox: { enabled: false },
      }),
    );

    const daemon = await startTerm2Daemon({
      stateDir,
      conversationsDir,
      socketPath,
      env: { ...process.env, TERM2_DAEMON_DIR: runtimeDir, TERM2_SETTINGS_DIR: settingsDir },
    });
    expect(daemon.kind).toBe('started');
    if (daemon.kind !== 'started') return;
    cleanups.push(() => daemon.shutdown({ mode: 'immediate' }));

    // 1. v1.0 client negotiates 1.0 and has EVERY v1.1 method & additive request field strictly rejected.
    const v10 = new TestUnixRpcClient(await connectRaw(socketPath));
    cleanups.push(() => v10.close());
    const hello10 = await v10.request('protocol.hello', {
      protocolVersion: '1.0',
      minSupportedVersion: '1.0',
      clientKind: 'tui',
      clientVersion: '1.0.0',
    });
    expect(hello10.ok).toBe(true);
    if (hello10.ok) expect(hello10.result['protocolVersion']).toBe('1.0');

    expect(await v10.request('session.launch', { cwd: wsA, selection: { kind: 'new' } })).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    });
    expect(await v10.request('session.list', { cwd: wsA })).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    });
    expect(await v10.request('settings.get', { view: 'tui' })).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    });
    expect(await v10.request('settings.subscribe', { view: 'tui' })).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    });
    expect(await v10.request('models.list', { provider: 'mock-v11' })).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    });
    expect(
      await v10.request('providers.upsert', {
        name: 'mock-v11',
        type: 'openai-compatible',
        originalId: 'mock-v11',
        keepApiKey: true,
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    expect(await v10.request('mcp.login', { serverId: 'x', handoffUrl: true })).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    });
    expect(
      await v10.request('session.handoff', {
        sourceSessionId: 'conv_00000000-0000-4000-8000-000000000001',
        model: { provider: 'mock-v11-alt', model: 'daemon-test-model' },
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    expect(
      await v10.request('settings.update', {
        expectedRevision: 'r0',
        sessionId: 'conv_00000000-0000-4000-8000-000000000001',
        persist: false,
        changes: [{ key: 'ui.displayMode', value: 'standard' }],
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    expect(await v10.request('session.acp.set_mcp', { sessionId: 'conv_1', servers: [] })).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    });
    expect(await v10.request('daemon.serve.start', {})).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    });
    expect(
      await v10.request('session.control.bind', {
        sessionId: 'conv_1',
        socketPath: path.join(runtimeDir, 'ctl.sock'),
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_request' } });

    // 2. v1.1 client negotiates 1.1; `local_leases` is advertised on Unix v1.1 (`daemon.serve.*` active).
    const v11 = new TestUnixRpcClient(await connectRaw(socketPath));
    cleanups.push(() => v11.close());
    const hello11 = await v11.request('protocol.hello', {
      protocolVersion: '1.1',
      minSupportedVersion: '1.1',
      clientKind: 'tui',
      clientVersion: '1.1.0',
    });
    expect(hello11.ok).toBe(true);
    if (hello11.ok) {
      expect(hello11.result['protocolVersion']).toBe('1.1');
      expect(hello11.result['capabilities']).toContain('local_leases');
    }
    expect(await v11.request('daemon.serve.start', {})).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    });
    // Control-socket leases (Step 14e Part 2): an unknown session or lease is not found.
    expect(
      await v11.request('session.control.bind', { sessionId: 'conv_1', name: 'x', discordInput: false }),
    ).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(await v11.request('session.control.unbind', { leaseId: 'lease_unknown' })).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
    expect(await v11.request('session.acp.set_mcp', { sessionId: 'conv_1', servers: [] })).toMatchObject({
      ok: false,
      error: { code: 'unavailable' },
    });

    // 3. `session.launch` new + explicit overrides (without mutating global defaults) + workspace boundary checks.
    const launched = await v11.request('session.launch', {
      cwd: wsA,
      selection: { kind: 'new' },
      approvalMode: 'auto',
      showReview: true,
      goal: { text: 'Verify v1.1 launch' },
    });
    expect(launched.ok).toBe(true);
    if (!launched.ok) return;
    const sessionId = (launched.result['session'] as { id: string }).id;
    expect(launched.result['workspace']).toMatchObject({ root: fs.realpathSync(wsA), target: 'local' });

    // `session.launch` resume via 'last' and bare UUID, plus fork with approvalPolicy.
    const resumedLast = await v11.request('session.launch', {
      cwd: wsA,
      selection: { kind: 'resume', sessionId: 'last' },
    });
    expect(resumedLast.ok).toBe(true);
    if (resumedLast.ok) expect((resumedLast.result['session'] as { id: string }).id).toBe(sessionId);

    const bareId = sessionId.replace(/^conv_/, '');
    const resumedBare = await v11.request('session.launch', {
      cwd: wsA,
      selection: { kind: 'resume', sessionId: bareId },
    });
    expect(resumedBare.ok).toBe(true);
    if (resumedBare.ok) expect((resumedBare.result['session'] as { id: string }).id).toBe(sessionId);

    const forked = await v11.request('session.launch', {
      cwd: wsA,
      selection: { kind: 'fork', sessionId },
      approvalPolicy: { mode: 'interactive' },
    });
    expect(forked.ok).toBe(true);
    if (!forked.ok) return;
    const forkedId = (forked.result['session'] as { id: string }).id;
    expect(forkedId).not.toBe(sessionId);
    expect(forked.result['forkedFrom']).toBe(sessionId);

    // Workspace mismatch on resume returns forbidden with structured workspace details; missing returns not_found.
    const mismatch = await v11.request('session.launch', {
      cwd: wsB,
      selection: { kind: 'resume', sessionId },
    });
    expect(mismatch).toMatchObject({
      ok: false,
      error: {
        code: 'forbidden',
        details: {
          sessionId,
          sessionWorkspace: { root: fs.realpathSync(wsA) },
          requestedWorkspace: { root: fs.realpathSync(wsB) },
        },
      },
    });
    expect(
      await v11.request('session.launch', {
        cwd: wsA,
        selection: { kind: 'resume', sessionId: 'conv_00000000-0000-4000-8000-000000000099' },
      }),
    ).toMatchObject({ ok: false, error: { code: 'not_found' } });

    // `session.list` with `cwd` filters accurately, paginates, and rejects cross-scope cursors with `invalid_request`.
    const listWsA = await v11.request('session.list', { cwd: wsA, limit: 1 });
    expect(listWsA.ok).toBe(true);
    if (listWsA.ok) {
      const items = listWsA.result['sessions'] as Array<{ id: string; messageCount?: number }>;
      expect(items.length).toBe(1);
      expect(items[0]?.messageCount).toBe(0);
      const nextCursor = listWsA.result['nextCursor'] as string | undefined;
      expect(typeof nextCursor).toBe('string');
      if (nextCursor) {
        const page2 = await v11.request('session.list', { cwd: wsA, limit: 1, cursor: nextCursor });
        expect(page2.ok).toBe(true);
        if (page2.ok) expect((page2.result['sessions'] as unknown[]).length).toBe(1);
        expect(await v11.request('session.list', { cwd: wsB, cursor: nextCursor })).toMatchObject({
          ok: false,
          error: { code: 'invalid_request' },
        });
        expect(await v11.request('session.list', { cursor: nextCursor })).toMatchObject({
          ok: false,
          error: { code: 'invalid_request' },
        });
      }
    }
    const listWsB = await v11.request('session.list', { cwd: wsB });
    expect(listWsB.ok).toBe(true);
    if (listWsB.ok) expect((listWsB.result['sessions'] as unknown[]).length).toBe(0);

    // `session.handoff` with explicit target model succeeds on v1.1 and binds the new session to that model.
    const handoffRes = await v11.request('session.handoff', {
      sourceSessionId: sessionId,
      model: { provider: 'mock-v11-alt', model: 'daemon-test-model' },
      text: 'Continue verifying v1.1 handoff.',
    });
    expect(handoffRes.ok).toBe(true);
    if (handoffRes.ok) {
      const handoffSession = handoffRes.result['session'] as {
        id: string;
        model?: { provider: string; model: string };
      };
      expect(handoffSession.id).not.toBe(sessionId);
      expect(handoffSession.model).toEqual({ provider: 'mock-v11-alt', model: 'daemon-test-model' });
    }

    // 4. Scoped TUI settings projection redacts secrets & URL credentials/query/hash, streams live updates, and persists.
    const globalTui = await v11.request('settings.get', { view: 'tui' });
    expect(globalTui.ok).toBe(true);
    const globalJson = JSON.stringify(globalTui);
    expect(globalJson).not.toContain(SENTINEL_SECRET);
    expect(globalJson).not.toContain('pass-sentinel');
    expect(globalJson).not.toContain('url-secret-1');
    expect(globalJson).not.toContain('frag-secret');

    const tuiSub = await v11.request('settings.subscribe', { sessionId, view: 'tui' });
    expect(tuiSub.ok).toBe(true);
    if (!tuiSub.ok) return;
    const tuiStreamId = String(tuiSub.result['streamId']);
    const tuiSnapEvent = await v11.waitForEvent((e) => e.streamId === tuiStreamId && e.event === 'settings.snapshot');
    expect(JSON.stringify(tuiSnapEvent)).not.toContain(SENTINEL_SECRET);

    const sessionTui = await v11.request('settings.get', { sessionId, view: 'tui' });
    expect(sessionTui.ok).toBe(true);
    expect(JSON.stringify(sessionTui)).not.toContain(SENTINEL_SECRET);
    if (globalTui.ok && sessionTui.ok) {
      const gEntries = (globalTui.result['settings'] as { entries: Record<string, { value: unknown }> }).entries;
      const sEntries = (sessionTui.result['settings'] as { entries: Record<string, { value: unknown }> }).entries;
      expect(gEntries['webSearch.firecrawl.baseUrl']?.value).toBeNull();
      expect(gEntries['shell.autoApproveMode']?.value).toBe('off');
      expect(sEntries['shell.autoApproveMode']?.value).toBe('auto');
      expect(sEntries['shell.showReview']?.value).toBe(true);

      // Temporary session-scoped write emits settings.changed, honors requestId idempotency, does not mutate global default.
      const sRev = String(sessionTui.result['revision']);
      const priorChangedCount = v11.events.filter(
        (e) => e.streamId === tuiStreamId && e.event === 'settings.changed',
      ).length;
      const tempUpdate = await v11.request('settings.update', {
        expectedRevision: sRev,
        sessionId,
        persist: false,
        requestId: 'req-tui-idempotent-1',
        changes: [{ key: 'ui.displayMode', value: 'standard' }],
      });
      expect(tempUpdate.ok).toBe(true);
      const tempReplay = await v11.request('settings.update', {
        expectedRevision: sRev,
        sessionId,
        persist: false,
        requestId: 'req-tui-idempotent-1',
        changes: [{ key: 'ui.displayMode', value: 'standard' }],
      });
      expect(tempReplay).toMatchObject({
        ok: true,
        result: { revision: tempUpdate.ok ? tempUpdate.result['revision'] : '' },
      });
      await v11.waitForEvent(
        (e) =>
          e.streamId === tuiStreamId &&
          e.event === 'settings.changed' &&
          v11.events.filter((ev) => ev.streamId === tuiStreamId && ev.event === 'settings.changed').length >
            priorChangedCount,
      );

      expect(
        await v11.request('settings.update', {
          expectedRevision: sRev,
          sessionId,
          persist: false,
          changes: [{ key: 'ui.displayMode', value: 'concise' }],
        }),
      ).toMatchObject({ ok: false, error: { code: 'stale_revision' } });
      expect(
        await v11.request('settings.update', {
          expectedRevision: tempUpdate.ok ? String(tempUpdate.result['revision']) : sRev,
          sessionId,
          persist: false,
          changes: [{ key: 'providers.openai.apiKey', value: 'leaked' }],
        }),
      ).toMatchObject({ ok: false, error: { code: 'invalid_request' } });

      // Persisted session-scoped write persists to settings.json and notifies subscribers.
      const persistUpdate = await v11.request('settings.update', {
        expectedRevision: tempUpdate.ok ? String(tempUpdate.result['revision']) : sRev,
        sessionId,
        persist: true,
        changes: [{ key: 'agent.maxTurns', value: 77 }],
      });
      expect(persistUpdate.ok).toBe(true);
      expect(JSON.parse(fs.readFileSync(path.join(settingsDir, 'settings.json'), 'utf8'))['agent']['maxTurns']).toBe(
        77,
      );

      const resetUpdate = await v11.request('settings.update', {
        expectedRevision: persistUpdate.ok ? String(persistUpdate.result['revision']) : sRev,
        sessionId,
        persist: false,
        changes: [{ key: 'ui.displayMode', reset: true }],
      });
      expect(resetUpdate.ok).toBe(true);
    }

    // Closing the session leaves it closed: settings.get returns not_found and global updates do NOT resurrect it.
    expect(await v11.request('session.close', { sessionId })).toMatchObject({ ok: true });
    expect(await v11.request('settings.get', { sessionId, view: 'tui' })).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
    const globalNow = await v11.request('settings.get', { view: 'tui' });
    if (globalNow.ok) {
      expect(
        await v11.request('settings.update', {
          expectedRevision: String(globalNow.result['revision']),
          view: 'tui',
          changes: [{ key: 'agent.maxTurns', value: 78 }],
        }),
      ).toMatchObject({ ok: true });
    }
    expect(await v11.request('settings.get', { sessionId, view: 'tui' })).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });

    // 5. `providers.upsert` with `apiKey: ""` + `keepApiKey` + `keepBaseUrl` renames custom provider while retaining stored secret on disk!
    const renamed = await v11.request('providers.upsert', {
      action: 'save',
      originalId: 'mock-v11',
      name: 'mock-v11-renamed',
      type: 'openai-compatible',
      apiKey: '',
      keepApiKey: true,
      keepBaseUrl: true,
    });
    expect(renamed).toMatchObject({ ok: true, result: { ok: true } });
    expect(JSON.stringify(renamed)).not.toContain(SENTINEL_SECRET);
    const savedOnDisk = fs.readFileSync(path.join(settingsDir, 'settings.json'), 'utf8');
    expect(savedOnDisk).toContain('mock-v11-renamed');
    expect(savedOnDisk).toContain(SENTINEL_SECRET);

    // 6. Per-provider `models.list` loads single provider independently with favorites/nicknames.
    const modelsRes = await v11.request('models.list', { provider: 'mock-v11-renamed', refresh: true });
    expect(modelsRes.ok).toBe(true);
    if (modelsRes.ok) {
      expect(modelsRes.result['provider']).toBe('mock-v11-renamed');
      expect(modelsRes.result['models']).toContainEqual(expect.objectContaining({ id: 'daemon-test-model' }));
      expect(Array.isArray(modelsRes.result['favorites'])).toBe(true);
    }
  });

  it('binds control sockets only for their holder and only to terminal sessions, and lets a handoff pause win over a move', async () => {
    const { root, stateDir, runtimeDir, socketPath, workspace } = makeSandboxRoot();
    const conversationsDir = path.join(stateDir, 'conversations');
    const settingsDir = path.join(root, 'settings');
    // The daemon opens control sockets in its own XDG_RUNTIME_DIR, which must be private.
    const xdg = path.join(root, 'xdg');
    fs.mkdirSync(xdg, { mode: 0o700 });
    fs.chmodSync(xdg, 0o700);
    const previousRuntimeDir = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = xdg;
    cleanups.push(() => {
      if (previousRuntimeDir === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = previousRuntimeDir;
    });
    fs.mkdirSync(settingsDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(settingsDir, 'settings.json'),
      JSON.stringify({
        agent: { modelSelection: { provider: 'mock-control', model: 'm' } },
        // Nothing here starts a turn; the provider is never reached.
        providers: [{ name: 'mock-control', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k' }],
        sandbox: { enabled: false },
      }),
    );
    const daemon = await startTerm2Daemon({
      stateDir,
      conversationsDir,
      socketPath,
      env: { ...process.env, TERM2_DAEMON_DIR: runtimeDir, TERM2_SETTINGS_DIR: settingsDir },
    });
    expect(daemon.kind).toBe('started');
    if (daemon.kind !== 'started') return;
    cleanups.push(() => daemon.shutdown({ mode: 'immediate' }));

    const open = async () => {
      const client = new TestUnixRpcClient(await connectRaw(socketPath));
      cleanups.push(() => client.close());
      const hello = await client.request('protocol.hello', {
        protocolVersion: '1.1',
        minSupportedVersion: '1.1',
        clientKind: 'tui',
        clientVersion: '1.1.0',
      });
      expect(hello.ok).toBe(true);
      return client;
    };
    const holder = await open();
    const other = await open();
    const launch = async (clientMode?: 'headless' | 'acp') => {
      const launched = await holder.request('session.launch', {
        cwd: workspace,
        selection: { kind: 'new' },
        ...(clientMode ? { clientMode } : {}),
      });
      expect(launched.ok).toBe(true);
      return launched.ok ? String((launched.result['session'] as { id: string }).id) : '';
    };
    const first = await launch();
    const second = await launch();
    const headless = await launch('headless');
    const acp = await launch('acp');

    // Only a terminal session gets a control socket, as in process.
    for (const sessionId of [headless, acp]) {
      expect(
        await holder.request('session.control.bind', { sessionId, name: 'refused', discordInput: true }),
      ).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    }
    expect(fs.existsSync(path.join(controlDirectory(xdg), 'refused.sock'))).toBe(false);

    // Another connection cannot drive, release or pause the holder's lease, nor take its name.
    const bound = await holder.request('session.control.bind', { sessionId: first, name: 'held', discordInput: false });
    expect(bound.ok).toBe(true);
    const leaseId = bound.ok ? String(bound.result['leaseId']) : '';
    expect(await other.request('session.control.rebind', { leaseId, sessionId: second })).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
    expect(await other.request('session.control.unbind', { leaseId })).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
    expect(await other.request('session.control.unbind', { leaseId, pauseForHandoff: true })).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
    expect(
      await other.request('session.control.bind', { sessionId: first, name: 'held', discordInput: false }),
    ).toMatchObject({ ok: false, error: { code: 'busy' } });
    // Moving the lease to a headless session is refused and leaves it bound where it was.
    expect(await holder.request('session.control.rebind', { leaseId, sessionId: headless })).toMatchObject({
      ok: false,
      error: { code: 'forbidden' },
    });
    expect(await holder.request('session.control.rebind', { leaseId, sessionId: first })).toMatchObject({ ok: true });

    // A move in flight and a handoff pause on one lease: the pause wins, so the detached socket admits nothing.
    const [moved, paused] = await Promise.all([
      holder.request('session.control.rebind', { leaseId, sessionId: second }),
      holder.request('session.control.unbind', { leaseId, pauseForHandoff: true }),
    ]);
    expect(moved).toMatchObject({ ok: true });
    expect(paused).toMatchObject({ ok: true });
    expect(
      await controlSocketRequest(path.join(controlDirectory(xdg), 'held.sock'), 'submit', {
        text: 'must not be admitted while paused',
        clientRequestId: 'paused-1',
      }),
    ).toMatchObject({ ok: false, error: { code: 'unavailable' } });
  });
});
