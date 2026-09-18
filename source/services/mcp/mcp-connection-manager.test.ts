import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpCallError, McpConnectionManager } from './mcp-connection-manager.js';
import type { ResolvedMcpServerConfig } from './mcp-config.js';
import type { StdioLaunchSpec } from './mcp-stdio-launcher.js';

const fixturesDir = resolve(import.meta.dirname, 'test-fixtures');

const stdioCommand = (extraArgs: string[] = []) =>
  ({
    name: 'fx',
    provenance: 'user',
    transport: 'stdio',
    command: process.execPath,
    args: [join(fixturesDir, 'stdio-fixture.mjs'), ...extraArgs],
  } satisfies ResolvedMcpServerConfig);

/** Spawns a fixture that prints {port} on stdout and resolves with its base URL. */
async function startHttpFixture(script: string): Promise<{ url: string; stop: () => void }> {
  const child = spawn(process.execPath, [join(fixturesDir, script)], { stdio: ['pipe', 'pipe', 'pipe'] });
  const [buf] = (await once(child.stdout, 'data')) as [Buffer];
  return {
    url: `http://127.0.0.1:${(JSON.parse(String(buf)) as { port: number }).port}`,
    stop: () => child.kill(),
  };
}

const until = async (probe: () => boolean | Promise<boolean>, message: string): Promise<void> => {
  const deadline = Date.now() + 5000;
  // The probe is usually async; a Promise is truthy, so it must be awaited.
  while (!(await probe())) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for: ${message}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

const isProcessAlive = async (pid: number): Promise<boolean> => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Reads the fixture's pid file and probes that exact process. Unlike waiting
 * for the fixture's exit-handler cleanup, this also holds when the process is
 * killed by a signal, which never runs 'exit' handlers.
 */
const fixtureGone = async (pidFile: string): Promise<boolean> => {
  const raw = await readFile(pidFile, 'utf8').catch(() => '');
  const pid = Number(raw);
  if (!pid) return true;
  return !(await isProcessAlive(pid));
};

describe('McpConnectionManager', () => {
  it('reconciles a changed server set without replacing the tool source', async () => {
    const launcher = vi.fn(async (spec: StdioLaunchSpec) => spec);
    const manager = new McpConnectionManager({ servers: [], stdioLauncher: launcher });
    manager.start();
    await manager.replaceServers([{ ...stdioCommand(), name: 'added' }]);
    expect(manager.snapshot().map((server) => server.name)).toEqual(['added']);
    await manager.replaceServers([]);
    expect(manager.snapshot()).toEqual([]);
    await manager.close();
  });
  const httpFixtures: Array<{ stop: () => void }> = [];
  const managers: McpConnectionManager[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(managers.splice(0).map((m) => m.close().catch(() => {})));
    for (const fixture of httpFixtures.splice(0)) fixture.stop();
    await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it('keeps an empty configured server set inert and closes cleanly', async () => {
    const manager = new McpConnectionManager({ servers: [] });
    const changed = vi.fn();
    manager.onCatalogChanged(changed);
    manager.start();
    await manager.whenSettled();
    expect(manager.snapshot()).toEqual([]);
    await manager.close();
    expect(changed).not.toHaveBeenCalled();
  });

  const track = (manager: McpConnectionManager): McpConnectionManager => {
    managers.push(manager);
    return manager;
  };

  const tempDir = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-manager-'));
    tempDirs.push(dir);
    return dir;
  };

  it('starts a stdio server, walks pagination to the end, and keeps snapshot identity', async () => {
    const manager = track(new McpConnectionManager({ servers: [stdioCommand()] }));
    const snapshotsBeforeSettle = manager.snapshot();
    expect(snapshotsBeforeSettle.map((s) => s.state)).toEqual(['connecting']);

    manager.start();
    await manager.whenSettled();

    const snapshot = manager.snapshot().find((s) => s.name === 'fx');
    expect(snapshot?.state).toBe('ready');
    // 2 tools on page 1, 3 on page 2: the manager followed the cursor chain.
    expect(snapshot?.tools.map((t) => t.name)).toEqual([
      'echo',
      'fail',
      'env_probe',
      'crash',
      'slow',
      'refresh',
      'die',
    ]);

    // Identity is stable while nothing changes.
    expect(manager.snapshot()).toBe(manager.snapshot());
    expect(manager.snapshot()).not.toBe(snapshotsBeforeSettle);
  });

  it('returns content and structuredContent from a successful call', async () => {
    const manager = track(new McpConnectionManager({ servers: [stdioCommand()] }));
    manager.start();
    await manager.whenSettled();

    const result = await manager.callTool('fx', 'echo', { message: 'hi' }, { signal: new AbortController().signal });
    expect(result.isError).toBe(false);
    expect(result.content).toEqual([{ type: 'text', text: 'echo:{"message":"hi"}' }]);
    expect(result.structuredContent).toEqual({ echo: { message: 'hi' } });
  });

  it('returns a server-reported tool failure as a result, not a rejection', async () => {
    const manager = track(new McpConnectionManager({ servers: [stdioCommand()] }));
    manager.start();
    await manager.whenSettled();

    const result = await manager.callTool('fx', 'fail', {}, { signal: new AbortController().signal });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: 'boom' }]);
  });

  it('passes configured env to the spawned stdio server', async () => {
    const config = { ...stdioCommand(), env: { MCP_FIXTURE_SECRET: 's3cret' } };
    const manager = track(new McpConnectionManager({ servers: [config] }));
    manager.start();
    await manager.whenSettled();

    const result = await manager.callTool('fx', 'env_probe', {}, { signal: new AbortController().signal });
    expect(result.content).toEqual([{ type: 'text', text: 's3cret' }]);
  });

  it('refetches on tools/list_changed, fires onCatalogChanged, and swaps the snapshot array', async () => {
    const manager = track(new McpConnectionManager({ servers: [stdioCommand()] }));
    manager.start();
    await manager.whenSettled();
    const before = manager.snapshot();
    const changes: number[] = [];
    manager.onCatalogChanged(() => changes.push(changes.length + 1));

    await manager.callTool('fx', 'refresh', {}, { signal: new AbortController().signal });
    await until(
      () =>
        manager
          .snapshot()
          .find((s) => s.name === 'fx')
          ?.tools.some((t) => t.name === 'added_tool') === true,
      'refetched catalog after list_changed',
    );

    expect(changes.length).toBeGreaterThan(0);
    expect(manager.snapshot()).not.toBe(before);
  });

  it('maps unknown server and unknown tool names to their error codes', async () => {
    const manager = track(new McpConnectionManager({ servers: [stdioCommand()] }));
    manager.start();
    await manager.whenSettled();

    await expect(manager.callTool('nope', 'echo', {}, { signal: new AbortController().signal })).rejects.toMatchObject({
      code: 'unknown_server',
    });
    await expect(
      manager.callTool('fx', 'no_such_tool', {}, { signal: new AbortController().signal }),
    ).rejects.toMatchObject({ code: 'unknown_tool' });
  });

  it('maps a call that exceeds timeoutMs to the timeout code', async () => {
    const manager = track(new McpConnectionManager({ servers: [stdioCommand()] }));
    manager.start();
    await manager.whenSettled();

    await expect(
      manager.callTool('fx', 'slow', {}, { signal: new AbortController().signal, timeoutMs: 300 }),
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  it('maps an aborted call to the aborted code', async () => {
    const manager = track(new McpConnectionManager({ servers: [stdioCommand()] }));
    manager.start();
    await manager.whenSettled();

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    await expect(manager.callTool('fx', 'slow', {}, { signal: controller.signal })).rejects.toMatchObject({
      code: 'aborted',
    });
  });

  it('marks a stdio server failed with its stderr tail after the process crashes', async () => {
    const manager = track(new McpConnectionManager({ servers: [stdioCommand()] }));
    manager.start();
    await manager.whenSettled();

    await manager.callTool('fx', 'crash', {}, { signal: new AbortController().signal });
    await until(() => manager.snapshot().find((s) => s.name === 'fx')?.state === 'failed', 'crash to fail the server');

    const snapshot = manager.snapshot().find((s) => s.name === 'fx');
    expect(snapshot?.error).toContain('fixture crashing on purpose');
    expect(snapshot?.tools).toEqual([]);
    await expect(manager.callTool('fx', 'echo', {}, { signal: new AbortController().signal })).rejects.toMatchObject({
      code: 'server_unavailable',
    });
  });

  it('fails a project stdio server closed unless the user enabled it, naming the exact override', async () => {
    const launches: string[] = [];
    const launcher = async (spec: StdioLaunchSpec) => {
      launches.push(spec.name);
      return { command: spec.command, args: spec.args, env: spec.env };
    };
    const dir = await tempDir();
    const userConfigPath = join(dir, 'mcp.json');
    const workspaceRoot = join(dir, 'repo');
    const project: ResolvedMcpServerConfig = {
      name: 'repo-fx',
      provenance: 'project',
      transport: 'stdio',
      command: process.execPath,
      args: [join(fixturesDir, 'stdio-fixture.mjs')],
    };
    const manager = track(
      new McpConnectionManager({ servers: [project], userConfigPath, workspaceRoot, stdioLauncher: launcher }),
    );
    manager.start();
    await manager.whenSettled();

    const snapshot = manager.snapshot().find((s) => s.name === 'repo-fx');
    expect(snapshot?.state).toBe('failed');
    expect(snapshot?.error).toContain('projectServers');
    expect(snapshot?.error).toContain('"repo-fx"');
    expect(snapshot?.error).toContain('enabled');
    // The exact nested line: scoped to this workspace's real path.
    expect(snapshot?.error).toContain(workspaceRoot);
    expect(snapshot?.error).toContain(userConfigPath);
    expect(launches).toEqual([]);
  });

  it('starts a project stdio server once the user enabled it', async () => {
    const project: ResolvedMcpServerConfig = {
      ...stdioCommand(),
      name: 'enabled-fx',
      provenance: 'project',
      projectEnabledOverride: true,
    };
    const manager = track(new McpConnectionManager({ servers: [project] }));
    manager.start();
    await manager.whenSettled();

    const snapshot = manager.snapshot().find((s) => s.name === 'enabled-fx');
    expect(snapshot?.state).toBe('ready');
    const result = await manager.callTool('enabled-fx', 'echo', {}, { signal: new AbortController().signal });
    expect(result.isError).toBe(false);
  });

  it('fails config-invalid entries without launching anything', async () => {
    const launches: string[] = [];
    const launcher = async (spec: StdioLaunchSpec) => {
      launches.push(spec.name);
      return { command: spec.command, args: spec.args, env: spec.env };
    };
    const broken: ResolvedMcpServerConfig = {
      name: 'broken',
      provenance: 'user',
      transport: 'stdio',
      error: 'needs a command (stdio) or a url (http/sse)',
    };
    const manager = track(new McpConnectionManager({ servers: [broken], stdioLauncher: launcher }));
    manager.start();
    await manager.whenSettled();

    expect(manager.snapshot().find((s) => s.name === 'broken')?.state).toBe('failed');
    expect(launches).toEqual([]);
  });

  it('connects to a Streamable HTTP server and calls tools', async () => {
    const fixture = await startHttpFixture('http-fixture.mjs');
    httpFixtures.push(fixture);
    const manager = track(
      new McpConnectionManager({
        servers: [{ name: 'http-fx', provenance: 'user', transport: 'streamable-http', url: fixture.url }],
      }),
    );
    manager.start();
    await manager.whenSettled();

    const snapshot = manager.snapshot().find((s) => s.name === 'http-fx');
    expect(snapshot?.state).toBe('ready');
    const result = await manager.callTool(
      'http-fx',
      'echo',
      { message: 'over http' },
      { signal: new AbortController().signal },
    );
    expect(result.content).toEqual([{ type: 'text', text: 'echo:{"message":"over http"}' }]);
    const failed = await manager.callTool('http-fx', 'fail', {}, { signal: new AbortController().signal });
    expect(failed.isError).toBe(true);
  });

  it('connects to a legacy HTTP+SSE server with explicit type sse', async () => {
    const fixture = await startHttpFixture('sse-fixture.mjs');
    httpFixtures.push(fixture);
    const manager = track(
      new McpConnectionManager({
        servers: [{ name: 'sse-fx', provenance: 'user', transport: 'sse', url: `${fixture.url}/sse` }],
      }),
    );
    manager.start();
    await manager.whenSettled();

    expect(manager.snapshot().find((s) => s.name === 'sse-fx')?.state).toBe('ready');
    const result = await manager.callTool(
      'sse-fx',
      'echo',
      { message: 'over sse' },
      { signal: new AbortController().signal },
    );
    expect(result.content).toEqual([{ type: 'text', text: 'echo:{"message":"over sse"}' }]);
    const failed = await manager.callTool('sse-fx', 'fail', {}, { signal: new AbortController().signal });
    expect(failed.isError).toBe(true);
  });

  it('close() shuts every connection down and leaves no child processes', async () => {
    const dir = await tempDir();
    const pidFile = join(dir, 'fixture.pid');
    const config = { ...stdioCommand(), env: { MCP_FIXTURE_PID_FILE: pidFile } };
    const manager = new McpConnectionManager({ servers: [config] });
    manager.start();
    await manager.whenSettled();

    await until(async () => {
      try {
        await readFile(pidFile, 'utf8');
        return true;
      } catch {
        return false;
      }
    }, 'fixture wrote its pid file');

    await manager.close();
    managers.splice(managers.indexOf(manager), 1);
    // The fixture deletes the pid file from its own 'exit' handler, so this
    // proves that exact process ended (pid reuse cannot fool it).
    await until(async () => {
      try {
        await readFile(pidFile, 'utf8');
        return false;
      } catch {
        return true;
      }
    }, 'fixture process to exit after close()');
  });

  it('close() during a slow handshake kills the child and never reports ready', async () => {
    const dir = await tempDir();
    const pidFile = join(dir, 'fixture.pid');
    const config = {
      ...stdioCommand(),
      env: { MCP_FIXTURE_PID_FILE: pidFile, MCP_FIXTURE_SLOW_INIT_MS: '2000' },
    };
    const manager = track(new McpConnectionManager({ servers: [config] }));
    let changes = 0;
    manager.onCatalogChanged(() => {
      changes += 1;
    });
    manager.start();
    await until(async () => {
      try {
        await readFile(pidFile, 'utf8');
        return true;
      } catch {
        return false;
      }
    }, 'fixture child to spawn (handshake still pending)');

    await manager.close();
    // The handshake never completed, so the snapshot must never say ready.
    expect(manager.snapshot().find((s) => s.name === 'fx')?.state).not.toBe('ready');
    const changesAtClose = changes;
    // Proves the exact child process that spawned was killed by close().
    await until(() => fixtureGone(pidFile), 'fixture child to be killed by close()');
    // ...and nothing notifies listeners once close() has resolved.
    await new Promise((r) => setTimeout(r, 100));
    expect(changes).toBe(changesAtClose);
  });

  it('close() during the launcher await never spawns a process', async () => {
    const launches: string[] = [];
    const launcher = async (spec: StdioLaunchSpec) => {
      launches.push(spec.name);
      await new Promise((r) => setTimeout(r, 150));
      return { command: spec.command, args: spec.args, env: spec.env };
    };
    const manager = track(new McpConnectionManager({ servers: [stdioCommand()], stdioLauncher: launcher }));
    manager.start();
    await manager.close();
    await new Promise((r) => setTimeout(r, 250));
    expect(launches).toEqual(['fx']);
    expect(manager.snapshot().find((s) => s.name === 'fx')?.state).not.toBe('ready');
  });

  it('tears the spawned process down when the first tools/list fails', async () => {
    const dir = await tempDir();
    const pidFile = join(dir, 'fixture.pid');
    const config: ResolvedMcpServerConfig = {
      name: 'bad-list',
      provenance: 'user',
      transport: 'stdio',
      command: process.execPath,
      args: [join(fixturesDir, 'stdio-bad-list.mjs')],
      env: { MCP_FIXTURE_PID_FILE: pidFile },
    };
    const manager = track(new McpConnectionManager({ servers: [config] }));
    manager.start();
    await manager.whenSettled();

    const snapshot = manager.snapshot().find((s) => s.name === 'bad-list');
    expect(snapshot?.state).toBe('failed');
    expect(snapshot?.error).toContain('tool catalog is broken');
    // The handshake succeeded, so a process existed; it must be gone now.
    await until(() => fixtureGone(pidFile), 'fixture process to exit after failed setup');
  });

  it('maps a mid-call process crash to server_unavailable', async () => {
    const manager = track(new McpConnectionManager({ servers: [stdioCommand()] }));
    manager.start();
    await manager.whenSettled();

    // 'die' exits the fixture without replying: the request dies with the transport.
    await expect(manager.callTool('fx', 'die', {}, { signal: new AbortController().signal })).rejects.toMatchObject({
      code: 'server_unavailable',
    });
  });

  it('close() of settled connections leaves no pending grace timer', async () => {
    const manager = track(new McpConnectionManager({ servers: [stdioCommand()] }));
    manager.start();
    await manager.whenSettled();
    const timersBefore = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    await manager.close();
    // A leaked close() grace timer would still be pending here (5s), so the
    // count could only grow; equality-or-fewer proves it was cleared.
    const timersAfter = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    expect(timersAfter).toBeLessThanOrEqual(timersBefore);
  });

  it('does not mark a server failed or notify after close() races list_changed', async () => {
    const manager = track(new McpConnectionManager({ servers: [stdioCommand()] }));
    manager.start();
    await manager.whenSettled();
    let changes = 0;
    manager.onCatalogChanged(() => {
      changes += 1;
    });

    // 'refresh' emits notifications/tools/list_changed; the refetch races close().
    void manager.callTool('fx', 'refresh', {}, { signal: new AbortController().signal }).catch(() => {});
    await manager.close();
    const changesAtClose = changes;
    await new Promise((r) => setTimeout(r, 100));
    expect(changes).toBe(changesAtClose);
    expect(manager.snapshot().find((s) => s.name === 'fx')?.state).not.toBe('failed');
  });

  it('surfaces McpCallError as a rejected McpCallError instance', async () => {
    const manager = track(new McpConnectionManager({ servers: [stdioCommand()] }));
    manager.start();
    await manager.whenSettled();
    const error = await manager
      .callTool('gone', 'echo', {}, { signal: new AbortController().signal })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(McpCallError);
  });
});
