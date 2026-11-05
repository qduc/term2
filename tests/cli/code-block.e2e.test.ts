import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testCliPath, spawnTerminal, createTestChildEnv, type TerminalSession } from '../helpers/terminal-e2e.js';
import {
  HARNESS_IDLE_ENV,
  waitForHarnessComposerValue,
  waitForHarnessIdleGeneration,
} from '../../rewrite/src/shared/lib/harness-input-idle.js';
import { resolveSettingsDirectory } from '../../rewrite/src/config/settings/settings-path.js';

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const builtCli = testCliPath(path.join(projectRoot, 'rewrite', 'dist', 'rewrite', 'src', 'app', 'cli.js'));
let root = '';
let session: TerminalSession | null = null;
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

it.each([60, 120])(
  'renders a long streamed code box within the old-CLI gutter at %i columns',
  { timeout: 120_000 },
  async (columns) => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-codebox-e2e-')));
    const home = path.join(root, 'home'),
      workspace = path.join(root, 'work');
    fs.mkdirSync(home);
    fs.mkdirSync(workspace);
    fs.mkdirSync(path.join(root, 'runtime'), { mode: 0o700 });
    const prelude = Array.from(
      { length: 30 },
      (_, i) =>
        `Paragraph ${String(i).padStart(2, '0')} explains the deterministic test and preserves host scrollback.`,
    ).join('\n\n');
    const code = `def add(a, b):\n    total = a + b\n    print("CODE_BOX_MARKER", total)\n    value = "${'Z'.repeat(
      130,
    )}"\n    return total`;
    const answer = `${prelude}\n\nBEFORE_CODE_BOX\n\n\`\`\`python\n${code}\n\`\`\`\n\nAFTER_CODE_BOX`;
    server = http.createServer((req, res) => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-alpha' }] }));
        return;
      }
      req.resume();
      req.on('end', () => {
        const id = 'codebox';
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const chunks = answer.match(/[\s\S]{1,64}/g) ?? [];
        let index = 0;
        const timer = setInterval(() => {
          const content = chunks[index++];
          if (content === undefined) {
            clearInterval(timer);
            res.end(
              `data: ${JSON.stringify({ id, choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
            );
          } else res.write(`data: ${JSON.stringify({ id, choices: [{ delta: { content } }] })}\n\n`);
        }, 10);
        res.on('close', () => clearInterval(timer));
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
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
        agent: {
          retryAttempts: 0,
          modelSelection: { provider: 'mockprov', model: 'mock-alpha' },
          contextCompaction: { enabled: false },
        },
        providers: [
          { name: 'mockprov', type: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'test-key' },
        ],
        sandbox: { enabled: false },
      }),
    );
    session = spawnTerminal('node', [builtCli], { cwd: workspace, env, cols: columns, rows: 24 });
    const idle = await waitForHarnessIdleGeneration(idlePath, { timeoutMs: 60_000 });
    session.write('show code box');
    await waitForHarnessComposerValue(idlePath, 'show code box', { timeoutMs: 30_000 });
    await new Promise((resolve) => setTimeout(resolve, 350));
    session.write('\r');
    await session.waitForOutput('AFTER_CODE_BOX', 60_000);
    await waitForHarnessIdleGeneration(idlePath, { after: idle, timeoutMs: 60_000 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const lines = session.getVisibleOutput().split('\n');
    const middle = lines.length - 1 - [...lines].reverse().findIndex((line) => line.includes('CODE_BOX_MARKER'));
    const reversedTop = lines
      .slice(0, middle)
      .reverse()
      .findIndex((line) => line.includes('╭'));
    const top = reversedTop < 0 ? -1 : middle - 1 - reversedTop;
    const bottom = lines.findIndex((line, index) => index > middle && line.includes('╰'));
    expect(top).toBeGreaterThanOrEqual(0);
    expect(bottom).toBeGreaterThan(top);
    const box = lines.slice(top, bottom + 1);
    const edge = columns - 3;
    expect(box[0]!.indexOf('╮')).toBe(edge);
    expect(box.at(-1)!.indexOf('╯')).toBe(edge);
    for (const line of box.slice(1, -1)) {
      expect(line.indexOf('│')).toBe(2);
      expect(line.lastIndexOf('│')).toBe(edge);
    }
    expect(box.filter((line) => line.includes('def add(a, b):'))).toHaveLength(1);
    expect(box.filter((line) => line.includes('total = a + b'))).toHaveLength(1);
    expect(box.filter((line) => line.includes('return total'))).toHaveLength(1);
    expect(box.slice(1, -1).every((line) => !/^\s*$/.test(line))).toBe(true);
  },
);
