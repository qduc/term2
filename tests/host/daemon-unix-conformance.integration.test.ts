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
import {
  HEADLESS_AUTO_APPROVE_REFUSAL,
  HEADLESS_REFUSAL,
  startTouchToolProvider,
} from '../helpers/touch-tool-provider.js';

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

const sessionIdOf = (frame: UnixResponseFrame) => (frame.ok ? (frame.result['session'] as { id: string }).id : '');
const streamIdOf = (frame: UnixResponseFrame) =>
  frame.ok ? CLIENT_API_SCHEMAS.unixSessionAttachResult.parse(frame.result).streamId : '';

type AcceptedEvent = { type?: string; payload?: Record<string, unknown> };
const accepted = (frame: UnixEventFrame, streamId: string): AcceptedEvent[] =>
  frame.streamId === streamId && frame.event === 'session.accepted' && Array.isArray(frame.payload['events'])
    ? (frame.payload['events'] as AcceptedEvent[])
    : [];

async function firstOfType(client: TestUnixRpcClient, streamId: string, type: string) {
  const frame = await client.waitForEvent((f) => accepted(f, streamId).some((e) => e.type === type), 15_000);
  return accepted(frame, streamId).find((e) => e.type === type)?.payload ?? {};
}

/**
 * Submits a turn whose model asks to `touch` `file` (`startTouchToolProvider`), and reports who resolved
 * the approval it opens. With `answerAs`, the test answers as the person at the terminal. A session with
 * no person (headless) has already resolved it by policy, and the policy's reason says whether the
 * session holds auto-approve.
 */
