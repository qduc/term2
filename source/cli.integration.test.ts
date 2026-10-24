import { it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawn, type SpawnOptions } from 'child_process';
import fs from 'fs';
import http from 'http';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { resolveSettingsDirectory } from './services/settings/settings-path.js';
import { createTestChildEnv } from './test-helpers/terminal-e2e.js';

const require = createRequire(import.meta.url);

function expectedToolLine(command: string): string {
  const preview = command.length > 80 ? `${command.slice(0, 80)}…` : command;
  return `[tool] shell: ${preview}`;
}

// dist/ is a gitignored build artifact, so a fresh worktree has no compiled
// CLI and these tests would fail until someone runs `pnpm build`. Instead of
// spawning tsx per test (which pays a ~2s compile per process), compile the
// CLI once into a per-worktree cache with the same compiler and config as
// `pnpm build` (incremental, so unchanged work is a fast no-op) and spawn
// that for every test.
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const typescriptDir = path.resolve(path.dirname(require.resolve('typescript-7')), '..');
const cliBuildDir = path.join(projectRoot, 'node_modules', '.cache', 'term2-cli-test-build');

let compiledCliPath: string | undefined;
function cliPath(): string {
  if (compiledCliPath) return compiledCliPath;
  fs.mkdirSync(cliBuildDir, { recursive: true });
  try {
    execFileSync(
      process.execPath,
      [
        path.join(typescriptDir, 'bin', 'tsc'),
        '--project',
        'tsconfig.build.json',
        '--outDir',
        cliBuildDir,
        '--incremental',
        '--tsBuildInfoFile',
        path.join(cliBuildDir, 'tsconfig.tsbuildinfo'),
      ],
      { cwd: projectRoot, stdio: 'pipe' },
    );
  } catch (error: any) {
    throw new Error(`Failed to build CLI for tests: ${error.stderr?.toString?.() ?? error}`);
  }
  // `pnpm build` copies the prompts next to the compiled output; do the same
  // so import.meta.dirname-based prompt resolution works from the cache dir.
  fs.cpSync(path.join(projectRoot, 'source', 'prompts'), path.join(cliBuildDir, 'prompts'), { recursive: true });
  compiledCliPath = path.join(cliBuildDir, 'cli.js');
  return compiledCliPath;
}

/**
 * Spawn the CLI and collect its streams as a promise. Async on purpose: the
 * mock provider server lives in this process, so a synchronous spawn would
 * block the event loop the server needs to answer the child's /models request.
 * stdin is always 'ignore' (immediate EOF): these invocations must never wait
 * on interactive input.
 */
function spawnCli(
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd?: string,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  // Fixture workspaces may themselves live under an inherited sandbox TMPDIR.
  // Give the child a separate scratch root: otherwise ordinary fixture files
  // gain scratch permissions (rm becomes YELLOW; explicit file writes need no approval).
  const child = spawn('node', args, {
    env: { ...env, TMPDIR: cliTempDir, TEMP: cliTempDir, TMP: cliTempDir },
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

let testDir = '';
let cliTempDir = '';

/**
 * Minimal OpenAI-compatible provider double: `/models` serves a fixed list,
 * chat completions get a one-frame SSE answer, and every chat request's
 * `model` field is recorded so tests can assert which model id actually
 * reached the wire.
 */
async function startModelMock(
  modelIds: Array<string | Record<string, unknown>>,
  /** SSE data payloads for the n-th chat request (1-based); defaults to a plain "ok" reply. */
  script?: (n: number, body?: Record<string, unknown>) => unknown[],
): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
  capturedModels: () => string[];
  capturedRequests: () => Record<string, unknown>[];
}> {
  const requestedModels: string[] = [];
  const requestedBodies: Record<string, unknown>[] = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url?.includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'list',
          data: modelIds.map((item) => (typeof item === 'string' ? { id: item } : item)),
        }),
      );
      return;
    }
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        requestedModels.push(String(parsed.model));
        requestedBodies.push(parsed);
      } catch {
        // Non-chat POSTs are recorded as unknown and ignored.
        requestedModels.push('<unparseable>');
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const scripted = script?.(requestedBodies.length, requestedBodies[requestedBodies.length - 1]);
      if (scripted) {
        res.end([...scripted.map((data) => `data: ${JSON.stringify(data)}\n`), 'data: [DONE]', ''].join('\n'));
        return;
      }
      res.end(
        [
          'data: {"id":"chatcmpl-mock","choices":[{"delta":{"role":"assistant","content":"ok"}}]}',
          '',
          'data: {"id":"chatcmpl-mock","choices":[{"delta":{},"finish_reason":"stop"}]}',
          '',
          'data: [DONE]',
          '',
        ].join('\n'),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
    capturedModels: () => [...requestedModels],
    capturedRequests: () => [...requestedBodies],
  };
}

function writeSettings(homeDir: string, settings: Record<string, unknown>): string {
  const settingsDir = resolveSettingsDirectory({ homeDir });
  fs.mkdirSync(settingsDir, { recursive: true });
  const settingsFile = path.join(settingsDir, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), 'utf-8');
  return settingsFile;
}

it('CLI generic model listing ignores vendor capabilities and replaces broadly filtered disk catalogs', async () => {
  const advertised = [
    { id: 'fixture-chat', supported_endpoint_types: ['openai'] },
    {
      id: 'fixture-vision',
      supported_endpoint_types: ['openai', 'gemini'],
      architecture: { input_modalities: ['text', 'image', 'video'], output_modalities: ['text'] },
    },
    { id: 'fixture-minimal' },
    { id: 'fixture-image', supported_endpoint_types: ['image-generation'] },
    { id: 'fixture-video', supported_endpoint_types: ['openai-video'] },
    { id: 'fixture-embedding', supported_endpoint_types: ['embeddings'] },
    { id: 'fixture-unadvertised', supported_endpoint_types: null },
    { id: 'fixture-empty', supported_endpoint_types: [] },
    { id: 'fixture-other-protocol', supported_endpoint_types: ['gemini'] },
    {
      id: 'fixture-mixed-output',
      supported_endpoint_types: ['openai'],
      architecture: { output_modalities: ['text', 'image'] },
    },
  ];
  const mock = await startModelMock(advertised);
  const cacheDir = path.join(testDir, 'cache');
  const cacheFile = path.join(cacheDir, 'models', 'fixture.json');
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(
    cacheFile,
    JSON.stringify({
      version: 2,
      provider: 'fixture',
      timestamp: Date.now(),
      models: [{ id: 'fixture-chat', provider: 'fixture' }],
    }),
  );
  writeSettings(testDir, {
    agent: { modelSelection: { provider: 'fixture', model: 'fixture-chat' } },
    providers: [{ name: 'fixture', type: 'openai-compatible', baseUrl: mock.baseUrl, apiKey: 'test-key' }],
  });
  const env = createTestChildEnv({ HOME: testDir, TERM2_CACHE_DIR: cacheDir, DISABLE_LOGGING: '1' });
  try {
    // A non-OrcaRouter endpoint must retain every model, even if it returns
    // similarly named capability fields with different vendor semantics.
    for (const args of [[], ['--refresh']]) {
      const result = await spawnCli([cliPath(), '--list-models', '--provider', 'fixture', ...args], env);
      expect(result.status, result.stderr).toBe(0);
      for (const item of advertised) {
        expect(result.stdout).toContain(item.id);
      }
    }
    const saved = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    expect(saved.version).toBe(3);
    expect(saved.models.map((model: { id: string }) => model.id).sort()).toEqual(advertised.map(({ id }) => id).sort());
  } finally {
    await mock.close();
  }
});

beforeEach(() => {
  testDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-cli-test-')));
  // The app suffix makes this the child's SANDBOX_TEMP_DIR on every platform,
  // independent of HOME and the runner's own temporary directory.
  cliTempDir = path.join(testDir, 'scratch', 'term2-nodejs');
  fs.mkdirSync(cliTempDir, { recursive: true });
});

