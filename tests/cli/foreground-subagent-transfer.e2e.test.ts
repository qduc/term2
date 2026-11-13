import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testCliPath, spawnTerminal, createTestChildEnv, type TerminalSession } from '../helpers/terminal-e2e.js';
import {
  HARNESS_IDLE_ENV,
  waitForHarnessComposerValue,
  waitForHarnessIdleGeneration,
} from '../../src/shared/lib/harness-input-idle.js';
import { resolveSettingsDirectory } from '../../src/config/settings/settings-path.js';

// A foreground explorer launched beside background delegation blocks the root turn in the terminal
// UI. The user's Ctrl+G move-to-background must free that turn with a truthful running handle, and
// the same child's later completion must arrive as the ordinary background notification.
const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const builtCli = testCliPath(path.join(projectRoot, 'dist', 'src', 'app', 'cli.js'));
const TIMEOUT_MS = 120_000;

let session: TerminalSession | null = null;
let root = '';
let server: http.Server | null = null;
let releaseChild: (() => void) | null = null;

afterEach(async () => {
  releaseChild?.();
  session?.dispose();
  session = null;
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
  if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  root = '';
});

type Body = { messages: { role: string; content?: unknown }[]; tools?: { function: { name: string } }[] };
const sse = (frames: unknown[]) =>
  [...frames.map((frame) => `data: ${JSON.stringify(frame)}\n`), 'data: [DONE]', ''].join('\n');
const textFrames = (content: string) => [
  { id: 'f', choices: [{ delta: { role: 'assistant', content } }] },
  { id: 'f', choices: [{ delta: {}, finish_reason: 'stop' }] },
];
const contentText = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
    ? content.map((part) => (part as { text?: string }).text ?? '').join('')
    : '';

