import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Writable } from 'node:stream';
import { afterAll, describe, expect, it, vi } from 'vitest';
import * as acp from '@agentclientprotocol/sdk/experimental/v2';
import { resolveSettingsDirectory } from '../services/settings/settings-path.js';
import { createTestChildEnv } from '../test-helpers/terminal-e2e.js';

// The launcher is exercised as a real child process because its contract is a
// stdio one: stdout must carry nothing but JSON-RPC, and the process must exit 0
// once its client disappears.
//
// The child runs the source entry through tsx, the same way cli.e2e.test.ts
// spawns the CLI. A tsc build into a cache directory would be cheaper to reuse,
// but `installationVersion` resolves the package version by relative path from
// its own file (`../../../package.json`), which is only correct when the build
// output sits directly under a directory holding package.json — as the published
// `dist/` does and a node_modules/.cache build does not. Running the source
// entry keeps that resolution honest instead of hand-building the layout.
//
// The scripted provider crosses the process boundary the way a real operator
// configures one — a runtime-defined openai-compatible provider in
// settings.json pointed at a loopback double — because the in-process
// registerProvider seam cannot reach into another process.

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const cliEntry = path.join(projectRoot, 'source', 'cli.tsx');

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
 * One OpenAI-compatible tool-call turn: a `shell` call with
 * `sandbox: 'unsandboxed'`, which `source/tools/system/shell.ts` makes
 * approval-required, so the child must ask its ACP client for permission.
 */
