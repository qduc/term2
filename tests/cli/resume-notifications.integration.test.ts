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
const NOTICE = 'Background subagent run';
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
    // No second request is spent on it: it rides the follow-up's first request, ahead of the follow-up, so the
    // new instruction stays the last thing the model reads.
    expect(roots(provider.seen, 'resumed')).toHaveLength(1);
    const messages = roots(provider.seen, 'resumed')[0]!.body.messages;
    expect(noticeIndexes(messages)).toHaveLength(1);
    expect(contentText(messages[noticeIndexes(messages)[0]!]!.content)).toContain(CHILD);
    expect(contentText(messages.at(-1)!.content)).toBe('follow up');
    expect(noticeIndexes(messages)[0]).toBe(messages.length - 2);
    expect(contentText(messages.at(-3)!.content)).toBe('Waiting for the explorer.');
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
    expect(notice).toContain('Background subagent run interrupted');
    expect(notice).toContain('status: interrupted');
    expect(notice).toContain('Interrupted: the session ended before the run finished.');
    expect(notice).toContain('Its outcome was not observed and no result is available.');
    expect(notice).toContain('Start the run again if it is still needed.');
    // The completion boilerplate would claim a result exists and tell the model to assess it.
    expect(notice).not.toContain('inlined above');
    expect(notice).not.toContain('Assess it');
    expect(notice).not.toContain('Background subagent run finished');
    expect(notice).not.toContain(CHILD);
    expect(JSON.stringify(messages)).not.toContain(CHILD);
  } finally {
    await provider.close();
  }
}, 120_000);

type Plain = { messages: Message[] };
/** A provider that answers each request from `script`, recording every body. */
async function startPlainProvider(script: (n: number, phaseNow: Seen['phase']) => Reply) {
  const bodies: { messages: Message[]; phase: Seen['phase'] }[] = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-alpha' }] }));
      return;
    }
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      bodies.push({ messages: (JSON.parse(raw) as Plain).messages, phase });
      const reply = script(bodies.length, phase);
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
  return { bodies, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

// The provider's own spacing in a call's arguments is part of what the model was sent. Resume used to rewrite it
// as compact JSON, which broke the request prefix (and its cache) from that call on.
it('resume keeps a tool call argument string exactly as the provider sent it', async () => {
  fs.writeFileSync(path.join(workspace, 'a.txt'), 'alpha\n');
  const RAW = '{ "path": "a.txt" ,\n  "start_line": 1 }';
  const provider = await startPlainProvider((n, now) => {
    if (now === 'resumed' || n === 2) return text(now === 'resumed' ? 'follow-up answer' : 'read it');
    return {
      frames: [
        {
          id: 'f',
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'call-read', type: 'function', function: { name: 'read_file', arguments: RAW } },
                ],
              },
            },
          ],
        },
        { id: 'f', choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      ],
    };
  });
  try {
    expect((await runCli(['Read a.txt'])).status).toBe(0);
    const liveLast = provider.bodies.at(-1)!.messages;
    expect(JSON.stringify(liveLast)).toContain(JSON.stringify(RAW).slice(1, -1));
    phase = 'resumed';
    expect((await runCli(['--resume', 'last', 'follow up'])).status).toBe(0);
    const resumed = provider.bodies.at(-1)!.messages;
    // Headless to headless: the whole request prefix, system prompt included, is byte-identical.
    expect(resumed.slice(0, liveLast.length).map((m) => JSON.stringify(m))).toEqual(
      liveLast.map((m) => JSON.stringify(m)),
    );
    expect(contentText(resumed.at(-1)!.content)).toBe('follow up');
  } finally {
    await provider.close();
  }
}, 120_000);

// A turn's recorded request notice decorated its user message in every later request. A log written by an earlier
// process carries it on turn_started (here added by hand: headless has no way to raise one), and resume must keep it.
it("resume sends an earlier process's decorated user message as it was decorated", async () => {
  const provider = await startPlainProvider((_n, now) => text(now === 'resumed' ? 'follow-up answer' : 'first answer'));
  try {
    expect((await runCli(['First question'])).status).toBe(0);
    const lines = fs.readFileSync(logPath(), 'utf8').trim().split('\n');
    const edited = lines.map((line) => {
      const entry = JSON.parse(line) as { fact: { type: string; requestNotice?: string } };
      if (entry.fact.type === 'turn_started') entry.fact.requestNotice = '[Profile notice] now in review mode';
      return JSON.stringify(entry);
    });
    fs.writeFileSync(logPath(), edited.join('\n') + '\n');
    phase = 'resumed';
    expect((await runCli(['--resume', 'last', 'follow up'])).status).toBe(0);
    const resumed = provider.bodies.at(-1)!.messages;
    const firstUser = resumed.find((m) => m.role === 'user')!;
    expect(contentText(firstUser.content)).toBe('[Profile notice] now in review mode\n\nFirst question');
    expect(contentText(resumed.at(-1)!.content)).toBe('follow up');
  } finally {
    await provider.close();
  }
}, 120_000);
