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
let providerRequests = 0;
const requests: string[] = [];

afterEach(async () => {
  session?.dispose();
  session = null;
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = '';
  providerRequests = 0;
  requests.length = 0;
});

type Reply = { text?: string; hang?: boolean; partialTool?: boolean };

/** One SSE reply per chat request, in order: a single shell call or plain text. */
async function startProvider(replies: Reply[]): Promise<string> {
  let requestCount = 0;
  server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-alpha' }] }));
      return;
    }
    providerRequests += 1;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      requests.push(Buffer.concat(chunks).toString());
      const reply = replies[requestCount++] ?? { text: 'done' };
      const id = `chatcmpl-${requestCount}`;
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

it('sends clean text and pasted PNG attachments without exposing editor markers', { timeout: TIMEOUT_MS }, async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-image-pty-')));
  const home = path.join(root, 'home'),
    workspace = path.join(root, 'work'),
    bin = path.join(root, 'bin');
  for (const dir of [home, workspace, bin]) fs.mkdirSync(dir);
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aWQAAAAASUVORK5CYII=',
    'base64',
  );
  fs.writeFileSync(path.join(root, 'pixel.png'), png);
  fs.writeFileSync(path.join(bin, 'xclip'), `#!/bin/sh\ncat '${path.join(root, 'pixel.png')}'\n`, { mode: 0o755 });
  const baseUrl = await startProvider([{ text: 'IMAGE-REPLY' }, { text: 'HISTORY-REPLY' }]);
  const idlePath = path.join(home, 'idle');
  const env = {
    HOME: home,
    PATH: `${bin}:${process.env.PATH}`,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_STATE_HOME: path.join(home, '.local/state'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_DATA_HOME: path.join(home, '.local/share'),
    XDG_RUNTIME_DIR: path.join(root, 'runtime'),
    TERM2_CONFIG_DIR: path.join(home, '.term2'),
    TERM2_CACHE_DIR: path.join(home, '.cache/term2'),
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
  const idle = await waitForHarnessIdleGeneration(idlePath, { timeoutMs: 60_000 });
  session.write('IMAGE-CHECK ');
  await waitForHarnessComposerValue(idlePath, 'IMAGE-CHECK ', { timeoutMs: 60_000 });
  session.write('\x16');
  await session.waitForOutput('[Pasted Image #1]', 30_000);
  session.write('\x16');
  await session.waitForOutput('[Pasted Image #2]', 30_000);
  session.write(' after');
  await session.waitForOutput(' after', 30_000);
  session.write('\r');
  await session.waitForOutput('IMAGE-REPLY', 30_000);
  const request = requests.find((entry) => entry.includes('IMAGE-CHECK'));
  expect(request).toBeDefined();
  expect(request).not.toMatch(/[\uE000\uE001]/);
  expect(request!.match(/data:image\/png;base64/g) ?? []).toHaveLength(2);
  expect(session.getVisibleOutput()).toContain('[2 images attached]');
  const user = JSON.parse(request!).messages.findLast((message: { role: string }) => message.role === 'user');
  expect(
    user.content
      .filter((part: { type: string }) => part.type === 'text')
      .map((part: { text: string }) => part.text)
      .join(''),
  ).toBe('IMAGE-CHECK  after');
  expect(
    user.content
      .filter((part: { type: string }) => part.type === 'image_url')
      .map((part: { image_url: { url: string } }) => part.image_url.url),
  ).toEqual([`data:image/png;base64,${png.toString('base64')}`, `data:image/png;base64,${png.toString('base64')}`]);
  await waitForHarnessIdleGeneration(idlePath, { after: idle, timeoutMs: 60_000 });
  await waitForHarnessComposerValue(idlePath, '', { timeoutMs: 60_000 });
  session.write('\x1b[A');
  await waitForHarnessComposerValue(idlePath, 'IMAGE-CHECK  after', { timeoutMs: 60_000 });
  session.write('\r');
  await session.waitForOutput('HISTORY-REPLY', 30_000);
  const replay = requests.filter((entry) => entry.includes('IMAGE-CHECK')).at(-1)!;
  expect(replay).not.toMatch(/[\uE000\uE001]/);
  const replayUser = JSON.parse(replay).messages.findLast((message: { role: string }) => message.role === 'user');
  expect(
    replayUser.content
      .filter((part: { type: string }) => part.type === 'image_url')
      .map((part: { image_url: { url: string } }) => part.image_url.url),
  ).toEqual([`data:image/png;base64,${png.toString('base64')}`, `data:image/png;base64,${png.toString('base64')}`]);
});
