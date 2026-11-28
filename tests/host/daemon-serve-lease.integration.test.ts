/**
 * Step 14e Part 1 integration suite: `term2 serve` HTTP/SSE leases over the singleton
 * Term2 daemon (`daemon.serve.start`/`stop`, `serve.pairing_otp`, D007 unified store,
 * shared `SessionIndex` live sidebar push, shared `GlobalMutationCoordinator`, and
 * connection-EOF automatic lease release without cancelling active daemon sessions).
 */
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CLIENT_API_CAPABILITIES,
  CLIENT_API_SCHEMAS,
  type UnixEventFrame,
  type UnixFrame,
  type UnixResponseFrame,
} from '../../src/protocol/client-api/client-api-schema.js';
import { createGatewayAssertion } from '../../src/host/server-assertion.js';
import { startTerm2Daemon } from '../../src/app/daemon/daemon.js';

class UnixTestClient {
  #nextId = 0;
  #buffer = '';
  readonly #pending = new Map<string, { resolve: (frame: UnixResponseFrame) => void; reject: (err: Error) => void }>();
  readonly events: UnixEventFrame[] = [];
  readonly #waiters: Array<(frame: UnixEventFrame) => boolean> = [];
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
          for (let i = this.#waiters.length - 1; i >= 0; i -= 1) {
            if (this.#waiters[i]!(frame)) this.#waiters.splice(i, 1);
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
    return new Promise((resolve, reject) => {
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
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for Unix event frame')), timeoutMs);
      this.#waiters.push((frame) => {
        if (!predicate(frame)) return false;
        clearTimeout(timer);
        resolve(frame);
        return true;
      });
    });
  }

  close(): void {
    this.socket.destroy();
  }
}

async function connectUnixV11(socketPath: string): Promise<UnixTestClient> {
  const socket = await new Promise<net.Socket>((resolve, reject) => {
    const s = net.createConnection({ path: socketPath });
    s.once('error', reject);
    s.once('connect', () => {
      s.off('error', reject);
      resolve(s);
    });
  });
  const client = new UnixTestClient(socket);
  const hello = await client.request('protocol.hello', {
    protocolVersion: '1.1',
    minSupportedVersion: '1.1',
    clientKind: 'serve-test',
    clientVersion: '1.1.0',
    capabilities: [...CLIENT_API_CAPABILITIES],
  });
  expect(hello.ok).toBe(true);
  return client;
}

function httpUnixRequest(
  socketPath: string,
  method: string,
  requestPath: string,
  body?: unknown,
  assertion?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { accept: 'application/json' };
    let serialized: string | undefined;
    if (body !== undefined) {
      serialized = JSON.stringify(body);
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(serialized));
    }
    if (assertion) headers['x-term2-assertion'] = assertion;
    const req = http.request({ socketPath, method, path: requestPath, headers }, (res) => {
      let raw = '';
      res.on('data', (chunk: Buffer | string) => {
        raw += String(chunk);
      });
      res.on('end', () => {
        const parsed = raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    req.on('error', reject);
    if (serialized !== undefined) req.write(serialized);
    req.end();
  });
}

function openSessionListSse(
  socketPath: string,
  assertion: string,
): {
  waitFor: (predicate: (frame: { event: string; data: Record<string, unknown> }) => boolean) => Promise<{
    event: string;
    data: Record<string, unknown>;
  }>;
  close: () => void;
} {
  const frames: Array<{ event: string; data: Record<string, unknown> }> = [];
  const listeners = new Set<() => void>();
  let failure: Error | null = null;
  const notify = () => listeners.forEach((fn) => fn());
  const req = http.request(
    {
      socketPath,
      method: 'GET',
      path: '/private/agent/v1/sessions/events',
      headers: { accept: 'text/event-stream', 'x-term2-assertion': assertion },
    },
    (res) => {
      if (res.statusCode !== 200) {
        failure = new Error(`Expected 200 from session list SSE, got ${res.statusCode}`);
        notify();
        res.destroy();
        return;
      }
      let buffer = '';
      res.on('data', (chunk: Buffer | string) => {
        buffer += String(chunk);
        let idx = buffer.indexOf('\n\n');
        while (idx >= 0) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          let eventName = 'message';
          let dataLine = '';
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) eventName = line.slice('event:'.length).trim();
            else if (line.startsWith('data:')) dataLine += line.slice('data:'.length).trim();
          }
          if (dataLine) {
            frames.push({ event: eventName, data: JSON.parse(dataLine) as Record<string, unknown> });
            notify();
          }
          idx = buffer.indexOf('\n\n');
        }
      });
      res.on('error', (error) => {
        failure = error;
        notify();
      });
    },
  );
  req.on('error', (error) => {
    failure = error;
    notify();
  });
  req.end();
  return {
    waitFor: (predicate) =>
      new Promise((resolve, reject) => {
        const check = () => {
          const found = frames.find(predicate);
          if (!found && !failure) return;
          clearTimeout(timer);
          listeners.delete(check);
          if (found) resolve(found);
          else reject(failure);
        };
        const timer = setTimeout(() => {
          listeners.delete(check);
          reject(new Error(`Timed out waiting for SSE event; saw ${JSON.stringify(frames.map((f) => f.event))}`));
        }, 10_000);
        listeners.add(check);
        check();
      }),
    close: () => req.destroy(),
  };
}

