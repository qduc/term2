import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testCliPath, spawnTerminal, createTestChildEnv, type TerminalSession } from '../helpers/terminal-e2e.js';
import {
  HARNESS_IDLE_ENV,
  readHarnessComposerState,
  waitForHarnessComposerValue,
  waitForHarnessIdleGeneration,
} from '../../src/shared/lib/harness-input-idle.js';
import { resolveSettingsDirectory } from '../../src/config/settings/settings-path.js';

// Issue #221: a message sent while /compact's summary request is still running must be
// queued behind the compaction and sent after it, not bounced back into the composer
// (duplicated) with 'Still sending the previous message'.
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

const QUEUED = 'queued during compaction';

it('queues a message sent during /compact and sends it after the compaction', { timeout: 120_000 }, async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-compact-queue-')));
  const home = path.join(root, 'home'),
    workspace = path.join(root, 'work'),
    conversations = path.join(root, 'conversations');
  fs.mkdirSync(home);
  fs.mkdirSync(workspace);
  fs.mkdirSync(path.join(root, 'runtime'), { mode: 0o700 });
  // Provider-visible order of requests: 'summary' or the root request's reply number.
  const order: string[] = [];
  const rootBodies: string[] = [];
  let releaseSummary: (() => void) | undefined;
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
      if (!isSummary) rootBodies.push(body);
      const n = rootBodies.length;
      const text = isSummary
        ? 'SHORT_COMPACTION_SUMMARY'
        : n === 1
        ? `${'earlier context '.repeat(500)} SEED_ONE_END`
        : `NORMAL_REPLY_${n}`;
      const id = `compact-queue-${order.length}`;
      const frames = [
        { id, choices: [{ delta: { role: 'assistant', content: text } }] },
        { id, choices: [{ delta: {}, finish_reason: 'stop' }] },
      ];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const finish = () => {
        order.push(isSummary ? 'summary' : `root-${n}`);
        res.end([...frames.map((frame) => `data: ${JSON.stringify(frame)}\n`), 'data: [DONE]', ''].join('\n'));
      };
      if (isSummary) releaseSummary = finish;
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
    session!.write('\r');
  };
  // Three settled turns leave a complete cold turn for compaction to replace.
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
  for (let i = 0; i < 400 && !releaseSummary; i++) await new Promise((resolve) => setTimeout(resolve, 25));
  expect(releaseSummary).toBeDefined();
  for (let i = 0; i < 1200 && !session.getVisibleOutput().slice(beforeCompact).includes('Compacting context...'); i++)
    await new Promise((resolve) => setTimeout(resolve, 25));
  expect(session.getVisibleOutput().slice(beforeCompact)).toContain('Compacting context...');

  // The summary request is still open: send the next message now.
  await send(QUEUED);
  await waitForHarnessComposerValue(idlePath, '', { timeoutMs: 30_000 });
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const during = session.getVisibleOutput().slice(beforeCompact);
  expect(during).not.toContain('Still sending the previous message');
  expect(readHarnessComposerState(idlePath)?.value).toBe('');
  // Held behind the compaction: no root request has carried it yet.
  expect(rootBodies.some((body) => body.includes(QUEUED))).toBe(false);

  releaseSummary!();
  await session.waitForOutput('estimated tokens).', 30_000);
  await session.waitForOutput('NORMAL_REPLY_4', 60_000);
  expect(order).toEqual(['root-1', 'root-2', 'root-3', 'summary', 'root-4']);
  // The queued message ran against the compacted context.
  expect(rootBodies[3]).toContain(QUEUED);
  expect(rootBodies[3]).toContain('SHORT_COMPACTION_SUMMARY');
  const after = session.getVisibleOutput().slice(beforeCompact);
  expect(after).not.toContain('Context compaction failed:');
  expect(after).not.toContain('Still sending the previous message');
});
