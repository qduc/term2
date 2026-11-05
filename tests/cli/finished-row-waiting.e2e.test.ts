import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testCliPath, spawnTerminal, createTestChildEnv, type TerminalSession } from '../helpers/terminal-e2e.js';
import { resolveSettingsDirectory } from '../../rewrite/src/config/settings/settings-path.js';
import { getProviderIds } from '../../rewrite/src/model/providers/index.js';

// Built direct CLI, loopback provider. While a later call waits for approval, legacy draws every live row as
// "○ … (waiting)", finished ones included. A confirmed legacy bug (#136 item 8, #150): next keeps a finished row's
// final status.
const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const builtCli = testCliPath(path.join(projectRoot, 'rewrite', 'dist', 'rewrite', 'src', 'app', 'cli.js'));

let session: TerminalSession | null = null;
let root = '';
let server: http.Server | null = null;

afterEach(async () => {
  session?.dispose();
  session = null;
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
  if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  root = '';
});

/** Two shell calls in one response: a read-only `ls` that runs at once, then an `rm` that needs approval. */
function startProvider(): Promise<string> {
  let posts = 0;
  server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [] }));
      return;
    }
    req.resume();
    req.on('end', () => {
      posts += 1;
      const id = `chatcmpl-${posts}`;
      const call = (index: number, command: string) => ({
        index,
        id: `call_${index}`,
        type: 'function',
        function: { name: 'shell', arguments: JSON.stringify({ command }) },
      });
      const delta =
        posts === 1
          ? { role: 'assistant', tool_calls: [call(0, 'ls')] }
          : posts === 2
          ? { role: 'assistant', tool_calls: [call(0, 'rm -f gone.txt')] }
          : { role: 'assistant', content: 'AFTER-TOOLS' };
      const frames = [
        { id, choices: [{ delta }] },
        { id, choices: [{ delta: {}, finish_reason: posts <= 2 ? 'tool_calls' : 'stop' }] },
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

it('a finished row keeps its status while a later call waits for approval', { timeout: 120_000 }, async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-finished-row-')));
  const home = path.join(root, 'home');
  const work = path.join(root, 'w');
  fs.mkdirSync(home);
  fs.mkdirSync(work);
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
  });
  const settingsDir = resolveSettingsDirectory({ homeDir: home, env });
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(
    path.join(settingsDir, 'settings.json'),
    JSON.stringify({
      agent: { retryAttempts: 0, disabledProviders: getProviderIds() },
      providers: [{ name: 'mockprov', type: 'openai-compatible', baseUrl, apiKey: 'test-key' }],
      sandbox: { enabled: false },
      shell: { autoApproveMode: 'off' },
    }),
  );

  session = spawnTerminal('node', [builtCli, '-m', 'mockprov/mock-alpha'], { cwd: work, env, cols: 100, rows: 34 });
  await session.waitForOutput('/ commands │ @ paths │ ! shell', 60_000);
  session.write('go');
  await new Promise((resolve) => setTimeout(resolve, 200));
  session.write('\r');
  await session.waitForOutput('Allow this action?', 30_000);
  await new Promise((resolve) => setTimeout(resolve, 500));

  const screen = session.getVisibleOutput();
  const lsRow = screen.split('\n').find((line) => /\bls \(\d+ms\)/.test(line));
  expect(lsRow, screen).toBeDefined();
  expect(lsRow).toContain('✓');
  expect(lsRow).not.toContain('(waiting)');
});
