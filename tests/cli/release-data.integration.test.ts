// Upgrade compatibility: data written by earlier Term2 releases must still load with this build.
//
// Each directory under tests/fixtures/release-data/ is a snapshot of what one release wrote
// (see its README.md; `pnpm capture:release-data` makes one). Every snapshot found there is
// copied into throwaway directories and loaded through the built CLI against loopback providers.
// The committed files are never opened for writing, and nothing here knows which versions exist,
// so adding 1.5.0/ later needs no change to this file.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestChildEnv } from '../helpers/terminal-e2e.js';
import { integrationCliPath as cliPath } from '../helpers/integration-cli.js';
import {
  GROK_FIXTURE_MODEL,
  sendSse,
  startGrokFixtureServer,
  startRefusingProxy,
  textFrames,
  writeGrokVersionCache,
  type GrokCapturedRequest,
  type GrokFixtureServer,
  type RefusingProxy,
} from '../../scripts/provider-black-box/grok-fixture.js';

const SNAPSHOTS = fileURLToPath(new URL('../fixtures/release-data', import.meta.url));
/** What the capture script writes in place of the capturing machine's temporary directory. */
const ROOT_PLACEHOLDER = '/term2-release-data';
const RESUME_PROMPT = 'Third prompt, sent after the upgrade.';
const FRESH_PROMPT = 'A fresh prompt after the upgrade.';
const TIMEOUT = 60_000;

const versions = fs
  .readdirSync(SNAPSHOTS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

type Json = Record<string, any>;
type Fact = { type: string } & Json;
type Run = { status: number | null; stdout: string; stderr: string };

let root = '';
let servers: GrokFixtureServer[] = [];
/**
 * Every child routes HTTPS here and is refused. A run reaches for hosts the fixtures do not
 * stand in for (the npm update check, the Codex and Grok catalogues), and a fake credential must
 * never be offered to a real one. Provider traffic itself is plain HTTP to 127.0.0.1.
 */
let refusingProxy: RefusingProxy;

beforeEach(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-release-data-')));
  refusingProxy = await startRefusingProxy();
});
afterEach(async () => {
  await Promise.all([...servers, refusingProxy].map((s) => s.close().catch(() => undefined)));
  servers = [];
  fs.rmSync(root, { recursive: true, force: true });
});

const sha256 = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const readJson = (file: string): Json => JSON.parse(fs.readFileSync(file, 'utf8')) as Json;

/** The snapshot as the loaded-from-disk facts, so assertions come from the snapshot rather than from this file. */
function readFacts(file: string): Fact[] {
  return fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => (JSON.parse(line) as { fact: Fact }).fact);
}

type Sandbox = {
  workspace: string;
  conversationsDir: string;
  settingsFile: string;
  configDir: string;
  cacheDir: string;
  env: NodeJS.ProcessEnv;
  /** Copies of the snapshot's conversation logs, by file name. */
  logs: string[];
};

