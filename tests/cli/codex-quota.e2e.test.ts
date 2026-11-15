import { expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnTerminal, testCliPath, createTestChildEnv } from '../helpers/terminal-e2e.js';
import { resolveSettingsDirectory } from '../../src/config/settings/settings-path.js';
import {
  HARNESS_IDLE_ENV,
  waitForHarnessComposerValue,
  waitForHarnessIdleGeneration,
} from '../../src/shared/lib/harness-input-idle.js';

const cli = testCliPath(fileURLToPath(new URL('../../dist/src/app/cli.js', import.meta.url)));
// Seconds until the 'expiry' case's quota window resets; the footer drops it on a timer at that moment.
const EXPIRY_S = 4;

it.each(['expiry', 'five-hour-expiry', 'configuration', 'secondary', 'five-hour-only', 'invalid', 'missing'] as const)(
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
        if (requests === 2 || (requests === 3 && (clearBy === 'invalid' || clearBy === 'missing')))
          frames.push({
            type: 'codex.rate_limits',
            rate_limits: {
              allowed: true,
              limit_reached: false,
              ...(clearBy === 'secondary'
                ? { primary: { window_minutes: 10080, used_percent: 101, reset_at: 1 } }
                : {}),
              ...(clearBy !== 'secondary' && (requests === 2 || clearBy === 'invalid')
                ? {
                    secondary: {
                      window_minutes: 300,
                      used_percent: requests === 3 ? 101 : 12,
                      reset_at: Math.floor(Date.now() / 1000) + (clearBy === 'five-hour-expiry' ? EXPIRY_S : 60),
                      reset_after_seconds: EXPIRY_S,
                    },
                  }
                : {}),
              ...(clearBy === 'five-hour-only'
                ? {}
                : {
                    [clearBy === 'secondary' ? 'secondary' : 'primary']: {
                      window_minutes: 10080,
                      used_percent: 37,
                      // Whole seconds: enough time to observe the initial render before expiry.
                      reset_at: Math.floor(Date.now() / 1000) + (clearBy === 'expiry' ? EXPIRY_S : 60),
                      reset_after_seconds: EXPIRY_S,
                    },
                  }),
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
      if (clearBy === 'five-hour-only') {
        await terminal.waitForOutput('5H 12%', 30000);
        expect(terminal.getVisibleOutput()).not.toContain('7D 37%');
      } else {
        await terminal.waitForOutput('7D 37%', 30000);
        // The fixture resets within a minute, so the weekly window shows a future clock
        // time; a run that crosses midnight instead falls back to the reset date.
        expect(terminal.getVisibleOutput()).toMatch(/7D 37%→(\d\d:\d\d|\d\d\/\d\d)/);
      }
      if (clearBy !== 'secondary') expect(terminal.getVisibleOutput()).toContain('5H 12%');
      const mark = terminal.getVisibleOutput().length;
      if (clearBy === 'expiry' || clearBy === 'five-hour-expiry') {
        // When only the five-hour window resets, the weekly window must survive that redraw.
        await expect
          .poll(
            () => {
              const updates = terminal.getVisibleOutput().slice(mark);
              const at = updates.lastIndexOf('Codex/');
              return (
                at >= 0 &&
                (clearBy === 'expiry'
                  ? !updates.slice(at).includes('7D 37%') && updates.slice(at).includes('5H 12%')
                  : updates.slice(at).includes('7D 37%') && !updates.slice(at).includes('5H 12%'))
              );
            },
            { timeout: 30000, interval: 100 },
          )
          .toBe(true);
      } else if (clearBy === 'configuration') {
        await terminal.waitForOutput('REPLY-2', 30000);
        await waitForHarnessIdleGeneration(idle, { after: generation, timeoutMs: 60000 });
        // The /effort menu takes the Enter and applies the level silently, as legacy does.
        await submit('/effort high');
        await terminal.waitForOutput('· high', 30000);
      } else if (clearBy === 'invalid' || clearBy === 'missing') {
        await terminal.waitForOutput('REPLY-2', 30000);
        generation = await waitForHarnessIdleGeneration(idle, { after: generation, timeoutMs: 60000 });
        await submit('third');
        await terminal.waitForOutput('REPLY-3', 30000);
        await waitForHarnessIdleGeneration(idle, { after: generation, timeoutMs: 60000 });
        const updates = terminal.getVisibleOutput().slice(mark);
        expect(updates.slice(updates.lastIndexOf('Codex/'))).toContain('7D 37%');
        expect(updates.slice(updates.lastIndexOf('Codex/'))).not.toContain('5H 12%');
      }
      if (clearBy === 'configuration') {
        const updates = terminal.getVisibleOutput().slice(mark);
        expect(updates).toContain('Codex/');
        expect(updates.slice(updates.lastIndexOf('Codex/'))).not.toContain('7D 37%');
        expect(updates.slice(updates.lastIndexOf('Codex/'))).not.toContain('5H 12%');
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