it('finishes a provider turn when file logging hits ENOSPC', async () => {
  const home = path.join(testDir, 'home');
  const workspace = path.join(testDir, 'workspace');
  const stateHome = path.join(home, '.local', 'state');
  fs.mkdirSync(workspace, { recursive: true });
  // Inject the disk error at the actual log stream boundary. /dev/full is
  // Linux-only, and env-paths uses a different log directory on macOS.
  const preload = path.join(testDir, 'disk-full.cjs');
  fs.writeFileSync(
    preload,
    `
const fs = require('node:fs');
const path = require('node:path');
const createWriteStream = fs.createWriteStream;
const failWrite = (...args) => queueMicrotask(() => args.at(-1)(Object.assign(new Error('fixture disk full'), { code: 'ENOSPC' })));
fs.createWriteStream = (filename, options) => {
  const name = path.basename(String(filename));
  return createWriteStream(filename, name.startsWith('term2-') && name.endsWith('.log')
    ? { ...options, fs: { ...fs, write: failWrite, writev: failWrite } }
    : options);
};
`,
  );
  const mock = await startModelMock(['mock-alpha']);
  const env = createTestChildEnv({
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_STATE_HOME: stateHome,
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_RUNTIME_DIR: path.join(testDir, 'runtime'),
    TERM2_CACHE_DIR: path.join(home, '.cache', 'term2'),
    TERM2_CONVERSATIONS_DIR: path.join(testDir, 'conversations'),
    TZ: process.env.TZ,
    LOG_LEVEL: 'debug',
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=${JSON.stringify(preload)}`,
  });
  writeSettings(home, {
    agent: { retryAttempts: 0, modelSelection: { model: 'mock-alpha', provider: 'mockprov' } },
    providers: [{ name: 'mockprov', type: 'openai-compatible', baseUrl: mock.baseUrl, apiKey: 'test-key' }],
  });

  try {
    const result = await spawnCli([cliPath(), '--auto-approve', 'Reply with a short answer'], env, workspace);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('ok');
    expect(result.stderr).toContain('File logging disabled after write failure');
    expect(result.stderr.match(/File logging disabled after write failure/g)).toHaveLength(1);
    expect(result.stderr).not.toContain('[winston]');
    expect(result.stderr).not.toContain("Unhandled 'error' event");
    expect(mock.capturedRequests()).toHaveLength(1);
  } finally {
    await mock.close();
  }
});

afterEach(() => {
  if (testDir && fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
});

it('CLI --help documents the available command-line options', () => {
  const help = execFileSync('node', [cliPath(), '--help'], {
    env: createTestChildEnv({
      HOME: testDir,
      DISABLE_LOGGING: '1',
    }),
    encoding: 'utf8',
  });

  expect(help).toContain('$ term2 [options] [prompt...]');
  expect(help).toContain(
    '-m, --model <model>                  Model pattern or ID, supports provider/id and optional :<thinking>',
  );
  expect(help).toContain('-p, --provider <provider>');
  expect(help).toContain('-r, --reasoning <effort>');
  expect(help).toContain('--goal <text>');
  expect(help).toContain('--goal-criteria <text>');
  expect(help).toContain('-l, --lite');
  expect(help).toContain('--auto-approve');
  expect(help).toContain('--ssh <user@host>');
  expect(help).toContain('--remote-dir <path>');
  expect(help).toContain('--ssh-port <port>');
  expect(help).toContain('-R, --resume [conversation-id|ls]');
  expect(help).toContain('--fork');
  expect(help).toContain('In a chat, type / to see available commands.');
  expect(help).toContain('settings.json');
  expect(help).toContain('Log in to Grok in a browser');
  expect(help).not.toContain('ChatForge BFF');
  expect(help).not.toContain('exactly as before');
});

it('CLI validates goal flags before startup', async () => {
  const { status, stderr } = await spawnCli(
    [cliPath(), '--goal-criteria', 'must pass'],
    createTestChildEnv({ HOME: testDir, TERM2_CONVERSATIONS_DIR: testDir, DISABLE_LOGGING: '1' }),
  );
  expect(status).toBe(1);
  expect(stderr).toContain('--goal-criteria requires --goal');
  const overBound = await spawnCli(
    [cliPath(), '--goal', 'x'.repeat(2001)],
    createTestChildEnv({ HOME: testDir, TERM2_CONVERSATIONS_DIR: testDir, DISABLE_LOGGING: '1' }),
  );
  expect(overBound.status).toBe(1);
  expect(overBound.stderr).toContain('Goal outcome must be at most 2000 characters');
});

it('interactive launch persists the goal before requiring a terminal', async () => {
  const { status, stderr } = await spawnCli(
    [cliPath(), '--lite', '--goal', 'Interactive outcome', '--goal-criteria', 'Visible result'],
    createTestChildEnv({ HOME: testDir, TERM2_CONVERSATIONS_DIR: testDir, DISABLE_LOGGING: '1' }),
  );
  expect(status).toBe(1);
  expect(stderr).toContain('term2 needs an interactive terminal');
  const logPath = fs.readdirSync(testDir).find((file) => file.endsWith('.jsonl'));
  expect(logPath, stderr).toBeDefined();
  const events = fs
    .readFileSync(path.join(testDir, logPath!), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line).event);
  expect(events.map((event) => event.type)).toEqual(['session_init', 'goal_changed']);
  expect(events[1]).toMatchObject({
    version: 1,
    goal: { outcome: 'Interactive outcome', successCriteria: 'Visible result', status: 'active' },
  });
});

it('positional launch durably records its goal before the first provider request', async () => {
  const tempHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-home-')));
  const mock = await startModelMock(['mock-alpha']);
  writeSettings(tempHome, {
    agent: { retryAttempts: 0, modelSelection: { model: 'mock-alpha', provider: 'mockprov' } },
    providers: [{ name: 'mockprov', type: 'openai-compatible', baseUrl: mock.baseUrl, apiKey: 'test-key' }],
  });
  try {
    const { status, stderr } = await spawnCli(
      [cliPath(), '--goal', 'Noninteractive outcome', '--goal-criteria', 'Provider returns', 'hello'],
      createTestChildEnv({ HOME: tempHome, TERM2_CONVERSATIONS_DIR: testDir, DISABLE_LOGGING: '1' }),
    );
    expect(status).toBe(0);
    // The text-only mock never calls goal_check, so the active-goal stop check
    // reminds twice and then returns control with a visible notice.
    expect(mock.capturedModels()).toEqual(['mock-alpha', 'mock-alpha', 'mock-alpha']);
    const sentRequest = JSON.stringify(mock.capturedRequests()[0]);
    expect(sentRequest).toContain('Noninteractive outcome');
    expect(sentRequest).toContain('Provider returns');
    expect(sentRequest).toContain('not user approval, authorization, permission, a plan');
    expect(sentRequest).toContain('goal_check');
    expect(JSON.stringify(mock.capturedRequests()[1])).toContain('Durable goal stop check');
    expect(stderr).toContain('Goal stop check unresolved');
    const logPath = fs.readdirSync(testDir).find((file) => file.endsWith('.jsonl'));
    expect(logPath).toBeDefined();
    const events = fs
      .readFileSync(path.join(testDir, logPath!), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).event);
    const goalIndex = events.findIndex((event) => event.type === 'goal_changed');
    const firstRequestArtifactIndex = events.findIndex((event) => event.type === 'assistant_journal_item');
    expect(goalIndex).toBeGreaterThanOrEqual(0);
    expect(firstRequestArtifactIndex, JSON.stringify(events.map((event) => event.type))).toBeGreaterThan(goalIndex);
    expect(events[goalIndex].goal).toMatchObject({
      outcome: 'Noninteractive outcome',
      successCriteria: 'Provider returns',
    });
    // The unresolved stop check never rewrites durable goal status.
    expect(events.filter((event) => event.type === 'goal_changed')).toHaveLength(1);
    expect(events[goalIndex].goal.status).toBe('active');
  } finally {
    await mock.close();
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

it('positional launch closes the goal after a recorded achieved goal_check and reports it', async () => {
  const tempHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-home-')));
  const check = {
    status: 'achieved',
    evidence: 'Provider returned the reply',
    criteriaEvidence: 'Provider returns: request 1 completed',
  };
  const mock = await startModelMock(['mock-alpha'], (n) =>
    n === 1
      ? [
          {
            id: 'chatcmpl-check',
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_check',
                      type: 'function',
                      function: { name: 'goal_check', arguments: JSON.stringify(check) },
                    },
                  ],
                },
              },
            ],
          },
          { id: 'chatcmpl-check', choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ]
      : [
          { id: 'chatcmpl-done', choices: [{ delta: { role: 'assistant', content: 'Shipped.' } }] },
          { id: 'chatcmpl-done', choices: [{ delta: {}, finish_reason: 'stop' }] },
        ],
  );
  writeSettings(tempHome, {
    // Exercise the legacy self-check/rollback path; independent completion has its own persisted-runtime coverage.
    agent: {
      completionVerification: false,
      retryAttempts: 0,
      modelSelection: { model: 'mock-alpha', provider: 'mockprov' },
    },
    providers: [{ name: 'mockprov', type: 'openai-compatible', baseUrl: mock.baseUrl, apiKey: 'test-key' }],
  });
  try {
    const { status, stdout, stderr } = await spawnCli(
      [cliPath(), '--goal', 'Noninteractive outcome', '--goal-criteria', 'Provider returns', 'hello'],
      createTestChildEnv({ HOME: tempHome, TERM2_CONVERSATIONS_DIR: testDir, DISABLE_LOGGING: '1' }),
    );
    expect(status, stderr).toBe(0);
    // One request for the check, one for the final reply: no reminder.
    expect(mock.capturedModels()).toEqual(['mock-alpha', 'mock-alpha']);
    expect(JSON.stringify(mock.capturedRequests()[1])).not.toContain('Durable goal stop check');
    expect(stdout).toContain('Shipped.');
    expect(stderr).toContain(
      "Goal (achieved): Noninteractive outcome\nSuccess criteria: Provider returns\nCompletion accepted after the model's goal_check.",
    );
    const logPath = fs.readdirSync(testDir).find((file) => file.endsWith('.jsonl'));
    const events = fs
      .readFileSync(path.join(testDir, logPath!), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).event);
    const goals = events.filter((event) => event.type === 'goal_changed');
    expect(goals).toHaveLength(2);
    expect(goals[0].goal.status).toBe('active');
    expect(goals[0].source).toBeUndefined();
    expect(goals[1]).toMatchObject({
      version: 1,
      source: 'goal_check',
      goal: { id: goals[0].goal.id, outcome: 'Noninteractive outcome', status: 'achieved' },
    });
  } finally {
    await mock.close();
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

it.each(['', 'mock-verifier'])(
  'the shipped CLI verifies a durable goal with verifier.model=%s',
  async (verifierModel) => {
    const tempHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-home-')));
    // The gate attests to a repository change set, so the workspace is a real Git
    // repository holding one uncommitted source file.
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-verify-repo-')));
    execFileSync('git', ['init', '--quiet', repo]);
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'fixture@example.test']);
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'Fixture']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# Fixture\n');
    fs.writeFileSync(
      path.join(repo, 'math.ts'),
      'export function add(a: number, b: number): number {\n  return a + b;\n}\n',
    );
    execFileSync('git', ['-C', repo, 'add', 'README.md']);
    execFileSync('git', ['-C', repo, 'commit', '--quiet', '-m', 'initial']);

    const check = {
      status: 'achieved',
      evidence: 'Provider returned the reply',
      criteriaEvidence: 'math.ts exports add(a, b) returning a + b',
    };
    const mock = await startModelMock(['mock-alpha', 'mock-verifier'], (n, body) => {
      const tools = Array.isArray(body?.tools) ? (body!.tools as Record<string, unknown>[]) : [];
      const messages = Array.isArray(body?.messages) ? (body!.messages as Record<string, unknown>[]) : [];
      const isVerifier = tools.some((tool) => {
        const fn = tool?.function as { name?: string } | undefined;
        return (fn?.name ?? (tool?.name as string | undefined)) === 'verification_probe';
      });
      if (isVerifier) {
        // The first verifier round probes the repository; the second returns the verdict.
        if (!messages.some((message) => message?.role === 'tool')) {
          return [
            {
              id: 'chatcmpl-probe',
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_probe',
                        type: 'function',
                        function: {
                          name: 'verification_probe',
                          arguments: JSON.stringify({ kind: 'list_files' }),
                        },
                      },
                    ],
                  },
                },
              ],
            },
            { id: 'chatcmpl-probe', choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
          ];
        }
        return [
          {
            id: 'chatcmpl-verdict',
            choices: [
              {
                delta: {
                  role: 'assistant',
                  content: JSON.stringify({
                    outcome: 'PASS',
                    evidence: 'math.ts is in the repository root and exports add(a, b) returning a + b.',
                    checked: ['Repository listing'],
                    limitations: ['Static inspection only'],
                  }),
                },
              },
            ],
          },
          { id: 'chatcmpl-verdict', choices: [{ delta: {}, finish_reason: 'stop' }] },
        ];
      }
      return n === 1
        ? [
            {
              id: 'chatcmpl-check',
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_check',
                        type: 'function',
                        function: { name: 'goal_check', arguments: JSON.stringify(check) },
                      },
                    ],
                  },
                },
              ],
            },
            { id: 'chatcmpl-check', choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
          ]
        : [
            { id: 'chatcmpl-done', choices: [{ delta: { role: 'assistant', content: 'Shipped.' } }] },
            { id: 'chatcmpl-done', choices: [{ delta: {}, finish_reason: 'stop' }] },
          ];
    });
    writeSettings(tempHome, {
      verifier: { model: verifierModel },
      // completionVerification is left at its default: the gate must run.
      agent: {
        retryAttempts: 0,
        modelSelection: { model: 'mock-alpha', provider: 'mockprov' },
      },
      providers: [{ name: 'mockprov', type: 'openai-compatible', baseUrl: mock.baseUrl, apiKey: 'test-key' }],
    });
    try {
      const { status, stdout, stderr } = await spawnCli(
        [
          cliPath(),
          '--goal',
          'Ship math.ts',
          '--goal-criteria',
          'math.ts exports add(a, b) returning a + b',
          'worker-prompt-sentinel',
        ],
        createTestChildEnv({ HOME: tempHome, TERM2_CONVERSATIONS_DIR: testDir, DISABLE_LOGGING: '1' }),
        repo,
      );
      expect(status, stderr).toBe(0);
      expect(stdout).toContain('Shipped.');
      expect(stderr).toContain('Goal (achieved): Ship math.ts');
      expect(stderr).toContain("Completion accepted after the model's goal_check.");

      const requests = mock.capturedRequests();
      // Two worker rounds, then the fresh verifier's probe round and verdict round.
      expect(requests).toHaveLength(4);
      const verifierRequests = requests.slice(2);
      expect(mock.capturedModels()).toEqual([
        'mock-alpha',
        'mock-alpha',
        verifierModel || 'mock-alpha',
        verifierModel || 'mock-alpha',
      ]);
      for (const request of verifierRequests) {
        const tools = (request.tools as Record<string, unknown>[]) ?? [];
        expect(tools).toHaveLength(1);
        expect((tools[0]!.function as { name: string }).name).toBe('verification_probe');
      }
      // The verifier sees the goal, never the worker's prompt or its evidence.
      const verifierBody = JSON.stringify(verifierRequests);
      expect(verifierBody).toContain('Ship math.ts');
      expect(verifierBody).not.toContain('worker-prompt-sentinel');
      expect(verifierBody).not.toContain('Provider returned the reply');

      // The gate persisted its decision before the goal was closed.
      const dataPath = execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          "import envPaths from 'env-paths'; process.stdout.write(envPaths('term2').data);",
        ],
        { cwd: projectRoot, env: createTestChildEnv({ HOME: tempHome }), encoding: 'utf8' },
      );
      const dbPath = path.join(dataPath, 'completion-verification.sqlite');
      expect(fs.existsSync(dbPath)).toBe(true);
      const db = new Database(dbPath, { readonly: true });
      try {
        const row = db.prepare('SELECT record FROM completion_verification').get() as { record: string };
        const record = JSON.parse(row.record);
        expect(record.state).toBe('COMPLETED');
        expect(record.decision.action).toBe('independent_verify');
        expect(record.report.outcome).toBe('PASS');
      } finally {
        db.close();
      }
    } finally {
      await mock.close();
      fs.rmSync(tempHome, { recursive: true, force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
  },
);

it('resume preserves the replayed goal without flags and replaces it before startup when flags are explicit', async () => {
  for (const explicit of [false, true]) {
    const id = explicit ? 'resume-goal-explicit' : 'resume-goal-implicit';
    const originalGoal = { id: `old-${id}`, outcome: 'Original', status: 'active' };
    fs.writeFileSync(
      path.join(testDir, `${id}.jsonl`),
      [
        {
          v: 3,
          seq: 1,
          ts: '2026-01-01T00:00:00.000Z',
          event: { type: 'session_init', id, createdAt: '2026-01-01T00:00:00.000Z', projectPath: process.cwd() },
        },
        {
          v: 3,
          seq: 2,
          ts: '2026-01-01T00:00:01.000Z',
          event: { type: 'goal_changed', version: 1, goal: originalGoal },
        },
      ]
        .map((event) => JSON.stringify(event))
        .join('\n') + '\n',
      'utf8',
    );
    const args = [cliPath(), '--resume', id, '--lite', ...(explicit ? ['--goal', 'Replacement'] : [])];
    const { status, stderr } = await spawnCli(
      args,
      createTestChildEnv({ HOME: testDir, TERM2_CONVERSATIONS_DIR: testDir, DISABLE_LOGGING: '1' }),
    );
    expect(status).toBe(1);
    expect(stderr).toContain('term2 needs an interactive terminal');
    const events = fs
      .readFileSync(path.join(testDir, `${id}.jsonl`), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).event);
    const goals = events.filter((event) => event.type === 'goal_changed');
    expect(goals).toHaveLength(explicit ? 2 : 1);
    expect(goals.at(-1).goal.outcome).toBe(explicit ? 'Replacement' : 'Original');
  }
});

it('CLI supports the advertised -h and -v aliases', () => {
  const env = createTestChildEnv({ HOME: testDir, DISABLE_LOGGING: '1' });
  expect(execFileSync('node', [cliPath(), '-h'], { env, encoding: 'utf8' })).toContain('Usage');
  expect(execFileSync('node', [cliPath(), '-v'], { env, encoding: 'utf8' })).toMatch(/\d+\.\d+/);
});

it('CLI rejects unknown flags with a clear error', () => {
  let error: any;
  try {
    execFileSync('node', [cliPath(), '--not-a-term2-option'], {
      env: createTestChildEnv({ HOME: testDir, DISABLE_LOGGING: '1' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (caught: any) {
    error = caught;
  }
  expect(error?.status).toBe(2);
  expect(error?.stderr.toString()).toContain('Unknown flag');
});

it('CLI explains that an interactive terminal is required instead of exposing Ink raw-mode errors', async () => {
  const tempHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-home-')));
  try {
    const { status, stderr } = await spawnCli(
      [cliPath(), '--lite'],
      createTestChildEnv({ HOME: tempHome, TERM2_CONVERSATIONS_DIR: testDir, DISABLE_LOGGING: '1' }),
    );
    expect(status).toBe(1);
    expect(stderr).toContain('term2 needs an interactive terminal');
    expect(stderr).toContain('term2 "<prompt>"');
    expect(stderr).not.toContain('raw mode');
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

it('CLI --resume ls prints list of conversations and exits', () => {
  // Create a mock conversation file in the testDir
  const convId = 'f81d4fae-7dec-11d0-a765-00a0c91e6bf6';
  const filePath = path.join(testDir, `${convId}.jsonl`);
  const initEnvelope = {
    v: 1,
    seq: 1,
    ts: '2026-05-28T14:40:16.000Z',
    event: {
      type: 'session_init',
      id: convId,
      createdAt: '2026-05-28T14:40:16.000Z',
      projectPath: process.cwd(),
      model: 'gpt-4o',
      appMode: {
        mentorMode: false,
        liteMode: true,
        planMode: false,
        orchestratorMode: false,
      },
    },
  };
  const userEnvelope = {
    v: 1,
    seq: 2,
    ts: '2026-05-28T14:40:20.000Z',
    event: {
      type: 'user_message',
      message: {
        id: 'user-msg-1',
        sender: 'user',
        text: 'hello this is a test prompt',
      },
    },
  };
  fs.writeFileSync(filePath, JSON.stringify(initEnvelope) + '\n' + JSON.stringify(userEnvelope) + '\n', 'utf-8');

  // Create a second mock conversation from a different project path
  const otherConvId = 'b22d4fae-7dec-11d0-a765-00a0c91e6bf6';
  const otherFilePath = path.join(testDir, `${otherConvId}.jsonl`);
  const otherInitEnvelope = {
    v: 1,
    seq: 1,
    ts: '2026-05-28T14:40:16.000Z',
    event: {
      type: 'session_init',
      id: otherConvId,
      createdAt: '2026-05-28T14:40:16.000Z',
      projectPath: '/Users/qduc/src/other-project',
    },
  };
  fs.writeFileSync(otherFilePath, JSON.stringify(otherInitEnvelope) + '\n', 'utf-8');

  // Also touch the files so listConversations gets mtime
  const now = new Date();
  fs.utimesSync(filePath, now, now);
  fs.utimesSync(otherFilePath, now, now);

  const stdout = execFileSync('node', [cliPath(), '--resume', 'ls'], {
    env: createTestChildEnv({
      HOME: testDir,
      TERM2_CONVERSATIONS_DIR: testDir,
      DISABLE_LOGGING: '1',
    }),
  }).toString();

  expect(stdout.includes('Recent Conversations (last 10):')).toBe(true);
  expect(stdout.includes(convId)).toBe(true);
  expect(stdout.includes(otherConvId)).toBe(false);
  expect(stdout.includes(process.cwd())).toBe(false);
  expect(stdout.includes('hello this is a test prompt')).toBe(true);
  expect(stdout.includes('1 message')).toBe(true);
  expect(stdout.includes('model: gpt-4o')).toBe(true);
  // A session saved as legacy Lite resumes as Bare, so the list labels it bare.
  expect(stdout.includes('mode: bare')).toBe(true);
  expect(stdout.includes(`term2 --resume ${convId}`)).toBe(true);
});

it('CLI --resume list also works', () => {
  // Create a mock conversation file in the testDir
  const convId = 'a12d4fae-7dec-11d0-a765-00a0c91e6bf6';
  const filePath = path.join(testDir, `${convId}.jsonl`);
  const initEnvelope = {
    v: 1,
    seq: 1,
    ts: '2026-05-28T14:40:16.000Z',
    event: {
      type: 'session_init',
      id: convId,
      createdAt: '2026-05-28T14:40:16.000Z',
      projectPath: process.cwd(),
    },
  };
  fs.writeFileSync(filePath, JSON.stringify(initEnvelope) + '\n', 'utf-8');

  const now = new Date();
  fs.utimesSync(filePath, now, now);

  const stdout = execFileSync('node', [cliPath(), '--resume', 'list'], {
    env: createTestChildEnv({
      HOME: testDir,
      TERM2_CONVERSATIONS_DIR: testDir,
      DISABLE_LOGGING: '1',
    }),
  }).toString();

  expect(stdout.includes('Recent Conversations (last 10):')).toBe(true);
  expect(stdout.includes(convId)).toBe(true);
});

it('CLI --resume prints message and exits when no conversation is found', () => {
  const tempHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-home-')));
  let error: any;
  let stderr = '';
  try {
    execFileSync('node', [cliPath(), '--resume', 'dummy'], {
      env: createTestChildEnv({
        HOME: tempHome,
        TERM2_CONVERSATIONS_DIR: testDir,
        DISABLE_LOGGING: '1',
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err: any) {
    error = err;
    stderr = err.stderr.toString();
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }

  expect(error).toBeTruthy();
  expect(error.status).toBe(1);
  expect(stderr.includes('No conversation found to resume (dummy).')).toBe(true);
  expect(stderr.includes('Run "term2 --resume ls" to list available conversations.')).toBe(true);
});

it('CLI --resume does not suggest --fork for a conversation from another project', async () => {
  const conversationId = 'c22d4fae-7dec-11d0-a765-00a0c91e6bf6';
  fs.writeFileSync(
    path.join(testDir, `${conversationId}.jsonl`),
    `${JSON.stringify({
      v: 1,
      seq: 1,
      ts: '2026-05-28T14:40:16.000Z',
      event: {
        type: 'session_init',
        id: conversationId,
        createdAt: '2026-05-28T14:40:16.000Z',
        projectPath: '/another/project',
      },
    })}\n`,
    'utf8',
  );

  const { status, stderr } = await spawnCli(
    [cliPath(), '--resume', conversationId],
    createTestChildEnv({
      HOME: testDir,
      TERM2_CONVERSATIONS_DIR: testDir,
      DISABLE_LOGGING: '1',
    }),
  );

  expect(status).toBe(1);
  expect(stderr).toContain('belongs to a different project path');
  expect(stderr).toContain(`term2 --resume ${conversationId}`);
  expect(stderr).not.toContain('--fork');
});

it('CLI --list-models combined with --resume errors instead of misreading the resume id as a search term', () => {
  const tempHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-home-')));
  let error: any;
  let stderr = '';
  try {
    execFileSync('node', [cliPath(), '--list-models', '--resume', 'abc123'], {
      env: createTestChildEnv({
        HOME: tempHome,
        TERM2_CONVERSATIONS_DIR: testDir,
        DISABLE_LOGGING: '1',
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err: any) {
    error = err;
    stderr = err.stderr.toString();
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }

  expect(error).toBeTruthy();
  expect(error.status).toBe(1);
  expect(stderr).toContain('--list-models');
  expect(stderr).toContain('--resume');
  expect(stderr).not.toContain('No models match');
});

it('CLI --list-models combined with --resume --fork errors', () => {
  const tempHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-home-')));
  let error: any;
  let stderr = '';
  try {
    execFileSync('node', [cliPath(), '--list-models', '--resume', 'abc123', '--fork'], {
      env: createTestChildEnv({
        HOME: tempHome,
        TERM2_CONVERSATIONS_DIR: testDir,
        DISABLE_LOGGING: '1',
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err: any) {
    error = err;
    stderr = err.stderr.toString();
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }

  expect(error).toBeTruthy();
  expect(error.status).toBe(1);
  expect(stderr).toContain('--list-models');
});

it('CLI --list-models without conflicting flags runs the listing errand, not a flag-conflict error', () => {
  const tempHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-home-')));
  let stdout = '';
  let stderr = '';
  let status: number | null = 0;
  try {
    try {
      stdout = execFileSync('node', [cliPath(), '--list-models'], {
        env: createTestChildEnv({
          HOME: tempHome,
          TERM2_CONVERSATIONS_DIR: testDir,
          DISABLE_LOGGING: '1',
        }),
        stdio: ['pipe', 'pipe', 'pipe'],
      }).toString();
    } catch (err: any) {
      status = err.status;
      stdout = err.stdout?.toString() ?? '';
      stderr = err.stderr?.toString() ?? '';
    }
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }

  // With no credentials configured, the listing errand itself reports "no
  // models available" (exit 1) rather than the flag-conflict error this
  // change introduces — proving the two failure modes stay distinct.
  expect(stderr).not.toContain('cannot be combined');
  expect(stdout + stderr).toContain('No models available.');
  expect(status).toBe(1);
});

it('CLI --refresh without --list-models errors clearly instead of being silently ignored', () => {
  const tempHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-home-')));
  let error: any;
  let stderr = '';
  try {
    execFileSync('node', [cliPath(), '--refresh', 'hello'], {
      env: createTestChildEnv({
        HOME: tempHome,
        TERM2_CONVERSATIONS_DIR: testDir,
        DISABLE_LOGGING: '1',
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err: any) {
    error = err;
    stderr = err.stderr.toString();
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }

  expect(error).toBeTruthy();
  expect(error.status).toBe(1);
  expect(stderr).toContain('--refresh');
  expect(stderr).toContain('--list-models');
});

it('CLI --list-models --refresh runs the listing errand, not the flag-conflict error', () => {
  const tempHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-home-')));
  let stdout = '';
  let stderr = '';
  let status: number | null = 0;
  try {
    try {
      stdout = execFileSync('node', [cliPath(), '--list-models', '--refresh'], {
        env: createTestChildEnv({
          HOME: tempHome,
          TERM2_CONVERSATIONS_DIR: testDir,
          DISABLE_LOGGING: '1',
        }),
        stdio: ['pipe', 'pipe', 'pipe'],
      }).toString();
    } catch (err: any) {
      status = err.status;
      stdout = err.stdout?.toString() ?? '';
      stderr = err.stderr?.toString() ?? '';
    }
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }

  // With no credentials configured, this hits the same "no models available"
  // outcome as plain --list-models, proving --refresh alongside --list-models
  // does not trip the "--refresh can only be used with --list-models" check.
  expect(stderr).not.toContain('can only be used with');
  expect(stdout + stderr).toContain('No models available.');
  expect(status).toBe(1);
});

it('CLI prompts before starting in non-lite mode from home directory', () => {
  const tempHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-home-')));

  let error: any;
  let stderr = '';
  try {
    try {
      execFileSync('node', [cliPath()], {
        env: createTestChildEnv({
          HOME: tempHome,
          TERM2_CONVERSATIONS_DIR: testDir,
          DISABLE_LOGGING: '1',
        }),
        cwd: tempHome,
        input: 'n\n',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err: any) {
      error = err;
      stderr = err.stderr.toString();
    }

    expect(error).toBeTruthy();
    expect(error.status).toBe(1);
    expect(stderr.includes('Warning: you are starting term2 in non-lite mode from your home directory.')).toBe(true);
    expect(stderr.includes('Cancelled.')).toBe(true);
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

it('CLI prompts before starting in non-lite mode from root directory', () => {
  const tempHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-home-')));

  let error: any;
  let stderr = '';
  try {
    try {
      execFileSync('node', [cliPath()], {
        env: createTestChildEnv({
          HOME: tempHome,
          TERM2_CONVERSATIONS_DIR: testDir,
          DISABLE_LOGGING: '1',
        }),
        cwd: '/',
        input: 'n\n',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err: any) {
      error = err;
      stderr = err.stderr.toString();
    }

    expect(error).toBeTruthy();
    expect(error.status).toBe(1);
    expect(stderr.includes('Warning: you are starting term2 in non-lite mode from your home directory.')).toBe(true);
    expect(stderr.includes('Cancelled.')).toBe(true);
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

it('CLI accepts a custom provider from settings.json in non-interactive mode', () => {
  const tempHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-home-')));
  const settingsDir = resolveSettingsDirectory({ homeDir: tempHome });
  fs.mkdirSync(settingsDir, { recursive: true });
  const providerName = 'my-custom-provider';

  const settingsFile = path.join(settingsDir, 'settings.json');
  fs.writeFileSync(
    settingsFile,
    JSON.stringify(
      {
        agent: {
          retryAttempts: 0,
        },
        providers: [
          {
            name: providerName,
            type: 'openai-compatible',
            baseUrl: 'http://127.0.0.1:65535/v1',
            apiKey: 'test-key',
          },
        ],
      },
      null,
      2,
    ),
    'utf-8',
  );

  let error: any;
  let stderr = '';

  try {
    execFileSync('node', [cliPath(), '--provider', providerName, 'hello'], {
      env: createTestChildEnv({
        HOME: tempHome,
        TERM2_CONVERSATIONS_DIR: testDir,
        DISABLE_LOGGING: '1',
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err: any) {
    error = err;
    stderr = err.stderr?.toString?.() ?? '';
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }

  // The command may still fail due to missing upstream provider endpoint, but
  // it should not fail the early provider validation path.
  expect(stderr.includes(`Error: Unknown provider "${providerName}".`)).toBe(false);
  expect(error).toBeTruthy();
});

it('CLI --model reports error and exits 1 when no models match pattern', async () => {
  // The no-match error requires at least one catalog to load, so serve one
  // from a loopback double. A prior version relied on an ambient network
  // catalog (codex's credential-free models endpoint); when that endpoint
  // began rejecting anonymous reads the resolution failed open to passthrough
  // and the CLI attempted a real provider connection instead.
  const tempHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-home-')));
  const mock = await startModelMock(['mock-alpha', 'mock-beta']);
  writeSettings(tempHome, {
    agent: { retryAttempts: 0, modelSelection: { model: 'gpt-5.1', provider: 'mockprov' } },
    providers: [{ name: 'mockprov', type: 'openai-compatible', baseUrl: mock.baseUrl, apiKey: 'test-key' }],
  });

  try {
    const childEnv = createTestChildEnv({
      HOME: tempHome,
      TERM2_CONVERSATIONS_DIR: testDir,
      DISABLE_LOGGING: '1',
    });
    const { status, stderr } = await spawnCli([cliPath(), '--model', 'nonexistent-xyz-pattern', 'hello'], childEnv);

    expect(status).toBe(1);
    expect(stderr).toContain('Error: No models match "nonexistent-xyz-pattern".');
  } finally {
    await mock.close();
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

it('CLI --model keeps settings.json session-only when resolution passes through an unreachable catalog', async () => {
  // Regression: the resolution block used settings.set() without
  // { persist: false }, so a one-off --model run rewrote the user's persisted
  // agent.modelSelection. Passthrough (all catalogs fail to load) also
  // reaches those set() calls, so an unreachable provider is enough to
  // exercise the persistence boundary.
  const tempHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-home-')));
  const settingsFile = writeSettings(tempHome, {
    agent: { retryAttempts: 0, modelSelection: { model: 'keep-session-model', provider: 'openai' } },
    providers: [
      { name: 'mockprov', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:65535/v1', apiKey: 'test-key' },
    ],
  });

  try {
    const childEnv = createTestChildEnv({
      HOME: tempHome,
      TERM2_CONVERSATIONS_DIR: testDir,
      DISABLE_LOGGING: '1',
    });
    const { status, stderr } = await spawnCli(
      [cliPath(), '--provider', 'mockprov', '--model', 'some-brand-new-model', 'hello'],
      childEnv,
    );

    // The chat turn itself fails against the unreachable provider, but the
    // settings file must be byte-identical to what we wrote.
    expect(status).not.toBe(0);
    expect(stderr.toLowerCase()).toContain('econnrefused');
    const persisted = fs.readFileSync(settingsFile, 'utf-8');
    expect(persisted).toContain('keep-session-model');
    expect(persisted).not.toContain('some-brand-new-model');
  } finally {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

it('CLI --json auto-selects an ambiguous model without asking for input', async () => {
  // Regression: the prompt defaulted to process.stdout, corrupting the NDJSON
  // event channel whenever an ambiguous pattern needed disambiguation.
  const tempHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-home-')));
  const mock = await startModelMock(['mock-alpha', 'mock-beta']);
  writeSettings(tempHome, {
    agent: { retryAttempts: 0, modelSelection: { model: 'gpt-5.1', provider: 'mockprov' } },
    providers: [{ name: 'mockprov', type: 'openai-compatible', baseUrl: mock.baseUrl, apiKey: 'test-key' }],
  });

  try {
    const childEnv = createTestChildEnv({
      HOME: tempHome,
      TERM2_CONVERSATIONS_DIR: testDir,
      DISABLE_LOGGING: '1',
    });
    const { status, stdout, stderr } = await spawnCli([cliPath(), '--json', '--model', 'mock', 'hello'], childEnv);

    expect(status, stderr).toBe(0);
    expect(stderr).toContain('Unattended model selection: assuming mockprov/mock-alpha');
    expect(stderr).not.toContain('Select a model');
    expect(mock.capturedModels()).toEqual(['mock-alpha']);
    expect(stdout).not.toContain('Multiple models match');
    expect(stdout).not.toContain('Select a model');
    for (const line of stdout.split('\n')) {
      if (line.trim().length > 0) expect(() => JSON.parse(line)).not.toThrow();
    }
  } finally {
    await mock.close();
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

it('CLI --model vendor/id resolves the literal id on the serving provider, warns about failed catalogs, and persists nothing', async () => {
  // Regression: a vendor prefix that collides with a built-in provider id
  // (openai/...) used to narrow the catalog load to that provider, so a
  // literal aggregator id was reported as no_match or silently switched and
  // persisted the wrong provider/model.
  const tempHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-home-')));
  const mock = await startModelMock(['openai/gpt-test', 'mock-alpha']);
  const settingsFile = writeSettings(tempHome, {
    agent: { retryAttempts: 0, modelSelection: { model: 'original-default', provider: 'mockprov' } },
    providers: [
      { name: 'mockprov', type: 'openai-compatible', baseUrl: mock.baseUrl, apiKey: 'test-key' },
      { name: 'brokenprov', type: 'openai-compatible', baseUrl: 'http://127.0.0.1:65535/v1', apiKey: 'test-key' },
    ],
  });

  try {
    const childEnv = createTestChildEnv({
      HOME: tempHome,
      TERM2_CONVERSATIONS_DIR: testDir,
      DISABLE_LOGGING: '1',
    });
    const { status, stdout, stderr } = await spawnCli(
      [cliPath(), '--json', '--model', 'openai/gpt-test', 'hello'],
      childEnv,
    );

    // The turn completes against the mock.
    expect(status).toBe(0);

    // The literal as-typed id reached the wire on the provider that serves it.
    expect(mock.capturedModels().length).toBeGreaterThan(0);
    expect(mock.capturedModels()[0]).toBe('openai/gpt-test');

    // The unreachable catalog is surfaced, not silently dropped.
    expect(stderr).toContain('warning: brokenprov:');

    // Session-only override: persisted defaults untouched.
    const persisted = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
    expect(persisted.agent.modelSelection.model).toBe('original-default');
    expect(persisted.agent.modelSelection.provider).toBe('mockprov');

    // stdout stays machine-readable.
    expect(stdout).not.toContain('Multiple models match');
    for (const line of stdout.split('\n')) {
      if (line.trim().length > 0) expect(() => JSON.parse(line)).not.toThrow();
    }
  } finally {
    await mock.close();
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

it('CLI resolves --model <value> as the last argument to the model, not a prompt', async () => {
  // A value right after -m/--model is ALWAYS the model, exactly as before
  // this feature — there is no positional-prompt ambiguity to resolve here.
  // With no prompt on the line, the run proceeds to the interactive app,
  // which (on this non-TTY spawn) renders its startup banner and then fails
  // on Ink's raw-mode guard — that failure is expected and is not what this
  // test is about. The banner renders the resolved agent.model/agent.provider
  // before that crash, so its content is direct proof of what resolution
  // picked, independent of the crash.
  const tempHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-home-')));
  const mock = await startModelMock(['mock-alpha', 'mock-beta']);
  writeSettings(tempHome, {
    agent: { retryAttempts: 0, modelSelection: { model: 'mock-alpha', provider: 'mockprov' } },
    providers: [{ name: 'mockprov', type: 'openai-compatible', baseUrl: mock.baseUrl, apiKey: 'test-key' }],
  });

  try {
    const childEnv = createTestChildEnv({
      HOME: tempHome,
      TERM2_CONVERSATIONS_DIR: testDir,
      DISABLE_LOGGING: '1',
    });
    const { stdout, stderr } = await spawnCli([cliPath(), '--model', 'mock-beta'], childEnv);

    expect(stderr).not.toContain('No models match');
    expect(stderr).not.toContain('Multiple models match');
    expect(stderr).toContain('term2 needs an interactive terminal');
    expect(stderr).not.toContain('raw mode');
  } finally {
    await mock.close();
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

it('CLI resolves -p <provider> -m <model> with nothing else to the model, not a prompt', async () => {
  const tempHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-home-')));
  const mock = await startModelMock(['mock-alpha', 'mock-beta']);
  writeSettings(tempHome, {
    agent: { retryAttempts: 0, modelSelection: { model: 'mock-alpha', provider: 'mockprov' } },
    providers: [{ name: 'mockprov', type: 'openai-compatible', baseUrl: mock.baseUrl, apiKey: 'test-key' }],
  });

  try {
    const childEnv = createTestChildEnv({
      HOME: tempHome,
      TERM2_CONVERSATIONS_DIR: testDir,
      DISABLE_LOGGING: '1',
    });
    const { stdout, stderr } = await spawnCli([cliPath(), '--provider', 'mockprov', '--model', 'mock-beta'], childEnv);

    expect(stderr).not.toContain('No models match');
    expect(stderr).not.toContain('Multiple models match');
    expect(stderr).not.toContain('Unknown provider');
    expect(stderr).toContain('term2 needs an interactive terminal');
    expect(stderr).not.toContain('raw mode');
  } finally {
    await mock.close();
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

it('CLI still treats --model <value> <prompt> (two or more trailing tokens) as unambiguous', async () => {
  const tempHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-home-')));
  const mock = await startModelMock(['mock-alpha', 'mock-beta']);
  writeSettings(tempHome, {
    agent: { retryAttempts: 0, modelSelection: { model: 'mock-alpha', provider: 'mockprov' } },
    providers: [{ name: 'mockprov', type: 'openai-compatible', baseUrl: mock.baseUrl, apiKey: 'test-key' }],
  });

  try {
    const childEnv = createTestChildEnv({
      HOME: tempHome,
      TERM2_CONVERSATIONS_DIR: testDir,
      DISABLE_LOGGING: '1',
    });
    const { status } = await spawnCli([cliPath(), '--model', 'mock-beta', 'hello'], childEnv);

    expect(status).toBe(0);
    expect(mock.capturedModels()).toEqual(['mock-beta']);
  } finally {
    await mock.close();
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

it('CLI "term2 <prompt>" with no --model is unchanged', async () => {
  const tempHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-home-')));
  const mock = await startModelMock(['mock-alpha']);
  writeSettings(tempHome, {
    agent: { retryAttempts: 0, modelSelection: { model: 'mock-alpha', provider: 'mockprov' } },
    providers: [{ name: 'mockprov', type: 'openai-compatible', baseUrl: mock.baseUrl, apiKey: 'test-key' }],
  });

  try {
    const childEnv = createTestChildEnv({
      HOME: tempHome,
      TERM2_CONVERSATIONS_DIR: testDir,
      DISABLE_LOGGING: '1',
    });
    const { status } = await spawnCli([cliPath(), 'explain this function'], childEnv);

    expect(status).toBe(0);
    expect(mock.capturedModels()).toEqual(['mock-alpha']);
  } finally {
    await mock.close();
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

it('CLI bare --model (no value) is a no-op outside a TTY session, not a picker attempt', async () => {
  // This spawn has no TTY, so the picker is never eligible
  // (isModelPickerEligible/model-picker-host.test.tsx cover the eligible
  // path directly). Here, --model with no value must fall through exactly
  // like it did before the picker existed: nothing is resolved, the
  // already-configured default model is used, and the run proceeds to the
  // ordinary interactive-app boot (which then hits the same expected
  // non-TTY raw-mode failure every other no-prompt case in this file hits).
  const tempHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-home-')));
  const mock = await startModelMock(['mock-alpha']);
  writeSettings(tempHome, {
    agent: { retryAttempts: 0, modelSelection: { model: 'mock-alpha', provider: 'mockprov' } },
    providers: [{ name: 'mockprov', type: 'openai-compatible', baseUrl: mock.baseUrl, apiKey: 'test-key' }],
  });

  try {
    const childEnv = createTestChildEnv({
      HOME: tempHome,
      TERM2_CONVERSATIONS_DIR: testDir,
      DISABLE_LOGGING: '1',
    });
    const { stdout, stderr } = await spawnCli([cliPath(), '--model'], childEnv);

    expect(stderr).not.toContain('No models match');
    expect(stderr).not.toContain('Multiple models match');
    expect(stderr).toContain('term2 needs an interactive terminal');
    expect(stderr).not.toContain('raw mode');
  } finally {
    await mock.close();
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

// Approval reuse guard (approval-call-binding, shipped in 0.32.0). A tool approval answers exactly
// one call. A later call that reuses the same id, whether the provider repeats an id or the
// chat-completions adapter has to invent ids because the provider sent none, must be decided again.
// The built CLI runs a non-interactive `--auto-approve` turn against the chat-completions mock. Its
// auto-approval policy says yes to an unsandboxed GREEN shell call and no to a RED one, so an
// approval that leaks to the later call is a real side effect: the RED `rm` deletes a file it was
// never allowed to touch.
type ToolCallId = { kind: 'provider'; id: string } | { kind: 'omitted' } | { kind: 'empty' };

function shellCallFrames(response: string, callId: ToolCallId, args: Record<string, unknown>): unknown[] {
  const idField = callId.kind === 'provider' ? { id: callId.id } : callId.kind === 'empty' ? { id: '' } : {};
  const call = { index: 0, ...idField, type: 'function', function: { name: 'shell', arguments: JSON.stringify(args) } };
  return [
    { id: response, choices: [{ delta: { tool_calls: [call] } }] },
    { id: response, choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ];
}

type SavedEvent = {
  type: string;
  arguments?: { command?: unknown };
  message?: { command?: unknown; isApprovalRejection?: boolean; success?: boolean };
};
type ScriptedShellCall = { callId: ToolCallId; args: (workspace: string) => Record<string, unknown> };

/**
 * Runs the built CLI non-interactively with `--auto-approve` against the chat-completions mock. The
 * n-th scripted call is the model's whole n-th response; after the last one the model says "done".
 * Everything the run can touch lives under one mkdtemp root that is removed afterwards.
 */
async function runShellCallsScenario(calls: ScriptedShellCall[], seed: Record<string, string> = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-approval-reuse-')));
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(home);
  fs.mkdirSync(workspace);
  for (const [name, content] of Object.entries(seed)) fs.writeFileSync(path.join(workspace, name), content);
  const commands = calls.map((call) => String(call.args(workspace).command));

  const mock = await startModelMock(['mock-alpha'], (n) =>
    n <= calls.length
      ? shellCallFrames(`chatcmpl-${n}`, calls[n - 1]!.callId, calls[n - 1]!.args(workspace))
      : [
          { id: 'chatcmpl-done', choices: [{ delta: { role: 'assistant', content: 'done' } }] },
          { id: 'chatcmpl-done', choices: [{ delta: {}, finish_reason: 'stop' }] },
        ],
  );
  const env = createTestChildEnv({
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
  });
  const settingsDir = resolveSettingsDirectory({ homeDir: home, env });
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(
    path.join(settingsDir, 'settings.json'),
    JSON.stringify({
      agent: { retryAttempts: 0, modelSelection: { model: 'mock-alpha', provider: 'mockprov' } },
      providers: [{ name: 'mockprov', type: 'openai-compatible', baseUrl: mock.baseUrl, apiKey: 'test-key' }],
      // Without the sandbox, approval depends only on the command, so the run is host-independent.
      sandbox: { enabled: false },
    }),
  );
  try {
    const { status, stdout, stderr } = await spawnCli(
      [cliPath(), '--auto-approve', 'tidy the workspace'],
      env,
      workspace,
    );
    // The session log the CLI saved for this conversation (what resume replays), read back from disk.
    const conversationsDir = path.join(root, 'conversations');
    const savedEvents = fs
      .readdirSync(conversationsDir)
      .filter((name) => name.endsWith('.jsonl'))
      .flatMap((name) => fs.readFileSync(path.join(conversationsDir, name), 'utf8').split('\n'))
      .filter((line) => line.trim())
      .map((line) => (JSON.parse(line) as { event: SavedEvent }).event);
    const files = Object.fromEntries(
      fs
        .readdirSync(workspace)
        .sort()
        .map((name) => [name, fs.readFileSync(path.join(workspace, name), 'utf8')]),
    );
    return {
      status,
      stdout,
      stderr,
      requests: mock.capturedRequests(),
      commands,
      // Read before the root is removed. Also proves the run wrote no project config here.
      files,
      /** Commands of the saved tool_started events, in order. */
      savedToolStarts: savedEvents.flatMap((event) =>
        event.type === 'tool_started' ? [String(event.arguments?.command)] : [],
      ),
      /** Commands of the saved command_message events (each execution's output record), in order. */
      savedCommandOutputs: savedEvents.flatMap((event) =>
        event.type === 'command_message' ? [String(event.message?.command)] : [],
      ),
      /** The saved command_message records: what ran, and whether it is recorded as refused. */
      savedCommandRecords: savedEvents.flatMap((event) =>
        event.type === 'command_message'
          ? [
              {
                command: String(event.message?.command),
                isApprovalRejection: event.message?.isApprovalRejection === true,
                success: event.message?.success,
              },
            ]
          : [],
      ),
      /** The `[tool] shell: <command>` lines the user saw, in order. */
      toolLines: stderr.split('\n').filter((line) => line.startsWith('[tool] shell')),
    };
  } finally {
    await mock.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function runApprovalReuseScenario(callId: ToolCallId) {
  const run = await runShellCallsScenario(
    [
      // Needs approval only because it asks to run unsandboxed; the command is GREEN, so the
      // policy answers yes and it runs.
      { callId, args: (w) => ({ command: `echo approved > ${path.join(w, 'approved.txt')}`, sandbox: 'unsandboxed' }) },
      // The next response: same tool, same id (or again none). RED, so the policy answers no.
      { callId, args: (w) => ({ command: `rm ${path.join(w, 'victim.txt')}` }) },
    ],
    { 'victim.txt': 'must survive\n' },
  );
  const [approvedCommand, refusedCommand] = run.commands as [string, string];
  return {
    ...run,
    approvedMarker: run.files['approved.txt'] ?? null,
    victim: run.files['victim.txt'] ?? null,
    approvedCommand,
    refusedCommand,
    workspaceEntries: Object.keys(run.files),
  };
}

type WireToolCall = { id: string; function: { name: string; arguments: string } };
type WireMessage = { role: string; tool_calls?: WireToolCall[]; tool_call_id?: string; content?: unknown };

/** The tool calls and tool results the CLI sent back to the provider in its last request. */
/** Bare has no file editors: it writes files through the shell. */
function bareShellWriteArguments(target: string, content: string): string {
  return JSON.stringify({
    command: `printf '%s\\n' ${JSON.stringify(content)} > ${JSON.stringify(target)}`,
    description: 'Write the fixture file',
  });
}

function lastWireToolExchange(requests: Record<string, unknown>[]) {
  const messages = requests.at(-1)?.messages as WireMessage[];
  const calls = messages.flatMap((message) => (message.role === 'assistant' ? message.tool_calls ?? [] : []));
  const results = messages
    .filter((message) => message.role === 'tool')
    .map((message) => ({ id: message.tool_call_id, content: JSON.stringify(message.content) }));
  return { calls, results };
}

function expectSecondCallRefused(run: Awaited<ReturnType<typeof runApprovalReuseScenario>>) {
  const report = `exit ${run.status}\nstderr:\n${run.stderr}`;
  expect(run.status, report).toBe(0);
  // The approved call ran...
  expect(run.approvedMarker, report).toBe('approved\n');
  // ...and the later call was decided on its own: refused, so the file it targets is intact.
  expect(run.victim, report).toBe('must survive\n');
  // Each call reached the approval policy on its own: two prompts, the second answered no.
  expect(run.stderr.match(/\[approval required\] shell/g), report).toHaveLength(2);
  expect(run.stderr, report).toContain('command is RED (dangerous) and cannot be executed automatically');
  expect(run.workspaceEntries).toEqual(['approved.txt', 'victim.txt']);
  // The user saw each call once, the refused one included: one `[tool]` line per call, never more.
  expect(run.toolLines, report).toEqual([expectedToolLine(run.approvedCommand), expectedToolLine(run.refusedCommand)]);
  // The saved session log records both calls and both outcomes, once each.
  expect(run.savedToolStarts).toEqual([run.approvedCommand, run.refusedCommand]);
  expect(run.savedCommandOutputs).toEqual([run.approvedCommand, run.refusedCommand]);
  // Three provider turns: first call, second call, final text. The provider received both calls
  // back with results that match them.
  expect(run.requests).toHaveLength(3);
  const { calls, results } = lastWireToolExchange(run.requests);
  expect(calls.map((call) => JSON.parse(call.function.arguments).command)).toEqual([
    run.approvedCommand,
    run.refusedCommand,
  ]);
  expect(results.map((result) => result.id)).toEqual(calls.map((call) => call.id));
  expect(results[1]?.content).toContain('cannot be executed automatically');
  return { calls, results };
}

it.each([
  ['the provider repeats call_0', 'call_0'],
  ['the provider repeats its own id', 'toolu_repeated'],
])(
  'an approved shell call does not approve a later call that reuses its id when %s',
  { timeout: 90_000 },
  async (_case, id) => {
    const run = await runApprovalReuseScenario({ kind: 'provider', id });
    const { calls } = expectSecondCallRefused(run);
    expect(calls.map((call) => call.id)).toEqual([id, id]);
  },
);

it.each([
  ['omits tool call ids', { kind: 'omitted' } as const],
  ['sends empty tool call ids', { kind: 'empty' } as const],
])(
  'an approved shell call does not approve a later call when the chat-completions provider %s',
  { timeout: 90_000 },
  async (_case, callId) => {
    const run = await runApprovalReuseScenario(callId);
    const { calls } = expectSecondCallRefused(run);
    // The adapter invents ids that are unique per response, never a positional `call_0` again.
    const [first, second] = calls.map((call) => call.id);
    expect(first).toMatch(/^call_[0-9a-f]{16}_0$/);
    expect(second).toMatch(/^call_[0-9a-f]{16}_0$/);
    expect(second).not.toBe(first);
  },
);

// Every executed tool call must be visible. A provider that repeats an id (some servers number calls
// per response, so every first call is `call_0`) must not make the later execution invisible on
// stderr. The session dedupes tool_started per id because one execution emits it twice: once when the
// model's call streams in and again from the approval or continuation plan before the tool runs.
// That duplicate must stay suppressed: one execution, one `[tool]` line.
it('every executed shell call is shown on stderr when the provider repeats its id', { timeout: 90_000 }, async () => {
  const id: ToolCallId = { kind: 'provider', id: 'call_0' };
  const run = await runShellCallsScenario([
    // Sandbox off and GREEN: both run without an approval prompt.
    { callId: id, args: (w) => ({ command: `echo one > ${path.join(w, 'one.txt')}` }) },
    { callId: id, args: (w) => ({ command: `echo two > ${path.join(w, 'two.txt')}` }) },
  ]);
  const report = `exit ${run.status}\nstderr:\n${run.stderr}`;
  expect(run.status, report).toBe(0);
  // Both calls really ran...
  expect(run.files, report).toEqual({ 'one.txt': 'one\n', 'two.txt': 'two\n' });
  expect(run.stderr, report).not.toContain('[approval required]');
  // ...so the user must see both, once each.
  expect(run.toolLines, report).toEqual(run.commands.map(expectedToolLine));
  // The saved session log (what resume replays) records both executions and both outputs, once each.
  expect(run.savedToolStarts).toEqual(run.commands);
  expect(run.savedCommandOutputs).toEqual(run.commands);
  const { calls } = lastWireToolExchange(run.requests);
  expect(calls.map((call) => call.id)).toEqual(['call_0', 'call_0']);
});

it('one approved shell execution prints exactly one [tool] line', { timeout: 90_000 }, async () => {
  const run = await runShellCallsScenario([
    {
      callId: { kind: 'provider', id: 'call_0' },
      // Unsandboxed, so it goes through approval: the plan re-emits tool_started for the same execution.
      args: (w) => ({ command: `echo one > ${path.join(w, 'one.txt')}`, sandbox: 'unsandboxed' }),
    },
  ]);
  const report = `exit ${run.status}\nstderr:\n${run.stderr}`;
  expect(run.status, report).toBe(0);
  expect(run.files, report).toEqual({ 'one.txt': 'one\n' });
  expect(run.stderr.match(/\[approval required\] shell/g), report).toHaveLength(1);
  expect(run.toolLines, report).toEqual([expectedToolLine(run.commands[0])]);
  expect(run.savedToolStarts).toEqual(run.commands);
  expect(run.savedCommandOutputs).toEqual(run.commands);
});

// A refused call's id can come back on a call that does run. The later execution must be shown and
// saved as what it was: it ran, so it is not an approval rejection.
it('a call that reuses a refused call id runs and is saved as run, not as refused', { timeout: 90_000 }, async () => {
  const id: ToolCallId = { kind: 'provider', id: 'call_0' };
  const run = await runShellCallsScenario(
    [
      // RED: the auto-approval policy refuses it.
      { callId: id, args: (w) => ({ command: `rm ${path.join(w, 'victim.txt')}` }) },
      // Same id, GREEN and no approval needed: it runs.
      { callId: id, args: (w) => ({ command: `echo two > ${path.join(w, 'two.txt')}` }) },
    ],
    { 'victim.txt': 'must survive\n' },
  );
  const [refusedCommand, ranCommand] = run.commands as [string, string];
  const report = `exit ${run.status}\nstderr:\n${run.stderr}`;
  expect(run.status, report).toBe(0);
  expect(run.files, report).toEqual({ 'two.txt': 'two\n', 'victim.txt': 'must survive\n' });
  expect(run.toolLines, report).toEqual([expectedToolLine(refusedCommand), expectedToolLine(ranCommand)]);
  // Only the first call was refused.
  expect(run.stderr.match(/Approval Rejected:/g), report).toHaveLength(1);
  expect(run.stderr, report).toContain(`cannot be executed automatically: ${refusedCommand}`);
  expect(run.savedCommandRecords).toEqual([
    { command: refusedCommand, isApprovalRejection: true, success: expect.anything() },
    { command: ranCommand, isApprovalRejection: false, success: true },
  ]);
});

it.each(['flag', 'config'])(
  'bare profile via %s keeps a small tool surface, project guidance, and versioned session identity',
  async (selection) => {
    // realpath: macOS tmpdir is a /var symlink, and the CLI reports the resolved cwd.
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-bare-')));
    fs.mkdirSync(path.join(testDir, '.agents'), { recursive: true });
    fs.writeFileSync(path.join(testDir, '.agents', 'AGENTS.md'), 'GLOBAL_GUIDANCE_SENTINEL: report observed checks.');
    fs.writeFileSync(
      path.join(repo, 'AGENTS.md'),
      'PROJECT_GUIDANCE_SENTINEL: preserve existing files and run relevant checks.',
    );
    fs.mkdirSync(path.join(repo, '.agents/skills/bare-probe'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, '.agents/skills/bare-probe/SKILL.md'),
      '---\nname: bare-probe\ndescription: BARE_SKILL_CATALOG_SENTINEL\n---\nProbe body.\n',
    );
    const mock = await startModelMock(['mock-alpha'], (n) =>
      n === 1
        ? [
            {
              id: 'bare-edit',
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'bare-create',
                        type: 'function',
                        function: {
                          name: 'shell',
                          arguments: bareShellWriteArguments('result.txt', 'bare edit succeeded'),
                        },
                      },
                    ],
                  },
                },
              ],
            },
            { id: 'bare-edit', choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
          ]
        : [
            {
              id: 'bare-done',
              choices: [{ delta: { role: 'assistant', content: 'Done; assumed the default filename.' } }],
            },
            { id: 'bare-done', choices: [{ delta: {}, finish_reason: 'stop' }] },
          ],
    );
    writeSettings(testDir, {
      app: { activeProfileId: selection === 'config' ? 'builtin:bare' : 'builtin:standard' },
      agent: { retryAttempts: 0, modelSelection: { model: 'mock-alpha', provider: 'mockprov' } },
      providers: [{ name: 'mockprov', type: 'openai-compatible', baseUrl: mock.baseUrl, apiKey: 'test-key' }],
    });
    try {
      const result = await spawnCli(
        [
          cliPath(),
          ...(selection === 'flag' ? ['--profile', 'bare'] : []),
          '--auto-approve',
          '--json',
          'Write a result file',
        ],
        createTestChildEnv({ HOME: testDir, TERM2_CONVERSATIONS_DIR: testDir, DISABLE_LOGGING: '1' }),
        repo,
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain('Profile: bare');
      expect(
        fs.existsSync(path.join(repo, 'result.txt')),
        JSON.stringify(lastWireToolExchange(mock.capturedRequests())),
      ).toBe(true);
      expect(fs.readFileSync(path.join(repo, 'result.txt'), 'utf8')).toBe('bare edit succeeded\n');
      const request = mock.capturedRequests()[0];
      const names = (request.tools as { function: { name: string } }[]).map((t) => t.function.name).sort();
      // Bare has no editors or activate_skill: the shell does both.
      expect(names).toEqual(['goal_check', 'run_code', 'shell']);
      const runCode = (request.tools as { function: { name: string; description: string } }[]).find(
        (t) => t.function.name === 'run_code',
      )!;
      // Script-only add-backs are listed by name; no editor is reachable.
      expect(runCode.function.description).not.toContain('create_file');
      expect(runCode.function.description).not.toContain('activate_skill');
      expect(runCode.function.description).toMatch(
        /Other tools \(call tools\.describe\(name\) before use\): .*web_search/,
      );
      expect(runCode.function.description).not.toContain('tools.web_search(');
      const system = (request.messages as { role: string; content: string }[])
        .filter((m) => m.role === 'system')
        .map((m) => m.content)
        .join('\n');
      expect(system.length).toBeLessThan(4000);
      expect(system).toContain('Unattended mode: Never ask');
      // AGENTS.md is read on demand, not injected.
      expect(system).not.toContain('PROJECT_GUIDANCE_SENTINEL');
      expect(system).not.toContain('GLOBAL_GUIDANCE_SENTINEL');
      expect(system).toContain('They are not preloaded');
      expect(system).toContain('report blocked');
      expect(system).toContain('BARE_SKILL_CATALOG_SENTINEL');
      expect(system).toContain('read the SKILL.md at its\nlocation with the shell');
      expect(system).not.toContain('activate_skill');
      expect(system).toContain(`cwd (you're already here, don't \`cd\` to it): ${repo}`);
      expect(system).toContain('Follow required independent review policies');
      expect(system).not.toContain('run_code');
      expect(mock.capturedModels()).toHaveLength(2);
      const emitted = result.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(emitted[0]).toMatchObject({
        type: 'session_start',
        activeProfileId: 'builtin:bare',
        activeProfileVersion: '2.0.0',
        activeProfileDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      const saved = fs.readdirSync(testDir).find((name) => name.endsWith('.jsonl'))!;
      const events = fs
        .readFileSync(path.join(testDir, saved), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line).event);
      expect(events[0]).toMatchObject({
        type: 'session_init',
        activeProfileId: 'builtin:bare',
        activeProfileVersion: emitted[0].activeProfileVersion,
        activeProfileDigest: emitted[0].activeProfileDigest,
      });
      expect(events.filter((e) => e.type === 'goal_changed')).toHaveLength(0);
    } finally {
      await mock.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  },
);

it.each(['full', 'bare'])(
  'headless %s completion in an unsupported workspace reports missing verification',
  async (profile) => {
    const mock = await startModelMock(['mock-alpha'], (n) =>
      n === 1
        ? [
            {
              id: 'check',
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'goal-check',
                        type: 'function',
                        function: {
                          name: 'goal_check',
                          arguments: JSON.stringify({ status: 'achieved', evidence: 'Reply delivered' }),
                        },
                      },
                    ],
                  },
                },
              ],
            },
            { id: 'check', choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
          ]
        : [
            { id: 'done', choices: [{ delta: { role: 'assistant', content: 'Done.' } }] },
            { id: 'done', choices: [{ delta: {}, finish_reason: 'stop' }] },
          ],
    );
    writeSettings(testDir, {
      agent: { retryAttempts: 0, modelSelection: { model: 'mock-alpha', provider: 'mockprov' } },
      providers: [{ name: 'mockprov', type: 'openai-compatible', baseUrl: mock.baseUrl, apiKey: 'test-key' }],
    });
    try {
      const result = await spawnCli(
        [cliPath(), '--profile', profile, '--goal', 'Deliver a reply', 'Reply'],
        createTestChildEnv({ HOME: testDir, TERM2_CONVERSATIONS_DIR: testDir, DISABLE_LOGGING: '1' }),
        testDir,
      );
      expect(result.status, result.stderr).toBe(profile === 'bare' ? 2 : 0);
      expect(result.stdout).toContain(
        profile === 'bare' ? 'Completion verification blocked' : 'independent verification not performed',
      );
      expect(result.stdout).toContain('durable goal remains active');
      expect(result.stderr).toContain(`Profile: ${profile}`);
    } finally {
      await mock.close();
    }
  },
);

