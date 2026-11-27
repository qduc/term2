/**
 * Conformance & security integration suite for the Term2 singleton Unix daemon
 * (`docs/plans/daemon/spec/transport-unix.md` & `client-api.md` v1.0) plus
 * Step 14a multi-workspace sandbox lease & network-approval scope isolation.
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
import { resolveWorkspaceSandboxTempDir } from '../../src/shared/utils/shell/temp-dir.js';
import { createSandboxNetworkApprovalScope } from '../../src/tools/shell/sandbox/sandbox-network-approval.js';
import { AnthropicShellSandboxRunner } from '../../src/tools/shell/sandbox/shell-sandbox-runner.js';
import { integrationCliPath } from '../helpers/integration-cli.js';

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
    expect(ad.protocolVersion).toBe('1.0');

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

    // Graceful shutdown broadcasts daemon.draining and removes daemon.sock + daemon.json before unlocking.
    const drainingPromise = healthy.waitForEvent((e) => e.event === 'daemon.draining');
    await started.shutdown({ mode: 'graceful', timeoutMs: 2_000 });
    const draining = await drainingPromise;
    CLIENT_API_SCHEMAS.daemonDrainingEvent.parse(draining.payload);
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
    expect(c1.welcome.protocolVersion).toBe('1.0');

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

  it('isolates multi-workspace sandbox leases, scratch temp dirs, and network approval scopes', async () => {
    const { root } = makeSandboxRoot();
    const wsA = path.join(root, 'ws-a');
    const wsB = path.join(root, 'ws-b');
    fs.mkdirSync(wsA, { recursive: true });
    fs.mkdirSync(wsB, { recursive: true });

    // Per-workspace private scratch dirs must be distinct 0700 subdirectories.
    const tmpA = resolveWorkspaceSandboxTempDir(wsA);
    const tmpB = resolveWorkspaceSandboxTempDir(wsB);
    expect(tmpA).not.toBe(tmpB);
    expect(fs.lstatSync(tmpA).mode & 0o777).toBe(0o700);
    expect(fs.lstatSync(tmpB).mode & 0o777).toBe(0o700);

    // Per-lease network approval scopes never cross-route handlers or pause controllers.
    const scopeA = createSandboxNetworkApprovalScope();
    const scopeB = createSandboxNetworkApprovalScope();
    const callsA: string[] = [];
    const callsB: string[] = [];
    let pausedA = 0;
    let pausedB = 0;
    const stopHandlerA = scopeA.registerHandler(async ({ host }) => {
      callsA.push(host);
      return 'allow-once';
    });
    const stopHandlerB = scopeB.registerHandler(async ({ host }) => {
      callsB.push(host);
      return 'deny';
    });
    const stopPauseA = scopeA.registerPauseController({
      pause: () => {
        pausedA += 1;
      },
      resume: () => undefined,
    });
    const stopPauseB = scopeB.registerPauseController({
      pause: () => {
        pausedB += 1;
      },
      resume: () => undefined,
    });
    try {
      expect(await scopeA.requestApproval({ host: 'alpha.example.com', port: 443 }, wsA)).toBe(true);
      expect(await scopeB.requestApproval({ host: 'beta.example.com', port: 443 }, wsB)).toBe(false);
      expect(callsA).toEqual(['alpha.example.com']);
      expect(callsB).toEqual(['beta.example.com']);
      expect(pausedA).toBe(1);
      expect(pausedB).toBe(1);
    } finally {
      stopHandlerA();
      stopHandlerB();
      stopPauseA();
      stopPauseB();
    }

    // Scoped lease tokens prevent Session B from acquiring/bypassing while Session A holds the lease.
    const runner = new AnthropicShellSandboxRunner();
    const leaseA = await runner.acquire();
    expect(leaseA.token).toBeDefined();
    expect(leaseA.networkScope).toBeDefined();
    let leaseBAcquired = false;
    const pendingB = runner.acquire().then((leaseB) => {
      leaseBAcquired = true;
      return leaseB;
    });
    // sleep-ok: observing that contending acquire() stays blocked while leaseA is held; 30ms spans multiple microtask and timer turns
    await new Promise((r) => setTimeout(r, 30));
    expect(leaseBAcquired).toBe(false);
    leaseA();
    const leaseB = await pendingB;
    expect(leaseBAcquired).toBe(true);
    expect(leaseB.token).not.toBe(leaseA.token);
    expect(leaseB.networkScope).not.toBe(leaseA.networkScope);
    leaseB();
  });
});
