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
import {
  HEADLESS_AUTO_APPROVE_REFUSAL,
  HEADLESS_REFUSAL,
  startTouchToolProvider,
} from '../helpers/touch-tool-provider.js';

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

    // Do NOT set process.env.TERM2_SETTINGS_DIR: startTerm2Daemon receives it via options.env
    // only, proving createSessionSettings forwards SettingsService.settingsDir without env leakage.
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

    // Attachment cut pairs the reduced snapshot with its exact batch ordinal.
    const cutA = connA.cut?.();
    expect(cutA).toBeDefined();
    expect(cutA!.ordinal).toBeGreaterThan(0);
    expect(cutA!.snapshot.seq).toBeGreaterThan(0);
    expect(cutA!.snapshot.lastError).toBeNull();
    expect(cutA!.snapshot.messages.map((m) => ({ role: m.role, text: m.text }))).toContainEqual(
      expect.objectContaining({ role: 'assistant', text: expect.stringContaining('remote reply') }),
    );

    // Closing Client B's connection detaches cleanly without closing the session; sendCommand works.
    connB.close();
    const invalidRes = await clientA.host.sendCommand!(LOCAL_PRINCIPAL, connA.sessionId, {
      type: 'answer',
      requestId: 'nonexistent-req',
      decision: { kind: 'allow' },
    });
    expect(invalidRes.ok).toBe(false);

    // Quota and MCP status work over the Unix socket for the attached session; invalid scopes reject cleanly.
    const quotaRes = await clientA.host.getQuota(connA.sessionId);
    expect(quotaRes).toEqual({
      quota: {
        provider: 'mock-daemon',
        subscription: false,
        windows: { fiveHour: null, weekly: null },
      },
    });
    for (const badQuota of [{ sessionId: 42 }, { sessionId: '' }, { typo: 'x' }]) {
      await expect(clientA.host.rpc.request('quota.get', badQuota)).rejects.toMatchObject({ code: 'invalid_request' });
    }
    expect(await clientA.host.getMcpStatus({ sessionId: connA.sessionId })).toEqual({ servers: [] });
    await expect(clientA.host.loginMcp('nonexistent-mcp')).rejects.toMatchObject({ code: 'not_found' });
    await expect(clientA.host.loginMcp('nonexistent-mcp', '/etc/passwd')).rejects.toMatchObject({
      code: 'invalid_request',
    });

    // v1.0 set_goal session command enforces strict schema and expectedGeneration CAS even after concurrent clear.
    await expect(
      clientA.host.rpc.request('session.command', {
        sessionId: connA.sessionId,
        command: { type: 'set_goal', action: 'set', goal: { text: 'Missing generation' } },
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(
      clientA.host.rpc.request('session.command', {
        sessionId: connA.sessionId,
        command: { type: 'set_goal', action: 'set', expectedGeneration: 0, goal: { text: 'Ok' }, extra: 1 },
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    const setGoalOk = await clientA.host.rpc.request('session.command', {
      sessionId: connA.sessionId,
      command: { type: 'set_goal', action: 'set', expectedGeneration: 0, goal: { text: 'Ship PR 1' } },
    });
    expect(setGoalOk).toEqual({ result: { ok: true, kind: 'accepted' } });
    await expect(
      clientA.host.rpc.request('session.command', {
        sessionId: connA.sessionId,
        command: { type: 'set_goal', action: 'clear', expectedGeneration: 0 },
      }),
    ).rejects.toMatchObject({ code: 'stale_revision' });
    await clientA.host.rpc.request('session.command', {
      sessionId: connA.sessionId,
      command: { type: 'set_goal', action: 'clear', expectedGeneration: 1 },
    });
    // Concurrent clear advanced generation to 2; stale achieved MUST return stale_revision (not busy).
    await expect(
      clientA.host.rpc.request('session.command', {
        sessionId: connA.sessionId,
        command: { type: 'set_goal', action: 'achieved', expectedGeneration: 1 },
      }),
    ).rejects.toMatchObject({ code: 'stale_revision' });

    // Replay reconnect from seq 0 delivers accepted history events; invalid fromSeq maps to replay_unavailable.
    const replayConn = await clientB.host.connect(LOCAL_PRINCIPAL, connA.sessionId, 0);
    expect(replayConn.snapshot).toBeNull();
    expect(replayConn.replay.fromSeq).toBe(0);
    expect(replayConn.replay.toSeq).toBeNull();
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

    // Disposing Client B never shuts down the daemon; Client A stays healthy and can close the session cleanly,
    // and set_goal on a dormant/closed session re-attaches via host so a subsequent closeSession releases it.
    const closeObserver = await clientB.host.connect(LOCAL_PRINCIPAL, connA.sessionId);
    const drainClosed = (async () => {
      const seen: WireEvent[] = [];
      for await (const event of closeObserver.events) seen.push(event);
      return seen;
    })();
    await clientA.host.closeSession!(LOCAL_PRINCIPAL, connA.sessionId);
    await expect(drainClosed).resolves.toBeInstanceOf(Array);
    await clientA.host.rpc.request('session.command', {
      sessionId: connA.sessionId,
      command: { type: 'set_goal', action: 'set', expectedGeneration: 2, goal: { text: 'Dormant goal' } },
    });
    await clientA.host.closeSession!(LOCAL_PRINCIPAL, connA.sessionId);
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
    for (const method of ['skills.list', 'workspaces.files', 'mcp.status']) {
      for (const invalid of [{ sessionId: 42 }, { workspaceId: '' }, { typo: 'misspelled scope' }]) {
        await expect(host.rpc.request(method, invalid)).rejects.toMatchObject({ code: 'invalid_request' });
      }
    }
    const previewSkill = await host.rpc.request<{ result: { ok: boolean; kind: string } }>('session.command', {
      sessionId,
      command: { type: 'preview', text: 'apply skill', skill: 'daemon-project-scope' },
    });
    expect(previewSkill.result).toMatchObject({ ok: true, kind: 'preview' });
    await expect(
      host.rpc.request('session.command', {
        sessionId,
        command: { type: 'preview', text: 'apply skill', skill: 'no-such-skill' },
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
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

  it('runs a built-CLI headless resume with only the approval policy it asked for, though the daemon still has the session live', async () => {
    const { root, stateDir, runtimeDir, socketPath, workspace } = makeSandboxRoot();
    const homeDir = path.join(root, 'home');
    const cliPath = integrationCliPath();

    const provider = await startTouchToolProvider();
    cleanups.push(provider.close);
    const { toolResults } = provider;

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: homeDir,
      XDG_STATE_HOME: path.join(root, 'xdg-state'),
      TERM2_DAEMON_MODE: '1',
      TERM2_DAEMON_DIR: runtimeDir,
      TERM2_DAEMON_SOCKET: socketPath,
      TERM2_CONVERSATIONS_DIR: path.join(stateDir, 'conversations'),
      DISABLE_LOGGING: '1',
    };
    const settingsDir = resolveSettingsDirectory({ homeDir, env });
    fs.mkdirSync(settingsDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(settingsDir, 'settings.json'),
      JSON.stringify({
        agent: { modelSelection: { provider: 'touch', model: 'touch-model' }, retryAttempts: 0 },
        providers: [{ name: 'touch', type: 'openai-compatible', baseUrl: provider.baseUrl, apiKey: 'k' }],
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
    const run = (...args: string[]) =>
      execFileAsync(process.execPath, [cliPath, '--quiet', ...args], { cwd: workspace, env, timeout: 30_000 });

    // The policy's reason for refusing a request no person can approve says which policy the session holds.
    await run('--auto-approve', 'Please create first.txt');
    expect(toolResults[0]).toContain(HEADLESS_AUTO_APPROVE_REFUSAL);

    // The daemon keeps the session live after that run. Resuming it without --auto-approve must not inherit it.
    await run('--resume', 'last', 'Please create second.txt');
    expect(toolResults).toHaveLength(2);
    expect(toolResults[1]).toContain(HEADLESS_REFUSAL);
    expect(toolResults[1]).not.toContain(HEADLESS_AUTO_APPROVE_REFUSAL);

    // Asking for auto-approve again gets it again.
    await run('--auto-approve', '--resume', 'last', 'Please create third.txt');
    expect(toolResults[2]).toContain(HEADLESS_AUTO_APPROVE_REFUSAL);
  });
});
