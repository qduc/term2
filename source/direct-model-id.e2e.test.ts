import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testCliPath, spawnTerminal, createTestChildEnv, type TerminalSession } from './test-helpers/terminal-e2e.js';
import { HARNESS_IDLE_ENV } from './lib/harness-input-idle.js';
import { resolveSettingsDirectory } from './services/settings/settings-path.js';
import { getProviderIds } from './providers/index.js';

// Built direct CLI, loopback provider. Proves `-m provider/model` reaches the provider as the bare id.
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const builtCli = testCliPath(path.join(projectRoot, 'rewrite', 'dist', 'rewrite', 'src', 'app', 'cli.js'));

let session: TerminalSession | null = null;
let root = '';
let server: http.Server | null = null;
const wireModels: string[] = [];

afterEach(async () => {
  session?.dispose();
  session = null;
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
  wireModels.length = 0;
  if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  root = '';
});

function startProvider(): Promise<string> {
  server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      // Empty catalog: resolution has to fail open instead of matching a row.
      res.end(JSON.stringify({ object: 'list', data: [] }));
      return;
    }
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      wireModels.push(JSON.parse(body).model as string);
      const id = `chatcmpl-${wireModels.length}`;
      const frames = [
        { id, choices: [{ delta: { role: 'assistant', content: `REPLY-${wireModels.length}` } }] },
        { id, choices: [{ delta: {}, finish_reason: 'stop' }] },
      ];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`${frames.map((frame) => `data: ${JSON.stringify(frame)}\n`).join('\n')}\ndata: [DONE]\n\n`);
    });
  });
  return new Promise((resolve) => {
    server!.listen(0, '127.0.0.1', () => {
      const address = server!.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve(`http://127.0.0.1:${port}/v1`);
    });
  });
}

function conversationModel(): { provider: string; model: string } {
  const name = fs.readdirSync(path.join(root, 'conversations')).find((entry) => entry.endsWith('.jsonl'));
  if (!name) throw new Error('no conversation log');
  const fact = JSON.parse(fs.readFileSync(path.join(root, 'conversations', name), 'utf8').split('\n')[0]!).fact;
  return fact.model;
}

async function launch(env: NodeJS.ProcessEnv, args: string[]) {
  session?.dispose();
  session = spawnTerminal('node', [builtCli, '-m', 'mockprov/mock-alpha', '-r', 'medium', ...args], {
    cwd: path.join(root, 'w'),
    env,
    cols: 120,
    rows: 32,
  });
  await session.waitForOutput('/ commands │ @ paths │ ! shell', 60_000);
}

async function exitCli() {
  session!.write('\x03');
  await session!.waitForOutput('Press Ctrl+C again to exit', 30_000);
  session!.write('\x03');
  await session!.waitForExit(30_000);
}

async function admitNext() {
  const next = wireModels.length + 1;
  session!.write('DROPCHECK');
  await new Promise((resolve) => setTimeout(resolve, 200));
  session!.write('\r');
  await session!.waitForOutput(`REPLY-${next}`, 30_000);
}

function expectBareModel(where: string) {
  const visible = session!.getVisibleOutput();
  expect(visible, where).not.toContain('mockprov/mockprov');
  expect(visible, where).toContain('mockprov/mock-alpha');
  expect(wireModels.at(-1), where).toBe('mock-alpha');
  expect(conversationModel(), where).toEqual({ provider: 'mockprov', model: 'mock-alpha' });
}

it.each([
  ['scratch settings, empty catalog', false],
  ['saved default, harness skips the catalog', true],
] as const)(
  '-m provider/model stays a bare id on launch and resume (%s)',
  { timeout: 120_000 },
  async (_label, harness) => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-model-id-')));
    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    fs.mkdirSync(path.join(root, 'w'));
    const baseUrl = await startProvider();
    const env = createTestChildEnv({
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
      CI: 'false',
      ...(harness ? { [HARNESS_IDLE_ENV]: path.join(home, 'input-idle') } : {}),
    });
    const settingsDir = resolveSettingsDirectory({ homeDir: home, env });
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(
      path.join(settingsDir, 'settings.json'),
      JSON.stringify({
        agent: harness
          ? { retryAttempts: 0, modelSelection: { model: 'mock-beta', provider: 'mockprov' } }
          : { retryAttempts: 0, disabledProviders: getProviderIds() },
        providers: [{ name: 'mockprov', type: 'openai-compatible', baseUrl, apiKey: 'test-key' }],
        sandbox: { enabled: false },
      }),
    );

    await launch(env, []);
    await admitNext();
    expectBareModel('fresh');
    const id = fs
      .readdirSync(path.join(root, 'conversations'))
      .find((entry) => entry.endsWith('.jsonl'))!
      .replace(/\.jsonl$/, '');
    await exitCli();

    await launch(env, ['--resume', id]);
    await admitNext();
    expectBareModel('resume');
    expect(wireModels).toEqual(['mock-alpha', 'mock-alpha']);
    await exitCli();
  },
);