it(
  'moves a running foreground explorer to the background and returns a running handle',
  { timeout: TIMEOUT_MS },
  async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-fg-transfer-e2e-')));
    const home = path.join(root, 'home');
    const workspace = path.join(root, 'w');
    fs.mkdirSync(home);
    fs.mkdirSync(workspace);
    const roots: Body[] = [];
    let childArrived = false;
    const childHeld = new Promise<void>((resolve) => (releaseChild = resolve));
    server = http.createServer((req, res) => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-alpha' }] }));
        return;
      }
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        const body = JSON.parse(raw) as Body;
        if (!body.tools?.some((tool) => tool.function.name === 'run_subagent')) {
          childArrived = true;
          void childHeld.then(() => {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.end(sse(textFrames('child evidence after transfer')));
          });
          return;
        }
        roots.push(body);
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (roots.length === 1) {
          res.end(
            sse([
              {
                id: 'f',
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: 'call_fg',
                          type: 'function',
                          function: {
                            name: 'run_subagent',
                            arguments: JSON.stringify({ execution: 'foreground', role: 'explorer', task: 'Hold on' }),
                          },
                        },
                      ],
                    },
                  },
                ],
              },
              { id: 'f', choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
            ]),
          );
          return;
        }
        res.end(sse(textFrames(roots.length === 2 ? 'root saw the handle' : 'root saw the notification')));
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/v1`;
    const idlePath = path.join(home, 'input-idle');
    const env = {
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      XDG_STATE_HOME: path.join(home, '.local', 'state'),
      XDG_CACHE_HOME: path.join(home, '.cache'),
      XDG_DATA_HOME: path.join(home, '.local', 'share'),
      XDG_RUNTIME_DIR: path.join(root, 'runtime'),
      TERM2_CONFIG_DIR: path.join(home, '.term2'),
      TERM2_CACHE_DIR: path.join(home, '.cache', 'term2'),
      TERM2_CONVERSATIONS_DIR: path.join(root, 'conversations'),
      DISABLE_LOGGING: '1',
      [HARNESS_IDLE_ENV]: idlePath,
      CI: 'false',
    };
    const settingsDir = resolveSettingsDirectory({ homeDir: home, env: createTestChildEnv(env) });
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(
      path.join(settingsDir, 'settings.json'),
      JSON.stringify({
        agent: { retryAttempts: 0, modelSelection: { model: 'mock-alpha', provider: 'mockprov' } },
        providers: [{ name: 'mockprov', type: 'openai-compatible', baseUrl, apiKey: 'test-key' }],
        sandbox: { enabled: false },
      }),
    );

    session = spawnTerminal('node', [builtCli], { cwd: workspace, env });
    await waitForHarnessIdleGeneration(idlePath, { timeoutMs: 60_000 });
    session.write('look it up');
    await waitForHarnessComposerValue(idlePath, 'look it up', { timeoutMs: 60_000 });
    session.write('\r');

    await expect.poll(() => childArrived, { timeout: 60_000 }).toBe(true);
    // The root turn is blocked on the foreground child: only one root request so far.
    expect(roots).toHaveLength(1);
    await session.waitForOutput('Hold on · Running', 60_000);
    session.write('\x07');
    await session.waitForOutput('[explorer · foreground]', 30_000);
    session.write('b');
    await session.waitForOutput('in the', 30_000);
    session.write('\r');
    await session.waitForOutput('Moved to background', 30_000);

    // The root turn continues with a running handle instead of a result, while the child is still held.
    await expect.poll(() => roots.length, { timeout: 30_000 }).toBe(2);
    const handle = JSON.parse(
      contentText(roots[1]!.messages.filter((message) => message.role === 'tool').at(-1)!.content),
    ) as { status: string; runId: string; hint: string };
    expect(handle.status).toBe('running');
    expect(handle.runId).toMatch(/\S/);
    expect(handle.hint).toContain('completion notification');

    // Releasing the same child delivers its result through the background notification turn.
    releaseChild!();
    await expect.poll(() => roots.length, { timeout: 60_000 }).toBe(3);
    const notification = roots[2]!.messages.map((message) => contentText(message.content)).join('\n');
    expect(notification).toContain('child evidence after transfer');
    expect(notification).toContain(handle.runId);
  },
);

// A background child cannot ask (background-approval-stop.e2e.test.ts); a foreground child's approval is a
// task interaction the terminal UI shows while the root turn waits, and the answer reaches the child.
it(
  'asks the user for a foreground explorer approval and returns the result in the same root turn',
  { timeout: TIMEOUT_MS },
  async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-fg-approval-e2e-')));
    const home = path.join(root, 'home');
    const workspace = path.join(root, 'w');
    fs.mkdirSync(home);
    fs.mkdirSync(workspace);
    const outside = path.join(root, 'outside.txt');
    fs.writeFileSync(outside, 'OUTSIDE_CONTENT_42');
    const roots: Body[] = [];
    const children: Body[] = [];
    server = http.createServer((req, res) => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-alpha' }] }));
        return;
      }
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        const body = JSON.parse(raw) as Body;
        const isRoot = Boolean(body.tools?.some((tool) => tool.function.name === 'run_subagent'));
        (isRoot ? roots : children).push(body);
        const call = (id: string, name: string, args: unknown) => [
          {
            id: 'f',
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
                },
              },
            ],
          },
          { id: 'f', choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ];
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        if (isRoot && roots.length === 1)
          return res.end(
            sse(call('call_fg', 'run_subagent', { execution: 'foreground', role: 'explorer', task: 'Read it' })),
          );
        if (isRoot) return res.end(sse(textFrames('ROOT_DONE')));
        if (children.length === 1) return res.end(sse(call('call_read', 'read_file', { path: outside })));
        const seen = body.messages
          .filter((message) => message.role === 'tool')
          .map((message) => contentText(message.content))
          .join(' ');
        return res.end(sse(textFrames(seen.includes('OUTSIDE_CONTENT_42') ? 'CHILD_READ_IT' : 'CHILD_DENIED')));
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/v1`;
    const idlePath = path.join(home, 'input-idle');
    const env = {
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      XDG_STATE_HOME: path.join(home, '.local', 'state'),
      XDG_CACHE_HOME: path.join(home, '.cache'),
      XDG_DATA_HOME: path.join(home, '.local', 'share'),
      XDG_RUNTIME_DIR: path.join(root, 'runtime'),
      TERM2_CONFIG_DIR: path.join(home, '.term2'),
      TERM2_CACHE_DIR: path.join(home, '.cache', 'term2'),
      TERM2_CONVERSATIONS_DIR: path.join(root, 'conversations'),
      DISABLE_LOGGING: '1',
      [HARNESS_IDLE_ENV]: idlePath,
      CI: 'false',
    };
    const settingsDir = resolveSettingsDirectory({ homeDir: home, env: createTestChildEnv(env) });
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(
      path.join(settingsDir, 'settings.json'),
      JSON.stringify({
        agent: { retryAttempts: 0, modelSelection: { model: 'mock-alpha', provider: 'mockprov' } },
        providers: [{ name: 'mockprov', type: 'openai-compatible', baseUrl, apiKey: 'test-key' }],
        sandbox: { enabled: false },
        shell: { autoApproveMode: 'off' },
      }),
    );

    session = spawnTerminal('node', [builtCli], { cwd: workspace, env });
    await waitForHarnessIdleGeneration(idlePath, { timeoutMs: 60_000 });
    session.write('read it');
    await waitForHarnessComposerValue(idlePath, 'read it', { timeoutMs: 60_000 });
    session.write('\r');

    await session.waitForOutput('Allow this read outside the workspace?', 60_000);
    expect(roots).toHaveLength(1);
    // A task approval publishes no readiness channel (it has no root call ID), and Ink subscribes the prompt's
    // input after it paints. Answer until the child's next request shows the answer landed.
    for (let attempt = 0; attempt < 20 && children.length < 2; attempt++) {
      session.write('y');
      await expect
        .poll(() => children.length, { timeout: 1_000 })
        .toBe(2)
        .catch(() => undefined);
    }
    await session.waitForOutput('ROOT_DONE', 60_000);
    expect(children).toHaveLength(2);
    expect(roots).toHaveLength(2);
    const toolResult = contentText(roots[1]!.messages.filter((message) => message.role === 'tool').at(-1)!.content);
    expect(toolResult).toMatch(/^Status: completed\n\nCHILD_READ_IT/);
  },
);
