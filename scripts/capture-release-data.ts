/**
 * Capture a snapshot of the data this build of Term2 writes to disk.
 *
 *   pnpm build && pnpm capture:release-data            # version read from package.json
 *   pnpm capture:release-data 1.5.0                    # explicit version
 *   pnpm capture:release-data 1.4.0 --cli /path/to/v1.4.0/dist/src/app/cli.js --only compacted-conversation
 *                                                      # add just the compacted conversation to an existing
 *                                                      # snapshot, written by that release's CLI
 *
 * The snapshot lands in `tests/fixtures/release-data/<version>/`, which the
 * release-data integration test discovers by directory listing, so a new
 * release needs no test change. Read `tests/fixtures/release-data/README.md`
 * first: a committed snapshot is never edited afterwards.
 *
 * Everything is produced by running the built CLI (`dist/src/app/cli.js`) or the
 * product's own writers (imported from `dist/`) inside throwaway directories,
 * against a loopback Responses provider (and, for the compacted conversation, a loopback
 * chat-completions provider). `--cli` names the CLI that runs the conversations; the settings and
 * credential writers always come from this build's `dist/`. Nothing here reads the real home
 * directory or touches the network beyond 127.0.0.1.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  completedFrame,
  createdFrame,
  messageOutput,
  sendSse,
  startGrokFixtureServer,
  textFrames,
  type GrokCapturedRequest,
  type GrokReply,
} from './provider-black-box/grok-fixture.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const defaultCliPath = path.join(repoRoot, 'dist', 'src', 'app', 'cli.js');
/** Set from `--cli` in `main`; the CLI that runs every conversation. */
let cliPath = defaultCliPath;

/** The non-default, non-secret settings the snapshot saves. The test asserts on `model` and `transport`. */
const SNAPSHOT_MODEL = 'release-data-model';
const SNAPSHOT_SETTINGS: ReadonlyArray<readonly [string, unknown]> = [
  ['agent.modelSelection', { provider: 'openai', model: SNAPSHOT_MODEL }],
  ['agent.transport', 'http'],
  ['agent.retryAttempts', 0],
  ['agent.maxTurns', 37],
  ['sandbox.enabled', false],
];
/**
 * The product records absolute paths under the capture directory: the workspace in the log's first
 * fact and the default memory directory in settings.json. They are rewritten to this root at capture
 * time so the snapshot names no machine, and the test points the root at its own temporary directory.
 */
const ROOT_PLACEHOLDER = '/term2-release-data';
const TOOL_COMMAND = 'echo release-data-tool-output';
const FIRST_PROMPT = 'First prompt: run the echo command.';
const SECOND_PROMPT = 'Second prompt: say done.';
const FIRST_ANSWER = 'First answer: the echo command ran.';
const SECOND_ANSWER = 'Second answer: done.';
/** Obviously fake credentials; nothing validates them, a loopback server only has to see them. */
const FAKE_CODEX_TOKEN = 'codex-snapshot-fake-access-token';
const FAKE_GROK_TOKEN = 'grok-snapshot-fake-access-token';

function shellCallFrames(responseId: string): Record<string, unknown>[] {
  const args = JSON.stringify({ command: TOOL_COMMAND, sandbox: 'unsandboxed' });
  const item = {
    id: 'item-1',
    type: 'function_call',
    status: 'in_progress',
    arguments: '',
    call_id: 'call-1',
    name: 'shell',
  };
  const done = { ...item, status: 'completed', arguments: args };
  return [
    createdFrame(responseId),
    { type: 'response.output_item.added', item, output_index: 0 },
    {
      type: 'response.function_call_arguments.delta',
      item_id: 'item-1',
      call_id: 'call-1',
      delta: args,
      output_index: 0,
    },
    {
      type: 'response.function_call_arguments.done',
      item_id: 'item-1',
      call_id: 'call-1',
      arguments: args,
      output_index: 0,
    },
    { type: 'response.output_item.done', item: done, output_index: 0 },
    completedFrame(responseId, [done]),
  ];
}

