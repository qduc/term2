import { expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnTerminal, testCliPath, createTestChildEnv } from './test-helpers/terminal-e2e.js';
import { resolveSettingsDirectory } from './services/settings/settings-path.js';
import {
  HARNESS_IDLE_ENV,
  waitForHarnessComposerValue,
  waitForHarnessIdleGeneration,
} from './lib/harness-input-idle.js';

const cli = testCliPath(fileURLToPath(new URL('../dist/rewrite/src/app/cli.js', import.meta.url)));

it.each(['expiry', 'configuration', 'secondary'] as const)(
  'shows genuine Codex quota and clears it on %s',
  async (clearBy) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-codex-quota-')));
    const home = path.join(root, 'home'),
      workspace = path.join(root, 'workspace'),
      codex = path.join(root, 'codex');
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
    let requests = 0;
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        requests++;
        const frames: unknown[] = [
          { type: 'response.created', response: { id: 'resp_' + requests, status: 'in_progress' } },
        ];
        if (requests === 2)
          frames.push({
            type: 'codex.rate_limits',
            rate_limits: {
              allowed: true,
              limit_reached: false,
              ...(clearBy === 'secondary'
                ? { primary: { window_minutes: 10080, used_percent: 101, reset_at: 1 } }
                : {}),
              [clearBy === 'secondary' ? 'secondary' : 'primary']: {
                window_minutes: 10080,
                used_percent: 37,
                reset_at: Math.floor(Date.now() / 1000) + (clearBy === 'expiry' ? 8 : 60),
                reset_after_seconds: 8,
              },
            },
          });
        frames.push(
          { type: 'response.output_text.delta', delta: `REPLY-${requests}` },
          {
            type: 'response.completed',
            response: {
              id: 'resp_' + requests,
              status: 'completed',
              output: [
                { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `REPLY-${requests}` }] },
              ],
            },
          },
        );
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no server');
    const idle = path.join(root, 'idle');
    const env = {
      HOME: home,
      CODEX_HOME: codex,
      CODEX_BASE_URL: `http://127.0.0.1:${address.port}`,
      XDG_CONFIG_HOME: path.join(home, 'config'),
      XDG_STATE_HOME: path.join(home, 'state'),
      XDG_DATA_HOME: path.join(home, 'data'),
      XDG_CACHE_HOME: path.join(home, 'cache'),
      TERM2_CONVERSATIONS_DIR: path.join(root, 'conversations'),
      DISABLE_LOGGING: '1',
      CI: 'false',
      [HARNESS_IDLE_ENV]: idle,
    };
    const settings = resolveSettingsDirectory({ homeDir: home, env: createTestChildEnv(env) });
    fs.mkdirSync(settings, { recursive: true });
    fs.writeFileSync(
      path.join(settings, 'settings.json'),
      JSON.stringify({
        agent: { modelSelection: { provider: 'codex', model: 'gpt-5.6-luna' }, transport: 'http', retryAttempts: 0 },
        ui: { skin: 'classic' },
        sandbox: { enabled: false },
      }),
    );
    const terminal = spawnTerminal('node', [cli], { cwd: workspace, env, cols: 120, rows: 40 });
    try {
      let generation = await waitForHarnessIdleGeneration(idle, { timeoutMs: 60000 });
      const submit = async (text: string) => {
        terminal.write(text);
        await waitForHarnessComposerValue(idle, text, { timeoutMs: 60000 });
        terminal.write('\r');
      };
      await submit('first');
      await terminal.waitForOutput('REPLY-1', 30000);
      generation = await waitForHarnessIdleGeneration(idle, { after: generation, timeoutMs: 60000 });
      expect(terminal.getVisibleOutput()).not.toContain('7D 37%');
      await submit('second');
      await terminal.waitForOutput('7D 37%', 30000);
      expect(terminal.getVisibleOutput()).toMatch(/7D 37%→\d\d\/\d\d/);
      const mark = terminal.getVisibleOutput().length;
      if (clearBy === 'expiry') {
        await new Promise((resolve) => setTimeout(resolve, 9000));
      } else if (clearBy === 'configuration') {
        await terminal.waitForOutput('REPLY-2', 30000);
        await waitForHarnessIdleGeneration(idle, { after: generation, timeoutMs: 60000 });
        // The /effort menu takes the Enter and applies the level silently, as legacy does.
        await submit('/effort high');
        await terminal.waitForOutput('· high', 30000);
      }
      if (clearBy !== 'secondary') {
        const updates = terminal.getVisibleOutput().slice(mark);
        expect(updates).toContain('Bare │ Codex/');
        expect(updates.slice(updates.lastIndexOf('Bare │ Codex/'))).not.toContain('7D 37%');
      }
      const logs = fs
        .readdirSync(path.join(root, 'conversations'))
        .filter((name) => name.endsWith('.jsonl'))
        .map((name) => fs.readFileSync(path.join(root, 'conversations', name), 'utf8'))
        .join('\n');
      expect(logs).not.toContain('codex_quota');
    } finally {
      terminal.dispose();
      await terminal.waitForExit(30000);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  },
  120000,
);