function approvalToolTurnBody(command: string): string {
  const arguments_ = JSON.stringify({ command, sandbox: 'unsandboxed' });
  return [
    `data: ${JSON.stringify({
      id: 'chatcmpl-acp-tool',
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: 'call_1', type: 'function', function: { name: 'shell', arguments: arguments_ } },
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
  script?: { toolCommand: string },
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  let toolCallIssued = false;
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
      // Only the first turn asks for the tool call; the turn after the tool
      // result (which still carries the prompt in its history) must answer with
      // text, or the model would loop on the same call.
      if (script && !toolCallIssued && body.includes('run the tool')) {
        toolCallIssued = true;
        res.end(approvalToolTurnBody(script.toolCommand));
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

describe('term2 acp (child process)', () => {
  it('serves initialize, a session turn and an EOF shutdown over real stdio', async () => {
    const tempHome = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'acp-home-')));
    const stateHome = path.join(tempHome, 'state');
    const conversationsDir = path.join(tempHome, 'conversations');
    const workspaceRoot = path.join(tempHome, 'workspace');
    fs.mkdirSync(workspaceRoot, { recursive: true });
    const workspace = realpathSync(workspaceRoot);
    disposables.push(() => rmSync(tempHome, { recursive: true, force: true }));

    const mock = await startModelMock(['acp-mock-model']);
    disposables.push(mock.close);

    const settingsDir = resolveSettingsDirectory({ homeDir: tempHome, env: { XDG_STATE_HOME: stateHome } });
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(
      path.join(settingsDir, 'settings.json'),
      JSON.stringify(
        {
          agent: { provider: 'acpmock', model: 'acp-mock-model', retryAttempts: 0 },
          providers: [{ name: 'acpmock', type: 'openai-compatible', baseUrl: mock.baseUrl, apiKey: 'test-key' }],
        },
        null,
        2,
      ),
      'utf-8',
    );

    const child = spawn(
      process.execPath,
      ['--import', 'tsx', cliEntry, 'acp', '--provider', 'acpmock', '--model', 'acp-mock-model'],
      {
        cwd: projectRoot,
        env: createTestChildEnv({
          HOME: tempHome,
          XDG_STATE_HOME: stateHome,
          TERM2_CONVERSATIONS_DIR: conversationsDir,
          TERM2_TEST_DB_DIR: conversationsDir,
          DISABLE_LOGGING: '1',
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

    // stdio contract: stdout is captured verbatim, then forwarded to the client.
    let stdoutText = '';
    const recorder = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        stdoutText += Buffer.from(chunk).toString('utf8');
        controller.enqueue(chunk);
      },
    });
    const agentToClient = (Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>).pipeThrough(
      recorder,
    );

    const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
    const stdinWriter = clientToAgent.writable.getWriter();
    void clientToAgent.readable.pipeTo(Writable.toWeb(child.stdin!) as unknown as WritableStream<Uint8Array>);

    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.on('close', (code, signal) => resolve({ code, signal }));
    });

    const updates: acp.UpdateSessionNotification[] = [];
    const client = acp
      .client({ name: 'acp-m2-e2e-client' })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        updates.push(params);
      });

    let sessionId = '';
    try {
      await client.connectWith(
        acp.ndJsonStream(new WritableStream<Uint8Array>({ write: (chunk) => stdinWriter.write(chunk) }), agentToClient),
        async (context) => {
          const initialized = await context.request(acp.methods.agent.initialize, {
            protocolVersion: acp.PROTOCOL_VERSION,
            info: { name: 'acp-m2-e2e-client', version: '1.0.0' },
          });
          expect(initialized.info.version).toBe(packageVersion);

          const created = await context.request(acp.methods.agent.session.new, { cwd: workspace });
          sessionId = created.sessionId;

          await context.request(acp.methods.agent.session.prompt, {
            sessionId,
            prompt: [{ type: 'text', text: 'say hello' }],
          });
          await vi.waitFor(
            () => {
              expect(updates).toEqual(
                expect.arrayContaining([
                  expect.objectContaining({ update: { sessionUpdate: 'state_update', state: 'running' } }),
                  expect.objectContaining({
                    update: expect.objectContaining({ sessionUpdate: 'agent_message_chunk' }),
                  }),
                  expect.objectContaining({
                    update: { sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' },
                  }),
                ]),
              );
            },
            { timeout: 30_000 },
          );
        },
      );
    } finally {
      // Closing stdin is the client's disconnect: the launcher must cancel and
      // close the still-live session without an explicit session/close.
      await stdinWriter.close();
    }

    const exit = await exited;
    expect(stderr).not.toContain('term2 acp: failed to start');
    expect({ code: exit.code, signal: exit.signal }, stderr).toEqual({ code: 0, signal: null });

    const lines = stdoutText.split('\n').filter((line) => line.trim().length > 0);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(JSON.parse(line), line).toMatchObject({ jsonrpc: '2.0' });
    }

    expect(sessionId).not.toBe('');
    expect(fs.existsSync(path.join(conversationsDir, `${sessionId}.jsonl`))).toBe(true);
    expect(fs.existsSync(path.join(conversationsDir, `${sessionId}.lock`))).toBe(false);
  }, 180_000);
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const waitFor = async (condition: () => boolean, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await sleep(50);
  }
  return condition();
};

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
  disposables.push(() => rmSync(tempHome, { recursive: true, force: true }));

  const mock = await startModelMock(['acp-mock-model'], { toolCommand: 'echo written > probe.txt' });
  disposables.push(mock.close);

  const settingsDir = resolveSettingsDirectory({ homeDir: tempHome, env: { XDG_STATE_HOME: stateHome } });
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(
    path.join(settingsDir, 'settings.json'),
    JSON.stringify(
      {
        agent: { provider: 'acpmock', model: 'acp-mock-model', retryAttempts: 0 },
        providers: [{ name: 'acpmock', type: 'openai-compatible', baseUrl: mock.baseUrl, apiKey: 'test-key' }],
      },
      null,
      2,
    ),
    'utf-8',
  );

  const child = spawn(
    process.execPath,
    ['--import', 'tsx', cliEntry, 'acp', '--provider', 'acpmock', '--model', 'acp-mock-model'],
    {
      cwd: projectRoot,
      env: createTestChildEnv({
        HOME: tempHome,
        XDG_STATE_HOME: stateHome,
        TERM2_CONVERSATIONS_DIR: conversationsDir,
        TERM2_TEST_DB_DIR: conversationsDir,
        DISABLE_LOGGING: '1',
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

  try {
    await client.connectWith(
      acp.ndJsonStream(new WritableStream<Uint8Array>({ write: (chunk) => stdinWriter.write(chunk) }), agentToClient),
      async (context) => {
        await context.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          info: { name: 'acp-perm-e2e-client', version: '1.0.0' },
        });
        const created = await context.request(acp.methods.agent.session.new, { cwd: workspace });
        await body({ context, sessionId: created.sessionId, workspace, workspaceFile, updates, permissionRequests });
      },
    );
  } finally {
    // Closing stdin is the client's disconnect: the launcher cancels and closes
    // the session, then exits.
    await stdinWriter.close().catch(() => undefined);
  }

  const exit = await Promise.race([exited, sleep(30_000).then(() => ({ code: 'timeout' as const, signal: null }))]);
  return { stdoutText, stderr, exit };
};

describe('term2 acp permission round trips (child process)', () => {
  // DEFECT: the child never sends `session/request_permission`. Its sessions are
  // built by `createProductionRuntimeFactory`, and `session-backend.ts` reads the
  // pending interaction from `turn.session.resources.runtime`, which that path
  // never sets -- so every approval-required call falls through to the M1
  // fail-closed default and the client's allow can never be honored.
  it('asks the client for permission and writes the file when allowed', async () => {
    await runAcpChild(
      async () => ({ outcome: { outcome: 'selected', optionId: 'allow-once' } }),
      async (session) => {
        await session.context.request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'run the tool' }],
        });

        const arrived = await waitFor(() => session.permissionRequests.length > 0, 5_000);
        // Observed while this test was written: instead of a permission request the
        // client sees state_update running -> tool_call pending -> two
        // `tool_call_update` failed updates carrying the fallback reason
        // 'Approval is not yet supported over ACP.', and no terminal state_update.
        expect(arrived, 'DEFECT: term2 acp never sent session/request_permission to its client').toBe(true);
        expect(session.permissionRequests[0]!.options.map((option) => option.optionId)).not.toContain(
          'unsandboxed-once',
        );

        const written = await waitFor(() => fs.existsSync(session.workspaceFile), 5_000);
        expect(written, 'an allowed shell call must run').toBe(true);
      },
    );
  }, 180_000);

  it('rejects the call without writing and keeps stdout protocol-only', async () => {
    const { stdoutText, exit } = await runAcpChild(
      async () => ({ outcome: { outcome: 'cancelled' } }),
      async (session) => {
        await session.context.request(acp.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: 'text', text: 'run the tool' }],
        });

        // Whether the rejection is honored or the fail-closed default denies it,
        // an approval-required call must not run.
        await sleep(3_000);
        expect(fs.existsSync(session.workspaceFile)).toBe(false);
      },
    );

    expect(exit).toEqual({ code: 0, signal: null });
    const lines = stdoutText.split('\n').filter((line) => line.trim().length > 0);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(JSON.parse(line), line).toMatchObject({ jsonrpc: '2.0' });
    }
  }, 180_000);
});
