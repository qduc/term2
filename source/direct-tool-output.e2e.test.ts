import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testCliPath, spawnTerminal, createTestChildEnv, type TerminalSession } from './test-helpers/terminal-e2e.js';
import {
  HARNESS_IDLE_ENV,
  waitForHarnessComposerValue,
  waitForHarnessIdleGeneration,
} from './lib/harness-input-idle.js';
import { resolveSettingsDirectory } from './services/settings/settings-path.js';

// Runs the built terminal UI (`pnpm build` output, as CI does before test:e2e) in a real pty against
// an OpenAI-compatible chat-completions double, and reads what the terminal rendered.
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const builtCli = testCliPath(path.join(projectRoot, 'rewrite', 'dist', 'rewrite', 'src', 'app', 'cli.js'));
const TIMEOUT_MS = 120_000;

let session: TerminalSession | null = null;
let root = '';
let server: http.Server | null = null;
let providerRequests: string[] = [];
let finishReasoning: (() => void) | undefined;

afterEach(async () => {
  session?.dispose();
  session = null;
  finishReasoning?.();
  finishReasoning = undefined;
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = '';
  providerRequests = [];
});

type Reply = {
  call?: { id: string; command?: string; tool?: string; args?: object };
  text?: string;
  reasoning?: string;
};

