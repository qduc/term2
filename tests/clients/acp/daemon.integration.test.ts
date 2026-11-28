/**
 * `term2 acp` over the singleton daemon (Step 14e Part 2b), built CLI only.
 *
 * Every check fails on an in-process fallback: the session must be listed by the daemon's
 * Unix `session.list`, the ACP-supplied MCP server must be a child of the daemon process,
 * and its process must end when the session closes and when the ACP process exits. The
 * daemon runs with a provider key and a PATH the ACP process does not have, so the MCP
 * server's environment shows which process it came from. A second ACP process checks
 * the holder rules: refused while the first holds the session, takes it over in Ask
 * after the first exits, and a foreign close reopens it only with the ACP surface.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import * as acp from '@agentclientprotocol/sdk';
import { LOCAL_PRINCIPAL } from '../../../src/app/application-workspaces.js';
import { connectRemoteDirectHost } from '../../../src/app/daemon/connect-daemon-host.js';
import { resolveSettingsDirectory } from '../../../src/config/settings/settings-path.js';
import { createGatewayAssertion } from '../../../src/host/server-assertion.js';
import type { AssertionPurpose } from '../../../src/host/server-contracts.js';
import { integrationCliPath } from '../../helpers/integration-cli.js';
import { createTestChildEnv } from '../../helpers/terminal-e2e.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const MCP_SCRIPT = `import fs from 'node:fs';
import readline from 'node:readline';
fs.appendFileSync(process.env.MCP_PID_FILE, process.pid + '\\n');
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  if (m.method === 'initialize')
    reply(m.id, { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } });
  else if (m.method === 'tools/list')
    reply(m.id, { tools: [{ name: 'echo', description: 'Echo context', inputSchema: { type: 'object', properties: {} } }] });
  else if (m.method === 'tools/call')
    reply(m.id, { content: [{ type: 'text', text: JSON.stringify({
      cwd: process.cwd(),
      token: process.env.MCP_SENTINEL,
      clientPath: (process.env.PATH ?? '').includes('acp-client-path-marker'),
      daemonPath: (process.env.PATH ?? '').includes('daemon-path-marker'),
      providerKey: process.env.OPENAI_API_KEY ?? 'absent',
    }) }] });
  else reply(m.id, {});
});`;

/**
 * Alternates a `run_code` call into the fixture MCP tool with a plain reply, two requests per
 * prompt. A prompt saying "Hold for cancel" gets no answer until the client cancels it.
 */
