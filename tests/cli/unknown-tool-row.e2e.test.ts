import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testCliPath, spawnTerminal, createTestChildEnv, type TerminalSession } from '../helpers/terminal-e2e.js';
import { resolveSettingsDirectory } from '../../rewrite/src/config/settings/settings-path.js';
import { getProviderIds } from '../../rewrite/src/model/providers/index.js';

// Built direct CLI, loopback provider. A call to a tool the turn didn't offer never runs; legacy still draws it as a
// green "✓" row. That is a confirmed legacy bug (#136 item 14, #150): next draws it as a failed "✗" row with the
// result text the model received.
const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const builtCli = testCliPath(path.join(projectRoot, 'rewrite', 'dist', 'rewrite', 'src', 'app', 'cli.js'));

let session: TerminalSession | null = null;
let root = '';
let server: http.Server | null = null;
const toolResults: string[] = [];

afterEach(async () => {
  session?.dispose();
  session = null;
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
  toolResults.length = 0;
  if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  root = '';
});

/** First POST asks for `tool`; every later one answers with text. */
function startProvider(tool: string, args: Record<string, unknown>): Promise<string> {
  let posts = 0;
  server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [] }));
      return;
    }
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const messages = (JSON.parse(body).messages ?? []) as { role: string; content?: unknown }[];
      for (const message of messages) if (message.role === 'tool') toolResults.push(String(message.content));
      posts += 1;
      const id = `chatcmpl-${posts}`;
      const delta =
        posts === 1
          ? {
              role: 'assistant',
              tool_calls: [
                { index: 0, id: 'call_1', type: 'function', function: { name: tool, arguments: JSON.stringify(args) } },
              ],
            }
          : { role: 'assistant', content: 'AFTER-TOOL' };
      const frames = [
        { id, choices: [{ delta }] },
        { id, choices: [{ delta: {}, finish_reason: posts === 1 ? 'tool_calls' : 'stop' }] },
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

it.each([
  // A name no profile has.
  ['frobnicate', {}, '✗ frobnicate'],
  // A real tool Bare doesn't offer: its row must not claim the file was created.
  ['create_file', { path: 'note.txt', content: 'hello\n' }, '✗ Created "note.txt"'],
] as const)('an unknown tool call (%s) is drawn as a failed row', { timeout: 120_000 }, async (tool, args, row) => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-unknown-tool-')));
  const home = path.join(root, 'home');
  const work = path.join(root, 'w');
  fs.mkdirSync(home);
  fs.mkdirSync(work);
  const baseUrl = await startProvider(tool, args);
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
    }),
  );

  session = spawnTerminal('node', [builtCli, '-m', 'mockprov/mock-alpha'], { cwd: work, env, cols: 100, rows: 34 });
  await session.waitForOutput('/ commands │ @ paths │ ! shell', 60_000);
  session.write('go');
  await new Promise((resolve) => setTimeout(resolve, 200));
  session.write('\r');
  await session.waitForOutput('AFTER-TOOL', 30_000);

  const visible = session.getVisibleOutput();
  expect(toolResults).toEqual([`Unknown tool: ${tool}`]);
  expect(visible).toContain(row);
  expect(visible).toContain(`Unknown tool: ${tool}`);
  expect(visible).not.toMatch(new RegExp(`✓ (${tool}|Created)`));
  // Nothing ran.
  expect(fs.readdirSync(work)).toEqual([]);
});
