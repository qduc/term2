import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as acp from '@agentclientprotocol/sdk/experimental/v2';
import { resolveSettingsDirectory } from '../../../src/config/settings/settings-path.js';
import { createTestChildEnv } from '../../helpers/terminal-e2e.js';
import { createAcpAgent } from '../../../src/clients/acp/agent.js';
import { createAcpBackend } from '../../../src/clients/acp/session-backend.js';
import { createDirectInProcessHost } from '../../../src/host/in-process-direct.js';
import { createDirectSessionStore } from '../../../src/session/store.js';
import type { ItemId, Model, ToolCallId } from '../../../src/model/index.js';
import type { Tool } from '../../../src/tools/index.js';

const root = fileURLToPath(new URL('../../..', import.meta.url));
// This suite deliberately exercises the direct executable, never the legacy gateway.
import { integrationCliPath } from '../../helpers/integration-cli.js';

type Fixture = {
  context: acp.ClientContext;
  workspace: string;
  updates: acp.UpdateSessionNotification[];
  requests: any[];
};

// Questions are exercised through the native Session/Host contract. The current
// CLI's Bare tool surface does not offer ask_user; restoring a removed profile
// would test a different product. Only the external model and tool are fixtures.
async function nativeQuestionFixture(
  body: (fixture: Fixture) => Promise<void>,
  options: {
    capabilities?: acp.InitializeRequest['capabilities'];
    elicitation?: (params: acp.CreateElicitationRequest) => Promise<acp.CreateElicitationResponse>;
  },
): Promise<void> {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'term2-acp-native-'));
  const workspace = path.join(temp, 'workspace');
  await mkdir(workspace);
  const requests: any[] = [];
  const updates: acp.UpdateSessionNotification[] = [];
  const ref = { provider: 'fixture', model: 'question-model' };
  const tool: Tool = {
    spec: { name: 'ask_user', description: 'Fixture question', inputSchema: { type: 'object' } },
    parse: (input) => input,
    approval: () => ({ kind: 'none' }),
    async execute(input, context) {
      const decision = await context.interact!({
        kind: 'question',
        toolName: 'ask_user',
        input,
        summary: 'Choose a color',
      });
      return {
        output: decision.kind === 'answer' ? decision.answer : '',
        isError: false,
        ...(decision.stopAfterApprovalResolution ? { stopAfterExecution: true as const } : {}),
      };
    },
  };
  const model: Model = {
    ref,
    contextWindow: 100_000,
    async *stream(request) {
      requests.push(request);
      if (requests.length === 1) {
        yield { type: 'text_delta', delta: 'Before ' };
        yield {
          type: 'item',
          item: { type: 'assistant_message', id: 'before' as ItemId, content: [{ type: 'text', text: 'Before tool' }] },
        };
        yield {
          type: 'item',
          item: {
            type: 'tool_call',
            id: 'question-call' as ItemId,
            callId: 'question-call' as ToolCallId,
            toolName: 'ask_user',
            input: { questions: [{ question: 'Choose a color', options: [{ label: 'Blue' }, { label: 'Green' }] }] },
          },
        };
      } else {
        yield { type: 'text_delta', delta: 'Question ' };
        yield {
          type: 'item',
          item: {
            type: 'assistant_message',
            id: `answer-${requests.length}` as ItemId,
            content: [{ type: 'text', text: 'Question resolved' }],
          },
        };
      }
      yield { type: 'done', stopReason: 'end_turn' };
    },
  };
  const workspaceGrant = { root: workspace, access: 'read_write' as const, target: 'local' };
  const sessions = createDirectSessionStore({
    directory: path.join(temp, 'sessions'),
    resolveWorkspace: () => workspaceGrant,
    createRuntime: () => ({
      appVersion: 'fixture',
      profile: { id: 'fixture', version: '1', digest: 'fixture' },
      request: { instructions: 'Ask one question', tools: [tool.spec] },
      deps: {
        models: { resolve: () => model, list: () => [ref] },
        tools: { get: (name) => (name === tool.spec.name ? tool : undefined), available: () => [tool] },
        toolContext: { workspace: workspaceGrant, settings: { get: () => undefined, watch: () => () => {} } },
      },
    }),
  });
  const principal = { userId: 'fixture', via: 'local' as const };
  const host = createDirectInProcessHost({
    sessions,
    defaultModel: ref,
    authorize: () => {},
    resolveWorkspace: () => workspaceGrant,
  });
  const logger = { error: () => {} };
  const backend = createAcpBackend({
    host,
    principal,
    logger,
    workspaces: {
      authorize: async () => ({ workspaceId: 'fixture', access: 'read_write' }),
      cwd: async () => workspace,
    },
  });
  let client = acp
    .client({ name: 'native-question-fixture' })
    .onNotification(acp.methods.client.session.update, ({ params }) => {
      updates.push(params);
    });
  if (options.elicitation)
    client = client.onRequest(acp.methods.client.elicitation.create, ({ params }) => options.elicitation!(params));
  const inbound = new TransformStream<Uint8Array, Uint8Array>();
  const outbound = new TransformStream<Uint8Array, Uint8Array>();
  const agentConnection = createAcpAgent({ backend, logger, version: 'fixture' }).connect(
    acp.ndJsonStream(outbound.writable, inbound.readable),
  );
  const clientConnection = client.connect(acp.ndJsonStream(inbound.writable, outbound.readable));
  try {
    await clientConnection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: 2,
      info: { name: 'native-question-fixture', version: '1' },
      ...(options.capabilities ? { capabilities: options.capabilities } : {}),
    });
    await body({ context: clientConnection.agent, workspace, updates, requests });
  } finally {
    clientConnection.close();
    agentConnection.close();
    await backend.shutdown();
    await host.dispose();
    await rm(temp, { recursive: true, force: true });
  }
}