async function startProvider() {
  const requests: any[] = [];
  let inference = 0;
  let held: http.ServerResponse | undefined;
  const server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'acp-model' }] }));
      return;
    }
    let raw = '';
    req.on('data', (chunk) => (raw += String(chunk)));
    req.on('end', () => {
      const request = JSON.parse(raw);
      if (JSON.stringify(request.messages.at(-1)).includes('Hold for cancel')) {
        held = res;
        return;
      }
      requests.push(request);
      const call = inference++ % 2 === 0;
      const delta = call
        ? {
            tool_calls: [
              {
                index: 0,
                id: `call-${requests.length}`,
                type: 'function',
                function: {
                  name: 'run_code',
                  arguments: JSON.stringify({
                    code: 'return await tools.airfixture__echo({});',
                    description: 'Call fixture MCP',
                  }),
                },
              },
            ],
          }
        : { content: 'ACP daemon reply' };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        [
          `data: ${JSON.stringify({ id: 'reply', choices: [{ delta }] })}`,
          `data: ${JSON.stringify({
            id: 'reply',
            choices: [{ delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }],
          })}`,
          'data: [DONE]',
        ].join('\n\n') + '\n\n',
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as import('node:net').AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    held: () => held !== undefined,
    /** The last tool result the model received, parsed. */
    lastToolResult(): Record<string, unknown> {
      const tool = requests
        .at(-1)
        .messages.filter((message: any) => message.role === 'tool')
        .at(-1);
      const match = /\{[^{}]*"token"[^{}]*\}/.exec(String(tool?.content).replace(/\\"/g, '"'));
      return match ? JSON.parse(match[0]) : {};
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function parentOf(pid: number): number {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
}

/** One JSON request to the serve lease's HTTP listener over its Unix socket. */
function httpUnix(
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
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: raw.trim() ? JSON.parse(raw) : {} }));
      },
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

function startAcp(cliPath: string, env: NodeJS.ProcessEnv, permissions: acp.RequestPermissionRequest[]) {
  const child = spawn(process.execPath, [cliPath, 'acp', '--provider', 'acpfixture', '--model', 'acp-model'], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  cleanups.push(() => {
    child.kill('SIGKILL');
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += String(chunk)));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once('close', (code, signal) => resolve({ code, signal })),
  );
  const connection = acp
    .client({ name: 'term2-acp-daemon-integration' })
    .onRequest(acp.methods.client.session.requestPermission, async ({ params }) => {
      permissions.push(params);
      return {
        outcome: {
          outcome: 'selected',
          optionId: params.options.find((option) => option.kind === 'allow_once')!.optionId,
        },
      };
    })
    .connect(
      acp.ndJsonStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      ),
    );
  cleanups.push(() => connection.close());
  return { child, context: connection.agent, exited, stderr: () => stderr };
}

describe('term2 acp over the daemon (built CLI)', () => {
  it('hosts ACP sessions and their MCP servers in the daemon with in-process ACP posture', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acp-daemon-')));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
    const home = path.join(root, 'home');
    const workspace = path.join(root, 'workspace');
    const scratch = path.join(root, 'scratch');
    const runtimeDir = path.join(root, 'run');
    const daemonSocket = path.join(runtimeDir, 'daemon.sock');
    const daemonState = path.join(root, 'daemon-state');
    const pidFile = path.join(root, 'mcp-pids');
    const poolPidFile = path.join(root, 'pool-pids');
    for (const dir of [home, workspace, scratch, runtimeDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const provider = await startProvider();
    cleanups.push(provider.close);

    const base = createTestChildEnv({
      HOME: home,
      XDG_STATE_HOME: path.join(root, 'xdg-state'),
      DISABLE_LOGGING: '1',
      TMPDIR: scratch,
      TMP: scratch,
      TEMP: scratch,
      TERM2_DAEMON_MODE: '1',
      TERM2_DAEMON_DIR: runtimeDir,
      TERM2_DAEMON_SOCKET: daemonSocket,
      TERM2_CONVERSATIONS_DIR: path.join(daemonState, 'conversations'),
      TERM2_CACHE_DIR: path.join(root, 'cache'),
    });
    const settingsDir = resolveSettingsDirectory({ homeDir: home, env: base });
    fs.mkdirSync(settingsDir, { recursive: true, mode: 0o700 });
    // 'always' would skip every approval; an ACP session must still ask (in-process ACP forces Ask).
    const settings = JSON.stringify({
      agent: { modelSelection: { provider: 'acpfixture', model: 'acp-model' }, retryAttempts: 0 },
      shell: { autoApproveMode: 'always', showReview: false },
      sandbox: { enabled: false },
      providers: [{ name: 'acpfixture', type: 'openai-compatible', baseUrl: provider.baseUrl, apiKey: 'test' }],
    });
    fs.writeFileSync(path.join(settingsDir, 'settings.json'), settings);
    base['TERM2_SETTINGS_DIR'] = settingsDir;
    const cliPath = integrationCliPath();
    const script = path.join(workspace, 'mcp.mjs');
    fs.writeFileSync(script, MCP_SCRIPT);
    // The user's own MCP configuration feeds the daemon's per-workspace pool; ACP sessions never load it.
    fs.writeFileSync(
      path.join(settingsDir, 'mcp.json'),
      JSON.stringify({
        mcpServers: { userpool: { command: process.execPath, args: [script], env: { MCP_PID_FILE: poolPidFile } } },
      }),
    );

    // The daemon has a provider key and its own PATH; the ACP process has neither.
    const daemon = spawn(
      process.execPath,
      [cliPath, 'daemon', 'start', '--socket', daemonSocket, '--state-dir', daemonState],
      {
        env: { ...base, PATH: `/daemon-path-marker:${base['PATH']}`, OPENAI_API_KEY: 'daemon-provider-secret' },
        stdio: 'ignore',
      },
    );
    const daemonExited = new Promise<void>((resolve) => daemon.once('close', () => resolve()));
    cleanups.push(async () => {
      daemon.kill('SIGTERM');
      await daemonExited;
    });
    await expect.poll(() => fs.existsSync(daemonSocket), { timeout: 30_000 }).toBe(true);
    const observer = await connectRemoteDirectHost({
      clientKind: 'custom',
      protocolVersion: '1.1',
      minSupportedVersion: '1.1',
      allowAutoStart: false,
      socketPath: daemonSocket,
      env: base,
    });
    cleanups.push(() => observer.host.dispose());
    const daemonSessions = async () =>
      ((await observer.host.rpc.request('session.list', {})) as { sessions: { id: string }[] }).sessions.map(
        ({ id }) => id,
      );
    const mcpPids = () =>
      fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8').trim().split('\n').filter(Boolean).map(Number) : [];

    const permissions: acp.RequestPermissionRequest[] = [];
    const acpEnv = { ...base, PATH: `/acp-client-path-marker:${base['PATH']}` };
    const first = startAcp(cliPath, acpEnv, permissions);
    const initialized = await first.context.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientInfo: { name: 'term2-acp-daemon-integration', version: '1' },
    });
    expect(initialized).toMatchObject({ protocolVersion: 1, agentCapabilities: { loadSession: true } });
    // Startup normalizes the file; nothing an ACP session does may write it afterwards.
    const savedSettings = () => fs.readFileSync(path.join(settingsDir, 'settings.json'), 'utf8');
    const preferences = savedSettings();

    const mcpServers: acp.McpServer[] = [
      {
        name: 'airfixture',
        command: process.execPath,
        args: [script],
        env: [
          { name: 'MCP_SENTINEL', value: 'session-mcp-visible' },
          { name: 'MCP_PID_FILE', value: pidFile },
        ],
      },
      { name: 'offline-fixture', command: process.execPath, args: ['-e', 'process.exit(1)'], env: [] },
    ];
    const { sessionId } = await first.context.request(acp.methods.agent.session.new, { cwd: workspace, mcpServers });

    // The daemon owns the session and runs the MCP server, not the ACP process.
    expect(await daemonSessions()).toContain(sessionId);
    expect(mcpPids()).toHaveLength(1);
    const [firstMcp] = mcpPids();
    const daemonPid = (await observer.host.status()).pid;
    expect(parentOf(firstMcp!)).toBe(daemonPid);
    expect(daemonPid).not.toBe(first.child.pid);

    await first.context.request(acp.methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: 'text', text: 'Call fixture MCP' }],
    });
    expect(fs.existsSync(poolPidFile)).toBe(false);
    // Ask mode holds although the saved preference is 'always'.
    expect(permissions).toHaveLength(1);
    expect(provider.lastToolResult()).toEqual({
      cwd: workspace,
      token: 'session-mcp-visible',
      clientPath: true,
      daemonPath: false,
      providerKey: 'absent',
    });

    // Configuration options read and write the daemon session; neither reaches saved defaults.
    const option = (response: { configOptions?: acp.SessionConfigOption[] | null }, id: string) =>
      response.configOptions?.find((entry) => entry.id === id);
    const thinking = await first.context.request(acp.methods.agent.session.setConfigOption, {
      sessionId,
      configId: 'thinking_level',
      value: 'high',
    });
    expect(option(thinking, 'thinking_level')).toMatchObject({ currentValue: 'high' });
    for (const value of ['always', 'ask']) {
      const changed = await first.context.request(acp.methods.agent.session.setConfigOption, {
        sessionId,
        configId: 'approval_mode',
        value,
      });
      expect(option(changed, 'approval_mode')).toMatchObject({ currentValue: value });
    }
    // Assisted needs ACP v1's sandboxed-shell review, which the daemon cannot be asked for yet: refused, not weakened.
    await expect(
      first.context.request(acp.methods.agent.session.setConfigOption, {
        sessionId,
        configId: 'approval_mode',
        value: 'assisted',
      }),
    ).rejects.toMatchObject({
      code: -32010,
      message: expect.stringMatching(/not available for ACP sessions over the term2 daemon/),
    });

    // Replacement is atomic: a server that will not start leaves the working one installed.
    await expect(
      first.context.request(acp.methods.agent.session.load, {
        sessionId,
        cwd: workspace,
        mcpServers: [{ name: 'broken', command: process.execPath, args: ['/no-such-acp-fixture.mjs'], env: [] }],
      }),
    ).rejects.toMatchObject({ code: -32010 });
    await first.context.request(acp.methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: 'text', text: 'Old MCP still works after failed replacement' }],
    });
    expect(provider.lastToolResult()).toMatchObject({ token: 'session-mcp-visible' });

    // Cancellation reaches the turn running in the daemon.
    const holding = first.context.request(acp.methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: 'text', text: 'Hold for cancel' }],
    });
    await expect.poll(() => provider.held(), { timeout: 10_000 }).toBe(true);
    await first.context.notify(acp.methods.agent.session.cancel, { sessionId });
    await expect(holding).resolves.toMatchObject({ stopReason: 'cancelled' });

    // Closing the session ends its MCP server.
    await first.context.request(acp.methods.agent.session.close, { sessionId });
    await expect.poll(() => alive(firstMcp!), { timeout: 10_000 }).toBe(false);

    // A session live under another client's surface is not handed to ACP.
    const interactive = await observer.host.launchSession({
      cwd: workspace,
      selection: { kind: 'new' },
      clientMode: 'interactive',
    });
    // Control: the same user configuration does start for a session that is not ACP.
    await expect.poll(() => fs.existsSync(poolPidFile), { timeout: 10_000 }).toBe(true);
    await expect(
      first.context.request(acp.methods.agent.session.load, {
        sessionId: interactive.session.id,
        cwd: workspace,
        mcpServers: [],
      }),
    ).rejects.toMatchObject({ code: -32010 });

    // Reopened with its servers. No other client may weaken it, clear its servers or take it over.
    await first.context.request(acp.methods.agent.session.load, { sessionId, cwd: workspace, mcpServers });
    expect(mcpPids()).toHaveLength(2);
    const reopenedMcp = mcpPids()[1]!;
    const settingsRevision = ((await observer.host.readSettings({ view: 'tui', sessionId })) as { revision: string })
      .revision;
    await expect(
      observer.host.updateScopedSettings({
        sessionId,
        expectedRevision: settingsRevision,
        persist: false,
        changes: [{ key: 'shell.autoApproveMode', value: 'auto' }],
      }),
    ).rejects.toMatchObject({ code: 'unavailable' });
    await expect(
      observer.host.launchSession({
        cwd: workspace,
        selection: { kind: 'resume', sessionId },
        clientMode: 'interactive',
        approvalMode: 'unattended',
      }),
    ).rejects.toMatchObject({ code: 'unavailable' });
    await expect(observer.host.rpc.request('session.acp.set_mcp', { sessionId, servers: [] })).rejects.toMatchObject({
      code: 'forbidden',
    });
    const second = startAcp(cliPath, acpEnv, permissions);
    await second.context.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientInfo: { name: 'term2-acp-daemon-integration', version: '1' },
    });
    // As the writer lock refuses a second in-process ACP process.
    await expect(
      second.context.request(acp.methods.agent.session.load, { sessionId, cwd: workspace, mcpServers: [] }),
    ).rejects.toMatchObject({ code: -32010 });

    // The holder clears its servers and leaves Always behind, then exits: the daemon still
    // ends every MCP process the session had, and the session stays.
    await first.context.request(acp.methods.agent.session.load, { sessionId, cwd: workspace, mcpServers: [] });
    expect(alive(reopenedMcp)).toBe(true);
    await first.context.request(acp.methods.agent.session.setConfigOption, {
      sessionId,
      configId: 'approval_mode',
      value: 'always',
    });
    first.child.stdin.end();
    await expect(first.exited).resolves.toEqual({ code: 0, signal: null });
    await expect.poll(() => alive(reopenedMcp), { timeout: 10_000 }).toBe(false);
    expect(await daemonSessions()).toContain(sessionId);
    expect(first.stderr()).not.toContain('detach failed');

    // A new ACP client takes over the still-live session in Ask, as a new in-process ACP process would.
    const loaded = await second.context.request(acp.methods.agent.session.load, {
      sessionId,
      cwd: workspace,
      mcpServers,
    });
    expect(option(loaded, 'approval_mode')).toMatchObject({ currentValue: 'ask' });

    // The web owner, through a serve lease whose grant covers the workspace, cannot put the
    // held session in Unattended either: the session's own policy refuses it on any route.
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const pemPath = path.join(root, 'bff.pem');
    fs.writeFileSync(pemPath, publicKey);
    const gateway = path.join(runtimeDir, 'gateway.sock');
    const sign = (purpose: AssertionPurpose, ids: { sessionId?: string } = {}) =>
      createGatewayAssertion({
        privateKey,
        kid: 'k',
        issuer: 'chatforge-bff',
        audience: 'term2-gateway',
        subject: 'web-owner',
        purpose,
        ...ids,
      });
    await observer.host.rpc.request('daemon.serve.start', {
      stateDir: path.join(root, 'serve-state'),
      localOwnerUserId: 'web-owner',
      allowWrite: true,
      pairing: false,
      bffKeys: [{ kid: 'k', pemPath }],
      transport: { kind: 'socket', socketPath: gateway },
    });
    const candidate = await httpUnix(
      gateway,
      'POST',
      '/private/agent/v1/workspace/candidates/validate',
      { absolutePath: workspace },
      sign('workspace_candidate_validate'),
    );
    await httpUnix(
      gateway,
      'POST',
      '/private/agent/v1/workspace/candidates/select',
      { candidateId: candidate.json['candidateId'], access: 'read_write' },
      sign('workspace_candidate_select'),
    );
    const configPath = `/private/agent/v1/sessions/${sessionId}/config?format=direct`;
    const discovered = await httpUnix(gateway, 'POST', configPath, {}, sign('session_update', { sessionId }));
    expect(discovered).toMatchObject({ status: 200, json: { approvalMode: 'off' } });
    const webChange = await httpUnix(
      gateway,
      'POST',
      configPath,
      {
        clientRequestId: 'web-unattended',
        expectedRevision: String(discovered.json['configRevision']),
        admission: 'idle',
        approvalMode: 'unattended',
      },
      sign('session_update', { sessionId }),
    );
    expect(webChange.status).not.toBe(200);
    const asked = permissions.length;
    await second.context.request(acp.methods.agent.session.prompt, {
      sessionId,
      prompt: [{ type: 'text', text: 'Call fixture MCP after takeover' }],
    });
    expect(permissions.length).toBe(asked + 1);

    // Another client closes it under the ACP client: a configuration write reopens it with the
    // ACP surface (Ask, sandbox), never the saved 'always' or the saved sandbox preference.
    await observer.host.closeSession!(LOCAL_PRINCIPAL, sessionId);
    const rewritten = await second.context.request(acp.methods.agent.session.setConfigOption, {
      sessionId,
      configId: 'thinking_level',
      value: 'low',
    });
    expect(option(rewritten, 'approval_mode')).toMatchObject({ currentValue: 'ask' });
    const reopened = (await observer.host.readSettings({ view: 'tui', sessionId })) as {
      settings: { entries: Record<string, { value: unknown }> };
    };
    expect(reopened.settings.entries['shell.autoApproveMode']?.value).toBe('off');
    expect(reopened.settings.entries['sandbox.enabled']?.value).toBe(true);
    second.child.stdin.end();
    await expect(second.exited).resolves.toEqual({ code: 0, signal: null });
    expect(savedSettings()).toBe(preferences);
  }, 120_000);
});
