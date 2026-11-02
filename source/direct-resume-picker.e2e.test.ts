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
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = '';
});

type Reply = { text?: string; hang?: boolean; partialTool?: boolean };

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
      const frames: object[] = [{ id, choices: [{ delta: { role: 'assistant', content: reply.text } }] }];
      // Tool-call output already seen: a steer waits for the normal boundary instead of interrupting the stream.
      if (reply.partialTool) {
        const call = {
          index: 0,
          id: 'call_p',
          type: 'function',
          function: { name: 'shell', arguments: '{"command":"sl' },
        };
        frames.push({ id, choices: [{ delta: { tool_calls: [call] } }] });
      }
      if (!reply.hang) frames.push({ id, choices: [{ delta: {}, finish_reason: 'stop' }] });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const body = frames.map((frame) => `data: ${JSON.stringify(frame)}\n`).join('\n');
      // A hanging reply streams its text and then never finishes, like a long answer being cut short.
      if (reply.hang) res.write(`${body}\n`);
      else res.end(`${body}\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/v1`;
}

it('opens a resume picker with a preview and switches to the selected session', { timeout: TIMEOUT_MS }, async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-resume-picker-')));
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'w');
  fs.mkdirSync(home);
  fs.mkdirSync(workspace);
  const baseUrl = await startProvider([{ text: 'PREVIOUS-ANSWER' }]);
  const idlePath = path.join(home, 'idle');
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
  const start = () => spawnTerminal('node', [builtCli], { cwd: workspace, env });
  const send = async (text: string) => {
    session!.write(text);
    await waitForHarnessComposerValue(idlePath, text, { timeoutMs: 60_000 });
    session!.write('\r');
  };
  session = start();
  const idle = await waitForHarnessIdleGeneration(idlePath, { timeoutMs: 60_000 });
  await send('previous unique prompt');
  await session.waitForOutput('PREVIOUS-ANSWER', 30_000);
  await waitForHarnessIdleGeneration(idlePath, { after: idle, timeoutMs: 60_000 });
  session.write('\x03');
  await session.waitForOutput('Press Ctrl+C again to exit', 30_000);
  session.write('\x03');
  await session.waitForExit(30_000);
  fs.rmSync(idlePath, { force: true });
  session = start();
  await waitForHarnessIdleGeneration(idlePath, { timeoutMs: 60_000 });
  await send('/resume ');
  await session.waitForOutput('Resume a conversation', 30_000);
  session.write('\x1b[B');
  await session.waitForOutput('Preview: previous unique prompt', 30_000);
  const offset = session.getVisibleOutput().length;
  session.write('\r');
  const started = Date.now();
  while (Date.now() - started < 30_000 && !session.getVisibleOutput().slice(offset).includes('PREVIOUS-ANSWER'))
    await new Promise((resolve) => setTimeout(resolve, 25));
  expect(session.getVisibleOutput().slice(offset)).toContain('PREVIOUS-ANSWER');
});
