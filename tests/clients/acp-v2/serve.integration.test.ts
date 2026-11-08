import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Writable } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import * as acp from '@agentclientprotocol/sdk/experimental/v2';
import { resolveSettingsDirectory } from '../../../src/config/settings/settings-path.js';
import { createTestChildEnv } from '../../helpers/terminal-e2e.js';

// The launcher is exercised as a real child process because its contract is a
// stdio one: stdout must carry nothing but JSON-RPC, and the process must exit 0
// once its client disappears.
//
// Use the same compiled CLI as the other integration launchers. The initialize
// response below still verifies that package-version resolution matches the app.
//
// The scripted provider crosses the process boundary the way a real operator
// configures one — a runtime-defined openai-compatible provider in
// settings.json pointed at a loopback double — because the in-process
// registerProvider seam cannot reach into another process.

const projectRoot = fileURLToPath(new URL('../../..', import.meta.url));
import { integrationCliPath } from '../../helpers/integration-cli.js';

const packageVersion: string = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).version;

const textTurnBody = [
  'data: {"id":"chatcmpl-acp","choices":[{"delta":{"role":"assistant","content":"hello from acp"}}]}',
  '',
  'data: {"id":"chatcmpl-acp","choices":[{"delta":{},"finish_reason":"stop"}]}',
  '',
  'data: [DONE]',
  '',
].join('\n');

/**
 * One real shell call; ACP must ask even when saved settings auto-approve.
 */
function approvalToolTurnBody(command: string, toolName = 'shell', toolInput?: object): string {
  const arguments_ = JSON.stringify(toolInput ?? { command, sandbox: 'unsandboxed' });
  return [
    `data: ${JSON.stringify({
      id: 'chatcmpl-acp-tool',
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: 'call_1', type: 'function', function: { name: toolName, arguments: arguments_ } },
            ],
          },
        },
      ],
    })}`,
    '',
    'data: {"id":"chatcmpl-acp-tool","choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
    '',
    'data: [DONE]',
    '',
  ].join('\n');
}

/**
 * Minimal OpenAI-compatible provider double: the /models path serves the
 * catalog the launcher's --model resolution needs, and chat completions answer
 * with a one-frame SSE turn, enough for one real ConversationService turn. With
 * a script, the first request carrying the `run the tool` prompt answers with
 * one approval-required tool call instead.
 */
async function startModelMock(
  modelIds: string[],
  script?: { toolCommand: string; toolName?: string; toolInput?: object },
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const toolTurns = new Set<number>();
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url?.includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: modelIds.map((id) => ({ id })) }));
      return;
    }
    let body = '';
    req.on('data', (chunk: Buffer | string) => {
      body += String(chunk);
    });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      // Each admitted user prompt asks once; the continuation after its tool result
      // answers with text. Repeated provider call IDs must not become execution IDs.
      const users = (JSON.parse(body).messages ?? []).filter(
        (message: { role: string }) => message.role === 'user',
      ).length;
      if (script && !toolTurns.has(users) && body.includes('run the tool')) {
        toolTurns.add(users);
        res.end(approvalToolTurnBody(script.toolCommand, script.toolName, script.toolInput));
        return;
      }
      res.end(textTurnBody);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

const disposables: Array<() => Promise<void> | void> = [];

afterAll(async () => {
  for (const dispose of disposables.splice(0).reverse()) {
    await dispose();
  }
});

type ChildSession = {
  context: acp.ClientContext;
  sessionId: string;
  workspace: string;
  workspaceFile: string;
  updates: acp.UpdateSessionNotification[];
  permissionRequests: acp.RequestPermissionRequest[];
};

/**
 * One real `term2 acp` child with a tool-call-scripting provider double, an ACP
 * client whose permission behaviour the caller supplies, and the child's raw
 * stdout so the caller can assert the protocol-only contract over these
 * exchanges. The child is killed by `disposables` if the body never returns.
 */
