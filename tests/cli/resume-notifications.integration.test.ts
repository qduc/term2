// Background-subagent notifications across --resume, through the built CLI against a loopback
// chat-completions double. A resumed session must show the model what the live one showed it.
import { it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { resolveSettingsDirectory } from '../../src/config/settings/settings-path.js';
import { createTestChildEnv } from '../helpers/terminal-e2e.js';
import { integrationCliPath as cliPath } from '../helpers/integration-cli.js';

type Message = { role: string; content?: unknown; tool_call_id?: string };
type Body = { messages: Message[]; tools?: { function: { name: string } }[] };
type Seen = { body: Body; root: boolean; phase: 'live' | 'resumed' };
type Reply = { frames: unknown[] };

let home = '';
let workspace = '';
let phase: Seen['phase'] = 'live';

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-resume-notice-')));
  workspace = path.join(home, 'ws');
  fs.mkdirSync(path.join(workspace, 'scratch', 'term2-nodejs'), { recursive: true });
  fs.mkdirSync(path.join(home, 'conversations'), { recursive: true });
  phase = 'live';
});
afterEach(() => {
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

const text = (content: string): Reply => ({
  frames: [
    { id: 'f', choices: [{ delta: { role: 'assistant', content } }] },
    { id: 'f', choices: [{ delta: {}, finish_reason: 'stop' }] },
  ],
});
const launch = (): Reply => ({
  frames: [
    {
      id: 'f',
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call-0-run_subagent',
                type: 'function',
                function: {
                  name: 'run_subagent',
                  arguments: JSON.stringify({ execution: 'background', role: 'explorer', task: 'Find parseInvoice' }),
                },
              },
            ],
          },
        },
      ],
    },
    { id: 'f', choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ],
});

const CHILD = 'Child evidence: parseInvoice is in src/a.js:2';

