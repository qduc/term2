import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { resolveSettingsDirectory } from '../../src/config/settings/settings-path.js';
import { integrationCliPath } from '../helpers/integration-cli.js';
import { createTestChildEnv } from '../helpers/terminal-e2e.js';

/**
 * Automatic context compaction through the built CLI, against a loopback chat-completions provider.
 *
 * Nobody types /compact here. The engine decides at each request boundary: it compares the larger of its own
 * estimate of the request and the input tokens the provider reported for the last completed request IN THE SAME
 * TURN (the figure is not carried across turns) with the soft trigger. `agent.contextCompaction.
 * compactThresholdTokens` is the soft trigger on a model with no catalogued window, which is every custom
 * openai-compatible provider; 1,000 is the schema minimum, but a bare request already estimates about 5,500
 * tokens, so the thresholds below sit well above the estimate and only the reported usage can cross them.
 *
 * Every scenario runs the same conversation, each prompt in its own CLI launch joined by --resume:
 *   alpha   one text reply.
 *   bravo   two read_file rounds, then a reply. The second round's response reports `usage` input tokens, which
 *           is the number under test. The next request is prepared with that figure.
 *   charlie one text reply, after the (possibly compacted) log is replayed.
 * Compaction needs a complete cold turn to summarise, so bravo has two rounds: the first is summarised, the
 * second stays hot.
 */

const SUMMARY_MARKER = 'SUMMARY_MARKER_Q7';
const ALPHA_REPLY = 'ALPHA_REPLY_Q7';
const BRAVO_REPLY = 'BRAVO_REPLY_Q7';
const CHARLIE_REPLY = 'CHARLIE_REPLY_Q7';
const ONE_FILE = 'ONE_FILE_MARKER_Q7';
const TWO_FILE = 'TWO_FILE_MARKER_Q7';
const PROMPTS = { alpha: 'alpha question', bravo: 'bravo question', charlie: 'charlie question' } as const;
const SUMMARY_REQUEST = '[Host context-compaction request]';

type Wire = { role: string; content?: unknown; tool_calls?: { id: string }[]; tool_call_id?: string };
type Request = { messages: Wire[]; tools?: { function?: { name?: string } }[] };
type Fact = Record<string, any>;

const text = (message: Wire): string =>
  typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
const humanTexts = (request: Request): string[] =>
  request.messages
    .filter((m) => m.role === 'user')
    .map(text)
    .filter((t) => Object.values(PROMPTS).some((prompt) => t.includes(prompt)));

let root = '';
let server: http.Server | undefined;
afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
  if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  root = '';
});

function sse(frames: object[]): string {
  return [...frames.map((frame) => `data: ${JSON.stringify(frame)}\n`), 'data: [DONE]', ''].join('\n');
}

