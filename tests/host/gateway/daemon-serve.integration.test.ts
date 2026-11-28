/**
 * `term2 serve` over the singleton daemon (Step 14e Part 1, `docs/plans/daemon/README.md`).
 *
 * Built CLI only: the serve process is a client holding a `daemon.serve.start` lease and
 * the daemon hosts the HTTP listener over its own sessions. The checks fail on an
 * in-process fallback: HTTP `daemon/status` must name the daemon the Unix socket reports,
 * and the web session's log must land in the daemon's conversation store.
 */
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { LOCAL_PRINCIPAL } from '../../../src/app/application-workspaces.js';
import { connectRemoteDirectHost } from '../../../src/app/daemon/connect-daemon-host.js';
import { connectOrStartDaemon } from '../../../src/app/daemon/daemon-bootstrap.js';
import { UnixRpcClient } from '../../../src/host/daemon/unix-rpc-client.js';
import { resolveSettingsDirectory } from '../../../src/config/settings/settings-path.js';
import { createGatewayAssertion } from '../../../src/host/server-assertion.js';
import type { AssertionPurpose } from '../../../src/host/server-contracts.js';
import type { WireEvent } from '../../../src/protocol/wire.js';
import { readFacts } from '../../../src/session/log.js';
import { integrationCliPath } from '../../helpers/integration-cli.js';
import { createTestChildEnv } from '../../helpers/terminal-e2e.js';

const execFileAsync = promisify(execFile);
const KID = 'daemon-serve-kid';
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function sign(purpose: AssertionPurpose, ids: { workspaceId?: string; sessionId?: string } = {}): string {
  return createGatewayAssertion({
    privateKey,
    kid: KID,
    issuer: 'chatforge-bff',
    audience: 'term2-gateway',
    subject: 'user-1',
    purpose,
    ...ids,
  });
}

function request(
  socketPath: string,
  method: string,
  requestPath: string,
  body: unknown,
  assertion: string,
): Promise<{ status: number; json: Record<string, any> }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        socketPath,
        method,
        path: requestPath,
        headers: {
          accept: 'application/json',
          'x-term2-assertion': assertion,
          ...(payload !== undefined
            ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) }
            : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk: Buffer | string) => (raw += String(chunk)));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : {} }));
      },
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/** Collects direct-wire events for one session until `waitFor` finds a match. */
function openEvents(socketPath: string, sessionId: string) {
  const frames: WireEvent[] = [];
  const req = http.request({
    socketPath,
    method: 'GET',
    path: `/private/agent/v1/sessions/${sessionId}/events?format=direct&after=0`,
    headers: { 'x-term2-assertion': sign('events_connect', { sessionId }), accept: 'text/event-stream' },
  });
  req.on('response', (res) => {
    let buffer = '';
    res.on('data', (chunk: Buffer | string) => {
      buffer += String(chunk);
      for (let index = buffer.indexOf('\n\n'); index >= 0; index = buffer.indexOf('\n\n')) {
        const data = buffer
          .slice(0, index)
          .split('\n')
          .find((line) => line.startsWith('data:'));
        buffer = buffer.slice(index + 2);
        if (data) frames.push(JSON.parse(data.slice(5).trim()) as WireEvent);
      }
    });
  });
  req.on('error', () => undefined);
  req.end();
  return {
    waitFor: async (predicate: (event: WireEvent) => boolean, timeout = 45_000) => {
      await expect.poll(() => frames.some(predicate), { timeout }).toBe(true);
      return frames.find(predicate)!;
    },
    close: () => {
      req.destroy();
    },
  };
}

