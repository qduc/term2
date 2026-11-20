import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { testCliPath, createTestChildEnv } from '../helpers/terminal-e2e.js';
import { resolveSettingsDirectory } from '../../src/config/settings/settings-path.js';

// Unattended approval (docs/plans/approvals-and-sandbox/unattended-approval.md), driven through the
// built headless CLI against an OpenAI-compatible double. The double answers the main model and the
// approval reviewer separately: a request that offers tools is the main model, one without is a review.
const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const builtCli = testCliPath(path.join(projectRoot, 'dist', 'src', 'app', 'cli.js'));
const TIMEOUT_MS = 120_000;

let server: http.Server | null = null;
let root = '';

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
  if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  root = '';
});

type MainReply = {
  readonly call?: { readonly id: string; readonly command: string; readonly unsandboxed?: true };
  readonly text?: string;
};
type Verdict = 'pass' | 'reject' | 'error';

const VERDICTS: Record<Exclude<Verdict, 'error'>, object> = {
  pass: {
    reasoning: 'Fixture review: explicitly requested',
    riskLevel: 'low',
    authorization: 'explicit',
    confidence: 'high',
  },
  reject: {
    reasoning: 'Fixture review: not requested by the user',
    riskLevel: 'high',
    authorization: 'unknown',
    confidence: 'high',
  },
};

type Recorded = { readonly main: string[]; readonly reviews: string[] };

