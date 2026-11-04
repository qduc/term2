import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  dismissUnlistedSlashMenu,
  testCliPath,
  spawnTerminal,
  createTestChildEnv,
  type TerminalSession,
} from './test-helpers/terminal-e2e.js';
import {
  HARNESS_IDLE_ENV,
  waitForHarnessComposerValue,
  waitForHarnessIdleGeneration,
} from './lib/harness-input-idle.js';
import { resolveSettingsDirectory } from './services/settings/settings-path.js';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const builtCli = testCliPath(path.join(projectRoot, 'rewrite', 'dist', 'rewrite', 'src', 'app', 'cli.js'));
let root = '';
let session: TerminalSession | null = null;
let server: http.Server | null = null;
let releaseSummary: (() => void) | undefined;
afterEach(async () => {
  session?.dispose();
  session = null;
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
  releaseSummary = undefined;
  if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  root = '';
});

it(
  'folds a failed then successful compact while keeping pending receipts and saved status',
  { timeout: 120_000 },
  async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-compact-receipts-')));
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
        const text = isSummary
          ? 'SHORT_COMPACTION_SUMMARY'
          : ++rootRequests === 1
          ? `${'earlier context '.repeat(500)} SEED_ONE_END`
          : `NORMAL_REPLY_${rootRequests}`;
        const id = `compact-test-${rootRequests}-${summaries}`;
        const frames = [
          { id, choices: [{ delta: { role: 'assistant', content: text } }] },
          { id, choices: [{ delta: {}, finish_reason: 'stop' }] },
        ];
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const finish = () =>
          res.end([...frames.map((frame) => `data: ${JSON.stringify(frame)}\n`), 'data: [DONE]', ''].join('\n'));
        if (isSummary && ++summaries === 1) releaseSummary = finish;
        else finish();
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
          retryAttempts: 0,
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
      await dismissUnlistedSlashMenu(session!, value);
      session!.write('\r');
    };
    await send('/compact');
    await session.waitForOutput('Nothing to compact: at least one complete cold turn is required.', 30_000);
    const failureFrame = session.getVisibleOutput().slice(session.getVisibleOutput().lastIndexOf('▌ term²'));
    expect(failureFrame).toContain('Nothing to compact: at least one complete cold turn is required.');
    expect(failureFrame).not.toContain('no_complete_cold_turn');
    expect(failureFrame).not.toContain('· compact · rejected');
    // The failure notice can render before the compact command releases input ownership.
    idle = await waitForHarnessIdleGeneration(idlePath, { after: idle, timeoutMs: 60_000 });
    await waitForHarnessComposerValue(idlePath, '', { timeoutMs: 30_000 });
    await new Promise((resolve) => setTimeout(resolve, 2100));
    await send('first');
    await session.waitForOutput('SEED_ONE_END', 60_000);
    idle = await waitForHarnessIdleGeneration(idlePath, { after: idle, timeoutMs: 60_000 });
    await send('second');
    await session.waitForOutput('NORMAL_REPLY_2', 60_000);
    idle = await waitForHarnessIdleGeneration(idlePath, { after: idle, timeoutMs: 60_000 });
    const beforeShortCompact = session.getVisibleOutput().length;
    await send('/compact');
    await session.waitForOutput('Nothing to compact: at least one complete cold turn is required.', 30_000);
    await waitForHarnessComposerValue(idlePath, '', { timeoutMs: 30_000 });
    await new Promise((resolve) => setTimeout(resolve, 2100));
    await send('third');
    await session.waitForOutput('NORMAL_REPLY_3', 60_000);
    idle = await waitForHarnessIdleGeneration(idlePath, { after: idle, timeoutMs: 60_000 });
    expect(session.getVisibleOutput().slice(beforeShortCompact)).not.toContain('no_complete_cold_turn');
    const beforeCompact = session.getVisibleOutput().length;
    await send('/compact');
    // Legacy announces a running compaction as 'Compacting context...'; earlier /compact runs printed it too.
    for (let i = 0; i < 1200 && !session.getVisibleOutput().slice(beforeCompact).includes('Compacting context...'); i++)
      await new Promise((resolve) => setTimeout(resolve, 25));
    expect(session.getVisibleOutput().slice(beforeCompact)).toContain('Compacting context...');
    for (let i = 0; i < 100 && !releaseSummary; i++) await new Promise((resolve) => setTimeout(resolve, 25));
    expect(releaseSummary).toBeDefined();
    releaseSummary!();
    await session.waitForOutput('estimated tokens).', 30_000);
    expect(session.getVisibleOutput()).toMatch(/Context compacted locally \(\d+ → \d+ estimated tokens\)\./);
    await waitForHarnessComposerValue(idlePath, '', { timeoutMs: 30_000 });
    const beforeLater = session.getVisibleOutput().length;
    await send('after compaction');
    await session.waitForOutput('NORMAL_REPLY_4', 60_000);
    await waitForHarnessIdleGeneration(idlePath, { after: idle, timeoutMs: 60_000 });
    const after = session.getVisibleOutput().slice(beforeLater);
    expect(after).not.toContain('· compact · rejected');
    expect(after).not.toContain('· compact · compacted');
    expect(after).not.toContain('Context compaction failed:');
    const file = fs.readdirSync(conversations).find((name) => name.endsWith('.jsonl'))!;
    const facts = fs
      .readFileSync(path.join(conversations, file), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).fact);
    const results = facts.filter((fact) => fact.type === 'command_finished').map((fact) => fact.outcome.kind);
    expect(results).toContain('rejected');
    expect(results).toContain('compacted');
    expect(facts.some((fact) => fact.type === 'history_replaced' && fact.reason === 'compaction')).toBe(true);
  },
);
