import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
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
  releaseCatalog(): void;
  releaseReply(): void;
  savedSettings(): Promise<string>;
};

async function fixture(
  body: (fixture: Fixture) => Promise<void>,
  options: {
    capabilities?: acp.InitializeRequest['clientCapabilities'];
    elicitation?: (params: acp.CreateElicitationRequest) => Promise<acp.CreateElicitationResponse>;
    question?: boolean;
    signal?: 'SIGINT' | 'SIGTERM';
    holdCatalog?: boolean;
    holdReply?: boolean;
    providerFailure?: { status: number; message: string };
    shell?: boolean;
    shellCalls?: readonly ({ command: string; sandbox?: 'unsandboxed'; background?: boolean } | undefined)[];
    approvalReviews?: readonly ('low' | 'high')[];
    beforeApprovalReview?: () => Promise<void>;
    runCode?: string;
    permission?: (params: acp.RequestPermissionRequest) => Promise<acp.RequestPermissionResponse>;
  } = {},
): Promise<void> {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'term2-acp-direct-'));
  const workspace = path.join(temp, 'workspace');
  await mkdir(workspace);
  const requests: any[] = [];
  let inferenceCount = 0;
  let reviewCount = 0;
  let releaseCatalog!: () => void;
  const catalogReady = new Promise<void>((resolve) => {
    releaseCatalog = resolve;
  });
  if (!options.holdCatalog) releaseCatalog();
  let releaseReply!: () => void;
  const replyReady = new Promise<void>((resolve) => {
    releaseReply = resolve;
  });
  if (!options.holdReply) releaseReply();
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET') {
      await catalogReady;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'acp-model' }, { id: 'vendor/second-model' }] }));
      return;
    }
    let raw = '';
    req.on('data', (chunk) => (raw += String(chunk)));
    req.on('end', async () => {
      const request = JSON.parse(raw);
      requests.push(request);
      await replyReady;
      if (options.providerFailure && requests.length === 1) {
        const { status, message } = options.providerFailure;
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message } }));
        return;
      }
      const reviewing = options.approvalReviews !== undefined && !request.tools?.length;
      if (reviewing) await options.beforeApprovalReview?.();
      const index = reviewing ? -1 : inferenceCount++;
      const shellInput =
        options.shellCalls?.[index] ??
        (options.shell && index === 0 ? { command: 'printf acp-tool-visible' } : undefined);
      const call = options.runCode ? index % 2 === 0 : shellInput !== undefined;
      const delta = call
        ? {
            tool_calls: [
              {
                index: 0,
                id: `shell-call-${requests.length}`,
                type: 'function',
                function: {
                  name: options.runCode ? 'run_code' : 'shell',
                  arguments: JSON.stringify(
                    options.runCode ? { code: options.runCode, description: 'Call fixture MCP' } : shellInput,
                  ),
                },
              },
            ],
          }
        : {
            content: reviewing
              ? JSON.stringify({
                  results: [
                    {
                      reasoning: 'Deterministic approval review',
                      riskLevel: options.approvalReviews?.[reviewCount++],
                      authorization: 'explicit',
                      confidence: 'high',
                    },
                  ],
                })
              : 'ACP fixture reply',
          };
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
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as import('node:net').AddressInfo;
  const home = path.join(temp, 'home');
  const state = path.join(temp, 'state');
  const scratch = path.join(temp, 'scratch');
  if (options.shellCalls) await mkdir(scratch);
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
    [integrationCliPath(), 'acp', ...(options.holdCatalog ? [] : ['--provider', 'acpfixture', '--model', 'acp-model'])],
    {
      cwd: root,
      env: createTestChildEnv({
        HOME: home,
        XDG_STATE_HOME: state,
        TERM2_CONVERSATIONS_DIR: path.join(temp, 'sessions'),
        TERM2_CACHE_DIR: path.join(temp, 'cache'),
        DISABLE_LOGGING: '1',
        ...(options.shellCalls ? { TMPDIR: scratch, TMP: scratch, TEMP: scratch } : {}),
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
  if (options.permission)
    app = app.onRequest(acp.methods.client.session.requestPermission, ({ params }) => options.permission!(params));
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
    await body({
      context: connection.agent,
      workspace,
      updates,
      requests,
      releaseCatalog,
      releaseReply,
      savedSettings: () => readFile(path.join(settingsDir, 'settings.json'), 'utf8'),
    });
    if (options.signal) child.kill(options.signal);
    else child.stdin.end();
    await expect(exited).resolves.toEqual({ code: 0, signal: null });
    for (const line of stdout.trim().split('\n')) expect(JSON.parse(line)).toMatchObject({ jsonrpc: '2.0' });
    expect(stderr).not.toContain('detach failed');
  } finally {
    releaseCatalog();
    releaseReply();
    connection.close();
    child.kill('SIGKILL');
    await exited;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(temp, { recursive: true, force: true });
  }
}

describe('ACP v1 built CLI compatibility for Air', () => {
  it('returns a safe provider failure message on session/prompt and can run the next prompt', async () => {
    await fixture(
      async ({ context, workspace, updates }) => {
        const { sessionId } = await context.request(acp.methods.agent.session.new, { cwd: workspace, mcpServers: [] });
        const prompt = () =>
          context.request(acp.methods.agent.session.prompt, {
            sessionId,
            prompt: [{ type: 'text', text: 'Send the scripted request' }],
          });
        const failure = await prompt().catch((error: unknown) => error);
        expect(failure).toMatchObject({
          code: -32603,
          message: 'The model provider rejected the request due to insufficient balance. Check your provider billing.',
          data: { kind: 'insufficient_balance', retryable: false },
        });
        expect(JSON.stringify(updates)).not.toContain('opaque-fixture-secret');
        await expect(prompt()).resolves.toEqual({ stopReason: 'end_turn' });
      },
      { providerFailure: { status: 402, message: 'Insufficient balance. Request data: opaque-fixture-secret' } },
    );
  });

  it('initializes without IDE auth, streams once, completes prompts and replays each load', async () => {
    await fixture(async ({ context, workspace, updates, requests }) => {
      const { sessionId } = await context.request(acp.methods.agent.session.new, { cwd: workspace, mcpServers: [] });
      expect(updates.every(({ update }) => update.sessionUpdate === 'config_option_update')).toBe(true);
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
      expect(updates.filter(({ update }) => update.sessionUpdate === 'user_message_chunk')).toEqual([]);
      expect(requests).toHaveLength(1);
      // Identical text is a distinct accepted message, never a deduplication key.
      updates.length = 0;
      await context.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: 'text', text: 'Hello Air' }],
      });
      expect(text()).toBe('ACP fixture reply');
      expect(updates.filter(({ update }) => update.sessionUpdate === 'user_message_chunk')).toEqual([]);
      const list = await context.request(acp.methods.agent.session.list, { cwd: workspace });
      expect(list.sessions.find((session) => session.sessionId === sessionId)).toMatchObject({
        title: 'Hello Air',
        updatedAt: expect.any(String),
      });
      for (let index = 0; index < 2; index++) {
        updates.length = 0;
        await context.request(acp.methods.agent.session.load, { sessionId, cwd: workspace, mcpServers: [] });
        expect(text()).toBe('ACP fixture replyACP fixture reply');
        const users = updates.flatMap(({ update }) => (update.sessionUpdate === 'user_message_chunk' ? [update] : []));
        expect(users.map((update) => update.content)).toEqual([
          { type: 'text', text: 'Hello Air' },
          { type: 'text', text: 'Hello Air' },
        ]);
        expect(new Set(users.map((update) => update.messageId)).size).toBe(2);
      }
      updates.length = 0;
      await context.request(acp.methods.agent.session.resume, { sessionId, cwd: workspace, mcpServers: [] });
      expect(updates.every(({ update }) => update.sessionUpdate === 'config_option_update')).toBe(true);
      await context.request(acp.methods.agent.session.close, { sessionId });
    });
  }, 30_000);

  it('reports the shell invocation and result in live and loaded tool updates', async () => {
    await fixture(
      async ({ context, workspace, updates }) => {
        const { sessionId } = await context.request(acp.methods.agent.session.new, { cwd: workspace, mcpServers: [] });
        await context.request(acp.methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: 'text', text: 'Run the fixture command' }],
        });
        const checkTools = () => {
          const tools = updates.flatMap(({ update }) =>
            update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update' ? [update] : [],
          );
          const created = tools.filter((tool) => tool.sessionUpdate === 'tool_call');
          expect(created).toHaveLength(1);
          expect(created[0]).toMatchObject({
            title: 'printf acp-tool-visible',
            name: 'shell',
            kind: 'execute',
            rawInput: { command: 'printf acp-tool-visible' },
          });
          expect(tools.at(-1)).toMatchObject({ toolCallId: created[0]!.toolCallId, status: 'completed' });
          expect(JSON.stringify(tools.at(-1)?.content)).toContain('acp-tool-visible');
        };
        checkTools();
        updates.length = 0;
        await context.request(acp.methods.agent.session.load, { sessionId, cwd: workspace, mcpServers: [] });
        checkTools();
      },
      { shell: true },
    );
  }, 30_000);

  for (const channel of ['terminal_output_delta', 'terminal_output'] as const) {
    it(`delivers command output once through ${channel}, including replay`, async () => {
      await fixture(
        async ({ context, workspace, updates }) => {
          const { sessionId } = await context.request(acp.methods.agent.session.new, {
            cwd: workspace,
            mcpServers: [],
          });
          await context.request(acp.methods.agent.session.prompt, {
            sessionId,
            prompt: [{ type: 'text', text: 'Run command' }],
          });
          const check = () => {
            const tools = updates.flatMap(({ update }) =>
              update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update' ? [update] : [],
            );
            const output = tools
              .flatMap((tool) => (tool._meta?.[channel] ? [tool._meta[channel] as { data: string }] : []))
              .map((part) => part.data)
              .join('');
            expect(output.match(/acp-tool-visible/g)).toHaveLength(1);
            expect(tools[0]?.content).toEqual([{ type: 'terminal', terminalId: tools[0]?.toolCallId }]);
            expect(tools[0]?._meta?.terminal_info).toEqual({ cwd: workspace, terminal_id: tools[0]?.toolCallId });
            expect(tools.at(-1)).toMatchObject({
              status: 'completed',
              _meta: { terminal_exit: { exit_code: null, signal: null } },
            });
            expect(tools.filter((tool) => tool._meta?.terminal_exit)).toHaveLength(1);
            expect(
              tools.every(
                (tool) => !tool._meta?.[channel === 'terminal_output' ? 'terminal_output_delta' : 'terminal_output'],
              ),
            ).toBe(true);
          };
          check();
          updates.length = 0;
          await context.request(acp.methods.agent.session.load, { sessionId, cwd: workspace, mcpServers: [] });
          check();
        },
        { shell: true, capabilities: { _meta: { [channel]: true } } },
      );
    }, 30_000);
  }

  it('accepts schema-valid embedded binary resources without dropping their context', async () => {
    await fixture(async ({ context, workspace, requests }) => {
      const { sessionId } = await context.request(acp.methods.agent.session.new, { cwd: workspace, mcpServers: [] });
      await context.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [
          {
            type: 'resource',
            resource: { uri: 'file:///context.bin', mimeType: 'application/octet-stream', blob: 'AQID' },
          },
        ],
      });
      expect(JSON.stringify(requests[0].messages)).toContain('file:///context.bin');
      expect(JSON.stringify(requests[0].messages)).toContain('AQID');
      await expect(
        context.request(acp.methods.agent.session.prompt, {
          sessionId: 'missing-session',
          prompt: [{ type: 'text', text: 'x' }],
        }),
      ).rejects.toMatchObject({ code: -32002 });
    });
  }, 30_000);

  it('connects client MCP stdio in the session cwd, uses native approval, and reconnects after close', async () => {
    await fixture(
      async ({ context, workspace, requests, savedSettings }) => {
        const preferences = await savedSettings();
        const script = path.join(workspace, 'mcp.mjs');
        await writeFile(
          script,
          `import readline from 'node:readline';
        const reply = (id, result) => process.stdout.write(JSON.stringify({jsonrpc:'2.0', id, result})+'\\n');
        readline.createInterface({input:process.stdin}).on('line', line => {
          const m = JSON.parse(line); if (m.id === undefined) return;
          if(m.method === 'initialize') reply(m.id, {protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}});
          else if(m.method === 'tools/list') reply(m.id, {tools:[{name:'echo', description:'Echo session context',inputSchema:{type:'object',properties:{}}}]});
          else if(m.method === 'tools/call') reply(m.id, {content:[{type:'text',text:JSON.stringify({cwd:process.cwd(),token:process.env.MCP_SENTINEL})}]});
          else reply(m.id, {});
        });`,
        );
        const mcpServers: acp.McpServer[] = [
          {
            name: 'airfixture',
            command: process.execPath,
            args: [script],
            env: [{ name: 'MCP_SENTINEL', value: 'session-mcp-visible' }],
          },
          {
            name: 'offline-fixture',
            command: process.execPath,
            args: ['-e', 'process.exit(1)'],
            env: [],
          },
        ];
        const { sessionId } = await context.request(acp.methods.agent.session.new, { cwd: workspace, mcpServers });
        await context.request(acp.methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: 'text', text: 'Call fixture MCP' }],
        });
        expect(JSON.stringify(requests)).toContain('session-mcp-visible');
        expect(JSON.stringify(requests)).toContain(workspace);
        await expect(
          context.request(acp.methods.agent.session.load, {
            sessionId,
            cwd: workspace,
            mcpServers: [{ name: 'broken', command: process.execPath, args: ['/no-such-acp-fixture.mjs'], env: [] }],
          }),
        ).rejects.toMatchObject({ code: -32010 });
        await context.request(acp.methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: 'text', text: 'Old MCP still works after failed replacement' }],
        });
        expect(
          JSON.stringify(
            requests
              .at(-1)
              .messages.filter((message: any) => message.role === 'tool')
              .at(-1),
          ),
        ).toContain('session-mcp-visible');
        await context.request(acp.methods.agent.session.close, { sessionId });
        await context.request(acp.methods.agent.session.load, { sessionId, cwd: workspace, mcpServers });
        await context.request(acp.methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: 'text', text: 'MCP after reopen' }],
        });
        expect(
          JSON.stringify(
            requests
              .at(-1)
              .messages.filter((message: any) => message.role === 'tool')
              .at(-1),
          ),
        ).toContain('session-mcp-visible');
        const other = await context.request(acp.methods.agent.session.new, {
          cwd: workspace,
          mcpServers: [{ ...mcpServers[0]!, env: [{ name: 'MCP_SENTINEL', value: 'sibling-mcp-visible' }] }],
        });
        await context.request(acp.methods.agent.session.prompt, {
          sessionId: other.sessionId,
          prompt: [{ type: 'text', text: 'Sibling MCP' }],
        });
        expect(JSON.stringify(requests.at(-1).messages)).toContain('sibling-mcp-visible');
        expect(JSON.stringify(requests.at(-1).messages)).not.toContain('session-mcp-visible');
        const empty = await context.request(acp.methods.agent.session.new, { cwd: workspace, mcpServers: [] });
        const offset = requests.length;
        await context.request(acp.methods.agent.session.prompt, {
          sessionId: empty.sessionId,
          prompt: [{ type: 'text', text: 'No MCP' }],
        });
        expect(JSON.stringify(requests[offset].tools)).not.toContain('airfixture__echo');
        expect(await savedSettings()).toBe(preferences);
      },
      {
        runCode: 'return await tools.airfixture__echo({});',
        permission: async (params) => ({
          outcome: {
            outcome: 'selected',
            optionId: params.options.find((option) => option.kind === 'allow_once')!.optionId,
          },
        }),
      },
    );
  }, 45_000);

  for (const transport of ['http', 'sse'] as const) {
    it(`uses forwarded MCP ${transport} with supplied headers and native approvals`, async () => {
      let stream: http.ServerResponse | undefined;
      let initialized = 0;
      let called = 0;
      const headers: string[] = [];
      const server = http.createServer(async (req, res) => {
        headers.push(String(req.headers['x-acp-fixture']));
        if (req.url === '/offline') {
          res.writeHead(500);
          res.end('private-startup-error-sentinel');
          return;
        }
        if (req.method === 'GET' && transport === 'sse') {
          stream = res;
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
          res.write('event: endpoint\ndata: /messages\n\n');
          return;
        }
        if (req.method !== 'POST') {
          res.writeHead(req.method === 'DELETE' ? 200 : 405);
          res.end();
          return;
        }
        let raw = '';
        for await (const chunk of req) raw += String(chunk);
        const message = JSON.parse(raw);
        if (message.id === undefined) {
          res.writeHead(202);
          res.end();
          return;
        }
        let result: unknown = {};
        if (message.method === 'initialize') {
          initialized++;
          result = {
            protocolVersion: message.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'network-fixture', version: '1' },
          };
        } else if (message.method === 'tools/list')
          result = { tools: [{ name: 'echo', inputSchema: { type: 'object', properties: {} } }] };
        else if (message.method === 'tools/call') {
          called++;
          result = { content: [{ type: 'text', text: 'network-mcp-visible' }] };
        }
        const response = JSON.stringify({ jsonrpc: '2.0', id: message.id, result });
        if (transport === 'sse') {
          stream!.write(`event: message\ndata: ${response}\n\n`);
          res.writeHead(202);
          res.end();
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(response);
        }
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address() as import('node:net').AddressInfo;
      try {
        await fixture(
          async ({ context, workspace, requests }) => {
            const mcpServers: acp.McpServer[] = [
              {
                name: 'airfixture',
                type: transport,
                url: `http://127.0.0.1:${address.port}/mcp`,
                headers: [{ name: 'x-acp-fixture', value: 'header-visible' }],
              },
              {
                name: 'offline-http',
                type: 'http',
                url: `http://127.0.0.1:${address.port}/offline`,
                headers: [{ name: 'x-acp-fixture', value: 'header-visible' }],
              },
            ];
            const { sessionId } = await context.request(acp.methods.agent.session.new, { cwd: workspace, mcpServers });
            await context.request(acp.methods.agent.session.prompt, {
              sessionId,
              prompt: [{ type: 'text', text: 'Call network MCP' }],
            });
            expect(JSON.stringify(requests.at(-1).messages)).toContain('network-mcp-visible');
            expect(called).toBe(1);
            expect(JSON.stringify(requests[0].tools)).toContain('offline-http: failed, 0 tools');
            expect(JSON.stringify(requests)).not.toContain('private-startup-error-sentinel');
            await context.request(acp.methods.agent.session.close, { sessionId });
            await context.request(acp.methods.agent.session.resume, { sessionId, cwd: workspace, mcpServers });
            expect(initialized).toBe(2);
            await context.request(acp.methods.agent.session.close, { sessionId });
          },
          {
            runCode: 'return await tools.airfixture__echo({});',
            permission: async (params) => ({
              outcome: {
                outcome: 'selected',
                optionId: params.options.find((option) => option.kind === 'allow_once')!.optionId,
              },
            }),
          },
        );
        expect(headers.every((value) => value === 'header-visible')).toBe(true);
      } finally {
        stream?.end();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }, 45_000);
  }

  it.each(['http', 'sse'] as const)(
    'does not forward MCP %s headers through a redirect',
    async (transport) => {
      let reachedTarget = false;
      const target = http.createServer((_req, res) => {
        reachedTarget = true;
        res.end();
      });
      await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
      const address = target.address() as import('node:net').AddressInfo;
      const redirect = http.createServer((_req, res) => {
        res.writeHead(307, { location: `http://127.0.0.1:${address.port}/other` });
        res.end();
      });
      await new Promise<void>((resolve) => redirect.listen(0, '127.0.0.1', resolve));
      const origin = redirect.address() as import('node:net').AddressInfo;
      try {
        await fixture(async ({ context, workspace }) => {
          const { sessionId } = await context.request(acp.methods.agent.session.new, {
            cwd: workspace,
            mcpServers: [
              {
                name: 'redirect',
                type: transport,
                url: `http://127.0.0.1:${origin.port}/mcp`,
                headers: [{ name: 'x-fixture-token', value: 'must-not-leak' }],
              },
            ],
          });
          await expect(
            context.request(acp.methods.agent.session.prompt, {
              sessionId,
              prompt: [{ type: 'text', text: 'Continue without the unavailable server' }],
            }),
          ).resolves.toMatchObject({ stopReason: 'end_turn' });
          expect(reachedTarget).toBe(false);
        });
      } finally {
        redirect.closeAllConnections();
        target.closeAllConnections();
        await Promise.all([
          new Promise<void>((resolve) => redirect.close(() => resolve())),
          new Promise<void>((resolve) => target.close(() => resolve())),
        ]);
      }
    },
    30_000,
  );

  it('shows a cold-cache selector before discovery finishes and applies/persists the selected inference model', async () => {
    await fixture(
      async ({ context, workspace, updates, requests, releaseCatalog, releaseReply, savedSettings }) => {
        const created = await context.request(acp.methods.agent.session.new, { cwd: workspace, mcpServers: [] });
        const preferences = await savedSettings();
        expect(created.configOptions).toMatchObject([
          {
            id: 'model',
            type: 'select',
            category: 'model',
            currentValue: 'acpfixture/acp-model',
            options: [{ value: 'acpfixture/acp-model' }],
          },
          { id: 'thinking_level', type: 'select', category: 'thought_level', currentValue: 'default' },
          { id: 'approval_mode', type: 'select', category: 'mode', currentValue: 'ask' },
        ]);
        releaseCatalog();
        await vi.waitFor(() =>
          expect(
            updates.some(
              ({ update }) =>
                update.sessionUpdate === 'config_option_update' &&
                JSON.stringify(update.configOptions).includes('vendor/second-model'),
            ),
          ).toBe(true),
        );
        const sessionId = created.sessionId;
        await expect(
          context.request(acp.methods.agent.session.setConfigOption, {
            sessionId,
            configId: 'model',
            value: 'unconfigured/arbitrary',
          }),
        ).rejects.toMatchObject({ code: -32602 });
        await expect(
          context.request(acp.methods.agent.session.setConfigOption, {
            sessionId,
            configId: 'unknown',
            value: 'acpfixture/acp-model',
          }),
        ).rejects.toMatchObject({ code: -32602 });
        const changed = await context.request(acp.methods.agent.session.setConfigOption, {
          sessionId,
          configId: 'model',
          value: 'acpfixture/vendor/second-model',
        });
        expect(changed.configOptions[0]).toMatchObject({ currentValue: 'acpfixture/vendor/second-model' });
        const prompting = context.request(acp.methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: 'text', text: 'Use the selected model' }],
        });
        await vi.waitFor(() => expect(requests).toHaveLength(1));
        await expect(
          context.request(acp.methods.agent.session.setConfigOption, {
            sessionId,
            configId: 'model',
            value: 'acpfixture/acp-model',
          }),
        ).rejects.toMatchObject({ code: -32010 });
        releaseReply();
        await prompting;
        expect(requests.at(-1).model).toBe('vendor/second-model');
        expect(await savedSettings()).toBe(preferences);
        const other = await context.request(acp.methods.agent.session.new, { cwd: workspace, mcpServers: [] });
        expect(other.configOptions?.[0]).toMatchObject({ currentValue: 'acpfixture/acp-model' });
        await context.request(acp.methods.agent.session.close, { sessionId });
        const loaded = await context.request(acp.methods.agent.session.load, {
          sessionId,
          cwd: workspace,
          mcpServers: [],
        });
        expect(loaded.configOptions?.[0]).toMatchObject({ currentValue: 'acpfixture/vendor/second-model' });
        const resumed = await context.request(acp.methods.agent.session.resume, {
          sessionId,
          cwd: workspace,
          mcpServers: [],
        });
        expect(resumed.configOptions?.[0]).toMatchObject({ currentValue: 'acpfixture/vendor/second-model' });
        await context.request(acp.methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: 'text', text: 'Still selected after resume' }],
        });
        expect(requests.at(-1).model).toBe('vendor/second-model');
      },
      { holdCatalog: true, holdReply: true },
    );
  }, 30_000);

  it('applies thinking levels to inference, retains session selection and restores Default', async () => {
    await fixture(async ({ context, workspace, requests, savedSettings }) => {
      const { sessionId, configOptions } = await context.request(acp.methods.agent.session.new, {
        cwd: workspace,
        mcpServers: [],
      });
      const thinking = (options: acp.SessionConfigOption[] | null | undefined) =>
        options?.find((option) => option.id === 'thinking_level');
      const preferences = await savedSettings();
      expect(thinking(configOptions)).toMatchObject({ category: 'thought_level', currentValue: 'default' });
      for (const value of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']) {
        const changed = await context.request(acp.methods.agent.session.setConfigOption, {
          sessionId,
          configId: 'thinking_level',
          value,
        });
        expect(thinking(changed.configOptions)).toMatchObject({ currentValue: value });
        await context.request(acp.methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: 'text', text: `Use ${value} thinking` }],
        });
        expect(requests.at(-1).reasoning_effort).toBe(value);
      }
      for (const value of ['maximum', true]) {
        await expect(
          context.request(acp.methods.agent.session.setConfigOption, {
            sessionId,
            configId: 'thinking_level',
            value,
          } as acp.SetSessionConfigOptionRequest),
        ).rejects.toMatchObject({ code: -32602 });
      }
      const loaded = await context.request(acp.methods.agent.session.load, {
        sessionId,
        cwd: workspace,
        mcpServers: [],
      });
      expect(thinking(loaded.configOptions)).toMatchObject({ currentValue: 'xhigh' });
      const modelChanged = await context.request(acp.methods.agent.session.setConfigOption, {
        sessionId,
        configId: 'model',
        value: 'acpfixture/vendor/second-model',
      });
      expect(thinking(modelChanged.configOptions)).toMatchObject({ currentValue: 'xhigh' });
      const other = await context.request(acp.methods.agent.session.new, { cwd: workspace, mcpServers: [] });
      expect(thinking(other.configOptions)).toMatchObject({ currentValue: 'default' });
      const restored = await context.request(acp.methods.agent.session.setConfigOption, {
        sessionId,
        configId: 'thinking_level',
        value: 'default',
      });
      expect(thinking(restored.configOptions)).toMatchObject({ currentValue: 'default' });
      await context.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: [{ type: 'text', text: 'Use provider default' }],
      });
      expect(requests.at(-1)).not.toHaveProperty('reasoning_effort');
      expect(await savedSettings()).toBe(preferences);
    });
  }, 30_000);

  it('changes the live approval and sandbox policy together through one ACP selector', async () => {
    const permissions: acp.RequestPermissionRequest[] = [];
    const command = 'echo mode-test >> ../approval-mode.txt';
    const configId = 'approval_mode';
    await fixture(
      async ({ context, workspace, requests, savedSettings }) => {
        const setup: acp.NewSessionRequest = { cwd: workspace, mcpServers: [] };
        const created = await context.request(acp.methods.agent.session.new, setup);
        const { sessionId } = created;
        const mode = (response: { configOptions?: acp.SessionConfigOption[] | null }) =>
          response.configOptions?.find(({ id }) => id === configId);
        const setMode = (value: string) =>
          context.request(acp.methods.agent.session.setConfigOption, { sessionId, configId, value });
        const prompt = (id: string) =>
          context.request(acp.methods.agent.session.prompt, {
            sessionId: id,
            prompt: [{ type: 'text', text: 'Append mode-test to the scratch file beside the workspace.' }],
          });
        const outside = path.resolve(workspace, '..', 'approval-mode.txt');
        const expectConfined = () => expect(readFile(outside, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        const reviews = () => requests.filter((request) => !request.tools?.length);
        const original = await savedSettings();
        expect(mode(created)).toMatchObject({
          category: 'mode',
          currentValue: 'ask',
          options: [
            { value: 'ask', name: 'Ask' },
            { value: 'assisted', name: 'Assisted' },
            { value: 'always', name: 'Always · Sandbox off' },
          ],
        });
        await expect(setMode('invalid')).rejects.toMatchObject({ code: -32602 });
        await prompt(sessionId);
        await expectConfined();
        expect(permissions).toHaveLength(0);
        expect(reviews()).toHaveLength(0);

        expect(mode(await setMode('assisted'))).toMatchObject({ currentValue: 'assisted' });
        await prompt(sessionId);
        expect(await readFile(path.join(workspace, 'assisted.txt'), 'utf8')).toBe('mode-test\n');
        await expectConfined();
        expect(reviews()).toHaveLength(1);
        expect(permissions).toHaveLength(0);
        await prompt(sessionId);
        await expectConfined();
        expect(reviews()).toHaveLength(2);
        expect(permissions).toHaveLength(1);

        expect(mode(await setMode('always'))).toMatchObject({ currentValue: 'always' });
        const sibling = await context.request(acp.methods.agent.session.new, setup);
        expect(mode(sibling)).toMatchObject({ currentValue: 'ask' });
        await prompt(sibling.sessionId);
        await expectConfined();
        await prompt(sessionId);
        expect(await readFile(outside, 'utf8')).toBe('mode-test\n');
        expect(permissions).toHaveLength(1);
        expect(reviews()).toHaveLength(2);

        expect(mode(await setMode('ask'))).toMatchObject({ currentValue: 'ask' });
        await prompt(sessionId);
        expect(await readFile(outside, 'utf8')).toBe('mode-test\n');
        expect(mode(await setMode('always'))).toMatchObject({ currentValue: 'always' });
        await context.request(acp.methods.agent.session.close, { sessionId });
        const loaded = await context.request(acp.methods.agent.session.load, { sessionId, ...setup });
        expect(loaded.configOptions?.find(({ id }) => id === configId)).toMatchObject({ currentValue: 'ask' });
        expect(await savedSettings()).toBe(original);
      },
      {
        approvalReviews: ['low', 'high'],
        shellCalls: [
          { command },
          undefined,
          { command: 'echo mode-test | tee assisted.txt' },
          undefined,
          { command },
          undefined,
          { command },
          undefined,
          { command },
          undefined,
          { command },
        ],
        async permission(params) {
          permissions.push(params);
          return { outcome: { outcome: 'selected', optionId: 'reject' } };
        },
      },
    );
  }, 45_000);

  it('cancels an in-flight Assisted review without requesting client permission', async () => {
    let releaseReview!: () => void;
    const review = new Promise<void>((resolve) => {
      releaseReview = resolve;
    });
    const permission = vi.fn(
      async (): Promise<acp.RequestPermissionResponse> => ({
        outcome: { outcome: 'selected', optionId: 'approve' },
      }),
    );
    try {
      await fixture(
        async ({ context, workspace, requests }) => {
          const { sessionId } = await context.request(acp.methods.agent.session.new, {
            cwd: workspace,
            mcpServers: [],
          });
          await context.request(acp.methods.agent.session.setConfigOption, {
            sessionId,
            configId: 'approval_mode',
            value: 'assisted',
          });
          const prompt = () =>
            context.request(acp.methods.agent.session.prompt, {
              sessionId,
              prompt: [{ type: 'text', text: 'Run the scripted command.' }],
            });
          const pending = prompt();
          await vi.waitFor(() => expect(requests.some((request) => !request.tools?.length)).toBe(true));
          await context.notify(acp.methods.agent.session.cancel, { sessionId });
          await expect(pending).resolves.toEqual({ stopReason: 'cancelled' });
          releaseReview();
          await expect(prompt()).resolves.toEqual({ stopReason: 'end_turn' });
          expect(permission).not.toHaveBeenCalled();
          await expect(readFile(path.join(workspace, 'cancelled.txt'), 'utf8')).rejects.toMatchObject({
            code: 'ENOENT',
          });
        },
        {
          shellCalls: [{ command: 'echo cancelled | tee cancelled.txt' }],
          approvalReviews: ['low'],
          beforeApprovalReview: () => review,
          permission,
        },
      );
    } finally {
      releaseReview();
    }
  }, 30_000);

  it.each(['unsandboxed-once', 'approve'])(
    'runs sandboxed shell without prompts and requires a distinct grant to retry outside (%s)',
    async (selection) => {
      const permissions: acp.RequestPermissionRequest[] = [];
      const command = 'echo escaped >> ../escaped.txt';
      await fixture(
        async ({ context, workspace, updates, requests }) => {
          const { sessionId } = await context.request(acp.methods.agent.session.new, {
            cwd: workspace,
            mcpServers: [],
          });
          await context.request(acp.methods.agent.session.prompt, {
            sessionId,
            prompt: [{ type: 'text', text: 'Run the workspace check and the requested outside write.' }],
          });
          expect(permissions).toHaveLength(2);
          expect(new Set(permissions.map(({ toolCall }) => toolCall.toolCallId)).size).toBe(2);
          for (const { toolCall, options } of permissions) {
            expect(toolCall.title).toContain(`Run outside sandbox once in ${workspace}: ${command}`);
            expect(toolCall.rawInput).toMatchObject({ command, sandbox: 'unsandboxed' });
            expect(options.map(({ optionId, kind }) => [optionId, kind])).toEqual([
              ['unsandboxed-once', 'allow_once'],
              ['reject', 'reject_once'],
            ]);
          }
          expect(JSON.stringify(requests[2].messages.at(-1))).toMatch(
            /sandbox|operation not permitted|permission denied|read-only file system/i,
          );
          expect(JSON.stringify(requests.at(-1).messages.at(-1))).toContain('require a foreground shell');
          const inside = path.join(workspace, 'inside.txt');
          const contents = await readFile(inside, 'utf8').catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT' || process.env.TERM2_ACP_REQUIRE_SHELL_SUCCESS === '1') throw error;
            return null;
          });
          if (contents === null) expect(JSON.stringify(updates)).toMatch(/sandbox|bwrap/i);
          else expect(contents).toBe('inside\n');
          const outside = path.join(workspace, '..', 'escaped.txt');
          if (selection === 'unsandboxed-once') await expect(readFile(outside, 'utf8')).resolves.toBe('escaped\n');
          else await expect(readFile(outside, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        },
        {
          shellCalls: [
            { command: 'echo inside | tee inside.txt' },
            { command },
            { command, sandbox: 'unsandboxed' },
            { command, sandbox: 'unsandboxed' },
            { command, sandbox: 'unsandboxed', background: true },
          ],
          async permission(params) {
            permissions.push(params);
            return { outcome: { outcome: 'selected', optionId: permissions.length === 1 ? selection : 'reject' } };
          },
        },
      );
    },
    30_000,
  );

  it('rejects unsupported workspace/MCP inputs before admission and exits cleanly on SIGTERM', async () => {
    await fixture(
      async ({ context, workspace, requests }) => {
        await expect(
          context.request(acp.methods.agent.session.new, { cwd: 'relative', mcpServers: [] }),
        ).rejects.toMatchObject({ code: -32602 });
        await expect(
          context.request(acp.methods.agent.session.new, {
            cwd: workspace,
            mcpServers: [{ name: 'blocked', command: '', args: [], env: [] }],
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