/** Copy one snapshot into this test's own directories; the committed files stay untouched. */
function install(version: string, extraEnv: NodeJS.ProcessEnv = {}): Sandbox {
  const snapshot = path.join(SNAPSHOTS, version);
  const dirs = {
    workspace: path.join(root, 'workspace'),
    conversationsDir: path.join(root, 'conversations'),
    stateDir: path.join(root, 'state', 'term2-nodejs'),
    configDir: path.join(root, 'config'),
    cacheDir: path.join(root, 'cache'),
    scratch: path.join(root, 'scratch'),
    home: path.join(root, 'home'),
  };
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });

  const logs = fs.readdirSync(path.join(snapshot, 'conversations')).filter((name) => name.endsWith('.jsonl'));
  for (const name of logs) {
    // A log names its workspace in its first fact and a conversation resumes only from that
    // directory. Point the recorded root at this test's directory (the workspace is `<root>/workspace`
    // in both); every other byte is kept.
    const text = fs.readFileSync(path.join(snapshot, 'conversations', name), 'utf8');
    const newline = text.indexOf('\n');
    const head = text.slice(0, newline).split(ROOT_PLACEHOLDER).join(root);
    fs.writeFileSync(path.join(dirs.conversationsDir, name), head + text.slice(newline));
  }
  // settings.json records the default memory directory as an absolute path under the same root.
  const settingsFile = path.join(dirs.stateDir, 'settings.json');
  fs.writeFileSync(
    settingsFile,
    fs.readFileSync(path.join(snapshot, 'settings', 'settings.json'), 'utf8').split(ROOT_PLACEHOLDER).join(root),
  );
  for (const name of fs.readdirSync(path.join(snapshot, 'config'))) {
    fs.copyFileSync(path.join(snapshot, 'config', name), path.join(dirs.configDir, name));
  }

  return {
    workspace: dirs.workspace,
    conversationsDir: dirs.conversationsDir,
    settingsFile,
    configDir: dirs.configDir,
    cacheDir: dirs.cacheDir,
    logs,
    env: createTestChildEnv({
      HOME: dirs.home,
      XDG_STATE_HOME: path.join(root, 'state'),
      XDG_DATA_HOME: path.join(root, 'data'),
      TERM2_CONVERSATIONS_DIR: dirs.conversationsDir,
      TERM2_CONFIG_DIR: dirs.configDir,
      TERM2_CACHE_DIR: dirs.cacheDir,
      DISABLE_LOGGING: '1',
      // A scratch root separate from the workspace, so approval classification is host-independent.
      TMPDIR: dirs.scratch,
      TEMP: dirs.scratch,
      TMP: dirs.scratch,
      ...refusingProxy.env,
      ...extraEnv,
    }),
  };
}