const runAcpChild = async (
  permission: ((params: acp.RequestPermissionRequest) => Promise<acp.RequestPermissionResponse>) | undefined,
  body: (session: ChildSession) => Promise<void>,
  options: { command?: string; sandbox?: boolean } = {},
): Promise<{
  stdoutText: string;
  stderr: string;
  exit: { code: number | null | 'timeout'; signal: NodeJS.Signals | null };
}> => {
  const tempHome = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'acp-perm-home-')));
  const stateHome = path.join(tempHome, 'state');
  const conversationsDir = path.join(tempHome, 'conversations');
  const workspace = path.join(tempHome, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const workspaceFile = path.join(workspace, 'probe.txt');
  fs.mkdirSync(path.join(tempHome, 'scratch'));
  disposables.push(() => rmSync(tempHome, { recursive: true, force: true }));

  const mock = await startModelMock(['acp-mock-model'], { toolCommand: options.command ?? 'echo written > probe.txt' });
  disposables.push(mock.close);

  const settingsDir = resolveSettingsDirectory({ homeDir: tempHome, env: { XDG_STATE_HOME: stateHome } });
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(
    path.join(settingsDir, 'settings.json'),
    JSON.stringify(
      {
        agent: { modelSelection: { provider: 'acpmock', model: 'acp-mock-model' }, retryAttempts: 0 },
        sandbox: { enabled: options.sandbox ?? false },
        shell: { autoApproveMode: 'always' },
        providers: [{ name: 'acpmock', type: 'openai-compatible', baseUrl: mock.baseUrl, apiKey: 'test-key' }],
      },
      null,
      2,
    ),
    'utf-8',
  );

  const child = spawn(
    process.execPath,
    [integrationCliPath(), 'acp', '--provider', 'acpmock', '--model', 'acp-mock-model'],
    {
      cwd: projectRoot,
      env: createTestChildEnv({
        HOME: tempHome,
        XDG_STATE_HOME: stateHome,
        TERM2_CONVERSATIONS_DIR: conversationsDir,
        TERM2_TEST_DB_DIR: conversationsDir,
        DISABLE_LOGGING: '1',
        TMPDIR: path.join(tempHome, 'scratch'),
        TEMP: path.join(tempHome, 'scratch'),
        TMP: path.join(tempHome, 'scratch'),
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  disposables.push(() => {
    child.kill('SIGKILL');
  });

  let stderr = '';
  child.stderr.on('data', (chunk: Buffer | string) => {
    stderr += String(chunk);
  });

  let stdoutText = '';
  const recorder = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      stdoutText += Buffer.from(chunk).toString('utf8');
      controller.enqueue(chunk);
    },
  });
  const agentToClient = (Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>).pipeThrough(recorder);

  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
  const stdinWriter = clientToAgent.writable.getWriter();
  void clientToAgent.readable.pipeTo(Writable.toWeb(child.stdin!) as unknown as WritableStream<Uint8Array>);

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('close', (code, signal) => resolve({ code, signal }));
  });

  const updates: acp.UpdateSessionNotification[] = [];
  const permissionRequests: acp.RequestPermissionRequest[] = [];
  let client = acp
    .client({ name: 'acp-perm-e2e-client' })
    .onNotification(acp.methods.client.session.update, ({ params }) => {
      updates.push(params);
    });
  if (permission) {
    client = client.onRequest(acp.methods.client.session.requestPermission, async ({ params }) => {
      permissionRequests.push(params);
      return await permission(params);
    });
  }

  const connection = client.connect(
    acp.ndJsonStream(new WritableStream<Uint8Array>({ write: (chunk) => stdinWriter.write(chunk) }), agentToClient),
  );
  try {
    const context = connection.agent;
    const initialized = await context.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      info: { name: 'acp-perm-e2e-client', version: '1.0.0' },
    });
    expect(initialized.info?.version).toBe(packageVersion);
    const created = await context.request(acp.methods.agent.session.new, { cwd: workspace });
    await body({ context, sessionId: created.sessionId, workspace, workspaceFile, updates, permissionRequests });
  } finally {
    // Keep reading the protocol while EOF disposes the process-owned Host.
    await stdinWriter.close().catch(() => undefined);
  }

  let timeout: NodeJS.Timeout | undefined;
  const exit = await Promise.race([
    exited,
    new Promise<{ code: 'timeout'; signal: null }>((resolve) => {
      timeout = setTimeout(() => resolve({ code: 'timeout', signal: null }), 30_000);
    }),
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
  connection.close();
  return { stdoutText, stderr, exit };
};

function assertTransport(result: Awaited<ReturnType<typeof runAcpChild>>): void {
  expect(result.exit, result.stderr).toEqual({ code: 0, signal: null });
  for (const line of result.stdoutText.trim().split('\n')) expect(JSON.parse(line)).toMatchObject({ jsonrpc: '2.0' });
  expect(result.stderr).not.toContain('detach failed');
}

async function toolTurn(session: ChildSession): Promise<void> {
  const from = session.updates.length;
  expect(
    await session.context.request(acp.methods.agent.session.prompt, {
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'run the tool' }],
    }),
  ).toEqual({});
  await expect
    .poll(
      () =>
        session.updates
          .slice(from)
          .some(({ update }) => update.sessionUpdate === 'state_update' && update.state === 'idle'),
      { timeout: 15_000 },
    )
    .toBe(true);
  expect(session.updates.slice(from).some(({ update }) => update.sessionUpdate === 'tool_call')).toBe(true);
  expect(
    session.updates
      .slice(from)
      .some(
        ({ update }) =>
          (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') &&
          (update.status === 'completed' || update.status === 'failed'),
      ),
  ).toBe(true);
}