async function startProvider(): Promise<{
  baseUrl: string;
  requests: () => number;
  /** Tool names offered on each chat request, in order. */
  tools: () => string[][];
  close: () => Promise<void>;
}> {
  let count = 0;
  const tools: string[][] = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'daemon-serve-model' }] }));
      return;
    }
    let body = '';
    req.on('data', (chunk: Buffer | string) => (body += String(chunk)));
    req.on('end', () => {
      count += 1;
      const parsed = JSON.parse(body) as { tools?: Array<{ function?: { name?: string } }> };
      tools.push((parsed.tools ?? []).map((tool) => tool.function?.name ?? ''));
      const id = `chatcmpl-${count}`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        `data: ${JSON.stringify({ id, choices: [{ delta: { role: 'assistant', content: `answer ${count}` } }] })}\n\n`,
      );
      res.write(`data: ${JSON.stringify({ id, choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests: () => count,
    tools: () => tools.map((names) => [...names]),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

type Serve = {
  readonly child: ChildProcessWithoutNullStreams;
  readonly stderr: () => string;
  readonly exited: Promise<number | null>;
};

async function startServe(cliPath: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<Serve> {
  const child = spawn(process.execPath, [cliPath, 'serve', ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  cleanups.push(() => {
    child.kill('SIGKILL');
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer | string) => (stderr += String(chunk)));
  const exited = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
  let closed = false;
  void exited.then(() => (closed = true));
  await expect
    .poll(
      () => {
        if (closed) throw new Error(`serve exited before readiness:\n${stderr}`);
        return stderr.includes('GATEWAY_READY');
      },
      { timeout: 60_000, interval: 50 },
    )
    .toBe(true);
  return { child, stderr: () => stderr, exited };
}

describe('term2 serve over the daemon (built CLI)', () => {
  it('hosts the listener in the daemon, runs a web turn there, and releases the lease on stop and on client death', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-serve-')));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const home = path.join(root, 'home');
    const runtimeDir = path.join(root, 'run');
    const daemonSocket = path.join(runtimeDir, 'daemon.sock');
    const daemonState = path.join(root, 'daemon-state');
    const conversationsDir = path.join(daemonState, 'conversations');
    const serveState = path.join(root, 'serve-state');
    const httpSocket = path.join(serveState, 'gateway.sock');
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
    const provider = await startProvider();
    cleanups.push(provider.close);

    const env = createTestChildEnv({
      HOME: home,
      XDG_STATE_HOME: path.join(root, 'xdg-state'),
      DISABLE_LOGGING: '1',
      TERM2_DAEMON_MODE: '1',
      TERM2_DAEMON_DIR: runtimeDir,
      TERM2_DAEMON_SOCKET: daemonSocket,
      TERM2_CONVERSATIONS_DIR: conversationsDir,
    });
    const settingsDir = resolveSettingsDirectory({ homeDir: home, env });
    fs.mkdirSync(settingsDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(settingsDir, 'settings.json'),
      JSON.stringify({
        agent: { modelSelection: { provider: 'mockprov', model: 'daemon-serve-model' }, retryAttempts: 0 },
        providers: [{ name: 'mockprov', type: 'openai-compatible', baseUrl: provider.baseUrl, apiKey: 'test-key' }],
      }),
    );
    env['TERM2_SETTINGS_DIR'] = settingsDir;
    const pemPath = path.join(root, 'bff.pem');
    fs.writeFileSync(pemPath, publicKey);
    const cliPath = integrationCliPath();
    const daemonCli = (command: string) =>
      execFileAsync(
        process.execPath,
        [cliPath, 'daemon', command, '--socket', daemonSocket, '--state-dir', daemonState],
        { env },
      );
    cleanups.push(async () => {
      await daemonCli('stop').catch(() => undefined);
    });

    // A local (unbound) session in the home directory, created through the daemon.
    const headless = await execFileAsync(process.execPath, [cliPath, '--quiet', 'hello from the terminal'], {
      cwd: home,
      env,
      timeout: 30_000,
    });
    expect(headless.stdout).toContain('answer 1');
    const localIds = fs
      .readdirSync(conversationsDir)
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => name.replace(/\.jsonl$/, ''));
    expect(localIds).toHaveLength(1);
    const localId = localIds[0]!;

    const serve = await startServe(
      cliPath,
      ['--state-dir', serveState, '--local-owner', 'user-1', '--bff-key', `${KID}=${pemPath}`, '--allow-write'],
      env,
    );
    expect(serve.stderr()).toMatch(/GATEWAY_READY pid=\d+ transport=socket path=\S+ pairing=off host=daemon/);

    // The listener belongs to the daemon the Unix socket reports, not to the serve process.
    const unixStatus = JSON.parse((await daemonCli('status')).stdout) as { daemonId: string; pid: number };
    const httpStatus = await request(
      httpSocket,
      'GET',
      '/private/agent/v1/daemon/status',
      undefined,
      sign('daemon_status'),
    );
    expect(httpStatus.status).toBe(200);
    expect(httpStatus.json).toMatchObject({ daemonId: unixStatus.daemonId, pid: unixStatus.pid });
    expect(unixStatus.pid).not.toBe(serve.child.pid);

    // D007: the web list shows the terminal's session under the covering host grant, but it stays
    // closed to web callers, as in-process serve never held local sessions.
    const listed = await request(httpSocket, 'GET', '/private/agent/v1/sessions', undefined, sign('session_list'));
    expect(listed.status).toBe(200);
    expect((listed.json.sessions as Array<{ id: string }>).map((session) => session.id)).toContain(localId);
    const localRead = await request(
      httpSocket,
      'POST',
      `/private/agent/v1/sessions/${localId}`,
      {},
      sign('session_read', { sessionId: localId }),
    );
    // Same answer as another owner's session: existence is not disclosed.
    expect(localRead).toMatchObject({ status: 404, json: { error: { code: 'not_found' } } });

    // A web session runs a turn inside the daemon, and its log lands in the daemon's store with its owner.
    const created = await request(
      httpSocket,
      'POST',
      '/private/agent/v1/sessions',
      { workspaceId: 'host' },
      sign('session_create', { workspaceId: 'host' }),
    );
    expect(created.status).toBe(201);
    const webId = created.json.session.id as string;
    expect(readFacts(path.join(conversationsDir, `${webId}.jsonl`))[0]).toMatchObject({
      type: 'session_started',
      workspace: home,
      binding: { client: 'user-1', id: 'host' },
    });
    const events = openEvents(httpSocket, webId);
    cleanups.push(events.close);
    await events.waitFor((event) => event.type === 'configuration');
    const submitted = await request(
      httpSocket,
      'POST',
      `/private/agent/v1/sessions/${webId}/messages`,
      { text: 'hello from the web', clientRequestId: 'daemon-serve-1' },
      sign('message_submit', { sessionId: webId }),
    );
    expect(submitted.json.accepted).toBe(true);
    const ended = await events.waitFor(
      (event) => event.type === 'turn_ended' && event.turnId === submitted.json.turnId,
    );
    expect(ended).toMatchObject({ payload: { outcome: 'completed', finalText: 'answer 2' } });
    expect(provider.requests()).toBe(2);
    events.close();

    // A second lease is refused while the first is held.
    const refused = spawn(
      process.execPath,
      [cliPath, 'serve', '--state-dir', path.join(root, 'other-state'), '--local-owner', 'user-1', '--pairing'],
      { env },
    );
    let refusedStderr = '';
    refused.stderr.on('data', (chunk: Buffer | string) => (refusedStderr += String(chunk)));
    const refusedCode = await new Promise<number | null>((resolve) => refused.on('close', resolve));
    expect(refusedCode).toBe(1);
    expect(refusedStderr).toContain('already active');

    // The --allow-write host grant gave the web session write tools.
    expect(provider.tools()[1]).toContain('create_file');

    // A terminal attached to the web session keeps it live in the daemon across the lease.
    const peer = await connectRemoteDirectHost({
      clientKind: 'control',
      conversationsDir,
      protocolVersion: '1.1',
      minSupportedVersion: '1.1',
      allowAutoStart: false,
      env,
    });
    cleanups.push(() => peer.host.dispose());
    const keepAlive = await peer.host.connect(LOCAL_PRINCIPAL, webId);
    let keepAliveEnded = false;
    void (async () => {
      for await (const _event of keepAlive.events) {
        // Drained only to see the stream end.
      }
      keepAliveEnded = true;
    })();

    // SIGTERM stops the lease cleanly; the daemon lives on.
    serve.child.kill('SIGTERM');
    expect(await serve.exited).toBe(0);
    expect(fs.existsSync(httpSocket)).toBe(false);
    expect(fs.existsSync(path.join(serveState, 'serve.lock.pid'))).toBe(false);
    expect(JSON.parse((await daemonCli('status')).stdout)).toMatchObject({ daemonId: unixStatus.daemonId });
    // Releasing the lease closed the web session under the terminal too: a later lease must reopen it
    // through its own grants rather than inherit the tools this grant gave it.
    await expect.poll(() => keepAliveEnded, { timeout: 10_000 }).toBe(true);

    // This store's web sessions belong to the first state directory; another one is refused.
    const otherState = spawn(
      process.execPath,
      [cliPath, 'serve', '--state-dir', path.join(root, 'other-state'), '--local-owner', 'user-1', '--pairing'],
      { env },
    );
    let otherStderr = '';
    otherState.stderr.on('data', (chunk: Buffer | string) => (otherStderr += String(chunk)));
    expect(await new Promise<number | null>((resolve) => otherState.on('close', resolve))).toBe(1);
    expect(otherStderr).toContain(`belong to --state-dir ${serveState}`);

    // A later lease without --allow-write reopens the web session read-only: releasing the first
    // lease closed it, so it does not keep the write tools its old grant gave it. Pairing OTPs
    // reach only the lease holder.
    const readOnly = await startServe(
      cliPath,
      ['--state-dir', serveState, '--local-owner', 'user-1', '--bff-key', `${KID}=${pemPath}`, '--pairing'],
      env,
    );
    expect(readOnly.stderr()).toMatch(/PAIRING OTP: \d{6}/);
    const reopened = openEvents(httpSocket, webId);
    cleanups.push(reopened.close);
    await reopened.waitFor((event) => event.type === 'configuration');
    const again = await request(
      httpSocket,
      'POST',
      `/private/agent/v1/sessions/${webId}/messages`,
      { text: 'write something', clientRequestId: 'daemon-serve-2' },
      sign('message_submit', { sessionId: webId }),
    );
    expect(again.json.accepted).toBe(true);
    await reopened.waitFor((event) => event.type === 'turn_ended' && event.turnId === again.json.turnId);
    expect(provider.tools()[2]).not.toContain('create_file');
    reopened.close();

    // A killed client releases the lease by EOF.
    readOnly.child.kill('SIGKILL');
    await readOnly.exited;
    await expect.poll(() => fs.existsSync(httpSocket), { timeout: 10_000 }).toBe(false);
    await expect.poll(() => fs.existsSync(path.join(serveState, 'serve.lock.pid')), { timeout: 10_000 }).toBe(false);

    // A client that disconnects at any point during serve.start leaves no listener behind:
    // the next lease on the same socket must start.
    const leaseParams = {
      stateDir: serveState,
      localOwnerUserId: 'user-1',
      allowWrite: false,
      pairing: true,
      bffKeys: [],
      transport: { kind: 'socket', socketPath: httpSocket },
    };
    const leaseClient = async () => {
      const connected = await connectOrStartDaemon({ clientKind: 'serve', allowAutoStart: false, env });
      return new UnixRpcClient(connected.socket);
    };
    for (const delayMs of [0, 1, 2, 5, 10, 20]) {
      const dropped = await leaseClient();
      const abandoned = dropped.request('daemon.serve.start', leaseParams).catch(() => undefined);
      // sleep-ok: places the disconnect at a point inside serve.start, which exposes no signal mid-start;
      // 0–20 ms spans the state-dir, seeding and socket-bind steps, 38 ms in total.
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      dropped.close();
      await abandoned;
      const next = await leaseClient();
      let leaseId: string | undefined;
      await expect
        .poll(
          async () => {
            try {
              leaseId = (await next.request<{ leaseId: string }>('daemon.serve.start', leaseParams)).leaseId;
              return 'started';
            } catch (error) {
              // The abandoned lease may still be tearing down; anything else is a leak.
              return (error as { code?: string }).code === 'busy' ? 'busy' : String((error as Error).message);
            }
          },
          { timeout: 10_000, interval: 50 },
        )
        .toBe('started');
      await next.request('daemon.serve.stop', { leaseId: leaseId! });
      next.close();
      expect(fs.existsSync(httpSocket), `delay ${delayMs}`).toBe(false);
    }
  }, 180_000);
});