/**
 * The compacted conversation. Three CLI launches joined by --resume:
 *   alpha    one text reply (cold history, summarised away).
 *   bravo    two read_file rounds, then a reply. The second round's response reports input usage past
 *            `agent.contextCompaction.compactThresholdTokens`, so the engine summarises before the third
 *            request. Compaction needs a complete cold turn, so alpha is the span that is replaced.
 *   charlie  one reply after the compacted log is replayed.
 * Chat completions rather than Responses: the loopback chat world is the route the automatic-compaction
 * integration test already proves; the Responses fixture has no usage-reporting reply.
 */
export const COMPACTED = {
  alphaPrompt: 'Compaction snapshot alpha question.',
  alphaReply: 'ALPHA_REPLY_BEFORE_COMPACTION_SENTINEL',
  bravoPrompt: 'Compaction snapshot bravo question.',
  bravoReply: 'BRAVO_REPLY_SENTINEL',
  charliePrompt: 'Compaction snapshot charlie question.',
  charlieReply: 'CHARLIE_REPLY_AFTER_COMPACTION_SENTINEL',
  oneFile: 'ONE_FILE_TOOL_RESULT_BEFORE_COMPACTION_SENTINEL',
  twoFile: 'TWO_FILE_TOOL_RESULT_HOT_TAIL_SENTINEL',
  summary: 'COMPACTION_SUMMARY_SENTINEL',
} as const;
const COMPACTION_REQUEST_MARKER = '[Host context-compaction request]';
const COMPACTED_DIR = 'conversations-compacted';
const COMPACTION_THRESHOLD_TOKENS = 40_000;
const COMPACTION_REPORTED_USAGE = 60_000;

type ChatRequest = { messages: { role: string; content?: unknown }[] };

function startChatLoopback(): Promise<{ baseUrl: string; requests: string[]; close: () => Promise<void> }> {
  const requests: string[] = [];
  const rounds = new Map<string, number>();
  const sse = (frames: object[]) =>
    [...frames.map((frame) => `data: ${JSON.stringify(frame)}\n`), 'data: [DONE]', ''].join('\n');
  const server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-alpha' }] }));
      return;
    }
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const request = JSON.parse(raw) as ChatRequest;
      requests.push(raw);
      const n = requests.length;
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
      const lastHuman = request.messages
        .filter((message) => message.role === 'user')
        .map((message) => JSON.stringify(message.content ?? ''))
        .filter((text) => text.includes('Compaction snapshot'))
        .at(-1);
      const prompt = [COMPACTED.alphaPrompt, COMPACTED.bravoPrompt, COMPACTED.charliePrompt].find((p) =>
        lastHuman?.includes(p),
      );
      const seen = (rounds.get(prompt ?? '') ?? 0) + 1;
      rounds.set(prompt ?? '', seen);
      let response: object[];
      if (raw.includes(COMPACTION_REQUEST_MARKER)) response = reply(COMPACTED.summary, 300);
      else if (prompt === COMPACTED.alphaPrompt) response = reply(COMPACTED.alphaReply, 400);
      else if (prompt === COMPACTED.charliePrompt) response = reply(COMPACTED.charlieReply, 400);
      else if (seen === 1) response = read('one.txt', 400);
      else if (seen === 2) response = read('two.txt', COMPACTION_REPORTED_USAGE);
      else response = reply(COMPACTED.bravoReply, 400);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(sse(response));
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({
        baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
        requests,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      }),
    ),
  );
}

/**
 * The first fact names the workspace, an absolute path under the capture root. Rewrite that root to the
 * placeholder; refuse if the root appears anywhere else in the log.
 */
function scrubLog(name: string, text: string, root: string, workspace: string): string {
  const newline = text.indexOf('\n');
  const head = text.slice(0, newline);
  const rest = text.slice(newline);
  if (rest.includes(root)) throw new Error(`${name}: capture path appears beyond the first fact; scrub it explicitly`);
  if (!head.includes(workspace)) throw new Error(`${name}: first fact does not name the workspace`);
  return head.split(root).join(ROOT_PLACEHOLDER) + rest;
}