describe('term2 acp real-tool permission round trips', () => {
  it.each(['reject', 'unknown', 'unsandboxed-once', 'allow-remember', 'cancelled', 'malformed', 'unsupported'])(
    'fails closed for %s without executing the shell',
    async (reply) => {
      const result = await runAcpChild(
        reply === 'unsupported'
          ? undefined
          : async () => {
              if (reply === 'malformed') return {} as acp.RequestPermissionResponse;
              if (reply === 'cancelled') return { outcome: { outcome: 'cancelled' } };
              return { outcome: { outcome: 'selected', optionId: reply } };
            },
        async (session) => {
          await toolTurn(session);
          if (reply !== 'unsupported') {
            expect(session.permissionRequests).toHaveLength(1);
            const request = session.permissionRequests[0]!;
            expect(request.sessionId).toBe(session.sessionId);
            expect(request.subject).toMatchObject({ type: 'tool_call', toolCall: { name: 'shell' } });
            expect(request.options.map((option) => option.optionId)).toEqual(['approve', 'reject']);
          }
          expect(fs.existsSync(session.workspaceFile)).toBe(false);
        },
      );
      assertTransport(result);
    },
    60_000,
  );

  it.each(['approve', 'allow-once'])(
    'honors %s without granting an unsandboxed escape',
    async (optionId) => {
      const result = await runAcpChild(
        async () => ({ outcome: { outcome: 'selected', optionId } }),
        async (session) => {
          await toolTurn(session);
          expect(session.permissionRequests).toHaveLength(1);
          const output = session.updates.filter(
            ({ update }) => update.sessionUpdate === 'tool_call_update' || update.sessionUpdate === 'tool_call',
          );
          if (process.env.TERM2_ACP_REQUIRE_SHELL_SUCCESS === '1') {
            expect(fs.existsSync(session.workspaceFile), JSON.stringify(session.updates)).toBe(true);
          }
          if (fs.existsSync(session.workspaceFile)) {
            expect(fs.readFileSync(session.workspaceFile, 'utf8').trim()).toBe('written');
          } else {
            // Hosts without working sandbox support must refuse, even after approval.
            expect(JSON.stringify(output)).toMatch(/sandbox|bwrap/i);
          }
        },
      );
      assertTransport(result);
    },
    60_000,
  );

  it('asks again after allow-once and resume, with distinct native execution IDs', async () => {
    let decisions = 0;
    const result = await runAcpChild(
      async () => ({
        outcome: {
          outcome: 'selected',
          optionId: decisions++ === 0 ? 'approve' : 'reject',
        },
      }),
      async (session) => {
        await toolTurn(session);
        await session.context.request(acp.methods.agent.session.close, { sessionId: session.sessionId });
        await session.context.request(acp.methods.agent.session.resume, {
          sessionId: session.sessionId,
          cwd: session.workspace,
          replayFrom: { type: 'start' },
        });
        await toolTurn(session);
        expect(session.permissionRequests).toHaveLength(2);
        const ids = session.permissionRequests.map((request) => {
          expect(request.subject?.type).toBe('tool_call');
          return (request.subject as acp.RequestPermissionRequest['subject'] & { toolCall: { toolCallId: string } })
            .toolCall.toolCallId;
        });
        expect(new Set(ids).size).toBe(2);
        if (process.env.TERM2_ACP_REQUIRE_SHELL_SUCCESS === '1') {
          expect(fs.readFileSync(session.workspaceFile, 'utf8')).toBe('written\n');
        }
      },
      { command: 'echo written >> probe.txt' },
    );
    assertTransport(result);
  }, 60_000);

  it('does not let saved sandbox=false or auto-approval run outside the required sandbox', async () => {
    const result = await runAcpChild(
      async () => ({ outcome: { outcome: 'selected', optionId: 'approve' } }),
      async (session) => {
        await toolTurn(session);
        expect(session.permissionRequests).toHaveLength(1);
        // The target is outside both the workspace and isolated child scratch.
        expect(fs.existsSync(path.join(path.dirname(session.workspace), 'escaped.txt'))).toBe(false);
      },
      { command: 'echo escaped > ../escaped.txt', sandbox: false },
    );
    assertTransport(result);
  }, 60_000);
});