/** One SSE reply per chat request, in order: a single shell call or plain text. */
async function startProvider(replies: Reply[]): Promise<string> {
  let requests = 0;
  server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-alpha' }] }));
      return;
    }
    let body = '';
    req.on('data', (chunk) => (body += chunk.toString()));
    req.on('end', () => {
      providerRequests.push(body);
      const reply = replies[requests++] ?? { text: 'control reply sentinel' };
      const id = `chatcmpl-${requests}`;
      const frames = reply.call
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
                          name: reply.call.tool ?? 'shell',
                          arguments: JSON.stringify(reply.call.args ?? { command: reply.call.command }),
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
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const finish = () =>
        res.end([...frames.map((frame) => `data: ${JSON.stringify(frame)}\n`), 'data: [DONE]', ''].join('\n'));
      if (reply.reasoning) {
        res.write(`data: ${JSON.stringify({ id, choices: [{ delta: { reasoning_content: reply.reasoning } }] })}\n\n`);
        setTimeout(() => {
          res.write(
            `data: ${JSON.stringify({
              id,
              choices: [{ delta: { reasoning_content: ' with more streamed detail' } }],
            })}\n\n`,
          );
          finishReasoning = finish;
        }, 1200);
      } else finish();
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/v1`;
}

/** Exercise the built standalone control client against the running TUI, not an in-process port. */
async function control(args: string[], env: NodeJS.ProcessEnv, cwd: string, input = '') {
  const child = spawn('node', [builtCli, 'control', ...args], { cwd, env: createTestChildEnv(env) });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
  child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
  child.stdin.end(input);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  expect(code, stderr).toBe(0);
  return stdout;
}

// Shell output is rendered once; the raw tool-result message array is not printed.
it(
  'the direct terminal UI shows shell output once, with no raw tool-result JSON, and inline code without extra spaces',
  { timeout: TIMEOUT_MS },
  async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-tool-rows-e2e-')));
    const home = path.join(root, 'home');
    const workspace = path.join(root, 'w');
    fs.mkdirSync(path.join(root, 'runtime'), { mode: 0o700 });
    fs.mkdirSync(home);
    fs.mkdirSync(workspace);
    const first = 'echo hi > b.txt && cat b.txt';
    const file = path.join(workspace, 'c.txt');
    const baseUrl = await startProvider([
      { call: { id: 'call_f', command: 'exit 3' } },
      { call: { id: 'call_1', tool: 'create_file', args: { path: file, content: 'alpha-line\nbeta-line' } } },
      {
        call: {
          id: 'call_2',
          tool: 'search_replace',
          args: { path: file, replacements: [{ search_content: 'alpha-line', replace_content: 'gamma-line' }] },
        },
      },
      { call: { id: 'call_0', args: { command: first, description: 'Write and read the file' } } },
      {
        reasoning: 'Locating the unique workspace fixture',
        text: 'Created `b.txt` and read it back: `hi`. Flags: `--foo` `--bar` first turn done. Bold **`BOLDCHIP`** here. End **`ENDCHIP`**. List: **`ONECHIP`** `TWOCHIP` end. Italic *`ITALICCHIP`* end.\n\n- `LISTCHIP` starts here.',
      },
    ]);
    const idlePath = path.join(home, 'input-idle');
    const env = {
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
      [HARNESS_IDLE_ENV]: idlePath,
      // Ink suppresses dynamic terminal updates in CI mode; this test needs an interactive TUI.
      CI: 'false',
    };
    const settingsDir = resolveSettingsDirectory({ homeDir: home, env: createTestChildEnv(env) });
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(
      path.join(settingsDir, 'settings.json'),
      JSON.stringify({
        agent: { retryAttempts: 0, modelSelection: { model: 'mock-alpha', provider: 'mockprov' } },
        providers: [{ name: 'mockprov', type: 'openai-compatible', baseUrl, apiKey: 'test-key' }],
        // Sandbox off and GREEN commands: both run without an approval prompt.
        sandbox: { enabled: false },
        shell: { autoApproveMode: 'always' },
      }),
    );

    session = spawnTerminal('node', [builtCli, '--control-socket=coord'], {
      cwd: workspace,
      env,
      cols: 160,
      rows: 40,
    });
    let idle = await waitForHarnessIdleGeneration(idlePath, { timeoutMs: 60_000 });

    // Submit only once the composer holds the text; Enter in the same write is taken as pasted input.
    const submit = async (text: string) => {
      session!.write(text);
      await waitForHarnessComposerValue(idlePath, text, { timeoutMs: 60_000 });
      session!.write('\r');
    };

    await submit('tidy the workspace');
    await session.waitForOutput('Locating the unique workspace fixture', 60_000);
    expect(session.getVisibleOutput()).toContain('Locating the unique workspace fixture');
    await session.waitForOutput('with more streamed detail', 30_000);
    await session.waitForOutput('tok/s', 30_000);
    const liveFrame = session.getVisibleOutput().slice(session.getVisibleOutput().lastIndexOf('▌ term²'));
    expect(liveFrame).toMatch(/Generating · \d+s/);
    expect(liveFrame).toContain('tok/s');
    expect(liveFrame).not.toContain('Queue: running');
    finishReasoning!();
    finishReasoning = undefined;
    await session.waitForOutput('first turn done', 60_000);
    idle = await waitForHarnessIdleGeneration(idlePath, { after: idle, timeoutMs: 60_000 });

    const help = await promisify(execFile)('node', [builtCli, '--help'], {
      cwd: workspace,
      env: createTestChildEnv(env),
    });
    expect(help.stdout).toMatch(/term2 control list[^\n]*\|\n/);
    const listing = await control(['list'], env, workspace);
    expect(JSON.parse(listing.trim()).name).toBe('coord');
    const status = JSON.parse(await control(['status', 'coord', '--json'], env, workspace));
    expect(status.phase).toBe('idle');
    const visible = session.getVisibleOutput();
    // The PTY helper retains previous redraws; inspect the latest frame, not scrollback.
    const currentFrame = visible.slice(visible.lastIndexOf('▌ term²'));
    expect(currentFrame).toContain('first turn done');
    expect(currentFrame).not.toContain('Locating the unique workspace fixture');
    // The bar under the composer names the profile, model and approval mode (this run is YOLO).
    expect(visible, visible).toMatch(/Bare[^\n]*mockprov\/mock-alpha[^\n]*YOLO/);
    expect(visible, visible).not.toContain('isApprovalRejection');
    expect(visible, visible).toContain('Created b.txt and read it back: hi.');
    // Inline code is a chip: padded on the background where a space stood, none before the full stop.
    expect(session.getOutput()).toMatch(/m b\.txt \x1b\[/);
    // Two chips with one space between them stay two chips with one padding column between them.
    expect(visible, visible).toContain('Flags: --foo --bar first turn done');
    expect(visible, visible).toMatch(/Bold\s+BOLDCHIP here\. End ENDCHIP\./);
    expect(visible, visible).toContain('List: ONECHIP TWOCHIP end.');
    expect(visible, visible).toContain('• LISTCHIP starts here.');
    const raw = session.getOutput();
    // The spaces on either side of bold code carry its background; punctuation does not.
    expect(raw).toMatch(/\x1b\[40m\x1b\[93m BOLDCHIP \x1b/);
    expect(raw).toMatch(/\x1b\[40m\x1b\[93m ENDCHIP\x1b/);
    expect(raw).toMatch(/\x1b\[40m\x1b\[93m ONECHIP \x1b\[22mTWOCHIP /);
    expect(raw).toMatch(/\x1b\[40m\x1b\[93m ITALICCHIP \x1b/);
    // The bullet supplies its own separator; do not add a second column.
    expect(raw).toMatch(/•\x1b\[39m \x1b\[40m\x1b\[93mLISTCHIP /);

    // The edit and the new content stay visible: the header only names the file.
    expect(visible, visible).toContain('+ beta-line');
    expect(visible, visible).toContain('- alpha-line');
    expect(visible, visible).toContain('+ gamma-line');
    // The first edit appears once, not again as a repeated command line.
    expect(visible, visible).not.toContain('search_replace "');
    // Collapsed by default: one row with the runtime, and no output until expanded with Ctrl+O.
    expect(visible, visible).toMatch(/\S \(\d+ms\)/);
    expect(visible, visible).not.toMatch(/Runtime: \d+ms\s+hi\b/);
    expect(visible, visible).toContain('Write and read the file');
    const collapsedRow = visible.slice(
      visible.lastIndexOf('✓ Write and read the file'),
      visible.lastIndexOf('Created b.txt'),
    );
    expect(collapsedRow, visible).not.toContain(first);
    expect(visible, visible).toContain('Shell command');
    // A failed command is not collapsed: its exit status stays visible without expanding.
    expect(visible, visible).toContain('exit 3');
    session.write('\x0f');
    for (let i = 0; i < 40 && !/Runtime: \d+ms\s+hi\b/.test(session.getVisibleOutput()); i++)
      await new Promise((resolve) => setTimeout(resolve, 250));
    expect(session.getVisibleOutput()).toMatch(/Runtime: \d+ms\s+hi\b/);
    const expanded = session.getVisibleOutput();
    expect(expanded.slice(expanded.lastIndexOf('✓ Write and read the file'))).toContain(first);
    // Collapse expanded output with Escape without clearing the current draft.
    session.write('output-draft');
    await waitForHarnessComposerValue(idlePath, 'output-draft', { timeoutMs: 30_000 });
    const beforeEscape = session.getVisibleOutput().length;
    session.write('\x1b');
    await new Promise((resolve) => setTimeout(resolve, 600));
    const afterEscape = session.getVisibleOutput().slice(beforeEscape);
    expect(afterEscape).toContain('Write and read the file');
    expect(afterEscape).not.toMatch(/Runtime: \d+ms\s+hi\b/);
    await waitForHarnessComposerValue(idlePath, 'output-draft', { timeoutMs: 30_000 });
    // The task panel owns its Escape and returns the same draft to the editor.
    session.write('\x07');
    await session.waitForOutput('Manage background tasks', 30_000);
    session.write('\x1b');
    await new Promise((resolve) => setTimeout(resolve, 300));
    session.write('-after');
    await waitForHarnessComposerValue(idlePath, 'output-draft-after', { timeoutMs: 30_000 });
    session.write('\x03');
    await waitForHarnessComposerValue(idlePath, '', { timeoutMs: 30_000 });
    // Keep the next test-exit Ctrl+C outside the root's double-interrupt window.
    await new Promise((resolve) => setTimeout(resolve, 2500));

    const receipt = JSON.parse(
      await control(['submit', 'coord', '--id', 'control-test', '--json'], env, workspace, 'a control message'),
    );
    expect(receipt.delivery).toBe('started');
    expect(receipt.messageId).toBeTruthy();
    await session.waitForOutput('control reply sentinel', 60_000);
    expect(providerRequests.some((body) => body.includes('a control message'))).toBe(true);
    // Quit the way a user does, so the app finishes its writes before the test removes its directories.
    session.write('\x03');
    await session.waitForOutput('Press Ctrl+C again to exit', 30_000);
    session.write('\x03');
    expect((await session.waitForExit(30_000)).exitCode).toBe(0);
  },
);