async function converse(options: {
  /** Input tokens the provider reports on bravo's second round. */
  usage: number;
  settings?: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
  /** Run charlie in a third launch, resuming the log. */
  resume?: boolean;
}) {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-auto-compact-')));
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  const conversations = path.join(root, 'conversations');
  const scratch = path.join(root, 'scratch', 'term2-nodejs');
  for (const dir of [home, workspace, conversations, scratch]) fs.mkdirSync(dir, { recursive: true });
  // Large enough that replacing it with a summary shrinks the request; a summary that does not is discarded.
  fs.writeFileSync(path.join(workspace, 'one.txt'), `${ONE_FILE}\n${'filler filler filler filler\n'.repeat(600)}`);
  fs.writeFileSync(path.join(workspace, 'two.txt'), `${TWO_FILE}\n`);

  const requests: { kind: 'summary' | 'main'; body: Request }[] = [];
  const rounds = new Map<string, number>();
  server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-alpha' }] }));
      return;
    }
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const body = JSON.parse(raw) as Request;
      const n = requests.length + 1;
      const frames = (delta: object, finish: string, inputTokens: number) => [
        { id: `c${n}`, choices: [{ delta }] },
        {
          id: `c${n}`,
          choices: [{ delta: {}, finish_reason: finish }],
          usage: { prompt_tokens: inputTokens, completion_tokens: 5, total_tokens: inputTokens + 5 },
        },
      ];
      const reply = (content: string, inputTokens: number) =>
        frames({ role: 'assistant', content }, 'stop', inputTokens);
      const read = (file: string, inputTokens: number) =>
        frames(
          {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: `call_${file}`,
                type: 'function',
                function: { name: 'read_file', arguments: JSON.stringify({ path: file }) },
              },
            ],
          },
          'tool_calls',
          inputTokens,
        );
      let response: object[];
      if (raw.includes(SUMMARY_REQUEST)) {
        requests.push({ kind: 'summary', body });
        response = reply(SUMMARY_MARKER, 300);
      } else {
        requests.push({ kind: 'main', body });
        const prompt = Object.values(PROMPTS).find((p) => humanTexts(body).at(-1)?.includes(p));
        const seen = (rounds.get(prompt ?? '') ?? 0) + 1;
        rounds.set(prompt ?? '', seen);
        if (prompt === PROMPTS.alpha) response = reply(ALPHA_REPLY, 400);
        else if (prompt === PROMPTS.charlie) response = reply(CHARLIE_REPLY, 400);
        else if (seen === 1) response = read('one.txt', 400);
        else if (seen === 2) response = read('two.txt', options.usage);
        else response = reply(BRAVO_REPLY, 400);
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sse(response));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  const env = createTestChildEnv({
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
    // The scratch root is separate from the workspace so file approvals are not skewed by an inherited TMPDIR.
    TMPDIR: scratch,
    TEMP: scratch,
    TMP: scratch,
    ...options.env,
  });
  const settingsDir = resolveSettingsDirectory({ homeDir: home, env });
  fs.mkdirSync(settingsDir, { recursive: true });
  const { agent: agentSettings, ...otherSettings } = options.settings ?? {};
  fs.writeFileSync(
    path.join(settingsDir, 'settings.json'),
    JSON.stringify({
      agent: {
        retryAttempts: 0,
        modelSelection: { provider: 'mockprov', model: 'mock-alpha' },
        maxRequestInputTokens: 200_000,
        ...(agentSettings as object),
      },
      providers: [
        { name: 'mockprov', type: 'openai-compatible', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'test-key' },
      ],
      sandbox: { enabled: false },
      ...otherSettings,
    }),
  );

  const launch = (args: string[]) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      // Async on purpose: the provider fixture lives in this process.
      const child = spawn('node', [integrationCliPath(), ...args], {
        env,
        cwd: workspace,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => (stdout += chunk));
      child.stderr.on('data', (chunk) => (stderr += chunk));
      child.on('error', reject);
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    });
  const logs = () => fs.readdirSync(conversations).filter((name) => name.endsWith('.jsonl'));
  const mark = () => requests.length;

  const first = await launch([PROMPTS.alpha]);
  expect(first.status, first.stderr).toBe(0);
  const logName = logs();
  expect(logName).toHaveLength(1);
  const id = logName[0]!.replace(/\.jsonl$/, '');
  const beforeBravo = mark();
  const second = await launch(['--resume', id, PROMPTS.bravo]);
  expect(second.status, second.stderr).toBe(0);
  const bravoRequests = requests.slice(beforeBravo);
  const beforeCharlie = mark();
  const third = options.resume ? await launch(['--resume', id, PROMPTS.charlie]) : undefined;
  if (third) expect(third.status, third.stderr).toBe(0);
  expect(logs()).toEqual(logName);

  const facts: Fact[] = fs
    .readFileSync(path.join(conversations, logName[0]!), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line).fact);
  return {
    first,
    second,
    third,
    all: requests,
    bravoRequests,
    charlieRequests: requests.slice(beforeCharlie),
    summaries: requests.filter((r) => r.kind === 'summary'),
    facts,
  };
}

type Conversation = Awaited<ReturnType<typeof converse>>;

const factsOfType = (run: Conversation, type: string) => run.facts.filter((fact) => fact.type === type);
const compactionReplacements = (run: Conversation) =>
  run.facts.filter((fact) => fact.type === 'history_replaced' && fact.reason === 'compaction');

/** The request in which bravo's final reply was produced: bravo's third main request. */
const bravoThird = (run: Conversation) => run.bravoRequests.filter((r) => r.kind === 'main')[2]!.body;

function expectUncompacted(run: Conversation) {
  expect(run.summaries, 'a summarising request was made although compaction should not have run').toHaveLength(0);
  expect(compactionReplacements(run), 'history was replaced although compaction should not have run').toHaveLength(0);
  expect(factsOfType(run, 'compaction_completed')).toHaveLength(0);
  // Nothing was dropped: the request after the crossing still carries every earlier turn verbatim.
  const carried = JSON.stringify(bravoThird(run).messages);
  for (const kept of [ALPHA_REPLY, ONE_FILE, TWO_FILE, PROMPTS.alpha, PROMPTS.bravo]) expect(carried).toContain(kept);
  expect(carried).not.toContain(SUMMARY_MARKER);
  expect(run.second.stdout).toContain(BRAVO_REPLY);
}

