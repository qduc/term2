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
} from '../../src/shared/lib/harness-input-idle.js';
import { resolveSettingsDirectory } from '../../src/config/settings/settings-path.js';

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const builtCli = testCliPath(path.join(projectRoot, 'dist', 'src', 'app', 'cli.js'));
let root = '';
let session: TerminalSession | null = null;
let server: http.Server | null = null;
let metrics: Record<string, unknown> = {};
let sentAt = 0;
let lastSent = 0;
let closedAt = 0;
afterEach(async () => {
  session?.dispose();
  session = null;
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
  if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  root = '';
  metrics = {};
  sentAt = lastSent = closedAt = 0;
});

async function exercise(mode: 'ctrl-c' | 'pending-steer-ctrl-c') {
  metrics.mode = mode;
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p4b-cancel-timing-')));
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'work');
  fs.mkdirSync(home);
  fs.mkdirSync(workspace);
  fs.mkdirSync(path.join(root, 'runtime'), { mode: 0o700 });
  let requestCount = 0;
  let tokenCount = 0;
  server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-alpha' }] }));
      return;
    }
    req.resume();
    req.on('end', () => {
      const requestNumber = ++requestCount;
      metrics.requestCount = requestCount;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      let n = 0;
      let timer: NodeJS.Timeout;
      const tick = () => {
        n++;
        lastSent = Date.now();
        const value = `${requestNumber === 2 && n === 1 ? 'P4BRESTART ' : ''}P4BTOKEN${String(++tokenCount).padStart(
          4,
          '0',
        )} `;
        res.write(`data: ${JSON.stringify({ id: 'paced', choices: [{ delta: { content: value } }] })}\n\n`);
      };
      tick();
      if (mode.startsWith('pending-steer-') && requestNumber === 1)
        res.write(
          `data: ${JSON.stringify({
            id: 'paced',
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'p4b-held-tool',
                      type: 'function',
                      function: { name: 'shell', arguments: '{"command":"sl' },
                    },
                  ],
                },
              },
            ],
          })}\n\n`,
        );
      timer = setInterval(tick, 50);
      res.on('close', () => {
        closedAt = Date.now();
        clearInterval(timer);
      });
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const a = server.address();
  const port = typeof a === 'object' && a ? a.port : 0;
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
      providers: [
        { name: 'mockprov', type: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'test-key' },
      ],
      sandbox: { enabled: false },
    }),
  );
  session = spawnTerminal('node', [builtCli], { cwd: workspace, env, cols: 120, rows: 40 });
  await waitForHarnessIdleGeneration(idlePath, { timeoutMs: 60_000 });
  session.write('Generate a long reply');
  await waitForHarnessComposerValue(idlePath, 'Generate a long reply', { timeoutMs: 30_000 });
  session.write('\r');
  await session.waitForOutput('P4BTOKEN0005', 30_000);
  if (mode.startsWith('pending-steer-')) {
    session.write('keep it short');
    await waitForHarnessComposerValue(idlePath, 'keep it short', { timeoutMs: 30_000 });
    session.write('\r');
    await session.waitForOutput('steer · mid-turn', 30_000);
    await waitForHarnessComposerValue(idlePath, '', { timeoutMs: 30_000 });
  }
  const maxToken = () =>
    Math.max(0, ...Array.from(session!.getVisibleOutput().matchAll(/P4BTOKEN(\d{4})/g), (match) => Number(match[1])));
  let max = maxToken();
  let lastVisibleAt = 0;
  sentAt = Date.now();
  session.write('\x03');
  const observe = setInterval(() => {
    const value = maxToken();
    if (value > max) {
      max = value;
      lastVisibleAt = Date.now();
    }
  }, 25);
  try {
    // Ctrl+C does not print the ordinary success notice; the Stopped marker is the first signal. Legacy drops a
    // pending steer on cancellation without a notice.
    await session.waitForOutput('Stopped', 5_000);
    metrics.ackMs = Date.now() - sentAt;
    const dir = path.join(root, 'conversations');
    const log = path.join(dir, fs.readdirSync(dir).find((name) => name.endsWith('.jsonl'))!);
    let facts: Array<{ type: string; outcome?: string; turnId?: string }> = [];
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      facts = fs
        .readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line).fact);
      if (facts.some((fact) => fact.type === 'turn_ended' && fact.outcome === 'cancelled')) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(facts.some((fact) => fact.type === 'turn_ended' && fact.outcome === 'cancelled')).toBe(true);
    const cancelIndex = facts.findIndex((fact) => fact.type === 'queue_cancelling');
    const endedIndex = facts.findIndex((fact) => fact.type === 'turn_ended' && fact.outcome === 'cancelled');
    expect(cancelIndex).toBeGreaterThanOrEqual(0);
    expect(endedIndex).toBeGreaterThan(cancelIndex);
    expect(facts.slice(cancelIndex + 1, endedIndex).some((fact) => fact.type === 'text_delta')).toBe(false);
    metrics.settleMs = Date.now() - sentAt;
    await new Promise((resolve) => setTimeout(resolve, 2500));
    metrics.lastVisibleMs = lastVisibleAt ? lastVisibleAt - sentAt : 0;
    metrics.lastServerMs = lastSent - sentAt;
    metrics.closeMs = closedAt ? closedAt - sentAt : null;
    metrics.lastToken = max;
    console.log('CANCEL-TIMING', JSON.stringify(metrics));
    expect(metrics.settleMs).toBeLessThan(2_000);
    expect(metrics.lastVisibleMs).toBeLessThan(2_000);
    if (mode.startsWith('pending-steer-')) expect(requestCount, 'no automatic restart after cancellation').toBe(1);
  } finally {
    clearInterval(observe);
  }
}

it('Ctrl+C stops a paced stream promptly', { timeout: 120_000 }, () => exercise('ctrl-c'));

it('pending steer must not restart after Ctrl+C', { timeout: 120_000 }, () => exercise('pending-steer-ctrl-c'));