async function approvalOutcome(
  client: TestUnixRpcClient,
  sessionId: string,
  streamId: string,
  file: string,
  answerAs?: string,
): Promise<{ source: string | undefined; reason: string | undefined }> {
  const submitted = await client.request('session.command', {
    sessionId,
    command: { type: 'submit', requestId: `touch-${file}`, text: `Please create ${file}`, origin: { kind: 'cli' } },
  });
  expect(submitted.ok).toBe(true);
  const opened = await firstOfType(client, streamId, 'interaction_opened');
  const requestId = (opened['interaction'] as { requestId: string }).requestId;
  if (answerAs) {
    // Refused as stale when a policy resolved the request first; the resolution below says which won.
    await client.request('session.command', {
      sessionId,
      command: { type: 'answer', requestId, decision: { kind: 'deny', reason: answerAs } },
    });
  }
  const resolved = await firstOfType(client, streamId, 'interaction_resolved');
  return {
    source: (resolved['provenance'] as { source?: string } | undefined)?.source,
    reason: (resolved['resolution'] as { reason?: string } | undefined)?.reason,
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

  async function touchProvider(): Promise<string> {
    const provider = await startTouchToolProvider();
    cleanups.push(provider.close);
    return provider.baseUrl;
  }

  function writeTouchSettings(settingsDir: string, baseUrl: string, sandbox = false): void {
    fs.writeFileSync(
      path.join(settingsDir, 'settings.json'),
      JSON.stringify({
        agent: { modelSelection: { provider: 'touch', model: 'touch-model' }, retryAttempts: 0 },
        providers: [{ name: 'touch', type: 'openai-compatible', baseUrl, apiKey: 'k' }],
        sandbox: { enabled: sandbox },
      }),
    );
  }

  async function openV11Client(socketPath: string, clientKind: 'tui' | 'headless'): Promise<TestUnixRpcClient> {
    const client = new TestUnixRpcClient(await connectRaw(socketPath));
    cleanups.push(() => client.close());
    const hello = await client.request('protocol.hello', {
      protocolVersion: '1.1',
      minSupportedVersion: '1.1',
      clientKind,
      clientVersion: '1.1.0',
    });
    expect(hello.ok).toBe(true);
    return client;
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
    // ACP MCP installation is backed (Step 14e Part 2b) and applies only to a live ACP session.
    expect(await v11.request('session.acp.set_mcp', { sessionId: 'conv_1', servers: [] })).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
    expect(await v11.request('session.acp.set_mcp', { sessionId: 'conv_1', servers: [{ name: 'x' }] })).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
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

    // `session.launch` resume via 'last' and bare UUID, plus fork with approvalPolicy. The resumes ask for the
    // same approval mode: one without it reopens the idle session with the saved mode, as in-process.
    const resumedLast = await v11.request('session.launch', {
      cwd: wsA,
      selection: { kind: 'resume', sessionId: 'last' },
      approvalMode: 'auto',
    });
    expect(resumedLast.ok).toBe(true);
    if (resumedLast.ok) expect((resumedLast.result['session'] as { id: string }).id).toBe(sessionId);

    const bareId = sessionId.replace(/^conv_/, '');
    const resumedBare = await v11.request('session.launch', {
      cwd: wsA,
      selection: { kind: 'resume', sessionId: bareId },
      approvalMode: 'auto',
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

  it("keeps a headless launch's approval policy on its own session when another client attaches a dormant session mid-launch", async () => {
    const { root, stateDir, runtimeDir, socketPath } = makeSandboxRoot();
    const conversationsDir = path.join(stateDir, 'conversations');
    const settingsDir = path.join(root, 'settings');
    const gateDir = path.join(root, 'gate');
    const launchWs = path.join(root, 'ws-launch');
    const dormantWs = path.join(root, 'ws-dormant');
    for (const dir of [settingsDir, gateDir, launchWs, dormantWs]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const launchRoot = fs.realpathSync(launchWs);

    writeTouchSettings(settingsDir, await touchProvider());

    // Holds the launch mid-start: a headless surface waits for its workspace's MCP servers to settle,
    // and this one never answers `initialize`. It marks that it started, then exits once released.
    const gate = path.join(gateDir, 'gate.mjs');
    fs.writeFileSync(
      gate,
      [
        "import fs from 'node:fs';",
        "import path from 'node:path';",
        'const dir = process.argv[2];',
        "fs.writeFileSync(path.join(dir, `started-${process.pid}`), '');",
        "setInterval(() => { if (fs.existsSync(path.join(dir, 'release'))) process.exit(1); }, 10);",
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(launchRoot, '.mcp.json'),
      JSON.stringify({ mcpServers: { gate: { command: process.execPath, args: [gate, gateDir] } } }),
    );
    fs.writeFileSync(
      path.join(settingsDir, 'mcp.json'),
      JSON.stringify({ projectServers: { [launchRoot]: { gate: { enabled: true } } } }),
    );
    const gateStarted = () => fs.readdirSync(gateDir).some((name) => name.startsWith('started-'));
    cleanups.push(() => fs.writeFileSync(path.join(gateDir, 'release'), ''));

    const daemon = await startTerm2Daemon({
      stateDir,
      conversationsDir,
      socketPath,
      env: { ...process.env, TERM2_DAEMON_DIR: runtimeDir, TERM2_SETTINGS_DIR: settingsDir },
    });
    expect(daemon.kind).toBe('started');
    if (daemon.kind !== 'started') return;
    cleanups.push(() => daemon.shutdown({ mode: 'immediate' }));

    const tui = await openV11Client(socketPath, 'tui');
    const headless = await openV11Client(socketPath, 'headless');

    // A stored session nobody has open.
    const stored = await tui.request('session.launch', { cwd: dormantWs, selection: { kind: 'new' } });
    expect(stored.ok).toBe(true);
    const dormantId = sessionIdOf(stored);
    expect(await tui.request('session.close', { sessionId: dormantId })).toMatchObject({ ok: true });
    expect(gateStarted()).toBe(false);

    // A headless auto-approve launch is held inside its own session start...
    const launching = headless.request('session.launch', {
      cwd: launchWs,
      selection: { kind: 'new' },
      clientMode: 'headless',
      approvalPolicy: { mode: 'headless', autoApprove: true },
    });
    await expect.poll(gateStarted, { timeout: 10_000 }).toBe(true);
    // ...while another client opens the dormant session.
    const attached = await tui.request('session.attach', { sessionId: dormantId });
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;
    const dormantStream = CLIENT_API_SCHEMAS.unixSessionAttachResult.parse(attached.result).streamId;
    fs.writeFileSync(path.join(gateDir, 'release'), '');
    const launched = await launching;
    expect(launched.ok).toBe(true);
    const launchedId = sessionIdOf(launched);

    // The attached session keeps its interactive surface: the request waits for the person, who answers it.
    const dormantOutcome = await approvalOutcome(tui, dormantId, dormantStream, 'dormant.txt', 'person declined');
    expect(dormantOutcome.reason).toBe('person declined');
    expect(dormantOutcome.source).not.toBe('policy');
    expect(fs.existsSync(path.join(dormantWs, 'dormant.txt'))).toBe(false);

    // The launch's own session did get its policy: nobody is asked, and the refusal is the auto-approve
    // one (without auto-approve it would tell the run to use --auto-approve).
    const own = await headless.request('session.attach', { sessionId: launchedId });
    expect(own.ok).toBe(true);
    if (!own.ok) return;
    const ownStream = CLIENT_API_SCHEMAS.unixSessionAttachResult.parse(own.result).streamId;
    expect(await approvalOutcome(headless, launchedId, ownStream, 'launched.txt')).toEqual({
      source: 'policy',
      reason: HEADLESS_AUTO_APPROVE_REFUSAL,
    });
  });

  /** A daemon whose model is `startTouchToolProvider`; the saved settings turn the sandbox off unless `sandbox`. */
  async function startTouchDaemon(sandbox = false) {
    const { root, stateDir, runtimeDir, socketPath, workspace } = makeSandboxRoot();
    const settingsDir = path.join(root, 'settings');
    fs.mkdirSync(settingsDir, { recursive: true, mode: 0o700 });
    writeTouchSettings(settingsDir, await touchProvider(), sandbox);
    const daemon = await startTerm2Daemon({
      stateDir,
      conversationsDir: path.join(stateDir, 'conversations'),
      socketPath,
      env: { ...process.env, TERM2_DAEMON_DIR: runtimeDir, TERM2_SETTINGS_DIR: settingsDir },
    });
    if (daemon.kind !== 'started') throw new Error('daemon did not start');
    cleanups.push(() => daemon.shutdown({ mode: 'immediate' }));
    const launch = (client: TestUnixRpcClient, sessionId: string | null, posture: Record<string, unknown>) =>
      client.request('session.launch', {
        cwd: workspace,
        selection: sessionId === null ? { kind: 'new' } : { kind: 'resume', sessionId },
        ...posture,
      });
    const attach = async (client: TestUnixRpcClient, sessionId: string) =>
      streamIdOf(await client.request('session.attach', { sessionId }));
    return {
      socketPath,
      launch,
      attach,
      /** One client run: launch, attach, then detach as the client exits. The session stays live and idle. */
      async run(client: TestUnixRpcClient, sessionId: string | null, posture: Record<string, unknown>) {
        const launched = await launch(client, sessionId, posture);
        expect(launched.ok).toBe(true);
        const id = sessionIdOf(launched);
        const streamId = await attach(client, id);
        expect(await client.request('session.detach', { streamId })).toMatchObject({ ok: true });
        return id;
      },
      async liveSetting(client: TestUnixRpcClient, sessionId: string, key: string) {
        const read = await client.request('settings.get', { sessionId, view: 'tui' });
        if (!read.ok) throw new Error(`settings.get failed: ${JSON.stringify(read)}`);
        return (read.result['settings'] as { entries: Record<string, { value: unknown }> }).entries[key]?.value;
      },
    };
  }

  const interactive = { clientMode: 'interactive' };
  const headlessAsk = { clientMode: 'headless', approvalPolicy: { mode: 'headless', autoApprove: false } };
  const headlessAuto = { clientMode: 'headless', approvalPolicy: { mode: 'headless', autoApprove: true } };

  it('resumes a live session only with the approval posture the resume asked for, and refuses a wider one it cannot reopen', async () => {
    const { socketPath, launch, attach, run } = await startTouchDaemon();
    const tui = await openV11Client(socketPath, 'tui');
    const headless = await openV11Client(socketPath, 'headless');

    // Interactive, then a headless resume: the session's own policy answers, as in a fresh headless run.
    const first = await run(tui, null, interactive);
    expect(sessionIdOf(await launch(headless, first, headlessAsk))).toBe(first);
    const firstStream = await attach(headless, first);
    expect(await approvalOutcome(headless, first, firstStream, 'first.txt', 'person declined')).toEqual({
      source: 'policy',
      reason: HEADLESS_REFUSAL,
    });

    // Headless with auto-approve, then a terminal resume: the person is asked again.
    const second = await run(headless, null, headlessAuto);
    expect(sessionIdOf(await launch(tui, second, interactive))).toBe(second);
    const secondStream = await attach(tui, second);
    const asked = await approvalOutcome(tui, second, secondStream, 'second.txt', 'person declined');
    expect(asked.reason).toBe('person declined');
    expect(asked.source).not.toBe('policy');

    // While another client has an auto-approve session open, it cannot be reopened: a resume asking
    // for less is refused, one asking for the same is admitted, and the session keeps its posture.
    const third = sessionIdOf(await launch(headless, null, headlessAuto));
    const held = await attach(headless, third);
    expect(await launch(tui, third, interactive)).toMatchObject({ ok: false, error: { code: 'busy' } });
    expect(await launch(headless, third, headlessAsk)).toMatchObject({ ok: false, error: { code: 'busy' } });
    expect(await launch(headless, third, headlessAuto)).toMatchObject({ ok: true });
    expect(await approvalOutcome(headless, third, held, 'third.txt')).toEqual({
      source: 'policy',
      reason: HEADLESS_AUTO_APPROVE_REFUSAL,
    });
  });

  it('holds the first attach after a launch to what that launch asked for, whatever another launch did in between', async () => {
    const { socketPath, launch, attach, run } = await startTouchDaemon();
    const setup = await openV11Client(socketPath, 'headless');
    const a = await openV11Client(socketPath, 'headless');
    const b = await openV11Client(socketPath, 'headless');

    // A launches a plain headless resume and has not attached yet when B asks for auto-approve.
    // B may not reopen the session under A, so B runs with the narrower posture; A gets what it asked for.
    const plain = await run(setup, null, headlessAsk);
    expect(await launch(a, plain, headlessAsk)).toMatchObject({ ok: true });
    expect(await launch(b, plain, headlessAuto)).toMatchObject({ ok: true });
    const plainStream = await attach(a, plain);
    expect(await approvalOutcome(a, plain, plainStream, 'plain.txt', 'person declined')).toEqual({
      source: 'policy',
      reason: HEADLESS_REFUSAL,
    });

    // The other way round, B's narrower resume is refused while A's auto-approve launch is still to attach.
    const auto = await run(setup, null, headlessAuto);
    expect(await launch(a, auto, headlessAuto)).toMatchObject({ ok: true });
    expect(await launch(b, auto, headlessAsk)).toMatchObject({ ok: false, error: { code: 'busy' } });

    // If the session closes before A attaches and B then opens it with auto-approve, A's attach is refused.
    const closed = await run(setup, null, headlessAsk);
    expect(await launch(a, closed, headlessAsk)).toMatchObject({ ok: true });
    expect(await setup.request('session.close', { sessionId: closed })).toMatchObject({ ok: true });
    expect(await launch(b, closed, headlessAuto)).toMatchObject({ ok: true });
    expect(await a.request('session.attach', { sessionId: closed })).toMatchObject({
      ok: false,
      error: { code: 'busy' },
    });

    // An attach that fails (here a bad replay cursor) ends the launch's hold too, so B may reopen the session.
    const failed = await run(setup, null, headlessAuto);
    expect(await launch(a, failed, headlessAuto)).toMatchObject({ ok: true });
    expect(
      await a.request('session.attach', { sessionId: failed, fromSeq: 999_999, sessionEpoch: failed }),
    ).toMatchObject({ ok: false, error: { code: 'cursor_out_of_range' } });
    expect(await launch(b, failed, headlessAsk)).toMatchObject({ ok: true });
  });

  it('refuses a launch that would loosen the approval mode or sandbox of a session another client has open', async () => {
    const { socketPath, launch, attach, liveSetting } = await startTouchDaemon(true);
    const a = await openV11Client(socketPath, 'tui');
    const b = await openV11Client(socketPath, 'tui');
    const shared = sessionIdOf(await launch(a, null, interactive));
    const held = await attach(a, shared);
    const posture = async () => [
      await liveSetting(a, shared, 'shell.autoApproveMode'),
      await liveSetting(a, shared, 'sandbox.enabled'),
    ];

    expect(await launch(b, shared, { ...interactive, approvalMode: 'always' })).toMatchObject({
      ok: false,
      error: { code: 'busy' },
    });
    expect(await launch(b, shared, { ...interactive, sandboxEnabled: false })).toMatchObject({
      ok: false,
      error: { code: 'busy' },
    });
    expect(await posture()).toEqual(['off', true]);
    // The same settings, or tighter ones, may still be applied to a session someone else has open.
    expect(await launch(b, shared, { ...interactive, approvalMode: 'off', sandboxEnabled: true })).toMatchObject({
      ok: true,
    });

    // Once nobody else has it open, the launch's own settings apply.
    expect(await a.request('session.detach', { streamId: held })).toMatchObject({ ok: true });
    expect(await launch(b, shared, { ...interactive, approvalMode: 'always' })).toMatchObject({ ok: true });
    expect(await posture()).toEqual(['always', true]);
  });

  it('keeps a rebuilt session enforcing the approval mode and sandbox its settings show', async () => {
    /** A session-scoped temporary write (`/auto-approve`, `/sandbox`); returns the response. */
    const setSetting = async (client: TestUnixRpcClient, sessionId: string, key: string, value: unknown) => {
      const read = await client.request('settings.get', { sessionId, view: 'tui' });
      const expectedRevision = read.ok ? String(read.result['revision']) : '';
      const changes = [{ key, value }];
      return await client.request('settings.update', { sessionId, expectedRevision, persist: false, changes });
    };
    /** A configure that rebuilds the session's tools, keeping its model. */
    const rebuild = (client: TestUnixRpcClient, sessionId: string) =>
      client.request('session.command', {
        sessionId,
        command: { type: 'configure', commandId: `rebuild-${sessionId}`, configuration: { model: touchModel } },
      });
    /** Submits a turn that asks to `touch` `file`: 'asked' when a person is asked (and declines), else 'ran'. */
    const turn = async (client: TestUnixRpcClient, sessionId: string, streamId: string, file: string) => {
      const submitted = await client.request('session.command', {
        sessionId,
        command: { type: 'submit', requestId: `turn-${file}`, text: `Please create ${file}`, origin: { kind: 'cli' } },
      });
      expect(submitted.ok).toBe(true);
      const frame = await client.waitForEvent(
        (f) => accepted(f, streamId).some((e) => e.type === 'interaction_opened' || e.type === 'turn_ended'),
        15_000,
      );
      const opened = accepted(frame, streamId).find((e) => e.type === 'interaction_opened');
      if (!opened) return 'ran';
      const requestId = (opened.payload!['interaction'] as { requestId: string }).requestId;
      await client.request('session.command', {
        sessionId,
        command: { type: 'answer', requestId, decision: { kind: 'deny', reason: 'person declined' } },
      });
      return 'asked';
    };
    const touchModel = { provider: 'touch', model: 'touch-model' };

    // Launched with `always` (its configure rebuilt it), then set back to off in the session, then left.
    // A resume asking for off, or asking nothing, must find off in force: its write asks the person.
    const { socketPath, launch, attach } = await startTouchDaemon();
    const a = await openV11Client(socketPath, 'tui');
    const b = await openV11Client(socketPath, 'tui');
    for (const [label, posture] of [
      ['explicit', { ...interactive, approvalMode: 'off' }],
      ['plain', interactive],
    ] as const) {
      const always = sessionIdOf(await launch(a, null, { ...interactive, approvalMode: 'always' }));
      const left = await attach(a, always);
      expect(await setSetting(a, always, 'shell.autoApproveMode', 'off')).toMatchObject({ ok: true });
      expect(await a.request('session.detach', { streamId: left })).toMatchObject({ ok: true });
      expect(await launch(b, always, posture)).toMatchObject({ ok: true });
      expect(await turn(b, always, await attach(b, always), `${label}.txt`)).toBe('asked');
    }

    // Mid-turn, a rebuilt session cannot take such a write (it would need a rebuild): refused, nothing changes.
    const busy = sessionIdOf(await launch(a, null, interactive));
    const busyStream = await attach(a, busy);
    expect(await rebuild(a, busy)).toMatchObject({ ok: true });
    const submitted = await a.request('session.command', {
      sessionId: busy,
      command: { type: 'submit', requestId: 'busy-1', text: 'Please create busy.txt', origin: { kind: 'cli' } },
    });
    expect(submitted.ok).toBe(true);
    await firstOfType(a, busyStream, 'interaction_opened');
    expect(await setSetting(a, busy, 'shell.autoApproveMode', 'always')).toMatchObject({
      ok: false,
      error: { code: 'busy' },
    });
    const read = await a.request('settings.get', { sessionId: busy, view: 'tui' });
    expect(
      read.ok && (read.result['settings'] as { entries: Record<string, { value: unknown }> }).entries,
    ).toMatchObject({ 'shell.autoApproveMode': { value: 'off' } });

    // The sandbox: turned off at launch and taken into a rebuild, then turned back on in the session, then left.
    // A plain resume (the saved setting is on) must find it on: the workspace write runs sandboxed, unasked.
    const sandboxed = await startTouchDaemon(true);
    const c = await openV11Client(sandboxed.socketPath, 'tui');
    const d = await openV11Client(sandboxed.socketPath, 'tui');
    const off = sessionIdOf(await sandboxed.launch(c, null, { ...interactive, sandboxEnabled: false }));
    const offStream = await sandboxed.attach(c, off);
    expect(await rebuild(c, off)).toMatchObject({ ok: true });
    expect(await setSetting(c, off, 'sandbox.enabled', true)).toMatchObject({ ok: true });
    expect(await c.request('session.detach', { streamId: offStream })).toMatchObject({ ok: true });
    expect(await sandboxed.launch(d, off, interactive)).toMatchObject({ ok: true });
    expect(await turn(d, off, await sandboxed.attach(d, off), 'sandboxed.txt')).toBe('ran');
  });

  it("leaves a session's settings as they were when it refuses a launch's configure", async () => {
    const { socketPath, launch, attach, liveSetting } = await startTouchDaemon(true);
    const a = await openV11Client(socketPath, 'tui');
    const b = await openV11Client(socketPath, 'tui');
    const running = sessionIdOf(await launch(a, null, interactive));
    const stream = await attach(a, running);
    // A turn waits on the person (with the sandbox off, the write asks), then the person turns the sandbox on.
    const read = await a.request('settings.get', { sessionId: running, view: 'tui' });
    const expectedRevision = read.ok ? String(read.result['revision']) : '';
    const off = [{ key: 'sandbox.enabled', value: false }];
    expect(
      await a.request('settings.update', { sessionId: running, expectedRevision, persist: false, changes: off }),
    ).toMatchObject({ ok: true });
    const submitted = await a.request('session.command', {
      sessionId: running,
      command: { type: 'submit', requestId: 'refused-1', text: 'Please create refused.txt', origin: { kind: 'cli' } },
    });
    expect(submitted.ok).toBe(true);
    await firstOfType(a, stream, 'interaction_opened');
    const reread = await a.request('settings.get', { sessionId: running, view: 'tui' });
    const on = [{ key: 'sandbox.enabled', value: true }];
    expect(
      await a.request('settings.update', {
        sessionId: running,
        expectedRevision: reread.ok ? String(reread.result['revision']) : '',
        persist: false,
        changes: on,
      }),
    ).toMatchObject({ ok: true });
    expect(await a.request('session.detach', { streamId: stream })).toMatchObject({ ok: true });

    // B's launch needs a configure for its approval mode, which the session cannot take mid-turn.
    const refused = await launch(b, running, { ...interactive, sandboxEnabled: false, approvalMode: 'auto' });
    expect(refused).toMatchObject({ ok: false, error: { code: 'busy' } });
    expect(await liveSetting(b, running, 'sandbox.enabled')).toBe(true);
    expect(await liveSetting(b, running, 'shell.autoApproveMode')).toBe('off');
  });

  it('lands an explicit approval mode on the live value an in-session change moved, so the attach is admitted', async () => {
    const { socketPath, launch, attach, liveSetting } = await startTouchDaemon();
    const a = await openV11Client(socketPath, 'tui');
    const b = await openV11Client(socketPath, 'tui');
    const d = await openV11Client(socketPath, 'tui');
    /** `/auto-approve <mode>` in the session: a session-only live change, no configure. */
    const setMode = async (client: TestUnixRpcClient, sessionId: string, mode: string) => {
      const read = await client.request('settings.get', { sessionId, view: 'tui' });
      const expectedRevision = read.ok ? String(read.result['revision']) : '';
      const changes = [{ key: 'shell.autoApproveMode', value: mode }];
      expect(
        await client.request('settings.update', { sessionId, expectedRevision, persist: false, changes }),
      ).toMatchObject({ ok: true });
    };

    // Changed to auto in the session, then everyone leaves; a new terminal asks for off explicitly.
    const moved = sessionIdOf(await launch(a, null, interactive));
    const movedStream = await attach(a, moved);
    await setMode(a, moved, 'auto');
    expect(await a.request('session.detach', { streamId: movedStream })).toMatchObject({ ok: true });
    expect(await launch(d, moved, { ...interactive, approvalMode: 'off' })).toMatchObject({ ok: true });
    expect(await d.request('session.attach', { sessionId: moved })).toMatchObject({ ok: true });
    expect(await liveSetting(d, moved, 'shell.autoApproveMode')).toBe('off');

    // B, still attached, changed it to auto while A was away. A comes back asking for what it last saw (off):
    // a tighter mode applies to a shared session, and A's attach is admitted.
    const shared = sessionIdOf(await launch(a, null, interactive));
    const sharedStream = await attach(a, shared);
    await attach(b, shared);
    expect(await a.request('session.detach', { streamId: sharedStream })).toMatchObject({ ok: true });
    await setMode(b, shared, 'auto');
    expect(await launch(a, shared, { ...interactive, approvalMode: 'off', sandboxEnabled: false })).toMatchObject({
      ok: true,
    });
    expect(await a.request('session.attach', { sessionId: shared })).toMatchObject({ ok: true });
    expect(await liveSetting(b, shared, 'shell.autoApproveMode')).toBe('off');
  });

  it("compares the approval mode and sandbox a launch set for its session alone, which a fresh session wouldn't have", async () => {
    const { socketPath, launch, attach, run, liveSetting } = await startTouchDaemon();
    const tui = await openV11Client(socketPath, 'tui');
    const headless = await openV11Client(socketPath, 'headless');

    // `--approval-mode always`, then a resume without it: the resume runs with the saved mode, and asks.
    const always = await run(tui, null, { ...interactive, approvalMode: 'always' });
    expect(await liveSetting(tui, always, 'shell.autoApproveMode')).toBe('always');
    expect(await launch(tui, always, interactive)).toMatchObject({ ok: true });
    expect(await liveSetting(tui, always, 'shell.autoApproveMode')).toBe('off');
    const alwaysStream = await attach(tui, always);
    expect(await approvalOutcome(tui, always, alwaysStream, 'always.txt', 'person declined')).toMatchObject({
      reason: 'person declined',
    });

    // While a terminal holds an `always` session, a plain headless resume of it is refused.
    const held = sessionIdOf(await launch(tui, null, { ...interactive, approvalMode: 'always' }));
    await attach(tui, held);
    expect(await launch(headless, held, headlessAsk)).toMatchObject({ ok: false, error: { code: 'busy' } });

    // A launch that turned the sandbox off, then a resume without that flag: the saved setting (on) again.
    const sandboxed = await startTouchDaemon(true);
    const tui2 = await openV11Client(sandboxed.socketPath, 'tui');
    const off = await sandboxed.run(tui2, null, { ...interactive, sandboxEnabled: false });
    expect(await sandboxed.liveSetting(tui2, off, 'sandbox.enabled')).toBe(false);
    expect(await sandboxed.launch(tui2, off, interactive)).toMatchObject({ ok: true });
    expect(await sandboxed.liveSetting(tui2, off, 'sandbox.enabled')).toBe(true);
  });
});