function runCli(sandbox: Sandbox, args: string[]): Promise<Run> {
  const child = spawn('node', [cliPath(), '--lite', ...args], {
    cwd: sandbox.workspace,
    env: sandbox.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: TIMEOUT,
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

async function startProvider(answer = 'Answer from the loopback provider.'): Promise<GrokFixtureServer> {
  const server = await startGrokFixtureServer((_request, number, response) =>
    sendSse(response, textFrames(`resp-release-data-${number}`, answer)),
  );
  servers.push(server);
  return server;
}

const describeRun = (run: Run) =>
  `exit=${run.status}\nstdout=${run.stdout.slice(-600)}\nstderr=${run.stderr.slice(-600)}`;
/** Responses requests only; the OpenAI model listing is a GET with no body. */
const responsesRequests = (server: GrokFixtureServer): GrokCapturedRequest[] =>
  server.requests.filter((request) => request.method === 'POST');

/** Every saved value is still in the file after the run (a run may add keys, never lose one). */
function expectNothingLost(saved: unknown, now: unknown, where = 'settings.json'): void {
  if (saved !== null && typeof saved === 'object' && !Array.isArray(saved)) {
    expect(now, `${where} is no longer an object`).toBeTypeOf('object');
    for (const [key, value] of Object.entries(saved as Json)) {
      expect(Object.keys(now as Json), `${where} lost ${key}`).toContain(key);
      expectNothingLost(value, (now as Json)[key], `${where}.${key}`);
    }
    return;
  }
  expect(now, `${where} changed`).toEqual(saved);
}

describe('committed release snapshots', () => {
  it('exist', () => {
    expect(versions, `no snapshot under ${SNAPSHOTS}`).not.toHaveLength(0);
  });

  describe.each(versions)('Term2 %s data', (version) => {
    it(
      'lists the conversation and resumes it with the earlier turns and tool result in the request',
      async () => {
        const provider = await startProvider();
        const sandbox = install(version, { OPENAI_BASE_URL: provider.baseUrl, OPENAI_API_KEY: 'loopback-key' });
        const [logName] = sandbox.logs;
        const facts = readFacts(path.join(SNAPSHOTS, version, 'conversations', logName!));
        const started = facts.find((fact) => fact.type === 'session_started')!;
        const id = String(started.id).replace(/^conv_/, '');

        const listing = await runCli(sandbox, ['--resume', 'ls']);
        expect(listing.status, describeRun(listing)).toBe(0);
        expect(
          listing.stdout,
          `--resume ls did not show ${id} from the ${version} snapshot\n${describeRun(listing)}`,
        ).toContain(id);

        const settingsBefore = readJson(sandbox.settingsFile);
        const resumed = await runCli(sandbox, ['--resume', id, RESUME_PROMPT]);
        expect(resumed.status, `resuming the ${version} snapshot failed\n${describeRun(resumed)}`).toBe(0);
        expect(resumed.stdout).toContain('Answer from the loopback provider.');

        const requests = responsesRequests(provider);
        expect(requests, 'one model request for the resumed turn').toHaveLength(1);
        const body = requests[0]!.body;
        const input = body.input as Json[];

        // What the snapshot's log recorded, read from the log itself.
        const userTexts = facts
          .filter((fact) => fact.type === 'turn_started')
          .flatMap((fact) =>
            (fact.input as Json[]).flatMap((item) => (item.content as Json[]).map((part) => part.text as string)),
          );
        const items = facts.filter((fact) => fact.type === 'item').map((fact) => fact.item as Json);
        const toolCalls = items.filter((item) => item.type === 'tool_call');
        const toolResults = items.filter((item) => item.type === 'tool_result');
        const assistantTexts = items
          .filter((item) => item.type === 'assistant_message')
          .flatMap((item) => (item.content as Json[]).map((part) => part.text as string));
        expect(userTexts.length, 'snapshot has at least two user turns').toBeGreaterThanOrEqual(2);
        expect(toolCalls.length, 'snapshot has a tool call').toBeGreaterThanOrEqual(1);
        expect(toolResults.length, 'snapshot has a tool result').toBeGreaterThanOrEqual(1);

        const userInputs = input
          .filter((item) => item.role === 'user')
          .map((item) => (item.content as Json[]).map((part) => part.text as string).join(''));
        // The old turns come first, in order, then the new prompt last.
        expect(userInputs, `request lost user turns from the ${version} log`).toEqual([...userTexts, RESUME_PROMPT]);
        for (const call of toolCalls) {
          const sent = input.find((item) => item.type === 'function_call' && item.call_id === call.callId);
          expect(sent, `tool call ${call.callId} from the ${version} log is missing from the request`).toBeDefined();
          expect(sent!.name).toBe(call.toolName);
          expect(JSON.parse(sent!.arguments as string)).toMatchObject(call.input as Json);
        }
        for (const result of toolResults) {
          const sent = input.find((item) => item.type === 'function_call_output' && item.call_id === result.callId);
          expect(
            sent,
            `tool result ${result.callId} from the ${version} log is missing from the request`,
          ).toBeDefined();
          expect(String(sent!.output)).toContain(String(result.output));
        }
        const requestText = JSON.stringify(input);
        for (const text of assistantTexts) expect(requestText).toContain(text);

        // The saved model selection reached the wire, over the saved transport (the loopback
        // double speaks HTTP only, so a lost `agent.transport` would never reach it).
        const saved = settingsBefore.agent as Json;
        expect(body.model).toBe(saved.modelSelection.model);
        expect(saved.transport).toBe('http');
        // The run appended to the log it resumed rather than starting another.
        expect(fs.readdirSync(sandbox.conversationsDir).filter((name) => name.endsWith('.jsonl'))).toEqual(
          sandbox.logs,
        );
        expect(
          readFacts(path.join(sandbox.conversationsDir, logName!)).filter((fact) => fact.type === 'turn_started'),
        ).toHaveLength(userTexts.length + 1);
        expectNothingLost(settingsBefore, readJson(sandbox.settingsFile));
      },
      TIMEOUT,
    );

    it(
      'applies the saved settings to a fresh run and keeps every saved value',
      async () => {
        const provider = await startProvider();
        const sandbox = install(version, { OPENAI_BASE_URL: provider.baseUrl, OPENAI_API_KEY: 'loopback-key' });
        const saved = readJson(sandbox.settingsFile);

        // No --model and no --provider: both come from the saved `agent.modelSelection`.
        const run = await runCli(sandbox, [FRESH_PROMPT]);
        expect(run.status, `a fresh run with the ${version} settings failed\n${describeRun(run)}`).toBe(0);
        const requests = responsesRequests(provider);
        expect(requests).toHaveLength(1);
        expect(requests[0]!.body.model).toBe(saved.agent.modelSelection.model);
        expectNothingLost(saved, readJson(sandbox.settingsFile));
      },
      TIMEOUT,
    );

    it(
      'reads the saved codex-auth.json: the request carries the stored access token',
      async () => {
        const provider = await startProvider();
        const sandbox = install(version, { CODEX_BASE_URL: provider.baseUrl });
        const store = readJson(path.join(sandbox.configDir, 'codex-auth.json'));
        const active = (store.accounts as Json[]).find((account) => account.id === store.activeAccountId)!;

        const run = await runCli(sandbox, ['--provider', 'codex', '--model', 'gpt-5.3-codex', FRESH_PROMPT]);
        expect(run.status, `codex run with the ${version} credential file failed\n${describeRun(run)}`).toBe(0);
        const requests = responsesRequests(provider);
        expect(requests, 'one request reached the Codex loopback').toHaveLength(1);
        expect(requests[0]!.headers.authorization, `the ${version} codex-auth.json token was not sent`).toBe(
          `Bearer ${active.tokens.access_token}`,
        );
      },
      TIMEOUT,
    );

    it(
      'reads the saved grok-auth.json: the request carries the stored access token',
      async () => {
        const provider = await startProvider();
        // A fresh version cache stops the client-version lookup before it reaches for x.ai.
        const sandbox = install(version, {
          GROK_BASE_URL: provider.baseUrl,
          GROK_HOME: path.join(root, 'grok-home-absent'),
        });
        await writeGrokVersionCache(sandbox.cacheDir, '1.0.62', 3_600_000);
        const store = readJson(path.join(sandbox.configDir, 'grok-auth.json'));
        const active = (store.accounts as Json[]).find((account) => account.id === store.activeAccountId)!;

        const run = await runCli(sandbox, ['--provider', 'grok', '--model', GROK_FIXTURE_MODEL, FRESH_PROMPT]);
        expect(run.status, `grok run with the ${version} credential file failed\n${describeRun(run)}`).toBe(0);
        const requests = responsesRequests(provider);
        expect(requests, 'one request reached the Grok loopback').toHaveLength(1);
        expect(requests[0]!.headers.authorization, `the ${version} grok-auth.json token was not sent`).toBe(
          `Bearer ${active.tokens.access_token}`,
        );
      },
      TIMEOUT,
    );

    it(
      'refuses a log with an unknown version by name, without touching it or calling the provider',
      async () => {
        const provider = await startProvider();
        const sandbox = install(version, { OPENAI_BASE_URL: provider.baseUrl, OPENAI_API_KEY: 'loopback-key' });
        const [logName] = sandbox.logs;
        const logFile = path.join(sandbox.conversationsDir, logName!);
        const id = String(readFacts(logFile)[0]!.id).replace(/^conv_/, '');
        // A log from a future release: every line carries a version this build does not know.
        const UNKNOWN = 99;
        const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
        fs.writeFileSync(
          logFile,
          lines.map((line) => line.replace(/^\{"v":\d+,/, `{"v":${UNKNOWN},`)).join('\n') + '\n',
        );
        expect(
          fs
            .readFileSync(logFile, 'utf8')
            .split('\n')
            .filter(Boolean)
            .every((line) => line.startsWith(`{"v":${UNKNOWN},`)),
        ).toBe(true);
        const before = sha256(logFile);

        // Resuming by id fails, and the message names the version and the file.
        const resumed = await runCli(sandbox, ['--resume', id, RESUME_PROMPT]);
        expect(resumed.status, `a log with unknown version ${UNKNOWN} must be refused\n${describeRun(resumed)}`).toBe(
          1,
        );
        expect(resumed.stderr).toContain(`${logName}:1: unsupported log version ${UNKNOWN}`);
        expect(resumed.stderr, 'a message, not a stack trace').not.toMatch(/\n\s+at /);
        expect(sha256(logFile), 'resume rewrote the log').toBe(before);

        // The listing says why it has nothing to show. (What it prints on stdout in that case is
        // not asserted: see the report that accompanies this test.)
        const listing = await runCli(sandbox, ['--resume', 'ls']);
        expect(listing.stderr).toContain(`unsupported log version ${UNKNOWN}`);
        expect(listing.stderr, 'a message, not a stack trace').not.toMatch(/\n\s+at /);
        expect(sha256(logFile), 'the listing rewrote the log').toBe(before);
        expect(responsesRequests(provider), 'the provider was called for a log that could not be read').toHaveLength(0);
      },
      TIMEOUT,
    );
  });
});
