/**
 * Integration suite for Step 14b: `RemoteDirectHost` and `DirectConnection` over
 * the singleton Unix daemon (`UnixRpcClient` + `connectRemoteDirectHost`).
 *
 * Crosses real boundaries: Unix domain socket, SQLite singleton lock, persisted
 * sessions/settings, and a loopback mock OpenAI provider.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { WireEvent } from '../../src/protocol/wire.js';
import { DirectProtocolError } from '../../src/protocol/errors.js';
import { startTerm2Daemon, type Term2DaemonHandle } from '../../src/app/daemon/daemon.js';
import { connectRemoteDirectHost } from '../../src/app/daemon/connect-daemon-host.js';
import { LOCAL_PRINCIPAL, localGrant } from '../../src/app/application-workspaces.js';
import { resolveSettingsDirectory } from '../../src/config/settings/settings-path.js';
import { integrationCliPath } from '../helpers/integration-cli.js';

const execFileAsync = promisify(execFile);

async function startMockOpenAiProvider(replyText: string): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  let reqCount = 0;
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url?.includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'remote-host-model' }] }));
      return;
    }
    req.resume();
    req.on('end', () => {
      reqCount += 1;
      const text = `${replyText} #${reqCount}`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        [
          `data: ${JSON.stringify({
            id: `chatcmpl-r-${reqCount}`,
            choices: [{ delta: { role: 'assistant', content: text } }],
          })}`,
          '',
          `data: {"id":"chatcmpl-r-${reqCount}","choices":[{"delta":{},"finish_reason":"stop"}]}`,
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

async function collectUntil(
  iterable: AsyncIterable<WireEvent>,
  stopWhen: (event: WireEvent) => boolean,
  timeoutMs = 10_000,
): Promise<WireEvent[]> {
  const collected: WireEvent[] = [];
  const iterator = iterable[Symbol.asyncIterator]();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const remaining = Math.max(1, deadline - Date.now());
    const next = await Promise.race([
      iterator.next(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Timed out waiting for WireEvent')), remaining),
      ),
    ]);
    if (next.done) break;
    collected.push(next.value);
    if (stopWhen(next.value)) break;
  }
  return collected;
}

describe('RemoteDirectHost over Unix Daemon (Step 14b)', () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop()!;
      try {
        await fn();
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
    settingsDir: string;
  } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 't2-rhost-'));
    const stateDir = path.join(root, 'state');
    const runtimeDir = path.join(root, 'run');
    const workspace = path.join(root, 'ws');
    const settingsDir = path.join(root, 'settings');
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(settingsDir, { recursive: true, mode: 0o700 });
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    return { root, stateDir, runtimeDir, socketPath: path.join(runtimeDir, 'daemon.sock'), workspace, settingsDir };
  }

  it('implements DirectHost + DirectConnection across two clients, replay reconnect, session-list & settings streams, and clean dispose', async () => {
    const { stateDir, runtimeDir, socketPath, workspace, settingsDir } = makeSandboxRoot();
    const conversationsDir = path.join(stateDir, 'conversations');

    const mock = await startMockOpenAiProvider('remote reply');
    cleanups.push(() => mock.close());

    fs.writeFileSync(
      path.join(settingsDir, 'settings.json'),
      JSON.stringify({
        agent: {
          modelSelection: { provider: 'mock-daemon', model: 'remote-host-model' },
        },
        providers: [
          {
            name: 'mock-daemon',
            type: 'openai-compatible',
            baseUrl: mock.baseUrl,
            apiKey: 'test-key',
          },
        ],
        sandbox: { enabled: false },
      }),
    );

    const prevSettingsDir = process.env['TERM2_SETTINGS_DIR'];
    process.env['TERM2_SETTINGS_DIR'] = settingsDir;
    cleanups.push(() => {
      if (prevSettingsDir === undefined) delete process.env['TERM2_SETTINGS_DIR'];
      else process.env['TERM2_SETTINGS_DIR'] = prevSettingsDir;
    });

    const daemonEnv: NodeJS.ProcessEnv = {
      ...process.env,
      TERM2_DAEMON_DIR: runtimeDir,
      TERM2_DAEMON_SOCKET: socketPath,
      TERM2_CONVERSATIONS_DIR: conversationsDir,
      TERM2_SETTINGS_DIR: settingsDir,
    };

    const daemonHandle: Term2DaemonHandle = await startTerm2Daemon({
      stateDir,
      conversationsDir,
      socketPath,
      env: daemonEnv,
    });
    expect(daemonHandle.kind).toBe('started');
    if (daemonHandle.kind !== 'started') return;
    cleanups.push(() => daemonHandle.shutdown({ mode: 'immediate' }));

    const clientA = await connectRemoteDirectHost({
      clientKind: 'test-remote-a',
      socketPath,
      stateDir,
      conversationsDir,
      allowAutoStart: false,
      env: daemonEnv,
    });
    cleanups.push(() => clientA.host.dispose());

    const clientB = await connectRemoteDirectHost({
      clientKind: 'test-remote-b',
      socketPath,
      stateDir,
      conversationsDir,
      allowAutoStart: false,
      env: daemonEnv,
    });
    cleanups.push(() => clientB.host.dispose());

    const status = await clientA.host.status();
    expect(status.attachedClientCount).toBeGreaterThanOrEqual(2);

    // Subscribe to session-list on Client B before Client A creates a session.
    const listEvents: string[] = [];
    const listSub = await clientB.host.subscribeSessionList((frame) => {
      listEvents.push(frame.event);
    });
    await expect.poll(() => listEvents.includes('session.list.snapshot')).toBe(true);

    // Client A creates a session and attaches; Client B sees it in listSessions() and attaches too.
    const connA = await clientA.host.createSession(LOCAL_PRINCIPAL, localGrant(workspace));
    expect(connA.sessionId).toBeTruthy();
    expect(connA.snapshot.sessionId).toBe(connA.sessionId);

    const listed = await clientB.host.listSessions(LOCAL_PRINCIPAL);
    expect(listed.sessions.some((s) => s.id === connA.sessionId)).toBe(true);

    const connB = await clientB.host.connect(LOCAL_PRINCIPAL, connA.sessionId);
    expect(connB.snapshot.sessionId).toBe(connA.sessionId);

    // Submit a turn from Client A; BOTH Client A and Client B observe turn_ended via DirectConnection.events.
    const waitA = collectUntil(connA.events, (e) => e.type === 'turn_ended');
    const waitB = collectUntil(connB.events, (e) => e.type === 'turn_ended');
    const submitRes = await connA.send({
      type: 'submit',
      requestId: 'req-remote-1',
      text: 'hello remote host',
      origin: { kind: 'cli' },
    });
    expect(submitRes.ok).toBe(true);

    const [eventsA, eventsB] = await Promise.all([waitA, waitB]);
    expect(eventsA.some((e) => e.type === 'turn_ended')).toBe(true);
    expect(eventsB.some((e) => e.type === 'turn_ended')).toBe(true);

    // Closing Client B's connection detaches cleanly without closing the session; sendCommand works.
    connB.close();
    const invalidRes = await clientA.host.sendCommand!(LOCAL_PRINCIPAL, connA.sessionId, {
      type: 'answer',
      requestId: 'nonexistent-req',
      decision: { kind: 'allow' },
    });
    expect(invalidRes.ok).toBe(false);

    // Replay reconnect from seq 0 delivers accepted history events; invalid fromSeq maps to replay_unavailable.
    const replayConn = await clientB.host.connect(LOCAL_PRINCIPAL, connA.sessionId, 0);
    expect(replayConn.snapshot).toBeNull();
    expect(replayConn.replay.fromSeq).toBe(0);
    const replayed = await collectUntil(replayConn.events, (e) => e.type === 'turn_ended');
    expect(replayed.some((e) => e.type === 'turn_ended')).toBe(true);
    replayConn.close();

    await expect(clientB.host.connect(LOCAL_PRINCIPAL, connA.sessionId, 999_999)).rejects.toSatisfy(
      (err: unknown) => err instanceof DirectProtocolError && err.code === 'replay_unavailable',
    );

    // Settings read/subscribe/update over RemoteDirectHost.
    const settingsEvents: string[] = [];
    const settingsSub = await clientB.host.subscribeSettings((frame) => {
      settingsEvents.push(frame.event);
    });
    await expect.poll(() => settingsEvents.includes('settings.snapshot')).toBe(true);
    const currentSettings = await clientA.host.readSettings();
    await clientA.host.updateSettings(String(currentSettings['revision']), [
      { key: 'agent.reasoningEffort', value: 'low' },
    ]);
    await expect.poll(() => settingsEvents.includes('settings.changed')).toBe(true);
    await settingsSub.unsubscribe();
    await listSub.unsubscribe();

    // Disposing Client B never shuts down the daemon; Client A stays healthy.
    connA.close();
    await clientB.host.dispose();
    const statusAfterDispose = await clientA.host.status();
    expect(statusAfterDispose.daemonId).toBe(daemonHandle.daemonId);
  });

  it('round-trips local workspace aliases after restart and resolves skills and files in the session workspace', async () => {
    const { stateDir, runtimeDir, socketPath, workspace, settingsDir } = makeSandboxRoot();
    const skillDirectory = path.join(workspace, '.term2', 'skills', 'daemon-project-scope');
    fs.mkdirSync(skillDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(skillDirectory, 'SKILL.md'),
      '---\nname: daemon-project-scope\ndescription: Test daemon workspace discovery.\n---\nPrivate skill instructions.\n',
    );
    fs.writeFileSync(path.join(workspace, 'daemon-project-file.txt'), 'workspace file');

    const env = { ...process.env, TERM2_DAEMON_DIR: runtimeDir, TERM2_SETTINGS_DIR: settingsDir };
    const conversationsDir = path.join(stateDir, 'conversations');
    const options = { stateDir, conversationsDir, socketPath, env };
    const start = async () => {
      const daemon = await startTerm2Daemon(options);
      if (daemon.kind !== 'started') throw new Error('Expected an isolated test daemon.');
      cleanups.push(() => daemon.shutdown({ mode: 'immediate' }));
      const { host } = await connectRemoteDirectHost({ ...options, clientKind: 'test', allowAutoStart: false });
      cleanups.push(() => host.dispose());
      return { daemon, host };
    };

    const first = await start();
    const connection = await first.host.createSession(LOCAL_PRINCIPAL, localGrant(workspace));
    const { sessionId } = connection;
    connection.close();
    const { sessions } = await first.host.rpc.request<{ sessions: { id: string; workspaceId: string }[] }>(
      'session.list',
    );
    const workspaceId = sessions.find(({ id }) => id === sessionId)?.workspaceId;
    expect(workspaceId).toMatch(/^local_[a-f0-9]+$/);
    await first.host.dispose();
    await first.daemon.shutdown({ mode: 'immediate' });

    const { host } = await start();
    const reopened = await host.createSession(LOCAL_PRINCIPAL, { workspaceId: workspaceId!, access: 'read_write' });
    expect(reopened.sessionId).not.toBe(sessionId);
    reopened.close();
    const expectedSkill = {
      name: 'daemon-project-scope',
      description: 'Test daemon workspace discovery.',
      isProjectLevel: true,
    };
    expect(await host.listSkills({ sessionId })).toContainEqual(expectedSkill);
    expect(await host.listSkills({ workspaceId })).toContainEqual(expectedSkill);
    const bySession = await host.listSessionFiles(sessionId);
    expect(bySession.entries).toContainEqual(expect.objectContaining({ path: 'daemon-project-file.txt' }));
    expect(await host.rpc.request('workspaces.files', { workspaceId, refresh: true })).toEqual(bySession);
    await expect(host.listSkills({ workspaceId: 'absent' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(host.listSkills({ sessionId: 'conv_00000000-0000-4000-8000-000000000001' })).rejects.toMatchObject({
      code: 'not_found',
    });
    for (const method of ['skills.list', 'workspaces.files']) {
      for (const invalid of [{ sessionId: 42 }, { workspaceId: '' }, { typo: 'misspelled scope' }]) {
        await expect(host.rpc.request(method, invalid)).rejects.toMatchObject({ code: 'invalid_request' });
      }
    }
  });

  it('runs a real built-CLI headless turn through TERM2_DAEMON_MODE=1 with auto-started daemon and clean stop', async () => {
    const { root, stateDir, runtimeDir, socketPath, workspace } = makeSandboxRoot();
    const conversationsDir = path.join(stateDir, 'conversations');
    const homeDir = path.join(root, 'home');
    const xdgStateHome = path.join(root, 'xdg-state');
    const cliPath = integrationCliPath();

    const mock = await startMockOpenAiProvider('headless daemon answer');
    cleanups.push(() => mock.close());

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: homeDir,
      XDG_STATE_HOME: xdgStateHome,
      TERM2_DAEMON_MODE: '1',
      TERM2_DAEMON_DIR: runtimeDir,
      TERM2_DAEMON_SOCKET: socketPath,
      TERM2_CONVERSATIONS_DIR: conversationsDir,
    };
    const settingsDir = resolveSettingsDirectory({ homeDir, env });
    fs.mkdirSync(settingsDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(settingsDir, 'settings.json'),
      JSON.stringify({
        agent: {
          modelSelection: { provider: 'mock-daemon', model: 'remote-host-model' },
        },
        providers: [
          {
            name: 'mock-daemon',
            type: 'openai-compatible',
            baseUrl: mock.baseUrl,
            apiKey: 'test-key',
          },
        ],
        sandbox: { enabled: false },
      }),
    );
    env['TERM2_SETTINGS_DIR'] = settingsDir;
    cleanups.push(async () => {
      await execFileAsync(
        process.execPath,
        [cliPath, 'daemon', 'stop', '--socket', socketPath, '--state-dir', stateDir],
        {
          env,
        },
      ).catch(() => undefined);
    });

    const { stdout } = await execFileAsync(process.execPath, [cliPath, '--quiet', 'hello from headless daemon'], {
      cwd: workspace,
      env,
      timeout: 20_000,
    });
    expect(stdout).toContain('headless daemon answer #1');
    expect(fs.existsSync(socketPath)).toBe(true);

    // Daemon remains alive after headless exits; status reports running and stop cleans up.
    const statusOut = await execFileAsync(
      process.execPath,
      [cliPath, 'daemon', 'status', '--socket', socketPath, '--state-dir', stateDir],
      { env },
    );
    const parsedStatus = JSON.parse(statusOut.stdout) as { daemonId: string };
    expect(parsedStatus.daemonId).toMatch(/^dmn_/);

    await execFileAsync(
      process.execPath,
      [cliPath, 'daemon', 'stop', '--socket', socketPath, '--state-dir', stateDir],
      { env },
    );
    await expect.poll(() => fs.existsSync(socketPath), { timeout: 5_000 }).toBe(false);
  });
});
