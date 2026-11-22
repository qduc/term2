import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { testCliPath, spawnTerminal, createTestChildEnv, type TerminalSession } from '../helpers/terminal-e2e.js';
import {
  HARNESS_IDLE_ENV,
  waitForHarnessComposerValue,
  waitForHarnessIdleGeneration,
} from '../../src/shared/lib/harness-input-idle.js';
import { resolveSettingsDirectory } from '../../src/config/settings/settings-path.js';

// Unattended approval (docs/plans/approvals-and-sandbox/unattended-approval.md) in the built terminal UI, in a
// real pty, against an OpenAI-compatible double. The double answers the main model and the approval reviewer
// separately: a request that offers tools is the main model, one without is a review. Criterion A2: no
// approval prompt reaches the TUI; A7: the limit's list is shown and the session takes a new turn; B4: a
// successful snapshot report stays out of the TUI. Decision 2 (ask_user still asks) has no TUI case: the Bare profile, the only
// selectable one, does not offer ask_user (no `user-interaction` capability).
const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const builtCli = testCliPath(path.join(projectRoot, 'dist', 'src', 'app', 'cli.js'));
const TIMEOUT_MS = 120_000;
// Set TERM2_TUI_CAPTURE_DIR to keep each scenario's final screen as a text file.
const CAPTURE_DIR = process.env.TERM2_TUI_CAPTURE_DIR;

let session: TerminalSession | null = null;
let server: http.Server | null = null;
let root = '';

afterEach(async () => {
  session?.dispose();
  session = null;
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
  if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  root = '';
});

type MainReply =
  | { readonly call: { readonly id: string; readonly name?: string; readonly args: object } }
  | { readonly text: string };
type Seen = { readonly main: string[]; readonly reviews: string[] };

const REJECT = {
  reasoning: 'Fixture review: not requested by the user',
  riskLevel: 'high',
  authorization: 'unknown',
  confidence: 'high',
};

async function startProvider(main: MainReply[]): Promise<{ baseUrl: string; seen: Seen }> {
  const seen: Seen = { main: [], reviews: [] };
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
        seen.reviews.push(body);
        frames = [
          { id, choices: [{ delta: { role: 'assistant', content: JSON.stringify({ results: [REJECT] }) } }] },
          { id, choices: [{ delta: {}, finish_reason: 'stop' }] },
        ];
      } else {
        const reply = main[seen.main.length] ?? { text: 'TUI_DONE' };
        seen.main.push(body);
        frames =
          'call' in reply
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
                            function: { name: reply.call.name ?? 'shell', arguments: JSON.stringify(reply.call.args) },
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

/** Start the TUI with the sandbox off (owner decision 5) and the given approval mode. */
async function startTui(
  baseUrl: string,
  mode: string,
  prepare?: (workspace: string) => void,
): Promise<{ submit: (text: string) => Promise<void>; workspace: string }> {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-unattended-tui-')));
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  const tmp = path.join(root, 'tmp');
  for (const dir of [home, workspace, tmp]) fs.mkdirSync(dir);
  prepare?.(workspace);
  const idlePath = path.join(home, 'input-idle');
  const env = {
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
    TERM2_CONVERSATIONS_DIR: path.join(root, 'conversations'),
    DISABLE_LOGGING: '1',
    [HARNESS_IDLE_ENV]: idlePath,
    CI: 'false',
  };
  const settingsDir = resolveSettingsDirectory({ homeDir: home, env: createTestChildEnv(env) });
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(
    path.join(settingsDir, 'settings.json'),
    JSON.stringify({
      agent: { retryAttempts: 0, modelSelection: { model: 'mock-alpha', provider: 'mockprov' } },
      providers: [{ name: 'mockprov', type: 'openai-compatible', baseUrl, apiKey: 'test-key' }],
      sandbox: { enabled: false },
      shell: { autoApproveMode: mode },
    }),
  );
  session = spawnTerminal('node', [builtCli], { cwd: workspace, env, cols: 120, rows: 40 });
  await waitForHarnessIdleGeneration(idlePath, { timeoutMs: 60_000 });
  return {
    workspace,
    submit: async (text: string) => {
      session!.write(text);
      await waitForHarnessComposerValue(idlePath, text, { timeoutMs: 60_000 });
      session!.write('\r');
    },
  };
}

function capture(name: string): void {
  if (!CAPTURE_DIR || !session) return;
  fs.mkdirSync(CAPTURE_DIR, { recursive: true });
  fs.writeFileSync(path.join(CAPTURE_DIR, `${name}.txt`), session.getVisibleOutput());
}

const shellCall = (id: string, command: string): MainReply => ({ call: { id, args: { command } } });

it(
  'switches to unattended with /auto-approve and refuses without showing an approval prompt',
  { timeout: TIMEOUT_MS },
  async () => {
    const { baseUrl, seen } = await startProvider([shellCall('c1', 'node -e "1"'), { text: 'TUI_AFTER_REFUSAL' }]);
    const { submit } = await startTui(baseUrl, 'off');
    await submit('/auto-approve unattended');
    await session!.waitForOutput('Unattended', 30_000);
    await submit('Check the runtime');
    await session!.waitForOutput('TUI_AFTER_REFUSAL', 60_000);
    const screen = session!.getVisibleOutput();
    capture('refusal');
    expect(seen.reviews).toHaveLength(1);
    expect(screen).not.toContain('Allow this action?');
    expect(screen).not.toContain('Allow once');
    expect(screen).toContain('Refused by unattended approval');
    expect(seen.main[1]).toContain('Fixture review: not requested by the user');
  },
);

it(
  'ends the turn at the refusal limit, lists the refusals, and takes the next message',
  { timeout: TIMEOUT_MS },
  async () => {
    const { baseUrl, seen } = await startProvider([
      shellCall('c1', 'node -e "1"'),
      shellCall('c2', 'node -e "2"'),
      shellCall('c3', 'node -e "3"'),
      { text: 'TUI_NEXT_TURN' },
    ]);
    const { submit } = await startTui(baseUrl, 'unattended');
    await submit('Check the runtime');
    await session!.waitForOutput('Unattended approval stopped this run after refusing 3 requests', 60_000);
    capture('limit');
    expect(seen.main).toHaveLength(3);
    expect(session!.getVisibleOutput()).not.toContain('Allow this action?');
    // The session is usable: the next message starts a new turn.
    await submit('Carry on');
    await session!.waitForOutput('TUI_NEXT_TURN', 60_000);
    capture('limit-next-turn');
    expect(seen.main).toHaveLength(4);
  },
);

it('shows unattended refusals without the successful workspace snapshot report', { timeout: TIMEOUT_MS }, async () => {
  const { baseUrl } = await startProvider([shellCall('c1', 'node -e "1"'), { text: 'TUI_SNAPSHOT_DONE' }]);
  await startTui(baseUrl, 'unattended', (workspace) => {
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...args], {
        cwd: workspace,
      });
    git('init', '-q');
    fs.writeFileSync(path.join(workspace, 'a.txt'), 'one\n');
    git('add', '.');
    git('commit', '-qm', 'init');
  }).then(({ submit }) => submit('Check the runtime'));
  await session!.waitForOutput('TUI_SNAPSHOT_DONE', 60_000);
  await session!.waitForOutput('Unattended approval refused 1 request in this run.', 30_000);
  capture('snapshot');
  expect(session!.getVisibleOutput()).not.toContain('Workspace snapshot before this turn:');
  expect(session!.getVisibleOutput()).not.toContain('To put back modified and deleted files:');
});
