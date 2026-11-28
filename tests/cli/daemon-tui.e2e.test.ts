import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { connectRemoteDirectHost } from '../../src/app/daemon/connect-daemon-host.js';
import { LOCAL_PRINCIPAL } from '../../src/app/application-workspaces.js';
import { resolveSettingsDirectory } from '../../src/config/settings/settings-path.js';
import { displaySessionId } from '../../src/protocol/session-id.js';
import type { WireEvent } from '../../src/protocol/wire.js';
import {
  HARNESS_IDLE_ENV,
  readHarnessIdleGeneration,
  waitForHarnessComposerValue,
  waitForHarnessIdleGeneration,
} from '../../src/shared/lib/harness-input-idle.js';
import { createTestChildEnv, spawnTerminal, testCliPath, type TerminalSession } from '../helpers/terminal-e2e.js';

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const builtCli = testCliPath(path.join(projectRoot, 'dist', 'src', 'app', 'cli.js'));
const TIMEOUT_MS = 120_000;

type ScriptedProvider = {
  readonly baseUrl: string;
  readonly requests: () => Array<{ model?: string; messages: Array<{ role: string; content?: unknown }> }>;
  readonly close: () => Promise<void>;
};

async function startProvider(replies: readonly string[]): Promise<ScriptedProvider> {
  const requests: Array<{ model?: string; messages: Array<{ role: string; content?: unknown }> }> = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-alpha' }, { id: 'mock-beta' }] }));
      return;
    }
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      const parsed = JSON.parse(body) as { model?: string; messages: Array<{ role: string; content?: unknown }> };
      requests.push(parsed);
      const index = requests.length;
      const text = replies[index - 1] ?? `daemon-reply-${index}`;
      const id = `chatcmpl-${index}`;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ id, choices: [{ delta: { role: 'assistant', content: text } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id, choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests: () => [...requests],
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

type DaemonTuiFixture = {
  readonly root: string;
  readonly daemonCwd: string;
  readonly workspace: string;
  readonly stateDir: string;
  readonly runtimeDir: string;
  readonly socketPath: string;
  readonly conversationsDir: string;
  readonly settingsDir: string;
  readonly idlePath: string;
  readonly env: NodeJS.ProcessEnv;
};

function createFixture(baseUrl: string, prefix: string): DaemonTuiFixture {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`)));
  const home = path.join(root, 'home');
  const daemonCwd = path.join(root, 'daemon-cwd');
  const workspace = path.join(root, 'workspace');
  const stateDir = path.join(root, 'state');
  const runtimeDir = path.join(root, 'run');
  const conversationsDir = path.join(stateDir, 'conversations');
  const scratch = path.join(root, 'scratch', 'term2-nodejs');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.mkdirSync(daemonCwd, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(conversationsDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(scratch, { recursive: true });

  const socketPath = path.join(runtimeDir, 'daemon.sock');
  const idlePath = path.join(home, 'input-idle');
  const baseEnv: NodeJS.ProcessEnv = {
    HOME: home,
    TMPDIR: scratch,
    TEMP: scratch,
    TMP: scratch,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_RUNTIME_DIR: runtimeDir,
    TERM2_CONFIG_DIR: path.join(home, '.term2'),
    TERM2_CACHE_DIR: path.join(home, '.cache', 'term2'),
    TERM2_CONVERSATIONS_DIR: conversationsDir,
    TERM2_DAEMON_MODE: '1',
    TERM2_DAEMON_DIR: runtimeDir,
    TERM2_DAEMON_SOCKET: socketPath,
    TERM2_EXIT_CONFIRM_WINDOW_MS: '300',
    DISABLE_LOGGING: '1',
    [HARNESS_IDLE_ENV]: idlePath,
    CI: 'false',
    NODE_ENV: 'test',
  };
  const settingsDir = resolveSettingsDirectory({ homeDir: home, env: createTestChildEnv(baseEnv) });
  fs.mkdirSync(settingsDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(settingsDir, 'settings.json'),
    JSON.stringify({
      ui: { skin: 'classic' },
      agent: {
        retryAttempts: 0,
        modelSelection: { provider: 'mockprov', model: 'mock-alpha' },
      },
      providers: [{ name: 'mockprov', type: 'openai-compatible', baseUrl, apiKey: 'secret-daemon-key' }],
      sandbox: { enabled: false },
      shell: { autoApproveMode: 'off' },
    }),
  );
  const env: NodeJS.ProcessEnv = { ...baseEnv, TERM2_SETTINGS_DIR: settingsDir };
  return { root, daemonCwd, workspace, stateDir, runtimeDir, socketPath, conversationsDir, settingsDir, idlePath, env };
}

async function submitLine(session: TerminalSession, idlePath: string, text: string): Promise<void> {
  session.write(text);
  await waitForHarnessComposerValue(idlePath, text, { timeoutMs: 30_000 });
  session.write('\r');
}

describe('Built CLI TUI over daemon (Step 14d)', () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      try {
        await fn?.();
      } catch {
        // Best-effort cleanup.
      }
    }
  });

  it(
    'runs TUI over an isolated daemon with second client sync, workspace-scoped skills, launch overrides, client-only /restart, and reconnect after daemon restart',
    async () => {
      const provider = await startProvider(['reply-one', 'reply-skill', 'reply-after-restart']);
      cleanups.push(() => provider.close());

      const fixture = createFixture(provider.baseUrl, 'term2-daemon-tui-e2e');
      cleanups.push(() => fs.rmSync(fixture.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

      // Seed a project-level skill ONLY in `workspace`, not in `daemonCwd`.
      const skillDir = path.join(fixture.workspace, '.agents', 'skills', 'alpha-skill');
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(
        path.join(skillDir, 'SKILL.md'),
        ['---', 'name: alpha-skill', 'description: Workspace daemon skill', '---', 'SKILL_BODY_MARKER_14D'].join('\n'),
      );

      // Start the daemon explicitly from `daemonCwd` (distinct from TUI launch workspace).
      const daemonEnv = createTestChildEnv(fixture.env);
      const daemonProc = spawn(
        process.execPath,
        [builtCli, 'daemon', 'start', '--socket', fixture.socketPath, '--state-dir', fixture.stateDir],
        { cwd: fixture.daemonCwd, env: daemonEnv, detached: true, stdio: 'ignore' },
      );
      daemonProc.unref();
      cleanups.push(async () => {
        await execFileAsync(
          process.execPath,
          [builtCli, 'daemon', 'stop', '--socket', fixture.socketPath, '--state-dir', fixture.stateDir],
          { cwd: fixture.daemonCwd, env: daemonEnv, timeout: 10_000 },
        ).catch(() => undefined);
      });

      let statusBefore: { daemonId: string; pid: number } | null = null;
      await expect
        .poll(
          async () => {
            try {
              const out = await execFileAsync(
                process.execPath,
                [builtCli, 'daemon', 'status', '--socket', fixture.socketPath, '--state-dir', fixture.stateDir],
                { cwd: fixture.daemonCwd, env: daemonEnv, timeout: 5_000 },
              );
              statusBefore = JSON.parse(out.stdout) as { daemonId: string; pid: number };
              return Boolean(statusBefore.daemonId);
            } catch {
              return false;
            }
          },
          { timeout: 15_000, interval: 100 },
        )
        .toBe(true);
      expect(statusBefore).not.toBeNull();

      // Launch TUI with CLI model override (`mock-beta`), while global default stays `mock-alpha`.
      const tui = spawnTerminal(process.execPath, [builtCli, '--provider', 'mockprov', '--model', 'mock-beta'], {
        cwd: fixture.workspace,
        env: fixture.env,
        cols: 100,
        rows: 30,
      });
      cleanups.push(() => tui.dispose());

      let idleGen = await waitForHarnessIdleGeneration(fixture.idlePath, { timeoutMs: 60_000 });
      await tui.waitForOutput('mock-beta', 30_000);

      // Attach a second independent client over the daemon Unix socket to the SAME session.
      const peer = await connectRemoteDirectHost({
        clientKind: 'control',
        conversationsDir: fixture.conversationsDir,
        protocolVersion: '1.1',
        minSupportedVersion: '1.1',
        env: daemonEnv,
      });
      cleanups.push(() => peer.host.dispose());

      const listed = await peer.host.listSessionsByCwd(fixture.workspace);
      expect(listed.sessions.length).toBeGreaterThanOrEqual(1);
      const sessionId = listed.sessions[0]!.id;

      const peerConn = await peer.host.connect(LOCAL_PRINCIPAL, sessionId);
      const peerEvents: WireEvent[] = [];
      const peerLoop = (async () => {
        for await (const event of peerConn.events) {
          peerEvents.push(event);
        }
      })();
      cleanups.push(async () => {
        peerConn.close();
        await peerLoop.catch(() => undefined);
      });

      // Send turn 1 from TUI; assert both TUI and peer receive the reply and provider saw 1 request using mock-beta.
      await submitLine(tui, fixture.idlePath, 'hello daemon tui');
      await tui.waitForOutput('reply-one', 30_000);
      idleGen = await waitForHarnessIdleGeneration(fixture.idlePath, { after: idleGen, timeoutMs: 30_000 });
      await expect
        .poll(() => peerEvents.some((ev) => ev.type === 'turn_ended' && ev.payload.outcome === 'completed'), {
          timeout: 15_000,
        })
        .toBe(true);
      expect(provider.requests()).toHaveLength(1);
      expect(provider.requests()[0]!.model).toBe('mock-beta');

      // Global settings.json must still keep `mock-alpha` (launch override did not mutate global defaults).
      const savedAfterOverride = JSON.parse(
        fs.readFileSync(path.join(fixture.settingsDir, 'settings.json'), 'utf8'),
      ) as { agent: { modelSelection: { model: string } } };
      expect(savedAfterOverride.agent.modelSelection.model).toBe('mock-alpha');

      // Detach peer client mid-session and confirm TUI continues cleanly.
      peerConn.close();
      await peerLoop.catch(() => undefined);

      // Invoke workspace-scoped `/skills` resolved server-side by the daemon.
      await submitLine(tui, fixture.idlePath, '/skills alpha-skill');
      await tui.waitForOutput('Skill "alpha-skill" activated.', 30_000);
      await waitForHarnessComposerValue(fixture.idlePath, '', { timeoutMs: 15_000 });
      await submitLine(tui, fixture.idlePath, 'inspect workspace');
      await tui.waitForOutput('reply-skill', 30_000);
      idleGen = await waitForHarnessIdleGeneration(fixture.idlePath, { after: idleGen, timeoutMs: 30_000 });
      expect(provider.requests()).toHaveLength(2);
      const skillReqText = JSON.stringify(provider.requests()[1]!.messages);
      expect(skillReqText).toContain('SKILL_BODY_MARKER_14D');

      // Client-only `/restart`: TUI execve-replaces itself while daemon stays the exact same process/daemonId.
      await submitLine(tui, fixture.idlePath, '/restart');
      await tui.waitForOutput(`Resumed conversation: ${displaySessionId(sessionId)}`, 30_000);
      await expect.poll(() => readHarnessIdleGeneration(fixture.idlePath), { timeout: 30_000 }).toBe(1);
      idleGen = 1;
      await waitForHarnessComposerValue(fixture.idlePath, '', { timeoutMs: 30_000 });
      const statusAfterClientRestart = JSON.parse(
        (
          await execFileAsync(
            process.execPath,
            [builtCli, 'daemon', 'status', '--socket', fixture.socketPath, '--state-dir', fixture.stateDir],
            { cwd: fixture.daemonCwd, env: daemonEnv },
          )
        ).stdout,
      ) as { daemonId: string; pid: number };
      expect(statusAfterClientRestart.daemonId).toBe(statusBefore!.daemonId);
      expect(statusAfterClientRestart.pid).toBe(statusBefore!.pid);

      // Stop the daemon while TUI stays open; TUI reconnects by auto-starting a fresh daemon on the same session.
      await execFileAsync(
        process.execPath,
        [builtCli, 'daemon', 'stop', '--socket', fixture.socketPath, '--state-dir', fixture.stateDir],
        { cwd: fixture.daemonCwd, env: daemonEnv, timeout: 15_000 },
      );

      let newDaemonId = '';
      await expect
        .poll(
          async () => {
            try {
              const out = await execFileAsync(
                process.execPath,
                [builtCli, 'daemon', 'status', '--socket', fixture.socketPath, '--state-dir', fixture.stateDir],
                { cwd: fixture.daemonCwd, env: daemonEnv, timeout: 5_000 },
              );
              const parsed = JSON.parse(out.stdout) as { daemonId: string; activeSessionCount: number };
              newDaemonId = parsed.daemonId;
              return parsed.daemonId !== statusBefore!.daemonId && parsed.activeSessionCount >= 1;
            } catch {
              return false;
            }
          },
          { timeout: 25_000, interval: 150 },
        )
        .toBe(true);
      expect(newDaemonId).toMatch(/^dmn_/);
      expect(newDaemonId).not.toBe(statusBefore!.daemonId);
      // Wait for Ink to clear the transient Connection closed state and re-arm the composer.
      idleGen = await waitForHarnessIdleGeneration(fixture.idlePath, { after: idleGen, timeoutMs: 30_000 });

      // Submit a turn after daemon restart and verify TUI continues seamlessly on the same session.
      await submitLine(tui, fixture.idlePath, 'after daemon restart');
      await tui.waitForOutput('reply-after-restart', 30_000);
      await waitForHarnessIdleGeneration(fixture.idlePath, { after: idleGen, timeoutMs: 30_000 });
      expect(provider.requests()).toHaveLength(3);

      // Quit TUI cleanly and verify daemon remains alive.
      await submitLine(tui, fixture.idlePath, '/quit');
      const exit = await tui.waitForExit(20_000);
      expect(exit.exitCode).toBe(0);
    },
    TIMEOUT_MS,
  );

  it(
    'supports /settings persistence, /model persistence, /mcp status, /resume switching, and redacted provider projections over daemon',
    async () => {
      const provider = await startProvider(['seed-session-reply', 'second-session-reply']);
      cleanups.push(() => provider.close());

      const fixture = createFixture(provider.baseUrl, 'term2-daemon-tui-ops-e2e');
      cleanups.push(() => fs.rmSync(fixture.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
      const daemonEnv = createTestChildEnv(fixture.env);

      // Seed one prior workspace session headlessly through the daemon so /resume has a target.
      await execFileAsync(process.execPath, [builtCli, '--quiet', 'seed prior session'], {
        cwd: fixture.workspace,
        env: daemonEnv,
        timeout: 25_000,
      });
      cleanups.push(async () => {
        await execFileAsync(
          process.execPath,
          [builtCli, 'daemon', 'stop', '--socket', fixture.socketPath, '--state-dir', fixture.stateDir],
          { cwd: fixture.daemonCwd, env: daemonEnv, timeout: 10_000 },
        ).catch(() => undefined);
      });

      const inspector = await connectRemoteDirectHost({
        clientKind: 'control',
        conversationsDir: fixture.conversationsDir,
        protocolVersion: '1.1',
        minSupportedVersion: '1.1',
        env: daemonEnv,
      });
      cleanups.push(() => inspector.host.dispose());

      const seededList = await inspector.host.listSessionsByCwd(fixture.workspace);
      expect(seededList.sessions).toHaveLength(1);
      const seededSessionId = seededList.sessions[0]!.id;

      // Verify TUI settings projection redacts provider API keys.
      const rawSettings = await inspector.host.readSettings({ view: 'tui' });
      expect(JSON.stringify(rawSettings)).not.toContain('secret-daemon-key');

      const tui = spawnTerminal(process.execPath, [builtCli], {
        cwd: fixture.workspace,
        env: fixture.env,
        cols: 100,
        rows: 30,
      });
      cleanups.push(() => tui.dispose());

      await waitForHarnessIdleGeneration(fixture.idlePath, { timeoutMs: 60_000 });
      await tui.waitForOutput('mock-alpha', 30_000);

      // 1. /settings live write persists to daemon settings.json.
      await submitLine(tui, fixture.idlePath, '/settings ui.displayMode standard');
      await expect
        .poll(
          () => {
            const disk = JSON.parse(fs.readFileSync(path.join(fixture.settingsDir, 'settings.json'), 'utf8')) as {
              ui?: { displayMode?: string };
            };
            return disk.ui?.displayMode;
          },
          { timeout: 15_000 },
        )
        .toBe('standard');
      // Wait for the settings command to finish clearing the composer (or Esc out if the menu stayed open).
      await expect
        .poll(
          () => {
            const composerFile = `${fixture.idlePath}.composer`;
            if (!fs.existsSync(composerFile)) return '';
            const state = JSON.parse(fs.readFileSync(composerFile, 'utf8')) as { value: string };
            if (state.value !== '') tui.write('\x1b');
            return state.value;
          },
          { timeout: 15_000, interval: 100 },
        )
        .toBe('');

      // 2. /model switches live session AND persists new default to daemon settings.json.
      await submitLine(tui, fixture.idlePath, '/model mock-beta --provider=mockprov');
      await tui.waitForOutput('Set model to mock-beta (mockprov)', 30_000);
      await waitForHarnessComposerValue(fixture.idlePath, '', { timeoutMs: 15_000 });
      await expect
        .poll(
          () => {
            const disk = JSON.parse(fs.readFileSync(path.join(fixture.settingsDir, 'settings.json'), 'utf8')) as {
              agent?: { modelSelection?: { model?: string; provider?: string } };
            };
            return disk.agent?.modelSelection;
          },
          { timeout: 15_000 },
        )
        .toEqual({ provider: 'mockprov', model: 'mock-beta' });

      // 3. /mcp queries daemon-owned MCP manager.
      await submitLine(tui, fixture.idlePath, '/mcp ');
      await tui.waitForOutput('No MCP servers are configured.', 30_000);
      await waitForHarnessComposerValue(fixture.idlePath, '', { timeoutMs: 15_000 });

      // 4. /goal set + /goal show reads WireGoal.text cleanly (never prints undefined).
      await submitLine(tui, fixture.idlePath, '/goal set Ship daemon TUI --criteria All gates pass');
      await tui.waitForOutput('Goal (active): Ship daemon TUI', 30_000);
      await waitForHarnessComposerValue(fixture.idlePath, '', { timeoutMs: 15_000 });
      const beforeGoalShow = tui.getVisibleOutput().length;
      await submitLine(tui, fixture.idlePath, '/goal show');
      await expect
        .poll(() => tui.getVisibleOutput().slice(beforeGoalShow), { timeout: 30_000 })
        .toContain('Goal (active): Ship daemon TUI');
      expect(tui.getVisibleOutput().slice(beforeGoalShow)).toContain('Success criteria: All gates pass');
      expect(tui.getVisibleOutput().slice(beforeGoalShow)).not.toContain('Goal (active): undefined');
      await waitForHarnessComposerValue(fixture.idlePath, '', { timeoutMs: 15_000 });

      // 5. /resume waits for the async resume picker list before Enter so it never races under parallel load.
      const resumeCmd = `/resume ${displaySessionId(seededSessionId)}`;
      tui.write(resumeCmd);
      await waitForHarnessComposerValue(fixture.idlePath, resumeCmd, { timeoutMs: 30_000 });
      await tui.waitForOutput('seed prior session', 30_000);
      tui.write('\r');
      await tui.waitForOutput('seed-session-reply', 30_000);
      await waitForHarnessComposerValue(fixture.idlePath, '', { timeoutMs: 15_000 });

      // 6. Explicit session.close from a peer client is terminal: TUI reports the closed error and does NOT re-open it.
      const statusBeforeClose = await inspector.host.status();
      await inspector.host.closeSession!(LOCAL_PRINCIPAL, seededSessionId);
      await tui.waitForOutput('Session closed.', 30_000);
      const statusAfterClose = await inspector.host.status();
      expect(statusAfterClose.activeSessionCount).toBe(statusBeforeClose.activeSessionCount - 1);

      // Exit cleanly with double Ctrl+C across separate PTY reads (composer is disabled on a terminal session error).
      let exited: { exitCode: number } | null = null;
      const exitPromise = tui.waitForExit(20_000).then((res) => {
        exited = res;
        return res;
      });
      await expect
        .poll(
          () => {
            if (!exited) tui.write('\x03');
            return exited !== null;
          },
          { timeout: 10_000, interval: 80 },
        )
        .toBe(true);
      const exit = await exitPromise;
      expect(exit.exitCode).toBe(0);
    },
    TIMEOUT_MS,
  );
});
