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

/**
 * `/compact` whose summary request keeps failing. `agent.retryAttempts = n` means n retries, so the
 * summary reaches the provider n + 1 times, and the command then fails with the provider's own error.
 * Before @qduc/agent-core 0.3.0-alpha.4, TurnModel.compact() ran turn-level recovery on top of the summary's
 * own retries: it started the recovery clock, waited one more backoff and re-dispatched the summary without
 * the reservation it had claimed, which term2 refused with "A recovery dispatch requires the engine-owned
 * budget reservation." — the only error the user saw.
 */

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const builtCli = testCliPath(path.join(projectRoot, 'dist', 'src', 'app', 'cli.js'));
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

type SummaryBehaviour = 'http-503' | 'stream-closed-early' | 'ok';

async function compactWithFailingSummary(summaryBehaviours: SummaryBehaviour[], retryAttempts: number) {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-compact-retries-')));
  const home = path.join(root, 'home'),
    workspace = path.join(root, 'work'),
    conversations = path.join(root, 'conversations');
  fs.mkdirSync(home);
  fs.mkdirSync(workspace);
  fs.mkdirSync(path.join(root, 'runtime'), { mode: 0o700 });
  let rootRequests = 0;
  let summaries = 0;
  server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-alpha' }] }));
      return;
    }
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const isSummary = body.includes('[Host context-compaction request]');
      const behaviour: SummaryBehaviour = isSummary
        ? summaryBehaviours[Math.min(summaries++, summaryBehaviours.length - 1)]!
        : 'ok';
      if (behaviour === 'http-503') {
        // A 1 ms Retry-After keeps the backoff out of the test's wall time; the engine honours it.
        res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '0.001', connection: 'close' });
        res.end(JSON.stringify({ error: { message: 'summary fixture unavailable' } }));
        return;
      }
      if (behaviour === 'stream-closed-early') {
        res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
        res.end();
        return;
      }
      const text = isSummary
        ? 'SHORT_COMPACTION_SUMMARY'
        : ++rootRequests === 1
        ? `${'earlier context '.repeat(500)} SEED_ONE_END`
        : `NORMAL_REPLY_${rootRequests}`;
      const id = `compact-retry-${rootRequests}-${summaries}`;
      const frames = [
        { id, choices: [{ delta: { role: 'assistant', content: text } }] },
        { id, choices: [{ delta: {}, finish_reason: 'stop' }] },
      ];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end([...frames.map((frame) => `data: ${JSON.stringify(frame)}\n`), 'data: [DONE]', ''].join('\n'));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const idlePath = path.join(home, 'input-idle');
  const env = {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_RUNTIME_DIR: path.join(root, 'runtime'),
    TERM2_CONFIG_DIR: path.join(home, '.term2'),
    TERM2_CACHE_DIR: path.join(home, '.cache', 'term2'),
    TERM2_CONVERSATIONS_DIR: conversations,
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
        retryAttempts,
        modelSelection: { provider: 'mockprov', model: 'mock-alpha' },
        contextCompaction: { enabled: false, mode: 'local' },
        maxRequestInputTokens: 200_000,
      },
      providers: [
        { name: 'mockprov', type: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'test-key' },
      ],
      sandbox: { enabled: false },
    }),
  );
  session = spawnTerminal('node', [builtCli], { cwd: workspace, env, cols: 160, rows: 50 });
  let idle = await waitForHarnessIdleGeneration(idlePath, { timeoutMs: 60_000 });
  const send = async (value: string) => {
    session!.write(value);
    await waitForHarnessComposerValue(idlePath, value, { timeoutMs: 30_000 });
    session!.write('\r');
  };
  // Three complete turns give /compact a cold turn to summarise (see compact-receipts.e2e.test.ts).
  await send('first');
  await session.waitForOutput('SEED_ONE_END', 60_000);
  idle = await waitForHarnessIdleGeneration(idlePath, { after: idle, timeoutMs: 60_000 });
  await send('second');
  await session.waitForOutput('NORMAL_REPLY_2', 60_000);
  idle = await waitForHarnessIdleGeneration(idlePath, { after: idle, timeoutMs: 60_000 });
  await send('third');
  await session.waitForOutput('NORMAL_REPLY_3', 60_000);
  idle = await waitForHarnessIdleGeneration(idlePath, { after: idle, timeoutMs: 60_000 });
  const beforeCompact = session.getVisibleOutput().length;
  await send('/compact');
  const settled = /Context compaction failed:|Context compacted locally/;
  for (let i = 0; i < 2400 && !settled.test(session.getVisibleOutput().slice(beforeCompact)); i++)
    await new Promise((resolve) => setTimeout(resolve, 25));
  await waitForHarnessComposerValue(idlePath, '', { timeoutMs: 30_000 });
  const output = session.getVisibleOutput().slice(beforeCompact);
  const file = fs.readdirSync(conversations).find((name) => name.endsWith('.jsonl'))!;
  const facts = fs
    .readFileSync(path.join(conversations, file), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line).fact);
  const finished = facts.filter((fact) => fact?.type === 'command_finished').at(-1);
  return { output, summaries, finished };
}

for (const retryAttempts of [1, 2]) {
  it(
    `/compact with a summary that keeps answering 503 sends ${
      retryAttempts + 1
    } summary requests and shows the provider's error (retryAttempts ${retryAttempts})`,
    { timeout: 180_000 },
    async () => {
      const result = await compactWithFailingSummary(['http-503'], retryAttempts);
      const context = JSON.stringify({ ...result, output: result.output.slice(-1500) });
      expect(result.summaries, context).toBe(retryAttempts + 1);
      expect(result.output, context).toContain('Context compaction failed:');
      expect(result.output, context).toContain('summary fixture unavailable');
      expect(result.output, context).not.toContain('engine-owned budget reservation');
      expect(result.finished?.outcome?.kind, context).not.toBe('compacted');
    },
  );
}

it(
  '/compact with a summary stream that keeps ending before any output fails instead of hanging (retryAttempts 1)',
  { timeout: 180_000 },
  async () => {
    const result = await compactWithFailingSummary(['stream-closed-early'], 1);
    const context = JSON.stringify({ ...result, output: result.output.slice(-1500) });
    expect(result.summaries, context).toBe(2);
    expect(result.output, context).toContain('Context compaction failed:');
    expect(result.output, context).not.toContain('engine-owned budget reservation');
  },
);

it(
  '/compact whose summary fails once and then succeeds still compacts (retryAttempts 1)',
  { timeout: 180_000 },
  async () => {
    const result = await compactWithFailingSummary(['http-503', 'ok'], 1);
    const context = JSON.stringify({ ...result, output: result.output.slice(-1500) });
    expect(result.summaries, context).toBe(2);
    expect(result.output, context).toMatch(/Context compacted locally \(\d+ → \d+ estimated tokens\)\./);
    expect(result.finished?.outcome?.kind, context).toBe('compacted');
  },
);
