import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
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

type MainReply = { readonly call?: { readonly id: string; readonly command: string }; readonly text?: string };
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
                          function: { name: 'shell', arguments: JSON.stringify({ command: reply.call.command }) },
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

/** Run one headless prompt with unattended approval and the sandbox off (owner decision 5). */
async function runHeadless(
  baseUrl: string,
  args: readonly string[] = [],
): Promise<{ status: number | null; output: string; conversations: string }> {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-unattended-')));
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  const tmp = path.join(root, 'tmp');
  for (const dir of [home, workspace, tmp]) fs.mkdirSync(dir);
  const conversations = path.join(root, 'conversations');
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
  });
  const settingsDir = resolveSettingsDirectory({ homeDir: home, env });
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(
    path.join(settingsDir, 'settings.json'),
    JSON.stringify({
      agent: { retryAttempts: 0, modelSelection: { model: 'mock-alpha', provider: 'mockprov' } },
      providers: [{ name: 'mockprov', type: 'openai-compatible', baseUrl, apiKey: 'test-key' }],
      sandbox: { enabled: false },
      shell: { autoApproveMode: 'unattended' },
    }),
  );
  const child = spawn('node', [builtCli, ...args, 'Check the runtime'], {
    cwd: workspace,
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
  return { status, output, conversations };
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
  expect(output).toContain('Unattended approval stopped this run after 3 refused requests');
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