it.each(['full', 'bare', 'lite', 'pair', 'plan', 'mentor', 'orchestrator'])(
  'headless %s has unattended instructions and no ask_user capability',
  async (profile) => {
    const mock = await startModelMock(['mock-alpha']);
    writeSettings(testDir, {
      agent: { retryAttempts: 0, modelSelection: { model: 'mock-alpha', provider: 'mockprov' } },
      providers: [{ name: 'mockprov', type: 'openai-compatible', baseUrl: mock.baseUrl, apiKey: 'test-key' }],
    });
    try {
      const result = await spawnCli(
        [cliPath(), '--profile', profile, 'Interpret reasonably and reply'],
        createTestChildEnv({ HOME: testDir, TERM2_CONVERSATIONS_DIR: testDir, DISABLE_LOGGING: '1' }),
        testDir,
      );
      expect(result.status, result.stderr).toBe(0);
      const request = mock.capturedRequests()[0];
      const system = (request.messages as { role: string; content: string }[])
        .filter((m) => m.role === 'system')
        .map((m) => m.content)
        .join('\n');
      expect(system).toContain('Unattended mode: Never ask the user questions');
      expect(system).toContain('state any assumptions in your final response');
      expect(JSON.stringify(request.tools)).not.toContain('"name":"ask_user"');
    } finally {
      await mock.close();
    }
  },
);

