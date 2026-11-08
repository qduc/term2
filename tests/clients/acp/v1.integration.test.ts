import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as acp from '@agentclientprotocol/sdk';
import { resolveSettingsDirectory } from '../../../src/config/settings/settings-path.js';
import { createTestChildEnv } from '../../helpers/terminal-e2e.js';

const root = fileURLToPath(new URL('../../..', import.meta.url));
// This suite deliberately exercises the direct executable, never the legacy gateway.
import { integrationCliPath } from '../../helpers/integration-cli.js';

type Fixture = {
  context: acp.ClientContext;
  workspace: string;
  updates: acp.SessionNotification[];
  requests: any[];
};

async function fixture(
  body: (fixture: Fixture) => Promise<void>,
  options: {
    capabilities?: acp.InitializeRequest['clientCapabilities'];
    elicitation?: (params: acp.CreateElicitationRequest) => Promise<acp.CreateElicitationResponse>;
    question?: boolean;
    signal?: 'SIGINT' | 'SIGTERM';
  } = {},
): Promise<void> {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'term2-acp-direct-'));
  const workspace = path.join(temp, 'workspace');
  await mkdir(workspace);
  const requests: any[] = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'acp-model' }] }));
      return;
    }
    let raw = '';
    req.on('data', (chunk) => (raw += String(chunk)));
    req.on('end', () => {
      requests.push(JSON.parse(raw));
      const delta = { content: 'ACP fixture reply' };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        [
          `data: ${JSON.stringify({ id: 'reply', choices: [{ delta }] })}`,
          `data: ${JSON.stringify({
            id: 'reply',
            choices: [{ delta: {}, finish_reason: 'stop' }],
          })}`,
          'data: [DONE]',
        ].join('\n\n') + '\n\n',
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as import('node:net').AddressInfo;
  const home = path.join(temp, 'home');
  const state = path.join(temp, 'state');
  const settingsDir = resolveSettingsDirectory({ homeDir: home, env: { XDG_STATE_HOME: state } });
  await mkdir(settingsDir, { recursive: true });
  await writeFile(
    path.join(settingsDir, 'settings.json'),
    JSON.stringify({
      agent: { modelSelection: { provider: 'acpfixture', model: 'acp-model' }, retryAttempts: 0 },
      sandbox: { enabled: false },
      providers: [
        {
          name: 'acpfixture',
          type: 'openai-compatible',
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          apiKey: 'test',
        },
      ],
    }),
  );
  const child = spawn(
    process.execPath,
    [integrationCliPath(), 'acp', '--provider', 'acpfixture', '--model', 'acp-model'],
    {
      cwd: root,
      env: createTestChildEnv({
        HOME: home,
        XDG_STATE_HOME: state,
        TERM2_CONVERSATIONS_DIR: path.join(temp, 'sessions'),
        DISABLE_LOGGING: '1',
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  const exited = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  let stdout = '';
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += String(chunk)));
  const recorder = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      stdout += Buffer.from(chunk).toString('utf8');
      controller.enqueue(chunk);
    },
  });
  const updates: acp.SessionNotification[] = [];
  let app = acp
    .client({ name: 'term2-direct-integration' })
    .onNotification(acp.methods.client.session.update, ({ params }) => {
      updates.push(params);
    });
  if (options.elicitation)
    app = app.onRequest(acp.methods.client.elicitation.create, ({ params }) => options.elicitation!(params));
  const connection = app.connect(
    acp.ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      (Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>).pipeThrough(recorder),
    ),
  );
  try {
    const initialized = await connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientInfo: { name: 'term2-air-integration', version: '1' },
      ...(options.capabilities ? { clientCapabilities: options.capabilities } : {}),
    });
    expect(initialized).toMatchObject({
      protocolVersion: 1,
      authMethods: [],
      agentInfo: { name: 'term2' },
      agentCapabilities: { loadSession: true },
    });
    await body({ context: connection.agent, workspace, updates, requests });
    if (options.signal) child.kill(options.signal);
    else child.stdin.end();
    await expect(exited).resolves.toEqual({ code: 0, signal: null });
    for (const line of stdout.trim().split('\n')) expect(JSON.parse(line)).toMatchObject({ jsonrpc: '2.0' });
    expect(stderr).not.toContain('detach failed');
  } finally {
    connection.close();
    child.kill('SIGKILL');
    await exited;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(temp, { recursive: true, force: true });
  }
}

describe('ACP v1 built CLI compatibility for Air', () => {
  it('initializes without IDE auth, streams once, completes prompts and replays each load', async () => {
    await fixture(async ({ context, workspace, updates, requests }) => {
      const { sessionId } = await context.request(acp.methods.agent.session.new, { cwd: workspace, mcpServers: [] });
      expect(updates).toEqual([]); // v2 state_update must never leak to a v1 client.
      const result = await context.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: 'text', text: 'Hello Air' }],
      });
      expect(result).toEqual({ stopReason: 'end_turn' });
      const text = () =>
        updates
          .filter(({ update }) => update.sessionUpdate === 'agent_message_chunk')
          .map(({ update }) =>
            update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text' ? update.content.text : '',
          )
          .join('');
      expect(text()).toBe('ACP fixture reply');
      expect(requests).toHaveLength(1);
      const list = await context.request(acp.methods.agent.session.list, { cwd: workspace });
      expect(list.sessions.some((session) => session.sessionId === sessionId)).toBe(true);
      for (let index = 0; index < 2; index++) {
        updates.length = 0;
        await context.request(acp.methods.agent.session.load, { sessionId, cwd: workspace, mcpServers: [] });
        expect(text()).toBe('ACP fixture reply');
        expect(updates.some(({ update }) => update.sessionUpdate === 'user_message_chunk')).toBe(true);
      }
      updates.length = 0;
      await context.request(acp.methods.agent.session.resume, { sessionId, cwd: workspace, mcpServers: [] });
      expect(updates).toEqual([]);
      await context.request(acp.methods.agent.session.close, { sessionId });
    });
  }, 30_000);

  it('rejects unsupported workspace/MCP inputs before admission and exits cleanly on SIGTERM', async () => {
    await fixture(
      async ({ context, workspace, requests }) => {
        await expect(
          context.request(acp.methods.agent.session.new, { cwd: 'relative', mcpServers: [] }),
        ).rejects.toMatchObject({ code: -32602 });
        await expect(
          context.request(acp.methods.agent.session.new, {
            cwd: workspace,
            mcpServers: [{ name: 'blocked', command: 'false', args: [], env: [] }],
          }),
        ).rejects.toMatchObject({ code: -32602 });
        const { sessionId } = await context.request(acp.methods.agent.session.new, { cwd: workspace, mcpServers: [] });
        await expect(
          context.request(acp.methods.agent.session.prompt, { sessionId, prompt: [] }),
        ).rejects.toMatchObject({ code: -32602 });
        await expect(
          context.request(acp.methods.agent.session.load, { sessionId, cwd: path.dirname(workspace), mcpServers: [] }),
        ).rejects.toMatchObject({ code: -32602 });
        expect(requests).toEqual([]);
      },
      { signal: 'SIGTERM' },
    );
  }, 30_000);
});