async function startProvider(main: MainReply[], verdicts: Verdict[]): Promise<{ baseUrl: string; seen: Recorded }> {
  const seen: Recorded = { main: [], reviews: [] };
  server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-alpha' }] }));
      return;
    }
    let body = '';
    req.on('data', (chunk) => (body += String(chunk)));
    req.on('end', () => {
      const parsed = JSON.parse(body) as { tools?: unknown[] };
      const isReview = !Array.isArray(parsed.tools) || parsed.tools.length === 0;
      const id = `chatcmpl-${seen.main.length + seen.reviews.length}`;
      let frames: unknown[];
      if (isReview) {
        const verdict = verdicts[seen.reviews.length] ?? 'reject';
        seen.reviews.push(body);
        if (verdict === 'error') {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'review model down' } }));
          return;
        }
        const text = JSON.stringify({ results: [VERDICTS[verdict]] });
        frames = [
          { id, choices: [{ delta: { role: 'assistant', content: text } }] },
          { id, choices: [{ delta: {}, finish_reason: 'stop' }] },
        ];
      } else {
        const reply = main[seen.main.length] ?? { text: 'UNATTENDED_DONE' };
        seen.main.push(body);
        frames = reply.call
          ? [
              {
                id,
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: reply.call.id,
                          type: 'function',
                          function: {
                            name: 'shell',
                            arguments: JSON.stringify({
                              command: reply.call.command,
                              ...(reply.call.unsandboxed ? { sandbox: 'unsandboxed' } : {}),
                            }),
                          },
                        },
                      ],
                    },
                  },
                ],
              },
              { id, choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
            ]
          : [
              { id, choices: [{ delta: { role: 'assistant', content: reply.text } }] },
              { id, choices: [{ delta: {}, finish_reason: 'stop' }] },
            ];
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end([...frames.map((frame) => `data: ${JSON.stringify(frame)}\n`), 'data: [DONE]', ''].join('\n'));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return { baseUrl: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/v1`, seen };
}

/** `shims` is prepended to PATH, or with `onlyShims` replaces it (a sandbox with no `bwrap` is unavailable). */
type Sandbox = { readonly escapeReview?: boolean; readonly shims: string; readonly onlyShims?: true };

/**
 * Run one headless prompt with unattended approval. The sandbox is off (owner decision 5) unless `sandbox`
 * names a folder of stand-in sandbox binaries that make it report available.
 */
async function runHeadless(
  baseUrl: string,
  args: readonly string[] = [],
  prepare?: (workspace: string) => string,
  sandbox?: Sandbox,
): Promise<{ status: number | null; output: string; conversations: string; cwd: string }> {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-unattended-')));
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  const tmp = path.join(root, 'tmp');
  for (const dir of [home, workspace, tmp]) fs.mkdirSync(dir);
  const conversations = path.join(root, 'conversations');
  // `prepare` may set the workspace up (a git repository) and choose the directory the run starts in.
  const cwd = prepare ? prepare(workspace) : workspace;
  const env = createTestChildEnv({
    HOME: home,
    // Approval fixtures isolate scratch paths: an inherited TMPDIR changes path classification.
    TMPDIR: tmp,
    TEMP: tmp,
    TMP: tmp,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    TERM2_CONFIG_DIR: path.join(home, '.term2'),
    TERM2_CACHE_DIR: path.join(home, '.cache', 'term2'),
    TERM2_CONVERSATIONS_DIR: conversations,
    DISABLE_LOGGING: '1',
    ...(sandbox
      ? { PATH: sandbox.onlyShims ? sandbox.shims : `${sandbox.shims}${path.delimiter}${process.env.PATH ?? ''}` }
      : {}),
  });
  const settingsDir = resolveSettingsDirectory({ homeDir: home, env });
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(
    path.join(settingsDir, 'settings.json'),
    JSON.stringify({
      agent: { retryAttempts: 0, modelSelection: { model: 'mock-alpha', provider: 'mockprov' } },
      providers: [{ name: 'mockprov', type: 'openai-compatible', baseUrl, apiKey: 'test-key' }],
      sandbox: { enabled: sandbox !== undefined },
      shell: {
        autoApproveMode: 'unattended',
        ...(sandbox?.escapeReview ? { unattendedEscapeReview: true } : {}),
      },
    }),
  );
  const child = spawn('node', [builtCli, ...args, 'Check the runtime'], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += String(chunk)));
  child.stderr.on('data', (chunk) => (output += String(chunk)));
  const status = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  return { status, output, conversations, cwd };
}

/** Every fact line of every conversation log under the run's conversations directory. */
function loggedFacts(dir: string): Record<string, unknown>[] {
  const files: string[] = [];
  const walk = (at: string): void => {
    if (!fs.existsSync(at)) return;
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.jsonl')) files.push(full);
    }
  };
  walk(dir);
  return files.flatMap((file) =>
    fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          return [(parsed['fact'] as Record<string, unknown> | undefined) ?? parsed];
        } catch {
          return [];
        }
      }),
  );
}

it('runs a command the reviewer approves, as auto does', { timeout: TIMEOUT_MS }, async () => {
  const { baseUrl, seen } = await startProvider([{ call: { id: 'c1', command: 'node -v' } }], ['pass']);
  const { status, output, conversations } = await runHeadless(baseUrl);
  expect(status, output).toBe(0);
  expect(seen.reviews).toHaveLength(1);
  // The command ran: its output reached the next model request.
  expect(seen.main[1]).toContain(process.version);
  const closed = loggedFacts(conversations).find((fact) => fact['type'] === 'interaction_closed');
  expect(closed).toMatchObject({ resolutionSource: 'policy', automaticApproval: true });
});

it('refuses what the reviewer rejects and lets the turn continue', { timeout: TIMEOUT_MS }, async () => {
  const { baseUrl, seen } = await startProvider([{ call: { id: 'c1', command: 'node -v' } }], ['reject']);
  const { status, output, conversations } = await runHeadless(baseUrl, ['--auto-approve']);
  expect(status, output).toBe(0);
  expect(output).toContain('UNATTENDED_DONE');
  // The refusal is the call's result, with the reviewer's reason and the instruction to change approach.
  expect(seen.main[1]).toContain('Refused by unattended approval');
  expect(seen.main[1]).toContain('Fixture review: not requested by the user');
  expect(seen.main[1]).toContain('Take a different approach');
  expect(seen.main[1]).not.toContain(process.version);
  // No client was asked: the headless client never saw the request as open.
  expect(output).not.toContain('[approval required]');
  // Durable: the open carries the review, the close is a policy refusal, and nothing stays pending.
  const facts = loggedFacts(conversations);
  const opened = facts.find((fact) => fact['type'] === 'interaction_opened');
  const closed = facts.find((fact) => fact['type'] === 'interaction_closed');
  expect(opened).toMatchObject({ review: { kind: 'reviewed', approved: false } });
  expect(closed).toMatchObject({ resolutionSource: 'policy', resolution: { kind: 'deny' } });
  expect(closed).not.toHaveProperty('automaticApproval');
});

it('refuses when the review is unavailable', { timeout: TIMEOUT_MS }, async () => {
  const { baseUrl, seen } = await startProvider([{ call: { id: 'c1', command: 'node -v' } }], ['error', 'error']);
  const { status, output } = await runHeadless(baseUrl);
  expect(status, output).toBe(0);
  expect(seen.main[1]).toContain('Refused by unattended approval');
  expect(seen.main[1]).toContain('review was unavailable');
});

it('refuses Docker host control without asking the reviewer', { timeout: TIMEOUT_MS }, async () => {
  const { baseUrl, seen } = await startProvider([{ call: { id: 'c1', command: 'docker ps' } }], ['pass']);
  const { status, output } = await runHeadless(baseUrl);
  expect(status, output).toBe(0);
  expect(seen.reviews).toHaveLength(0);
  expect(seen.main[1]).toContain('Refused by unattended approval');
  expect(seen.main[1]).toContain('Docker host');
});

it('ends the turn at three consecutive refusals and exits non-zero', { timeout: TIMEOUT_MS }, async () => {
  const { baseUrl, seen } = await startProvider(
    [
      { call: { id: 'c1', command: 'node -e "1"' } },
      { call: { id: 'c2', command: 'node -e "2"' } },
      { call: { id: 'c3', command: 'node -e "3"' } },
      { text: 'SHOULD_NOT_BE_REQUESTED' },
    ],
    ['reject', 'reject', 'reject'],
  );
  const { status, output, conversations } = await runHeadless(baseUrl, ['--auto-approve']);
  expect(status, output).not.toBe(0);
  // No model request after the limit.
  expect(seen.main).toHaveLength(3);
  expect(output).not.toContain('SHOULD_NOT_BE_REQUESTED');
  // The final output lists each refusal with its reason.
  expect(output).toContain('Unattended approval stopped this run after refusing 3 requests');
  expect(output.match(/Fixture review: not requested by the user/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  const ended = loggedFacts(conversations).find((fact) => fact['type'] === 'turn_ended');
  expect(ended).toMatchObject({ terminalCause: 'approval_refusal_limit' });
});

it('a command that runs resets the consecutive count', { timeout: TIMEOUT_MS }, async () => {
  const { baseUrl, seen } = await startProvider(
    [
      { call: { id: 'c1', command: 'node -e "1"' } },
      { call: { id: 'c2', command: 'node -e "2"' } },
      { call: { id: 'c3', command: 'node -v' } },
      { call: { id: 'c4', command: 'node -e "4"' } },
    ],
    ['reject', 'reject', 'pass', 'reject'],
  );
  const { status, output } = await runHeadless(baseUrl);
  expect(status, output).toBe(0);
  expect(seen.main).toHaveLength(5);
  expect(output).toContain('UNATTENDED_DONE');
});

// Part B: the per-turn workspace snapshot.

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...args], {
    cwd,
    encoding: 'utf8',
  });

/** A repository with a committed, a modified, a staged, an untracked and an ignored file. */
function seedRepository(dir: string): void {
  git(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'ignored.txt\n');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'two\n');
  fs.writeFileSync(path.join(dir, 'd.txt'), 'keep\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'init');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'modified\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'staged\n');
  git(dir, 'add', 'b.txt');
  fs.writeFileSync(path.join(dir, 'u.txt'), 'untracked\n');
  fs.writeFileSync(path.join(dir, 'ignored.txt'), 'ignored\n');
}

const snapshotRefs = (cwd: string): string[] =>
  git(cwd, 'for-each-ref', '--format=%(refname)', 'refs/term2/snapshots/').split('\n').filter(Boolean);

const MUTATE =
  "node -e \"const f=require('fs');f.writeFileSync('a.txt','turn\\n');f.rmSync('d.txt');f.writeFileSync('c.txt','created\\n')\"";

for (const layout of ['primary checkout', 'linked worktree'] as const) {
  it(
    `snapshots a ${layout} before the first tool call without touching status or index`,
    { timeout: TIMEOUT_MS },
    async () => {
      const { baseUrl } = await startProvider([{ call: { id: 'c1', command: 'node -v' } }], ['pass']);
      let before = { status: '', index: '', stash: '', head: '' };
      const { status, output, cwd } = await runHeadless(baseUrl, [], (workspace) => {
        let dir = workspace;
        if (layout === 'linked worktree') {
          const main = path.join(workspace, 'main');
          fs.mkdirSync(main);
          seedRepository(main);
          dir = path.join(workspace, 'linked');
          git(main, 'worktree', 'add', '-q', dir);
          // The linked worktree gets its own modified, staged and untracked files.
          fs.writeFileSync(path.join(dir, 'a.txt'), 'linked modified\n');
          fs.writeFileSync(path.join(dir, 'b.txt'), 'linked staged\n');
          git(dir, 'add', 'b.txt');
          fs.writeFileSync(path.join(dir, 'u.txt'), 'linked untracked\n');
        } else seedRepository(dir);
        before = {
          status: git(dir, 'status', '--porcelain'),
          index: git(dir, 'ls-files', '-s'),
          stash: git(dir, 'stash', 'list'),
          head: git(dir, 'rev-parse', 'HEAD', '--symbolic-full-name', 'HEAD'),
        };
        return dir;
      });
      expect(status, output).toBe(0);
      expect(git(cwd, 'status', '--porcelain')).toBe(before.status);
      expect(git(cwd, 'ls-files', '-s')).toBe(before.index);
      expect(git(cwd, 'stash', 'list')).toBe(before.stash);
      expect(git(cwd, 'rev-parse', 'HEAD', '--symbolic-full-name', 'HEAD')).toBe(before.head);
      const refs = snapshotRefs(cwd);
      expect(refs).toHaveLength(1);
      const files = git(cwd, 'ls-tree', '-r', '--name-only', refs[0]!).split('\n').filter(Boolean);
      expect(files).toEqual(expect.arrayContaining(['a.txt', 'b.txt', 'd.txt', 'u.txt']));
      expect(files).not.toContain('ignored.txt');
      const prefix = layout === 'linked worktree' ? 'linked ' : '';
      expect(git(cwd, 'show', `${refs[0]}:a.txt`)).toBe(`${prefix}modified\n`);
      expect(git(cwd, 'show', `${refs[0]}:b.txt`)).toBe(`${prefix}staged\n`);
      expect(git(cwd, 'show', `${refs[0]}:u.txt`)).toBe(`${prefix}untracked\n`);
      expect(output).toContain(`Workspace snapshot before this turn: ${refs[0]}`);
      expect(output).toContain('No files changed since it.');
    },
  );
}

it(
  'reports the files a turn changed, and the restore command puts back modified and deleted files',
  { timeout: TIMEOUT_MS },
  async () => {
    const { baseUrl } = await startProvider([{ call: { id: 'c1', command: MUTATE } }], ['pass']);
    const { status, output, cwd } = await runHeadless(baseUrl, [], (workspace) => {
      seedRepository(workspace);
      return workspace;
    });
    expect(status, output).toBe(0);
    expect(fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8')).toBe('turn\n');
    expect(output).toMatch(/Files changed since it \(3\):/);
    expect(output).toContain('M a.txt');
    expect(output).toContain('D d.txt');
    expect(output).toContain('A c.txt');
    const restore =
      /To put back modified and deleted files: git -C ("[^"]+") restore --source=(\S+) --worktree -- \./.exec(output);
    expect(restore, output).not.toBeNull();
    const indexBefore = git(cwd, 'ls-files', '-s');
    git(JSON.parse(restore![1]!) as string, 'restore', `--source=${restore![2]}`, '--worktree', '--', '.');
    expect(fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8')).toBe('modified\n');
    expect(fs.readFileSync(path.join(cwd, 'd.txt'), 'utf8')).toBe('keep\n');
    // Documented: a file the turn created and did not stage is kept; the index is not touched.
    expect(fs.readFileSync(path.join(cwd, 'c.txt'), 'utf8')).toBe('created\n');
    expect(git(cwd, 'ls-files', '-s')).toBe(indexBefore);
  },
);

it(
  'says there is no snapshot in a workspace that is not a git repository, and the turn proceeds',
  { timeout: TIMEOUT_MS },
  async () => {
    const { baseUrl, seen } = await startProvider([{ call: { id: 'c1', command: 'node -v' } }], ['pass']);
    const { status, output } = await runHeadless(baseUrl);
    expect(status, output).toBe(0);
    expect(seen.main[1]).toContain(process.version);
    expect(output.match(/No workspace snapshot for this turn: the workspace is not a git repository\./g)).toHaveLength(
      1,
    );
  },
);

it('keeps only the newest 20 snapshot refs', { timeout: TIMEOUT_MS }, async () => {
  const { baseUrl } = await startProvider([{ text: 'UNATTENDED_DONE' }], []);
  const { status, output, cwd } = await runHeadless(baseUrl, [], (workspace) => {
    seedRepository(workspace);
    const head = git(workspace, 'rev-parse', 'HEAD').trim();
    for (let i = 0; i < 20; i += 1) git(workspace, 'update-ref', `refs/term2/snapshots/${1000000000000 + i}-old`, head);
    return workspace;
  });
  expect(status, output).toBe(0);
  const refs = snapshotRefs(cwd);
  expect(refs).toHaveLength(20);
  expect(refs).not.toContain('refs/term2/snapshots/1000000000000-old');
  expect(refs.filter((ref) => !ref.endsWith('-old'))).toHaveLength(1);
});

// Decision 4: where the sandbox is on, a request to leave it is refused without a review. The TUI and headless
// ask with no `unsandboxed-once` grant and run an allowed escape outside the sandbox, so the route must
// recognise the call itself. Stand-in `bwrap`/`socat` make the sandbox report available; they exit 97 if run,
// so a marker file written means the command ran unsandboxed.
const MARK = "node -e \"require('fs').writeFileSync('ESCAPED.txt','outside')\"";

function sandboxShims(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-sandbox-shims-'));
  for (const name of ['bwrap', 'socat'])
    fs.writeFileSync(path.join(dir, name), '#!/bin/sh\nexit 97\n', { mode: 0o755 });
  return dir;
}

it('refuses a sandbox escape without a review where the sandbox is on', { timeout: TIMEOUT_MS }, async () => {
  if (process.platform !== 'linux') return;
  const shims = sandboxShims();
  try {
    const { baseUrl, seen } = await startProvider([{ call: { id: 'c1', command: MARK, unsandboxed: true } }], ['pass']);
    const { status, output, cwd } = await runHeadless(baseUrl, ['--auto-approve'], undefined, { shims });
    expect(status, output).toBe(0);
    expect(seen.reviews).toHaveLength(0);
    expect(seen.main[1]).toContain('Refused by unattended approval');
    expect(seen.main[1]).toContain('outside the sandbox');
    expect(fs.existsSync(path.join(cwd, 'ESCAPED.txt'))).toBe(false);
  } finally {
    fs.rmSync(shims, { recursive: true, force: true });
  }
});

it(
  'hands a sandbox escape to the reviewer when shell.unattendedEscapeReview is on',
  { timeout: TIMEOUT_MS },
  async () => {
    if (process.platform !== 'linux') return;
    const shims = sandboxShims();
    try {
      const { baseUrl, seen } = await startProvider(
        [{ call: { id: 'c1', command: MARK, unsandboxed: true } }],
        ['reject'],
      );
      const { status, output, cwd } = await runHeadless(baseUrl, [], undefined, { shims, escapeReview: true });
      expect(status, output).toBe(0);
      expect(seen.reviews).toHaveLength(1);
      expect(seen.main[1]).toContain('Fixture review: not requested by the user');
      expect(fs.existsSync(path.join(cwd, 'ESCAPED.txt'))).toBe(false);
    } finally {
      fs.rmSync(shims, { recursive: true, force: true });
    }
  },
);

it(
  'hands a sandbox escape to the reviewer when the sandbox is enabled but unavailable',
  { timeout: TIMEOUT_MS },
  async () => {
    if (process.platform !== 'linux') return;
    // Only node and git on PATH: no bwrap, so the sandbox reports a missing dependency (decision 5, A12).
    const shims = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-no-sandbox-'));
    for (const name of ['node', 'git']) {
      const found = execFileSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).trim();
      fs.symlinkSync(found, path.join(shims, name));
    }
    try {
      const { baseUrl, seen } = await startProvider(
        [{ call: { id: 'c1', command: MARK, unsandboxed: true } }],
        ['reject'],
      );
      const { status, output, cwd } = await runHeadless(baseUrl, [], undefined, { shims, onlyShims: true });
      expect(status, output).toBe(0);
      expect(seen.reviews).toHaveLength(1);
      expect(seen.main[1]).toContain('Fixture review: not requested by the user');
      expect(fs.existsSync(path.join(cwd, 'ESCAPED.txt'))).toBe(false);
    } finally {
      fs.rmSync(shims, { recursive: true, force: true });
    }
  },
);