/** Live phase: launch, wait, answer the completion notice. Resumed phase: every root request is answered the same. */
async function startProvider() {
  const seen: Seen[] = [];
  let liveRoots = 0;
  const server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-alpha' }] }));
      return;
    }
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const body = JSON.parse(raw) as Body;
      const root = Boolean(body.tools?.some((tool) => tool.function.name === 'run_subagent'));
      seen.push({ body, root, phase });
      const reply = !root
        ? text(CHILD)
        : phase === 'resumed'
        ? text('follow-up answer')
        : (() => {
            liveRoots++;
            return liveRoots === 1
              ? launch()
              : text(liveRoots === 2 ? 'Waiting for the explorer.' : 'Found it in src/a.js.');
          })();
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end([...reply.frames.map((frame) => `data: ${JSON.stringify(frame)}\n`), 'data: [DONE]', ''].join('\n'));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const settingsDir = resolveSettingsDirectory({ homeDir: home });
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(
    path.join(settingsDir, 'settings.json'),
    JSON.stringify({
      app: { activeProfileId: 'builtin:standard' },
      agent: { retryAttempts: 0, modelSelection: { model: 'mock-alpha', provider: 'mockprov' } },
      providers: [
        { name: 'mockprov', type: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'test-key' },
      ],
    }),
  );
  return { seen, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

function runCli(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const scratch = path.join(workspace, 'scratch', 'term2-nodejs');
  const child = spawn('node', [cliPath(), '--profile', 'standard', ...args], {
    cwd: workspace,
    env: {
      ...createTestChildEnv({
        HOME: home,
        TERM2_CONVERSATIONS_DIR: path.join(home, 'conversations'),
        DISABLE_LOGGING: '1',
      }),
      TMPDIR: scratch,
      TEMP: scratch,
      TMP: scratch,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

const contentText = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
    ? content.map((part) => (part as { text?: string }).text ?? '').join('')
    : '';
const NOTICE = 'Background subagent run finished';
const roots = (seen: Seen[], which: Seen['phase']) => seen.filter((entry) => entry.root && entry.phase === which);
const noticeIndexes = (messages: Message[]) =>
  messages.flatMap((message, index) => (contentText(message.content).includes(NOTICE) ? [index] : []));

function logPath(): string {
  const file = fs.readdirSync(path.join(home, 'conversations')).find((name) => name.endsWith('.jsonl'));
  if (!file) throw new Error('no conversation log');
  return path.join(home, 'conversations', file);
}
const readFacts = (): { type: string; [key: string]: unknown }[] =>
  fs
    .readFileSync(logPath(), 'utf8')
    .trim()
    .split('\n')
    .map((line) => (JSON.parse(line) as { fact: { type: string } }).fact);
/** The process died right after the log's first fact of this type: drop everything it wrote later. */
function killAfter(type: string): void {
  const lines = fs.readFileSync(logPath(), 'utf8').trim().split('\n');
  const keep = readFacts().findIndex((fact) => fact.type === type) + 1;
  if (keep === 0) throw new Error(`log has no ${type}`);
  fs.writeFileSync(logPath(), lines.slice(0, keep).join('\n') + '\n');
}

it('resume after a consumed notification sends the live session history, notice at the same position', async () => {
  const provider = await startProvider();
  try {
    const live = await runCli(['Find parseInvoice']);
    expect(live.status, live.stderr).toBe(0);
    const liveRoots = roots(provider.seen, 'live');
    expect(liveRoots).toHaveLength(3);
    const liveLast = liveRoots[2]!.body.messages;
    expect(noticeIndexes(liveLast)).toHaveLength(1);
    expect(contentText(liveLast[noticeIndexes(liveLast)[0]!]!.content)).toContain(CHILD);

    phase = 'resumed';
    const resumed = await runCli(['--resume', 'last', 'follow up']);
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(roots(provider.seen, 'resumed')).toHaveLength(1);
    const messages = roots(provider.seen, 'resumed')[0]!.body.messages;
    // Byte-identical prefix: everything the live session's last request carried, then the live answer and the follow-up.
    expect(messages.slice(0, liveLast.length).map((m) => JSON.stringify(m))).toEqual(
      liveLast.map((m) => JSON.stringify(m)),
    );
    expect(noticeIndexes(messages)).toEqual(noticeIndexes(liveLast));
    expect(contentText(messages.at(-1)!.content)).toBe('follow up');
    expect(contentText(messages.at(-2)!.content)).toBe('Found it in src/a.js.');
  } finally {
    await provider.close();
  }
}, 120_000);

it('resume with a notification still pending delivers it to the first resumed turn, once', async () => {
  const provider = await startProvider();
  try {
    const live = await runCli(['Find parseInvoice']);
    expect(live.status, live.stderr).toBe(0);
    killAfter('background_notice_enqueued');
    expect(readFacts().some((fact) => fact.type === 'background_notices_delivered')).toBe(false);

    phase = 'resumed';
    const resumed = await runCli(['--resume', 'last', 'follow up']);
    expect(resumed.status, resumed.stderr).toBe(0);
    // No second request is spent on it: it rides the follow-up's first request, after the follow-up.
    expect(roots(provider.seen, 'resumed')).toHaveLength(1);
    const messages = roots(provider.seen, 'resumed')[0]!.body.messages;
    expect(noticeIndexes(messages)).toHaveLength(1);
    expect(contentText(messages[noticeIndexes(messages)[0]!]!.content)).toContain(CHILD);
    expect(contentText(messages.at(-2)!.content)).toBe('follow up');
    const delivered = readFacts().filter((fact) => fact.type === 'background_notices_delivered');
    expect(delivered).toHaveLength(1);
  } finally {
    await provider.close();
  }
}, 120_000);

it('resume with the child still running tells the model its outcome was not observed, with no result invented', async () => {
  const provider = await startProvider();
  try {
    const live = await runCli(['Find parseInvoice']);
    expect(live.status, live.stderr).toBe(0);
    killAfter('queue_settled');
    expect(readFacts().some((fact) => fact.type === 'task_finished')).toBe(false);

    phase = 'resumed';
    const resumed = await runCli(['--resume', 'last', 'follow up']);
    expect(resumed.status, resumed.stderr).toBe(0);
    const messages = roots(provider.seen, 'resumed')[0]!.body.messages;
    expect(noticeIndexes(messages)).toHaveLength(1);
    const notice = contentText(messages[noticeIndexes(messages)[0]!]!.content);
    expect(notice).toContain('status: interrupted');
    expect(notice).toContain('outcome_unobserved');
    expect(notice).not.toContain(CHILD);
    expect(JSON.stringify(messages)).not.toContain(CHILD);
  } finally {
    await provider.close();
  }
}, 120_000);