// What a user might have saved. The supervised profile must win over all of it.
const conflictingSettings = {
  agent: {
    contextCompaction: { enabled: false, mode: 'native', compactThreshold: 0.8, compactThresholdTokens: 150_000 },
  },
};

describe('automatic context compaction', () => {
  // `auto` is the default mode. For a provider without a native compaction endpoint it resolves to local
  // summarisation, so both spellings are the same strategy; the rows pin that.
  it.each(['auto', 'local'] as const)(
    'summarises the older turns when reported usage crosses the threshold, then resumes on the compacted history (%s mode)',
    { timeout: 60_000 },
    async (mode) => {
      const run = await converse({
        usage: 60_000,
        resume: true,
        settings: {
          agent: { contextCompaction: { enabled: true, mode, compactThreshold: 0.8, compactThresholdTokens: 40_000 } },
        },
      });

      // One summarising request, made in bravo's turn between its second and third main requests; none in
      // alpha's turn or charlie's, and nobody asked for it.
      expect(run.summaries, 'no summarising request: reported usage over the threshold did not compact').toHaveLength(
        1,
      );
      expect(
        run.bravoRequests.map((r) => r.kind),
        'summariser not between the second and third main request',
      ).toEqual(['main', 'main', 'summary', 'main']);
      expect(factsOfType(run, 'command_started')).toHaveLength(0);
      expect(run.charlieRequests.map((r) => r.kind)).toEqual(['main']);
      // The summariser was shown the span that gets replaced.
      const summarised = JSON.stringify(run.summaries[0]!.body.messages);
      expect(summarised).toContain(ALPHA_REPLY);
      expect(summarised).toContain(ONE_FILE);

      // The next model request: summary in place of the older span, user messages and hot tail intact.
      const [, , , next] = run.bravoRequests;
      expect(next!.kind).toBe('main');
      const wire = next!.body.messages;
      const carried = JSON.stringify(wire);
      expect(carried, 'request after compaction lacks the summary').toContain(SUMMARY_MARKER);
      expect(carried, 'summarised turn still sent verbatim').not.toContain(ALPHA_REPLY);
      expect(carried, 'summarised tool result still sent verbatim').not.toContain(ONE_FILE);
      expect(carried, 'turn after the boundary missing').toContain(TWO_FILE);
      expect(humanTexts(next!.body).map((t) => (t.includes(PROMPTS.alpha) ? 'alpha' : 'bravo'))).toEqual([
        'alpha',
        'bravo',
      ]);
      // Tool calls and results still pair up.
      const called = wire.flatMap((m) => m.tool_calls?.map((call) => call.id) ?? []);
      expect(called).toEqual(['call_two.txt']);
      expect(wire.filter((m) => m.role === 'tool').map((m) => m.tool_call_id)).toEqual(called);
      expect(run.second.stdout).toContain(BRAVO_REPLY);

      // The log records what happened, once, as an automatic compaction by the local strategy.
      const started = factsOfType(run, 'compaction_started');
      expect(started).toMatchObject([{ trigger: 'automatic', strategy: 'local', lastCompletedInputTokens: 60_000 }]);
      // The local estimate was under the threshold, so it was the provider's figure that crossed it.
      expect(started[0].before.renderedInputTokens).toBeLessThan(40_000);
      expect(factsOfType(run, 'compaction_completed')).toMatchObject([{ strategy: 'local' }]);
      const replacements = compactionReplacements(run);
      expect(replacements).toHaveLength(1);
      expect(JSON.stringify(replacements[0].history)).toContain(SUMMARY_MARKER);
      expect(JSON.stringify(replacements[0].history)).not.toContain(ONE_FILE);

      // Resuming replays the compacted history: charlie's request carries the summary, the hot tail, bravo's
      // reply and all three user messages, not the summarised span, and does not compact a second time.
      const charlie = run.charlieRequests[0]!.body;
      const resumed = JSON.stringify(charlie.messages);
      expect(resumed, 'resumed request lacks the compacted summary').toContain(SUMMARY_MARKER);
      expect(resumed, 'resumed request lost the hot tail').toContain(TWO_FILE);
      expect(resumed).toContain(BRAVO_REPLY);
      expect(resumed, 'resume replayed the pre-compaction turns').not.toContain(ALPHA_REPLY);
      expect(resumed).not.toContain(ONE_FILE);
      expect(humanTexts(charlie).map((t) => t.replace(/.*?(alpha|bravo|charlie) question.*/s, '$1'))).toEqual([
        'alpha',
        'bravo',
        'charlie',
      ]);
      expect(run.third!.stdout).toContain(CHARLIE_REPLY);
      expect(run.summaries).toHaveLength(1);
      expect(compactionReplacements(run)).toHaveLength(1);
    },
  );

  it('leaves the conversation alone while reported usage stays under the threshold', { timeout: 60_000 }, async () => {
    const run = await converse({
      usage: 39_000,
      settings: {
        agent: {
          contextCompaction: { enabled: true, mode: 'auto', compactThreshold: 0.8, compactThresholdTokens: 40_000 },
        },
      },
    });
    expectUncompacted(run);
    expect(factsOfType(run, 'compaction_started')).toHaveLength(0);
  });

  it(
    'does not compact when agent.contextCompaction.enabled is false, however far usage is over',
    { timeout: 60_000 },
    async () => {
      const run = await converse({
        usage: 150_000,
        settings: {
          agent: {
            contextCompaction: { enabled: false, mode: 'auto', compactThreshold: 0.8, compactThresholdTokens: 40_000 },
          },
        },
      });
      expectUncompacted(run);
      expect(factsOfType(run, 'compaction_started')).toHaveLength(0);
    },
  );

  // `native` is an explicit choice and never silently falls back to a summarising model. A custom
  // openai-compatible provider has no native endpoint, so nothing is compacted, and the turn still finishes.
  it(
    'does not substitute local summarisation when native mode is chosen for a provider without a native endpoint',
    { timeout: 60_000 },
    async () => {
      const run = await converse({
        usage: 60_000,
        settings: {
          agent: {
            contextCompaction: { enabled: true, mode: 'native', compactThreshold: 0.8, compactThresholdTokens: 40_000 },
          },
        },
      });
      expectUncompacted(run);
    },
  );

  // TERM2_SUPERVISED=1 is the unattended profile: it replaces the compaction settings with local mode at 60,000
  // tokens under an 80,000-token input ceiling, over whatever settings.json says, so a single env var makes a
  // headless run compact itself. The saved settings here would otherwise disable compaction.
  it(
    'compacts a supervised run at 60,000 reported tokens over saved settings that disable compaction',
    { timeout: 60_000 },
    async () => {
      const over = await converse({ usage: 61_000, env: { TERM2_SUPERVISED: '1' }, settings: conflictingSettings });
      expect(over.summaries).toHaveLength(1);
      expect(over.bravoRequests.map((r) => r.kind)).toEqual(['main', 'main', 'summary', 'main']);
      expect(factsOfType(over, 'compaction_started')).toMatchObject([{ trigger: 'automatic', strategy: 'local' }]);
      expect(JSON.stringify(over.bravoRequests[3]!.body.messages)).toContain(SUMMARY_MARKER);
      expect(JSON.stringify(over.bravoRequests[3]!.body.messages)).not.toContain(ONE_FILE);
    },
  );

  it(
    'leaves a supervised run alone just under 60,000 reported tokens, the same saved settings',
    { timeout: 60_000 },
    async () => {
      const under = await converse({ usage: 59_000, env: { TERM2_SUPERVISED: '1' }, settings: conflictingSettings });
      expectUncompacted(under);
    },
  );

  // The milestone reminder tells the model to call `session_rollover`, a tool only the interactive TUI offers.
  // A headless run must not be told to call a tool its request does not carry.
  it(
    'sends no rollover reminder in a headless run, whose requests carry no session_rollover tool',
    { timeout: 60_000 },
    async () => {
      const run = await converse({
        usage: 60_000,
        settings: {
          agent: {
            sessionRollover: { enabled: true, milestones: [1000], autoBrief: true },
            contextCompaction: { enabled: false },
          },
        },
      });
      expect(run.bravoRequests.map((r) => r.kind)).toEqual(['main', 'main', 'main']);
      const wire = JSON.stringify(run.bravoRequests.map((r) => r.body.messages));
      expect(wire, 'the model was told to call session_rollover').not.toContain('crossed rollover milestone');
      const tools = run.all.flatMap((r) => r.body.tools?.map((tool) => tool.function?.name) ?? []);
      expect(tools, 'the fixture saw no tool list').toContain('read_file');
      expect(tools).not.toContain('session_rollover');
    },
  );
});
