import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testCliPath, spawnTerminal, createTestChildEnv, type TerminalSession } from './test-helpers/terminal-e2e.js';
import {
  HARNESS_IDLE_ENV,
  waitForHarnessComposerValue,
  waitForHarnessIdleGeneration,
} from './lib/harness-input-idle.js';
import { resolveSettingsDirectory } from './services/settings/settings-path.js';

// Runs the built terminal UI (`pnpm build` output, as CI does before test:e2e) in a real pty against
// an OpenAI-compatible chat-completions double, and reads what the terminal rendered.
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const builtCli = testCliPath(path.join(projectRoot, 'rewrite', 'dist', 'rewrite', 'src', 'app', 'cli.js'));
const TIMEOUT_MS = 120_000;

let session: TerminalSession | null = null;
let root = '';
let server: http.Server | null = null;

afterEach(async () => {
  session?.dispose();
  session = null;
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = '';
});

type Reply = { call?: { id: string; command?: string; tool?: string; args?: object }; text?: string };

/** One SSE reply per chat request, in order: a single shell call or plain text. */
async function startProvider(replies: Reply[]): Promise<string> {
  let requests = 0;
  server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-alpha' }] }));
      return;
    }
    req.resume();
    req.on('end', () => {
      const reply = replies[requests++] ?? { text: 'done' };
      const id = `chatcmpl-${requests}`;
      const frames = reply.call
        ? [
            {
              id,
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: reply.call.id,
                        type: 'function',
                        function: {
                          name: reply.call.tool ?? 'shell',
                          arguments: JSON.stringify(reply.call.args ?? { command: reply.call.command }),
                        },
                      },
                    ],
                  },
                },
              ],
            },
            { id, choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
          ]
        : [
            { id, choices: [{ delta: { role: 'assistant', content: reply.text } }] },
            { id, choices: [{ delta: {}, finish_reason: 'stop' }] },
          ];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end([...frames.map((frame) => `data: ${JSON.stringify(frame)}\n`), 'data: [DONE]', ''].join('\n'));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/v1`;
}

// A subagent's deltas, usage and turn markers update its task row; they are not transcript lines.
it('a subagent run adds no per-event lines to the transcript', { timeout: TIMEOUT_MS }, async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-subagent-events-e2e-')));
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'w');
  fs.mkdirSync(home);
  fs.mkdirSync(workspace);
  const { execFileSync } = await import('node:child_process');
  // Git sees only this run's directory: not the real HOME, global config or system config.
  const gitEnv = {
    PATH: process.env.PATH,
    HOME: home,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const g = (...a: string[]) => execFileSync('git', a, { cwd: workspace, stdio: 'pipe', env: gitEnv });
  g('init', '-q');
  g('config', 'user.email', 'a@b.c');
  g('config', 'user.name', 'x');
  fs.writeFileSync(path.join(workspace, 'f'), 'x');
  g('add', '.');
  g('commit', '-qm', 'i');
  g('worktree', 'add', '-q', path.join(root, 'wt'));
  const baseUrl = await startProvider([
    {
      call: {
        id: 'call_0',
        tool: 'run_subagent',
        args: { role: 'explorer', execution: 'background', task: 'run echo sub in the shell then report' },
      },
    },
    { call: { id: 'call_s', command: 'echo sub' } },
    { text: 'sub finished' },
    { text: 'parent finished' },
  ]);
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
    // Ink suppresses dynamic terminal updates in CI mode; this test needs an interactive TUI.
    CI: 'false',
  };
  const settingsDir = resolveSettingsDirectory({ homeDir: home, env: createTestChildEnv(env) });
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(
    path.join(settingsDir, 'settings.json'),
    JSON.stringify({
      agent: { retryAttempts: 0, modelSelection: { model: 'mock-alpha', provider: 'mockprov' } },
      providers: [{ name: 'mockprov', type: 'openai-compatible', baseUrl, apiKey: 'test-key' }],
      // Sandbox off and GREEN commands: both run without an approval prompt.
      sandbox: { enabled: false },
    }),
  );

  session = spawnTerminal('node', [builtCli], { cwd: path.join(root, 'wt'), env });
  const idle = await waitForHarnessIdleGeneration(idlePath, { timeoutMs: 60_000 });

  // Submit only once the composer holds the text; Enter in the same write is taken as pasted input.
  const submit = async (text: string) => {
    session!.write(text);
    await waitForHarnessComposerValue(idlePath, text, { timeoutMs: 60_000 });
    session!.write('\r');
  };

  await submit('use a subagent');
  await session.waitForOutput('parent finished', 60_000);
  // Positive control, read from the durable log rather than the screen (a settled task leaves the live
  // panel): the child task started and finished, so its events had all arrived before the check below.
  const logged = async () => {
    const dir = path.join(root, 'conversations');
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl')) : [];
    return files.map((name) => fs.readFileSync(path.join(dir, name), 'utf8')).join('\n');
  };
  const deadline = Date.now() + 60_000;
  let log = await logged();
  const settled = () => {
    const facts = log.split('\n').flatMap((line) => {
      try {
        return [JSON.parse(line).fact as { type: string; taskId?: string; task?: { taskId?: string; kind?: string } }];
      } catch {
        return [];
      }
    });
    const child = facts.find((fact) => fact.type === 'task_started' && fact.task?.kind === 'subagent')?.task?.taskId;
    return child !== undefined && facts.some((fact) => fact.type === 'task_finished' && fact.taskId === child);
  };
  while (!settled() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    log = await logged();
  }
  expect(settled(), 'the subagent task started and finished in the log').toBe(true);
  const visible = session.getVisibleOutput();
  expect(visible, visible).toContain('parent finished');
  expect(visible, visible).not.toMatch(/subagent: explorer/);
});