/** Run the three launches with the configured CLI and return the scrubbed log. Never writes outside its own root. */
async function captureCompactedConversation(): Promise<{ name: string; text: string }> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-capture-compact-')));
  const dirs = {
    home: path.join(root, 'home'),
    state: path.join(root, 'state'),
    conversations: path.join(root, 'conversations'),
    config: path.join(root, 'config'),
    cache: path.join(root, 'cache'),
    workspace: path.join(root, 'workspace'),
    scratch: path.join(root, 'scratch', 'term2-nodejs'),
  };
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
  // Large enough that replacing it with a summary shrinks the request; a summary that does not is discarded.
  fs.writeFileSync(
    path.join(dirs.workspace, 'one.txt'),
    `${COMPACTED.oneFile}\n${'filler filler filler filler\n'.repeat(600)}`,
  );
  fs.writeFileSync(path.join(dirs.workspace, 'two.txt'), `${COMPACTED.twoFile}\n`);
  const provider = await startChatLoopback();
  try {
    fs.mkdirSync(path.join(dirs.state, 'term2-nodejs'), { recursive: true });
    fs.writeFileSync(
      path.join(dirs.state, 'term2-nodejs', 'settings.json'),
      JSON.stringify({
        agent: {
          retryAttempts: 0,
          modelSelection: { provider: 'mockprov', model: 'mock-alpha' },
          maxRequestInputTokens: 200_000,
          contextCompaction: {
            enabled: true,
            mode: 'auto',
            compactThreshold: 0.8,
            compactThresholdTokens: COMPACTION_THRESHOLD_TOKENS,
          },
        },
        providers: [
          { name: 'mockprov', type: 'openai-compatible', baseUrl: provider.baseUrl, apiKey: 'capture-only-key' },
        ],
        sandbox: { enabled: false },
      }),
    );
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: dirs.home,
      XDG_STATE_HOME: dirs.state,
      XDG_DATA_HOME: path.join(root, 'data'),
      XDG_CACHE_HOME: dirs.cache,
      XDG_CONFIG_HOME: path.join(dirs.home, '.config'),
      TERM2_CONVERSATIONS_DIR: dirs.conversations,
      TERM2_CONFIG_DIR: dirs.config,
      TERM2_CACHE_DIR: dirs.cache,
      DISABLE_LOGGING: '1',
      TMPDIR: dirs.scratch,
      TEMP: dirs.scratch,
      TMP: dirs.scratch,
      LANG: 'C.UTF-8',
    };
    const first = await run(['--lite', COMPACTED.alphaPrompt], env, dirs.workspace);
    if (first.status !== 0)
      throw new Error(`compaction alpha run failed (${first.status}):\n${first.out.slice(-1500)}`);
    const logs = fs.readdirSync(dirs.conversations).filter((name) => name.endsWith('.jsonl'));
    if (logs.length !== 1) throw new Error(`expected one log, found ${logs.join(', ')}`);
    const id = logs[0]!.replace(/^conv_/, '').replace(/\.jsonl$/, '');
    for (const [label, prompt] of [
      ['bravo', COMPACTED.bravoPrompt],
      ['charlie', COMPACTED.charliePrompt],
    ] as const) {
      const result = await run(['--lite', '--resume', id, prompt], env, dirs.workspace);
      if (result.status !== 0)
        throw new Error(`compaction ${label} run failed (${result.status}):\n${result.out.slice(-1500)}`);
    }
    const summaries = provider.requests.filter((raw) => raw.includes(COMPACTION_REQUEST_MARKER));
    const name = logs[0]!;
    const text = fs.readFileSync(path.join(dirs.conversations, name), 'utf8');
    const facts = text
      .trim()
      .split('\n')
      .map((line) => (JSON.parse(line) as { fact: { type: string } }).fact);
    if (summaries.length !== 1 || !facts.some((fact) => fact.type === 'compaction_completed')) {
      throw new Error(
        `this CLI did not compact (summary requests: ${summaries.length}; fact types: ${[
          ...new Set(facts.map((f) => f.type)),
        ].join(', ')}). Refusing to save a log without a compaction.`,
      );
    }
    return { name, text: scrubLog(name, text, root, dirs.workspace) };
  } finally {
    await provider.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function run(args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<{ status: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (out += chunk));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, out }));
  });
}

async function importDist<T>(relative: string): Promise<T> {
  return (await import(pathToFileURL(path.join(repoRoot, 'dist', relative)).href)) as T;
}

/** Refuse to leave a snapshot that names this machine: its paths or hostname. */
function assertNoMachineIdentity(directory: string, identities: string[]): void {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    const text = fs.readFileSync(file, 'utf8');
    for (const identity of identities) {
      if (
        identity &&
        identity !== '/' &&
        new RegExp(`(?<![\\w-])${identity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`).test(text)
      ) {
        throw new Error(`${path.relative(directory, file)} still contains ${JSON.stringify(identity)}`);
      }
    }
  }
}

