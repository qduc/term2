import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnTerminal, testCliPath, createTestChildEnv, type TerminalSession } from '../helpers/terminal-e2e.js';
import { resolveSettingsDirectory } from '../../src/config/settings/settings-path.js';
import {
  HARNESS_IDLE_ENV,
  waitForHarnessComposerValue,
  waitForHarnessIdleGeneration,
} from '../../src/shared/lib/harness-input-idle.js';

const builtCli = testCliPath(fileURLToPath(new URL('../../dist/src/app/cli.js', import.meta.url)));

let session: TerminalSession | null = null;
let server: http.Server | null = null;
let root = '';
let finishThinking: (() => void) | undefined;

afterEach(async () => {
  session?.dispose();
  session = null;
  finishThinking?.();
  finishThinking = undefined;
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
  if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  root = '';
});

it('shows Thinking status when a Responses model starts reasoning without summary deltas', async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-thinking-status-')));
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  const codex = path.join(root, 'codex');
  fs.mkdirSync(home);
  fs.mkdirSync(workspace);
  fs.mkdirSync(codex);
  const jwt = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  fs.writeFileSync(
    path.join(codex, 'auth.json'),
    JSON.stringify({
      tokens: {
        access_token: `${jwt({ alg: 'none' })}.${jwt({ exp: Math.floor(Date.now() / 1000) + 3600 })}.fixture`,
        refresh_token: 'fixture',
        account_id: 'fixture',
      },
    }),
  );

  server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const writeEvent = (frame: unknown) => {
        res.write(`data: ${JSON.stringify(frame)}\n\n`);
      };
      writeEvent({ type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } });
      writeEvent({
        type: 'response.output_item.added',
        output_index: 0,
        item: { id: 'rs_1', type: 'reasoning', summary: [] },
      });
      finishThinking = () => {
        if (res.writableEnded) return;
        writeEvent({
          type: 'response.output_item.done',
          output_index: 0,
          item: { id: 'rs_1', type: 'reasoning', summary: [] },
        });
        writeEvent({
          type: 'response.output_item.added',
          output_index: 1,
          item: { id: 'msg_1', type: 'message', role: 'assistant', status: 'in_progress', content: [] },
        });
        writeEvent({
          type: 'response.output_text.delta',
          item_id: 'msg_1',
          output_index: 1,
          content_index: 0,
          delta: 'thinking status verified',
        });
        writeEvent({
          type: 'response.completed',
          response: {
            id: 'resp_1',
            status: 'completed',
            output: [
              { id: 'rs_1', type: 'reasoning', summary: [] },
              {
                id: 'msg_1',
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text: 'thinking status verified' }],
              },
            ],
            usage: {
              input_tokens: 10,
              output_tokens: 20,
              input_tokens_details: { cached_tokens: 0 },
              output_tokens_details: { reasoning_tokens: 15 },
            },
          },
        });
        res.write('data: [DONE]\n\n');
        res.end();
      };
    });
  });

  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const idlePath = path.join(root, 'idle.json');
  const env = createTestChildEnv({
    HOME: home,
    CODEX_HOME: codex,
    CODEX_BASE_URL: `http://127.0.0.1:${port}`,
    XDG_CONFIG_HOME: path.join(home, 'config'),
    XDG_STATE_HOME: path.join(home, 'state'),
    XDG_DATA_HOME: path.join(home, 'data'),
    XDG_CACHE_HOME: path.join(home, 'cache'),
    TERM2_CONVERSATIONS_DIR: path.join(root, 'conversations'),
    DISABLE_LOGGING: '1',
    CI: 'false',
    [HARNESS_IDLE_ENV]: idlePath,
  });
  const settingsDir = resolveSettingsDirectory({ env, homeDir: home });
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(
    path.join(settingsDir, 'settings.json'),
    JSON.stringify({
      agent: {
        retryAttempts: 0,
        transport: 'http',
        modelSelection: { provider: 'codex', model: 'gpt-5.4' },
      },
      sandbox: { enabled: false },
    }),
  );

  session = spawnTerminal('node', [builtCli], { cwd: workspace, env, cols: 140, rows: 40 });
  const idle = await waitForHarnessIdleGeneration(idlePath, { timeoutMs: 60_000 });
  session.write('hi');
  await waitForHarnessComposerValue(idlePath, 'hi', { timeoutMs: 60_000 });
  session.write('\r');

  await session.waitForOutput('Thinking ·', 30_000);
  const liveFrame = session.getVisibleOutput().slice(session.getVisibleOutput().lastIndexOf('▌ term²'));
  expect(liveFrame).toMatch(/Thinking · \d+s/);

  finishThinking!();
  finishThinking = undefined;
  await session.waitForOutput('thinking status verified', 30_000);
  await waitForHarnessIdleGeneration(idlePath, { after: idle, timeoutMs: 60_000 });
}, 90_000);