it.each<[string, boolean]>([
  ['bare retains the outside-workspace edit approval boundary without asking headlessly', false],
  ['bare permits explicit sandbox scratch writes without approval', true],
])('%s', async (_title, scratch) => {
  const workspace = path.join(testDir, 'workspace');
  fs.mkdirSync(workspace);
  const target = path.join(scratch ? cliTempDir : testDir, 'outside.txt');
  const content = 'fixture edit';
  const reply = scratch ? 'Scratch edit completed.' : 'Outside edit denied; kept existing permissions.';
  const mock = await startModelMock(['mock-alpha'], (n) =>
    n === 1
      ? [
          {
            id: 'outside-edit',
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'outside-create',
                      type: 'function',
                      function: {
                        name: 'shell',
                        arguments: bareShellWriteArguments(target, content),
                      },
                    },
                  ],
                },
              },
            ],
          },
          { id: 'outside-edit', choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ]
      : [
          {
            id: 'done',
            choices: [{ delta: { role: 'assistant', content: reply } }],
          },
          { id: 'done', choices: [{ delta: {}, finish_reason: 'stop' }] },
        ],
  );
  writeSettings(testDir, {
    agent: { retryAttempts: 0, modelSelection: { model: 'mock-alpha', provider: 'mockprov' } },
    providers: [{ name: 'mockprov', type: 'openai-compatible', baseUrl: mock.baseUrl, apiKey: 'test-key' }],
  });
  try {
    const result = await spawnCli(
      [cliPath(), '--profile', 'bare', 'Attempt the fixture edit'],
      createTestChildEnv({ HOME: testDir, TERM2_CONVERSATIONS_DIR: testDir, DISABLE_LOGGING: '1' }),
      workspace,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(target), JSON.stringify(lastWireToolExchange(mock.capturedRequests()))).toBe(scratch);
    expect(result.stdout).toContain(reply);
    const toolExchange = lastWireToolExchange(mock.capturedRequests());
    expect(toolExchange.results).toHaveLength(1);
    // Bare edits through the shell, so the sandbox is the write boundary.
    if (scratch) {
      expect(fs.readFileSync(target, 'utf8')).toBe(`${content}\n`);
      expect(toolExchange.results[0]?.content).toContain('exit 0');
      expect(result.stderr).not.toContain('[approval required]');
    } else {
      // The sandbox's denial text is platform-specific; the failed exit is not.
      expect(toolExchange.results[0]?.content).toMatch(/exit [1-9]/);
    }
  } finally {
    await mock.close();
  }
});

it('headless auto-approve at home refuses without printing or waiting for a question', async () => {
  const result = await spawnCli(
    [cliPath(), '--auto-approve', '--profile', 'bare', 'Reply'],
    createTestChildEnv({ HOME: testDir, DISABLE_LOGGING: '1' }),
    testDir,
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Headless startup refused');
  expect(result.stdout + result.stderr).not.toContain('Continue?');
});