function parseArgs(argv: string[]): { version?: string; cli?: string; only?: string } {
  const out: { version?: string; cli?: string; only?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--cli') out.cli = argv[++i];
    else if (arg === '--only') out.only = argv[++i];
    else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
    else out.version = arg;
  }
  return out;
}

/** Write a captured file into the snapshot, refusing to replace anything already there. */
function addFile(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { flag: 'wx' });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.only !== undefined && args.only !== 'compacted-conversation') {
    throw new Error(`--only takes "compacted-conversation", not ${JSON.stringify(args.only)}`);
  }
  if (args.cli) cliPath = path.resolve(args.cli);
  const version =
    args.version ??
    (JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { version: string }).version;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`not a version: ${version}`);
  const snapshotsRoot = process.env.RELEASE_DATA_OUT ?? path.join(repoRoot, 'tests', 'fixtures', 'release-data');
  const target = path.join(snapshotsRoot, version);
  if (!fs.existsSync(cliPath)) throw new Error(`Missing ${cliPath}; run pnpm build first`);

  if (args.only) {
    // Add one conversation to a snapshot that already exists; nothing already in it is read for writing.
    if (!fs.existsSync(target)) throw new Error(`${target} does not exist; --only adds to an existing snapshot.`);
    if (fs.existsSync(path.join(target, COMPACTED_DIR))) {
      throw new Error(`${path.join(target, COMPACTED_DIR)} exists. A committed snapshot is never overwritten.`);
    }
    const compacted = await captureCompactedConversation();
    const staging = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-capture-stage-')));
    try {
      addFile(path.join(staging, COMPACTED_DIR, compacted.name), compacted.text);
      assertNoMachineIdentity(staging, [os.homedir(), os.tmpdir(), os.hostname()]);
      addFile(path.join(target, COMPACTED_DIR, compacted.name), compacted.text);
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
    console.log(`added ${COMPACTED_DIR}/${compacted.name} to ${path.relative(repoRoot, target)}`);
    return;
  }
  if (fs.existsSync(target)) {
    throw new Error(`${target} exists. A committed snapshot is never overwritten; capture the next version instead.`);
  }

  const realHome = os.homedir();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-capture-')));
  const dirs = {
    home: path.join(root, 'home'),
    data: path.join(root, 'data'),
    state: path.join(root, 'state'),
    conversations: path.join(root, 'conversations'),
    config: path.join(root, 'config'),
    cache: path.join(root, 'cache'),
    workspace: path.join(root, 'workspace'),
    scratch: path.join(root, 'scratch'),
  };
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
  const settingsDir = path.join(dirs.state, 'term2-nodejs');
  // The settings schema defaults `memory.directory` to the user's data directory, resolved when the
  // module loads. Releases up to 1.4.0 persisted it in settings.json; later ones write it only when it
  // was set. Point it at the capture directory before importing either way.
  process.env.HOME = dirs.home;
  process.env.XDG_DATA_HOME = dirs.data;

  // settings.json: saved through the product's own persistence path, never written by hand.
  const { SettingsService } = await importDist<typeof import('../src/app/settings-service.js')>(
    'src/app/settings-service.js',
  );
  const settings = new SettingsService({ settingsDir, disableLogging: true, disableFilePersistence: false });
  for (const [key, value] of SNAPSHOT_SETTINGS) {
    const result = (
      settings as unknown as { setPersistentDynamic(k: string, v: unknown): { status: string } }
    ).setPersistentDynamic(key, value);
    if (result.status !== 'saved') throw new Error(`settings ${key}: ${JSON.stringify(result)}`);
  }

  // Credential files: the product's own account-store writers, fake token values.
  const codex = await importDist<typeof import('../src/model/providers/codex-auth.js')>(
    'src/model/providers/codex-auth.js',
  );
  codex.saveCodexTokens(
    {
      access_token: FAKE_CODEX_TOKEN,
      refresh_token: 'codex-snapshot-fake-refresh-token',
      account_id: 'snapshot-codex-account',
    },
    path.join(dirs.config, 'codex-auth.json'),
  );
  const grok = await importDist<typeof import('../src/model/providers/grok-auth.js')>(
    'src/model/providers/grok-auth.js',
  );
  grok.saveGrokTokens(
    {
      access_token: FAKE_GROK_TOKEN,
      refresh_token: 'grok-snapshot-fake-refresh-token',
      // Far future, so the snapshot never reaches the refresh path (which would need the network).
      expires_at: Date.UTC(2100, 0, 1),
      email: 'snapshot-grok@example.test',
      user_id: 'snapshot-grok-user',
    },
    path.join(dirs.config, 'grok-auth.json'),
  );

  // Conversation: two CLI runs against one loopback provider. Run 1 = prompt + shell call + answer; run 2 resumes it.
  let phase: 'first' | 'second' = 'first';
  let firstRunRequests = 0;
  const reply: GrokReply = (_request: GrokCapturedRequest, number, response) => {
    if (phase === 'second') return sendSse(response, textFrames(`resp-snap-${number}`, SECOND_ANSWER));
    firstRunRequests += 1;
    return sendSse(
      response,
      firstRunRequests === 1 ? shellCallFrames(`resp-snap-${number}`) : textFrames(`resp-snap-${number}`, FIRST_ANSWER),
    );
  };
  const provider = await startGrokFixtureServer(reply);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: dirs.home,
    XDG_STATE_HOME: dirs.state,
    XDG_DATA_HOME: dirs.data,
    TERM2_CONVERSATIONS_DIR: dirs.conversations,
    TERM2_CONFIG_DIR: dirs.config,
    TERM2_CACHE_DIR: dirs.cache,
    OPENAI_BASE_URL: provider.baseUrl,
    OPENAI_API_KEY: 'capture-only-openai-key',
    DISABLE_LOGGING: '1',
    TMPDIR: dirs.scratch,
    TEMP: dirs.scratch,
    TMP: dirs.scratch,
    LANG: 'C.UTF-8',
  };
  try {
    const first = await run(['--lite', '--auto-approve', FIRST_PROMPT], env, dirs.workspace);
    if (first.status !== 0) throw new Error(`first run failed (${first.status}):\n${first.out.slice(-1500)}`);
    const logs = fs.readdirSync(dirs.conversations).filter((name) => name.endsWith('.jsonl'));
    if (logs.length !== 1) throw new Error(`expected one log, found ${logs.join(', ')}`);
    const id = logs[0]!.replace(/^conv_/, '').replace(/\.jsonl$/, '');
    phase = 'second';
    const second = await run(['--lite', '--resume', id, SECOND_PROMPT], env, dirs.workspace);
    if (second.status !== 0) throw new Error(`second run failed (${second.status}):\n${second.out.slice(-1500)}`);
  } finally {
    await provider.close();
  }

  // Copy out only the files the product persisted, preserving its bytes.
  fs.mkdirSync(path.join(target, 'conversations'), { recursive: true });
  fs.mkdirSync(path.join(target, 'settings'), { recursive: true });
  fs.mkdirSync(path.join(target, 'config'), { recursive: true });
  for (const name of fs.readdirSync(dirs.conversations)) {
    if (!name.endsWith('.jsonl')) continue;
    const text = fs.readFileSync(path.join(dirs.conversations, name), 'utf8');
    fs.writeFileSync(path.join(target, 'conversations', name), scrubLog(name, text, root, dirs.workspace));
  }
  const settingsText = fs.readFileSync(path.join(settingsDir, 'settings.json'), 'utf8');
  fs.writeFileSync(path.join(target, 'settings', 'settings.json'), settingsText.split(root).join(ROOT_PLACEHOLDER));
  for (const name of ['codex-auth.json', 'grok-auth.json']) {
    fs.copyFileSync(path.join(dirs.config, name), path.join(target, 'config', name));
  }
  try {
    const compacted = await captureCompactedConversation();
    addFile(path.join(target, COMPACTED_DIR, compacted.name), compacted.text);
    assertNoMachineIdentity(target, [root, realHome, os.tmpdir(), os.hostname()]);
  } catch (error) {
    fs.rmSync(target, { recursive: true, force: true });
    throw error;
  }
  console.log(`captured Term2 ${version} -> ${path.relative(repoRoot, target)}`);
  fs.rmSync(root, { recursive: true, force: true });
}

await main();
