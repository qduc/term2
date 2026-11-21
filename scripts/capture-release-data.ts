/**
 * Capture a snapshot of the data this build of Term2 writes to disk.
 *
 *   pnpm build && pnpm capture:release-data            # version read from package.json
 *   pnpm capture:release-data 1.5.0                    # explicit version
 *
 * The snapshot lands in `tests/fixtures/release-data/<version>/`, which the
 * release-data integration test discovers by directory listing, so a new
 * release needs no test change. Read `tests/fixtures/release-data/README.md`
 * first: a committed snapshot is never edited afterwards.
 *
 * Everything is produced by running the built CLI (`dist/src/app/cli.js`) or the
 * product's own writers (imported from `dist/`) inside throwaway directories,
 * against a loopback Responses provider. Nothing here reads the real home
 * directory or touches the network beyond 127.0.0.1.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
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
const cliPath = path.join(repoRoot, 'dist', 'src', 'app', 'cli.js');

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

async function main(): Promise<void> {
  const version =
    process.argv[2] ??
    (JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { version: string }).version;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`not a version: ${version}`);
  const snapshotsRoot = process.env.RELEASE_DATA_OUT ?? path.join(repoRoot, 'tests', 'fixtures', 'release-data');
  const target = path.join(snapshotsRoot, version);
  if (fs.existsSync(target)) {
    throw new Error(`${target} exists. A committed snapshot is never overwritten; capture the next version instead.`);
  }
  if (!fs.existsSync(cliPath)) throw new Error(`Missing ${cliPath}; run pnpm build first`);

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
  // module loads, and settings.json persists it. Point it at the capture directory before importing.
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
    // The path appears only in the first fact; refuse to guess about anywhere else.
    const text = fs.readFileSync(path.join(dirs.conversations, name), 'utf8');
    const newline = text.indexOf('\n');
    const head = text.slice(0, newline);
    const rest = text.slice(newline);
    if (rest.includes(root))
      throw new Error(`${name}: capture path appears beyond the first fact; scrub it explicitly`);
    if (!head.includes(dirs.workspace)) throw new Error(`${name}: first fact does not name the workspace`);
    fs.writeFileSync(path.join(target, 'conversations', name), head.split(root).join(ROOT_PLACEHOLDER) + rest);
  }
  const settingsText = fs.readFileSync(path.join(settingsDir, 'settings.json'), 'utf8');
  fs.writeFileSync(path.join(target, 'settings', 'settings.json'), settingsText.split(root).join(ROOT_PLACEHOLDER));
  for (const name of ['codex-auth.json', 'grok-auth.json']) {
    fs.copyFileSync(path.join(dirs.config, name), path.join(target, 'config', name));
  }
  try {
    assertNoMachineIdentity(target, [root, realHome, os.tmpdir(), os.hostname()]);
  } catch (error) {
    fs.rmSync(target, { recursive: true, force: true });
    throw error;
  }
  console.log(`captured Term2 ${version} -> ${path.relative(repoRoot, target)}`);
  fs.rmSync(root, { recursive: true, force: true });
}

await main();