async function fixture(
  body: (fixture: Fixture) => Promise<void>,
  options: {
    capabilities?: acp.InitializeRequest['capabilities'];
    elicitation?: (params: acp.CreateElicitationRequest) => Promise<acp.CreateElicitationResponse>;
    question?: boolean;
    signal?: 'SIGINT' | 'SIGTERM';
  } = {},
): Promise<void> {
  if (options.question) return await nativeQuestionFixture(body, options);
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
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
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
  const updates: acp.UpdateSessionNotification[] = [];
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
      info: { name: 'term2-direct-integration', version: '1' },
      ...(options.capabilities ? { capabilities: options.capabilities } : {}),
    });
    expect(initialized.capabilities?.session?.prompt).toMatchObject({ image: {}, embeddedContext: {} });
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

async function idle(updates: acp.UpdateSessionNotification[], from: number): Promise<void> {
  await expect
    .poll(
      () =>
        updates.slice(from).some(({ update }) => update.sessionUpdate === 'state_update' && update.state === 'idle'),
      { timeout: 15_000 },
    )
    .toBe(true);
}

describe('ACP v2 compatibility over SDK NDJSON and native Host', () => {
  it('rejects automatic approval flags with diagnostics only on stderr', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'acp-invalid-flags-'));
    const child = spawn(process.execPath, [integrationCliPath(), 'acp', '--auto-approve'], {
      env: createTestChildEnv({ HOME: directory, XDG_STATE_HOME: directory, DISABLE_LOGGING: '1' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    try {
      const code = await new Promise((resolve) => child.once('close', resolve));
      expect(code).toBe(1);
      expect(stdout).toBe('');
      expect(stderr).toMatch(/unknown.*auto-approve/i);
    } finally {
      child.kill('SIGKILL');
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it('accepts standard embedded text and synchronizes resume without replaying history', async () => {
    await fixture(async ({ context, workspace, updates, requests }) => {
      const created = await context.request(acp.methods.agent.session.new, { cwd: workspace });
      const from = updates.length;
      await context.request(acp.methods.agent.session.prompt, {
        sessionId: created.sessionId,
        prompt: [{ type: 'resource', resource: { uri: 'file:///fixture.txt', text: 'embedded ACP sentinel' } }],
      });
      await idle(updates, from);
      expect(JSON.stringify(requests)).toContain('embedded ACP sentinel');
      expect(
        updates
          .slice(from)
          .some(
            ({ update }) => update.sessionUpdate === 'agent_message_chunk' || update.sessionUpdate === 'agent_message',
          ),
      ).toBe(true);
      const listed = await context.request(acp.methods.agent.session.list, { cwd: workspace });
      expect(listed.sessions.map((session) => session.sessionId)).toContain(created.sessionId);
      expect(updates.filter(({ update }) => update.sessionUpdate === 'session_info_update')).toEqual([
        {
          sessionId: created.sessionId,
          update: { sessionUpdate: 'session_info_update', title: 'embedded ACP sentinel' },
        },
      ]);
      const resumed = updates.length;
      await context.request(acp.methods.agent.session.resume, { sessionId: created.sessionId, cwd: workspace });
      expect(updates.slice(resumed).map(({ update }) => update)).toEqual([
        { sessionUpdate: 'session_info_update', title: 'embedded ACP sentinel' },
        { sessionUpdate: 'state_update', state: 'idle' },
      ]);
      const replay = updates.length;
      await context.request(acp.methods.agent.session.resume, {
        sessionId: created.sessionId,
        cwd: workspace,
        replayFrom: { type: 'start' },
      });
      expect(updates.slice(replay).some(({ update }) => update.sessionUpdate === 'user_message')).toBe(true);
      expect(updates.at(-1)?.update).toMatchObject({ sessionUpdate: 'state_update', state: 'idle' });
      await expect(
        context.request(acp.methods.agent.session.prompt, {
          sessionId: created.sessionId,
          prompt: [{ type: 'resource', resource: { uri: 'file:///fixture.bin', blob: 'YQ==' } }],
        }),
      ).rejects.toMatchObject({ code: -32602 });
      await expect(context.request(acp.methods.agent.session.new, { cwd: 'relative' })).rejects.toMatchObject({
        code: -32602,
      });
      await expect(
        context.request(acp.methods.agent.session.new, { cwd: workspace, additionalDirectories: [workspace] }),
      ).rejects.toMatchObject({ code: -32602 });
      // Image bytes and trailing text cross the built CLI/provider boundary in order.
      const imageStart = updates.length;
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCFsAAAAASUVORK5CYII=';
      await context.request(acp.methods.agent.session.prompt, {
        sessionId: created.sessionId,
        prompt: [
          { type: 'text', text: 'before image' },
          { type: 'image', mimeType: 'image/png', data: png },
          { type: 'text', text: 'after image' },
        ],
      });
      await idle(updates, imageStart);
      expect(updates.slice(imageStart).filter(({ update }) => update.sessionUpdate === 'session_info_update')).toEqual(
        [],
      );
      const message = requests.at(-1).messages.findLast((message: any) => message.role === 'user');
      expect(message.content).toEqual([
        { type: 'text', text: 'before image' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } },
        { type: 'text', text: 'after image' },
      ]);
      const admitted = requests.length;
      for (const prompt of [
        [],
        [{ type: 'text', text: '   ' }],
        [{ type: 'image', mimeType: 'text/plain', data: 'YQ==' }],
        [{ type: 'image', mimeType: 'image/png', data: 'YQ' }],
        [{ type: 'image', mimeType: 'image/png', data: 'data:image/png;base64,YQ==' }],
        [{ type: 'audio', mimeType: 'audio/wav', data: 'YQ==' }],
      ]) {
        await expect(
          context.request(acp.methods.agent.session.prompt, {
            sessionId: created.sessionId,
            prompt: prompt as acp.PromptRequest['prompt'],
          }),
        ).rejects.toMatchObject({ code: -32602 });
      }
      expect(requests.length).toBe(admitted);
      await expect(
        context.request(acp.methods.agent.session.resume, {
          sessionId: created.sessionId,
          cwd: path.dirname(workspace),
        }),
      ).rejects.toMatchObject({ code: -32602 });
      await expect(
        context.request(acp.methods.agent.session.new, {
          cwd: workspace,
          mcpServers: [{ type: 'stdio', name: 'unsupported', command: 'false', args: [], env: [] }],
        }),
      ).rejects.toMatchObject({ code: -32602 });
      await expect(
        context.request(acp.methods.agent.session.resume, {
          sessionId: created.sessionId,
          cwd: workspace,
          replayFrom: { type: 'cursor', cursor: '1' } as any,
        }),
      ).rejects.toMatchObject({ code: -32602 });
      await context.request(acp.methods.agent.session.close, { sessionId: created.sessionId });
    });
  }, 60_000);

  it.each([undefined, {}, { form: null }, { url: {} }])(
    'never sends form elicitation without advertised form support: %j',
    async (elicitation) => {
      let calls = 0;
      await fixture(
        async ({ context, workspace, updates }) => {
          const { sessionId } = await context.request(acp.methods.agent.session.new, { cwd: workspace });
          const from = updates.length;
          await context.request(acp.methods.agent.session.prompt, {
            sessionId,
            prompt: [{ type: 'text', text: 'ask a question' }],
          });
          await idle(updates, from);
          expect(
            updates
              .slice(from)
              .some(({ update }) => update.sessionUpdate === 'state_update' && update.state === 'requires_action'),
          ).toBe(true);
          expect(
            updates
              .slice(from)
              .some(
                ({ update }) => update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update',
              ),
          ).toBe(true);
          expect(calls).toBe(0);
        },
        {
          question: true,
          capabilities: elicitation === undefined ? {} : { elicitation },
          elicitation: async () => {
            calls++;
            return { action: 'accept', content: { q0: 'Blue' } };
          },
        },
      );
    },
    60_000,
  );

  it('reports blocked work and cancellation, ignores a late answer, and resumes idle', async () => {
    let answer!: (value: acp.CreateElicitationResponse) => void;
    let calls = 0;
    await fixture(
      async ({ context, workspace, updates, requests }) => {
        const { sessionId } = await context.request(acp.methods.agent.session.new, { cwd: workspace });
        await context.request(acp.methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: 'text', text: 'ask a question' }],
        });
        await expect.poll(() => calls, { timeout: 15_000 }).toBe(1);
        await expect
          .poll(() => updates.at(-1)?.update, { timeout: 15_000 })
          .toMatchObject({ sessionUpdate: 'state_update', state: 'requires_action' });
        const from = updates.length;
        await expect(
          context.request(acp.methods.agent.session.prompt, {
            sessionId,
            prompt: [{ type: 'text', text: 'concurrent prompt' }],
          }),
        ).rejects.toMatchObject({ code: -32000 });
        // Cancel before resuming on this connection; a local active prompt cannot
        // be replaced. A late client answer must not restart cancelled work.
        await context.notify(acp.methods.agent.session.cancel, { sessionId });
        await idle(updates, from);
        expect(
          updates
            .slice(from)
            .reverse()
            .find(({ update }) => update.sessionUpdate === 'state_update')?.update,
        ).toMatchObject({ state: 'idle', stopReason: 'cancelled' });
        answer({ action: 'accept', content: { q0: 'Blue' } });
        await context.request(acp.methods.agent.session.resume, { sessionId, cwd: workspace });
        expect(updates.at(-1)?.update).toMatchObject({ state: 'idle' });
        expect(requests.length).toBe(1);
      },
      {
        question: true,
        capabilities: { elicitation: { form: {} } },
        elicitation: async () => {
          calls++;
          return await new Promise((resolve) => {
            answer = resolve;
          });
        },
      },
    );
  }, 60_000);

  it('delivers a real question answer and reports resumed foreground progress', async () => {
    await fixture(
      async ({ context, workspace, updates, requests }) => {
        const { sessionId } = await context.request(acp.methods.agent.session.new, { cwd: workspace });
        const from = updates.length;
        await context.request(acp.methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: 'text', text: 'ask a question' }],
        });
        await idle(updates, from);
        const states = updates
          .slice(from)
          .flatMap(({ update }) => (update.sessionUpdate === 'state_update' ? [update.state] : []));
        const blocked = states.indexOf('requires_action');
        expect(blocked).toBeGreaterThanOrEqual(0);
        expect(states.slice(blocked + 1)).toContain('running');
        expect(states.at(-1)).toBe('idle');
        expect(JSON.stringify(requests.slice(1))).toContain('Blue');
        const live = updates.slice(from).map(({ update }) => update);
        const draftIds = live.flatMap((update) =>
          update.sessionUpdate === 'agent_message_chunk' ? [update.messageId] : [],
        );
        expect(new Set(draftIds).size).toBe(2);
        const before = updates.length;
        await context.request(acp.methods.agent.session.resume, {
          sessionId,
          cwd: workspace,
          replayFrom: { type: 'start' },
        });
        const replayed = updates.slice(before).map(({ update }) => update);
        const messages = replayed.filter(
          (update): update is acp.SessionUpdate & { sessionUpdate: 'agent_message' } =>
            update.sessionUpdate === 'agent_message',
        );
        expect(messages.map((update) => update.messageId)).toEqual([...new Set(draftIds)]);
        expect(messages.map((update) => update.content)).toEqual([
          [{ type: 'text', text: 'Before tool' }],
          [{ type: 'text', text: 'Question resolved' }],
        ]);
        const tool = replayed.findIndex((update) => update.sessionUpdate === 'tool_call');
        const first = replayed.findIndex((update) => update.sessionUpdate === 'agent_message');
        const last =
          replayed.length - 1 - [...replayed].reverse().findIndex((update) => update.sessionUpdate === 'agent_message');
        expect(first).toBeLessThan(tool);
        expect(tool).toBeLessThan(last);
        const tail = updates.length;
        await context.request(acp.methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: 'text', text: 'next turn' }],
        });
        await idle(updates, tail);
        // Snapshot upserts may repeat an existing ID, but must not append its text twice.
        const oldIds = new Set(messages.map((message) => message.messageId));
        expect(
          updates
            .slice(tail)
            .some(({ update }) => update.sessionUpdate === 'agent_message_chunk' && oldIds.has(update.messageId)),
        ).toBe(false);
        for (const { update } of updates.slice(tail)) {
          if (update.sessionUpdate === 'agent_message' && oldIds.has(update.messageId)) {
            expect(update.content).toEqual(messages.find((message) => message.messageId === update.messageId)!.content);
          }
        }
      },
      {
        question: true,
        capabilities: { elicitation: { form: {} } },
        elicitation: async () => ({ action: 'accept', content: { q0: 'Blue' } }),
      },
    );
  }, 60_000);

  it.each(['SIGINT', 'SIGTERM'] as const)(
    'shuts down cleanly on %s with protocol-only stdout',
    async (signal) => {
      await fixture(
        async ({ context, workspace }) => {
          await context.request(acp.methods.agent.session.new, { cwd: workspace });
        },
        { signal },
      );
    },
    60_000,
  );
});
