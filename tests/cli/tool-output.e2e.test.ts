import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testCliPath, spawnTerminal, createTestChildEnv, type TerminalSession } from '../helpers/terminal-e2e.js';
import {
  HARNESS_IDLE_ENV,
  readHarnessIdleGeneration,
  waitForHarnessComposerValue,
  waitForHarnessIdleGeneration,
} from '../../src/shared/lib/harness-input-idle.js';
import { resolveSettingsDirectory } from '../../src/config/settings/settings-path.js';

// Runs the built terminal UI (`pnpm build` output, as CI does before test:e2e) in a real pty against
// an OpenAI-compatible chat-completions double, and reads what the terminal rendered.
const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const builtCli = testCliPath(path.join(projectRoot, 'dist', 'src', 'app', 'cli.js'));
const TIMEOUT_MS = 120_000;
// Long enough that the closing double Ctrl+C lands inside it on a loaded runner; short enough to wait out.
const EXIT_CONFIRM_WINDOW_MS = 1_000;

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
  if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
        // A measured rate needs two deltas apart in time, not a long pause: about 13 estimated
        // tokens over 250 ms is ~50 tok/s, far inside the status bar's 500 tok/s plausibility cap.
        setTimeout(() => {
          res.write(
            `data: ${JSON.stringify({
              id,
              choices: [{ delta: { reasoning_content: ' with more streamed detail' } }],
            })}\n\n`,
          );
          finishReasoning = finish;
        }, 250);
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
    const failedDescription = `Check failure summary ${'H'.repeat(90)}`;
    const failureOutput = `FAIL_SENTINEL_${'Z'.repeat(130)}`;
    const file = path.join(workspace, 'c.txt');
    const baseUrl = await startProvider([
      {
        call: {
          id: 'call_f',
          args: {
            command: `printf '%s\\n' '${failureOutput}'; printf '%s\\n' 'fatal: not a git repository' >&2; exit 128`,
            description: failedDescription,
          },
        },
      },
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
      // The draft-clearing Ctrl+C below arms the exit window; the closing pair must fit inside it.
      TERM2_EXIT_CONFIRM_WINDOW_MS: String(EXIT_CONFIRM_WINDOW_MS),
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
      rows: 50,
    });
    let idle = await waitForHarnessIdleGeneration(idlePath, { timeoutMs: 60_000 });

    // Submit only once the composer holds the text; Enter in the same write is taken as pasted input.
    const submit = async (text: string) => {
      session!.write(text);
      await waitForHarnessComposerValue(idlePath, text, { timeoutMs: 60_000 });
      session!.write('\r');
    };

    await submit('tidy the workspace');
    // The default concise mode hides reasoning without suppressing its streaming activity/rate.
    await session.waitForOutput('tok/s', 30_000);
    expect(session.getVisibleOutput()).not.toContain('Locating the unique workspace fixture');
    expect(session.getVisibleOutput()).not.toContain('with more streamed detail');
    const liveFrame = session.getVisibleOutput().slice(session.getVisibleOutput().lastIndexOf('▌ term²'));
    expect(liveFrame).toMatch(/Generating · \d+s/);
    expect(liveFrame).toContain('tok/s');
    expect(liveFrame).not.toContain('Queue: running');
    const beforeSettled = session.getVisibleOutput().length;
    finishReasoning!();
    finishReasoning = undefined;
    await session.waitForOutput('first turn done', 60_000);
    idle = await waitForHarnessIdleGeneration(idlePath, { after: idle, timeoutMs: 60_000 });

    const help = await promisify(execFile)('node', [builtCli, '--help'], {
      cwd: workspace,
      env: createTestChildEnv(env),
    });
    // --help is legacy's meow text byte for byte; its control example is the status call.
    expect(help.stdout).toContain('$ term2 control status worker-1 --json');
    const listing = await control(['list'], env, workspace);
    expect(JSON.parse(listing.trim()).name).toBe('coord');
    const status = JSON.parse(await control(['status', 'coord', '--json'], env, workspace));
    expect(status.phase).toBe('idle');
    const visible = session.getVisibleOutput();
    // Static content is not repeated in every frame, and this helper returns
    // accumulated PTY bytes rather than a terminal screen. Check that settled
    // reasoning is not emitted again after the last answer, not screen contents.
    expect(visible).toContain('first turn done');
    // Settled Ink Static rows retain one separator, not a padding line per row.
    // Concise display folds the settled run into legacy's one summary line, with the failures named below it.
    // Bare offers create_file and search_replace directly, so only the shell probe failed.
    expect(visible).toMatch(
      /✓ Ran 2 shell commands, created 1 file, edited 1 file\r?\n[^\n]*✗ 1 failed: Check failure/,
    );
    expect(visible.slice(visible.lastIndexOf('first turn done'))).not.toContain(
      'Locating the unique workspace fixture',
    );
    // The bar under the composer names the profile, model and approval mode (this run is YOLO).
    expect(visible, visible).toMatch(/mockprov\/mock-alpha[^\n]*YOLO/);
    expect(visible, visible).not.toContain('isApprovalRejection');
    expect(visible, visible).toContain('Created b.txt and read it back: hi.');
    // Adjacent prose retains its spaces outside the code background and punctuation stays adjacent.
    expect(session.getOutput()).toMatch(/Created \x1b\[40m\x1b\[93mb\.txt\x1b\[39m\x1b\[49m and/);
    // Two chips with one space between them stay two chips with one uncolored space between them.
    expect(visible, visible).toContain('Flags: --foo --bar first turn done');
    expect(visible, visible).toMatch(/Bold\s+BOLDCHIP here\. End ENDCHIP\./);
    expect(visible, visible).toContain('List: ONECHIP TWOCHIP end.');
    expect(visible, visible).toContain('• LISTCHIP starts here.');
    const raw = session.getOutput();
    // Bold and italic wrappers also leave adjacent spaces and punctuation outside the background.
    expect(raw).toMatch(/Bold \x1b\[1m\x1b\[40m\x1b\[93mBOLDCHIP\x1b\[39m\x1b\[49m\x1b\[22m here/);
    expect(raw).toMatch(/ENDCHIP\x1b\[39m\x1b\[49m\x1b\[22m\./);
    expect(raw).toMatch(/ONECHIP\x1b\[39m\x1b\[49m\x1b\[22m \x1b\[40m\x1b\[93mTWOCHIP/);
    expect(raw).toMatch(/Italic \x1b\[3m\x1b\[40m\x1b\[93mITALICCHIP\x1b\[39m\x1b\[49m\x1b\[23m end/);
    // The bullet supplies its own separator; do not add a second column.
    expect(raw).toMatch(/•\x1b\[39m \x1b\[40m\x1b\[93mLISTCHIP\x1b\[39m\x1b\[49m starts/);

    // The current frame collapses the known failed call, even though earlier live frames may contain its input.
    const settledFrame = visible.slice(beforeSettled);
    const summaryLines = settledFrame.split('\n');
    // Three failures: the shell probe plus the two calls Bare doesn't offer (#136 item 14).
    const summaryIndex = summaryLines.findIndex((line) => line.includes('✗') && line.includes('3 failed:'));
    expect(summaryIndex).toBeGreaterThanOrEqual(0);
    expect(summaryLines[summaryIndex + 1]?.trim() ?? '').not.toMatch(/^H/);
    expect(settledFrame).not.toContain(failureOutput);
    // The first edit appears once, not again as a repeated command line.
    expect(visible, visible).not.toContain('search_replace "');
    // Collapsed as in legacy: one row with the runtime and no output.
    expect(visible, visible).toMatch(/\S \(\d+ms\)/);
    expect(visible, visible).not.toMatch(/Runtime: \d+ms\s+hi\b/);
    expect(visible, visible).toContain('Write and read the file');
    const collapsedRow = visible.slice(
      visible.lastIndexOf('✓ Write and read the file'),
      visible.lastIndexOf('Created b.txt'),
    );
    expect(collapsedRow, visible).not.toContain(first);
    // Legacy has no output expansion: Ctrl+O replaces the draft with `/model ` and opens the model menu, and the
    // tool rows stay collapsed (use-app-keyboard-shortcuts.ts).
    session.write('output-draft');
    await waitForHarnessComposerValue(idlePath, 'output-draft', { timeoutMs: 30_000 });
    const beforeCtrlO = session.getVisibleOutput().length;
    session.write('\x0f');
    await session.waitForOutput('Select model', 30_000);
    await waitForHarnessComposerValue(idlePath, '/model ', { timeoutMs: 30_000 });
    const afterCtrlO = session.getVisibleOutput().slice(beforeCtrlO);
    expect(afterCtrlO).not.toMatch(/Runtime: \d+ms\s+hi\b/);
    expect(afterCtrlO).not.toContain(failureOutput);
    session.write('\x1b');
    await waitForHarnessComposerValue(idlePath, '', { timeoutMs: 30_000 });
    session.write('output-draft');
    await waitForHarnessComposerValue(idlePath, 'output-draft', { timeoutMs: 30_000 });
    // Legacy BackgroundTaskManager opens only with live work: with none, Ctrl+G leaves the draft alone.
    const beforeCtrlG = session.getVisibleOutput().length;
    session.write('\x07');
    // Ctrl+G must reach the TUI as its own read. Written back to back with `-after`, the two arrive as one chunk
    // that the editor takes as text (a probe left the draft as "draft\u0007-x"), so `-after` cannot be the sync
    // point, and nothing is published for a key that does nothing.
    // sleep-ok: Ctrl+G opens no task manager without live work; it is read and drawn within milliseconds, so
    // 500 ms also keeps it out of the next key's read under load.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(session.getVisibleOutput().slice(beforeCtrlG)).not.toContain('Manage background tasks');
    session.write('-after');
    await waitForHarnessComposerValue(idlePath, 'output-draft-after', { timeoutMs: 30_000 });
    session.write('\x03');
    await waitForHarnessComposerValue(idlePath, '', { timeoutMs: 30_000 });
    // That Ctrl+C was handled by now, so its exit window ends within EXIT_CONFIRM_WINDOW_MS of this moment.
    const exitWindowEnds = Date.now() + EXIT_CONFIRM_WINDOW_MS + 50;

    const receipt = JSON.parse(
      await control(['submit', 'coord', '--id', 'control-test', '--json'], env, workspace, 'a control message'),
    );
    expect(receipt.delivery).toBe('started');
    expect(receipt.messageId).toBeTruthy();
    await session.waitForOutput('control reply sentinel', 60_000);
    expect(providerRequests.some((body) => body.includes('a control message'))).toBe(true);
    // sleep-ok: the draft-clearing Ctrl+C's exit window has to lapse, and nothing publishes its end; only the
    // remainder after the control turn is slept, 50 ms past the 1 s window.
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, exitWindowEnds - Date.now())));
    // Quit the way a user does, so the app finishes its writes before the test removes its directories.
    session.write('\x03');
    await session.waitForOutput('Press Ctrl+C again to exit', 30_000);
    session.write('\x03');
    expect((await session.waitForExit(30_000)).exitCode).toBe(0);
  },
);

it('collapses failed shell probes, and Ctrl+O opens the model menu as in legacy', { timeout: TIMEOUT_MS }, async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-failed-probes-')));
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(home);
  fs.mkdirSync(workspace);
  fs.mkdirSync(path.join(root, 'runtime'), { mode: 0o700 });
  const baseUrl = await startProvider([
    {
      call: {
        id: 'fail1',
        args: { command: "printf 'fatal: probe-one\\n' >&2; exit 128", description: 'First probe' },
      },
    },
    {
      call: {
        id: 'fail2',
        args: { command: "printf 'error: probe-two\\n' >&2; exit 127", description: 'Second probe' },
      },
    },
    { text: 'PROBES-FINISHED' },
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
      shell: { autoApproveMode: 'always' },
    }),
  );
  session = spawnTerminal('node', [builtCli], { cwd: workspace, env, cols: 160, rows: 50 });
  await waitForHarnessIdleGeneration(idlePath, { timeoutMs: 60_000 });
  session.write('run probes');
  await waitForHarnessComposerValue(idlePath, 'run probes', { timeoutMs: 60_000 });
  session.write('\r');
  await session.waitForOutput('PROBES-FINISHED', 60_000);
  await session.waitForOutput('✗ Ran 2 shell commands', 30_000);
  // Legacy's Ctrl+O opens the model menu; the failed run stays one collapsed row.
  const beforeCtrlO = session.getVisibleOutput().length;
  session.write('\x0f');
  await session.waitForOutput('Select model', 30_000);
  const afterCtrlO = session.getVisibleOutput().slice(beforeCtrlO);
  expect(afterCtrlO).not.toContain('fatal: probe-one');
  expect(afterCtrlO).not.toContain('error: probe-two');
});

it.each([undefined, 'concise', 'standard'] as const)(
  'reasoning follows display mode %s and an idle mode change in the built terminal',
  { timeout: TIMEOUT_MS },
  async (initialMode) => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-reasoning-display-')));
    const home = path.join(root, 'home');
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(home);
    fs.mkdirSync(workspace);
    fs.mkdirSync(path.join(root, 'runtime'), { mode: 0o700 });
    const baseUrl = await startProvider([
      { reasoning: 'REASONING_FIRST_SENTINEL', text: 'ANSWER_FIRST_SENTINEL' },
      { reasoning: 'REASONING_SECOND_SENTINEL', text: 'ANSWER_SECOND_SENTINEL' },
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
      CI: 'false',
    };
    const settingsDir = resolveSettingsDirectory({ homeDir: home, env: createTestChildEnv(env) });
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(
      path.join(settingsDir, 'settings.json'),
      JSON.stringify({
        agent: { retryAttempts: 0, modelSelection: { model: 'mock-alpha', provider: 'mockprov' } },
        providers: [{ name: 'mockprov', type: 'openai-compatible', baseUrl, apiKey: 'test-key' }],
        ...(initialMode ? { ui: { displayMode: initialMode } } : {}),
      }),
    );
    session = spawnTerminal('node', [builtCli], { cwd: workspace, env, cols: 100, rows: 32 });
    await waitForHarnessIdleGeneration(idlePath, { timeoutMs: 60_000 });
    const submit = async (text: string) => {
      session!.write(text);
      await waitForHarnessComposerValue(idlePath, text, { timeoutMs: 30_000 });
      session!.write('\r');
      await waitForHarnessComposerValue(idlePath, '', { timeoutMs: 30_000 });
    };
    const turn = async (label: 'FIRST' | 'SECOND', shown: boolean) => {
      const offset = session!.getVisibleOutput().length;
      const idle = readHarnessIdleGeneration(idlePath);
      await submit(`answer ${label.toLowerCase()}`);
      // No answer is sent yet. A measured rate proves the client consumed the two reasoning deltas.
      await vi.waitFor(() => expect(session!.getVisibleOutput().slice(offset)).toContain('tok/s'), {
        timeout: 30_000,
      });
      const reasoning = `REASONING_${label}_SENTINEL`;
      if (shown) {
        await session!.waitForOutput(reasoning, 30_000);
        await session!.waitForOutput('with more streamed detail', 30_000);
      } else {
        expect(session!.getVisibleOutput().slice(offset)).not.toContain(reasoning);
        expect(session!.getVisibleOutput().slice(offset)).not.toContain('with more streamed detail');
      }
      expect(finishReasoning).toBeTypeOf('function');
      finishReasoning!();
      finishReasoning = undefined;
      await session!.waitForOutput(`ANSWER_${label}_SENTINEL`, 30_000);
      await waitForHarnessIdleGeneration(idlePath, { after: idle, timeoutMs: 30_000 });
      const output = session!.getVisibleOutput().slice(offset);
      if (!shown) expect(output).not.toContain(reasoning);
      expect(output.slice(output.lastIndexOf(`ANSWER_${label}_SENTINEL`))).not.toContain(reasoning);
    };
    await turn('FIRST', initialMode === 'standard');
    const nextMode = initialMode === 'standard' ? 'concise' : 'standard';
    // Use the actual settings menu: select the key, enter its value, then dismiss the list.
    session.write('/settings ');
    await waitForHarnessComposerValue(idlePath, '/settings ', { timeoutMs: 30_000 });
    await session.waitForOutput('type search', 30_000);
    session.write('ui.displayMode');
    await waitForHarnessComposerValue(idlePath, '/settings ui.displayMode', { timeoutMs: 30_000 });
    session.write('\r');
    await waitForHarnessComposerValue(idlePath, '/settings ui.displayMode ', { timeoutMs: 30_000 });
    session.write(nextMode);
    await waitForHarnessComposerValue(idlePath, `/settings ui.displayMode ${nextMode}`, { timeoutMs: 30_000 });
    session.write('\r');
    await waitForHarnessComposerValue(idlePath, '/settings ui.displayMode', { timeoutMs: 30_000 });
    session.write('\x1b');
    await waitForHarnessComposerValue(idlePath, '', { timeoutMs: 30_000 });
    await turn('SECOND', nextMode === 'standard');
    expect(providerRequests).toHaveLength(2);
    session.write('\x03');
    await session.waitForOutput('Press Ctrl+C again to exit', 30_000);
    session.write('\x03');
    expect((await session.waitForExit(30_000)).exitCode).toBe(0);
  },
);
