import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testCliPath, spawnTerminal, createTestChildEnv, type TerminalSession } from '../helpers/terminal-e2e.js';
import { resolveSettingsDirectory } from '../../rewrite/src/config/settings/settings-path.js';
import { getProviderIds } from '../../rewrite/src/model/providers/index.js';

// Built direct CLI, loopback provider. A background child can't ask the user, so a call that needs approval ends
// its run. Legacy reports that run as "completed" with an empty result, which hides the stop from the model: a
// confirmed legacy bug (#136 item 11, #150). Next reports a failed run that names the call.
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const builtCli = testCliPath(path.join(projectRoot, 'rewrite', 'dist', 'rewrite', 'src', 'app', 'cli.js'));

let session: TerminalSession | null = null;
let root = '';
let server: http.Server | null = null;
const parentMessages: string[] = [];
let childPosts = 0;

afterEach(async () => {
  session?.dispose();
  session = null;
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
  parentMessages.length = 0;
  childPosts = 0;
  if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  root = '';
});

type Delta = Record<string, unknown>;
const toolCall = (name: string, args: Record<string, unknown>): Delta => ({
  role: 'assistant',
  tool_calls: [{ index: 0, id: `call_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});

function startProvider(): Promise<string> {
  let parentPosts = 0;
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
      const child = String(messages[0]?.content ?? '').startsWith('You are a nested subagent');
      let delta: Delta;
      if (child) {
        childPosts += 1;
        // A read outside the workspace needs approval; a second child request would mean it ran anyway.
        delta =
          childPosts === 1
            ? toolCall('read_file', { path: '/etc/hostname' })
            : { role: 'assistant', content: 'CHILD-RAN' };
      } else {
        parentPosts += 1;
        for (const message of messages) parentMessages.push(JSON.stringify(message.content ?? ''));
        delta =
          parentPosts === 1
            ? toolCall('run_subagent', { execution: 'background', role: 'explorer', task: 'Read the hostname' })
            : { role: 'assistant', content: parentPosts === 2 ? 'LAUNCHED' : 'NOTED' };
      }
      const id = `chatcmpl-${parentPosts}-${childPosts}`;
      const toolTurn = 'tool_calls' in delta;
      const frames = [
        { id, choices: [{ delta }] },
        { id, choices: [{ delta: {}, finish_reason: toolTurn ? 'tool_calls' : 'stop' }] },
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

it(
  'a background child stopped by an approval reports a failed run that names the call',
  { timeout: 120_000 },
  async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-bg-approval-stop-')));
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

    session = spawnTerminal('node', [builtCli, '-m', 'mockprov/mock-alpha'], {
      cwd: path.join(root, 'w'),
      env,
      cols: 100,
      rows: 34,
    });
    await session.waitForOutput('/ commands │ @ paths │ ! shell', 60_000);
    session.write('delegate it');
    await new Promise((resolve) => setTimeout(resolve, 200));
    session.write('\r');
    await session.waitForOutput('Failed (read_file needed approval', 60_000);
    await session.waitForOutput('NOTED', 30_000);

    // The read never ran: the child sent one request and got no second turn.
    expect(childPosts).toBe(1);
    const notice = parentMessages.find((message) => message.includes('Background subagent run finished'));
    expect(notice, parentMessages.join('\n')).toBeDefined();
    expect(notice).toContain('status: failed');
    expect(notice).toContain("read_file needed approval; a background run can't ask");
    expect(notice).not.toContain('status: completed');
    expect(session.getVisibleOutput()).toContain('✗ Failed (read_file needed approval');
  },
);