describe('Daemon serve lease (Step 14e Part 1)', () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      try {
        await cleanups.pop()!();
      } catch {
        // Best-effort teardown.
      }
    }
  });

  it('shares one daemon/store/SessionIndex/mutations across Unix and HTTP+SSE, scopes OTP to caller, and releases lease on EOF', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't2-srvlease-')));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const daemonStateDir = path.join(root, 'daemon-state');
    const serveStateDir = path.join(root, 'serve-state');
    const runtimeDir = path.join(root, 'run');
    const settingsDir = path.join(root, 'settings');
    const conversationsDir = path.join(daemonStateDir, 'conversations');
    const daemonSocket = path.join(runtimeDir, 'daemon.sock');
    const gatewaySocket = path.join(serveStateDir, 'gateway.sock');
    const wsGranted = path.join(root, 'ws-granted');
    const wsUngranted = path.join(root, 'ws-ungranted');
    fs.mkdirSync(wsGranted, { recursive: true });
    fs.mkdirSync(wsUngranted, { recursive: true });
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(
      path.join(settingsDir, 'settings.json'),
      JSON.stringify({
        agent: { modelSelection: { provider: 'mock-serve', model: 'mock-model' } },
        providers: [{ name: 'mock-serve', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k' }],
      }),
    );

    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const publicKeyPath = path.join(root, 'bff.pub.pem');
    fs.writeFileSync(publicKeyPath, publicKey);
    const sign = (
      purpose: Parameters<typeof createGatewayAssertion>[0]['purpose'],
      ids: { workspaceId?: string; sessionId?: string } = {},
    ) =>
      createGatewayAssertion({
        privateKey,
        kid: 'lease-test-kid',
        issuer: 'chatforge-bff',
        audience: 'term2-gateway',
        subject: 'local-owner',
        purpose,
        ...ids,
      });

    const env = {
      ...process.env,
      HOME: root,
      TERM2_DAEMON_DIR: runtimeDir,
      TERM2_CONVERSATIONS_DIR: conversationsDir,
      TERM2_SETTINGS_DIR: settingsDir,
    };
    const started = await startTerm2Daemon({
      stateDir: daemonStateDir,
      conversationsDir,
      socketPath: daemonSocket,
      env,
    });
    expect(started.kind).toBe('started');
    if (started.kind !== 'started') return;
    cleanups.push(() => started.shutdown({ mode: 'immediate' }));

    const owner = await connectUnixV11(daemonSocket);
    cleanups.push(() => owner.close());
    const sibling = await connectUnixV11(daemonSocket);
    cleanups.push(() => sibling.close());

    // Start HTTP+SSE serve lease with pairing enabled.
    const leaseRes = await owner.request('daemon.serve.start', {
      stateDir: serveStateDir,
      localOwnerUserId: 'local-owner',
      allowWrite: true,
      pairing: true,
      bffKeys: [{ kid: 'lease-test-kid', pemPath: publicKeyPath }],
      transport: { kind: 'socket', socketPath: gatewaySocket },
    });
    expect(leaseRes.ok).toBe(true);
    if (!leaseRes.ok) return;
    const leaseId = String(leaseRes.result['leaseId']);

    // Pairing OTP event is delivered ONLY to the starting Unix connection, never to sibling.
    const otpEvent = await owner.waitForEvent((frame) => frame.event === 'serve.pairing_otp');
    expect(otpEvent.payload['leaseId']).toBe(leaseId);
    expect(String(otpEvent.payload['code'])).toMatch(/^\d{6}$/);
    expect(sibling.events.some((frame) => frame.event === 'serve.pairing_otp')).toBe(false);

    // Duplicate stateDir lease is refused with `busy`; sibling cannot stop owner's lease.
    const dup = await sibling.request('daemon.serve.start', {
      stateDir: serveStateDir,
      localOwnerUserId: 'local-owner',
      allowWrite: false,
      pairing: false,
      bffKeys: [{ kid: 'lease-test-kid', pemPath: publicKeyPath }],
      transport: { kind: 'socket', socketPath: path.join(serveStateDir, 'dup.sock') },
    });
    expect(dup).toMatchObject({ ok: false, error: { code: 'busy' } });
    expect(await sibling.request('daemon.serve.stop', { leaseId })).toMatchObject({
      ok: false,
      error: { code: 'forbidden' },
    });

    // HTTP+SSE hello stays v1.0 without `local_leases`; daemon/status shares the exact daemonId.
    const httpHello = await httpUnixRequest(
      gatewaySocket,
      'GET',
      '/private/agent/v1/hello',
      undefined,
      sign('protocol_hello'),
    );
    expect(httpHello.status).toBe(200);
    expect(httpHello.body['protocolVersion']).toBe('1.0');
    expect(httpHello.body['capabilities']).not.toContain('local_leases');

    const httpStatus = await httpUnixRequest(
      gatewaySocket,
      'GET',
      '/private/agent/v1/daemon/status',
      undefined,
      sign('daemon_status'),
    );
    expect(httpStatus.status).toBe(200);
    expect(httpStatus.body['daemonId']).toBe(started.daemonId);

    // Admit wsGranted via HTTP workspace API; leave wsUngranted unadmitted.
    const validated = await httpUnixRequest(
      gatewaySocket,
      'POST',
      '/private/agent/v1/workspace/candidates/validate',
      { absolutePath: wsGranted },
      sign('workspace_candidate_validate'),
    );
    expect(validated.status).toBe(200);
    const selected = await httpUnixRequest(
      gatewaySocket,
      'POST',
      '/private/agent/v1/workspace/candidates/select',
      { candidateId: validated.body['candidateId'], access: 'read_write' },
      sign('workspace_candidate_select'),
    );
    expect(selected.status).toBe(200);
    const grantedWorkspaceId = String(selected.body['workspaceId']);

    // Subscribe to HTTP session-list SSE stream before local Unix client launches sessions.
    const sse = openSessionListSse(gatewaySocket, sign('session_list_events'));
    cleanups.push(() => sse.close());
    await sse.waitFor((frame) => frame.event === 'session.list.snapshot');

    // Local Unix client launches a session in wsGranted and another in wsUngranted.
    const localGranted = await sibling.request('session.launch', {
      cwd: wsGranted,
      selection: { kind: 'new' },
    });
    expect(localGranted.ok).toBe(true);
    if (!localGranted.ok) return;
    const localGrantedId = (localGranted.result['session'] as { id: string }).id;

    // Web sidebar SSE receives the local Unix session live!
    const livePush = await sse.waitFor(
      (frame) =>
        frame.event === 'session.list.upsert' &&
        (frame.data['session'] as { id?: string } | undefined)?.id === localGrantedId,
    );
    expect((livePush.data['session'] as { workspaceId?: string }).workspaceId).toBe(grantedWorkspaceId);

    const localUngranted = await sibling.request('session.launch', {
      cwd: wsUngranted,
      selection: { kind: 'new' },
    });
    expect(localUngranted.ok).toBe(true);
    if (!localUngranted.ok) return;
    const localUngrantedId = (localUngranted.result['session'] as { id: string }).id;

    // Web GET /sessions sees ONLY the granted local session, and can read it while ungranted is 403.
    const webList = await httpUnixRequest(
      gatewaySocket,
      'GET',
      '/private/agent/v1/sessions',
      undefined,
      sign('session_list'),
    );
    expect(webList.status).toBe(200);
    const listedIds = (webList.body['sessions'] as Array<{ id: string }>).map((s) => s.id);
    expect(listedIds).toContain(localGrantedId);
    expect(listedIds).not.toContain(localUngrantedId);

    const webReadGranted = await httpUnixRequest(
      gatewaySocket,
      'POST',
      `/private/agent/v1/sessions/${localGrantedId}`,
      {},
      sign('session_read', { sessionId: localGrantedId }),
    );
    expect(webReadGranted.status).toBe(200);

    const webReadUngranted = await httpUnixRequest(
      gatewaySocket,
      'POST',
      `/private/agent/v1/sessions/${localUngrantedId}`,
      {},
      sign('session_read', { sessionId: localUngrantedId }),
    );
    expect(webReadUngranted.status).toBe(404);
    sse.close();

    // Shared GlobalMutationCoordinator: HTTP settings write pushes live `settings.changed` to Unix subscriber.
    const unixSettingsBefore = await sibling.request('settings.get', { view: 'tui' });
    expect(unixSettingsBefore.ok).toBe(true);
    const settingsSub = await sibling.request('settings.subscribe', { view: 'tui' });
    expect(settingsSub.ok).toBe(true);
    const httpSettingsBefore = await httpUnixRequest(
      gatewaySocket,
      'GET',
      '/private/agent/v1/settings',
      undefined,
      sign('settings_read'),
    );
    expect(httpSettingsBefore.status).toBe(200);
    const httpSettingsPut = await httpUnixRequest(
      gatewaySocket,
      'PUT',
      '/private/agent/v1/settings',
      {
        expectedRevision: httpSettingsBefore.body['revision'],
        changes: [{ key: 'agent.temperature', value: 0.2 }],
      },
      sign('settings_write'),
    );
    expect(httpSettingsPut.status, JSON.stringify(httpSettingsPut.body)).toBe(200);
    const changedEvent = await sibling.waitForEvent((frame) => frame.event === 'settings.changed');
    expect(changedEvent.payload['revision']).toBeTruthy();
    const unixSettingsAfter = await sibling.request('settings.get', { view: 'tui' });
    expect(unixSettingsAfter.ok).toBe(true);
    if (unixSettingsBefore.ok && unixSettingsAfter.ok) {
      expect(unixSettingsAfter.result['revision']).not.toBe(unixSettingsBefore.result['revision']);
    }

    // Destroying the leasing Unix connection releases the serve lease without cancelling active daemon sessions.
    owner.close();
    await expect.poll(() => fs.existsSync(gatewaySocket), { timeout: 5_000 }).toBe(false);
    await expect.poll(() => fs.existsSync(path.join(serveStateDir, 'serve.lock.pid')), { timeout: 5_000 }).toBe(false);

    // Local sessions in the daemon remain intact after serve lease EOF teardown.
    const listAfterEof = await sibling.request('session.list', {});
    expect(listAfterEof.ok).toBe(true);
    if (listAfterEof.ok) {
      const ids = (listAfterEof.result['sessions'] as Array<{ id: string }>).map((s) => s.id);
      expect(ids).toContain(localGrantedId);
      expect(ids).toContain(localUngrantedId);
    }

    // Sibling can now acquire and explicitly stop a fresh serve lease on the same stateDir.
    const secondLease = await sibling.request('daemon.serve.start', {
      stateDir: serveStateDir,
      localOwnerUserId: 'local-owner',
      allowWrite: false,
      pairing: false,
      bffKeys: [{ kid: 'lease-test-kid', pemPath: publicKeyPath }],
      transport: { kind: 'socket', socketPath: gatewaySocket },
    });
    expect(secondLease.ok).toBe(true);
    if (secondLease.ok) {
      expect(await sibling.request('daemon.serve.stop', { leaseId: String(secondLease.result['leaseId']) })).toEqual({
        kind: 'response',
        id: expect.any(String),
        ok: true,
        result: { stopped: true },
      });
      expect(fs.existsSync(gatewaySocket)).toBe(false);
    }
  }, 60_000);
});
