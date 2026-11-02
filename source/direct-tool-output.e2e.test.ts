import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
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

afterEach(async () => {
  session?.dispose();
  session = null;
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = '';
});

type Reply = { call?: { id: string; command?: string; tool?: string; args?: object }; text?: string };

/** One SSE reply per chat request, in order: a single shell call or plain text. */
async function startProvider(replies: Reply[]): Promise<string> {
  let requests = 0;
  server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-alpha' }] }));
      return;
    }
    req.resume();
    req.on('end', () => {
      const reply = replies[requests++] ?? { text: 'done' };
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
      res.end([...frames.map((frame) => `data: ${JSON.stringify(frame)}\n`), 'data: [DONE]', ''].join('\n'));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/v1`;
}

// Shell output is rendered once; the raw tool-result message array is not printed.
it(
  'the direct terminal UI shows shell output once, with no raw tool-result JSON, and inline code without extra spaces',
  { timeout: TIMEOUT_MS },
  async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-tool-rows-e2e-')));
    const home = path.join(root, 'home');
    const workspace = path.join(root, 'w');
    fs.mkdirSync(home);
    fs.mkdirSync(workspace);
    const first = `echo hi > ${path.join(workspace, 'b.txt')} && cat ${path.join(workspace, 'b.txt')}`;
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
      { call: { id: 'call_0', command: first } },
      { text: 'Created `b.txt` and read it back: `hi`. first turn done' },
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

    session = spawnTerminal('node', [builtCli], { cwd: workspace, env });
    let idle = await waitForHarnessIdleGeneration(idlePath, { timeoutMs: 60_000 });

    // Submit only once the composer holds the text; Enter in the same write is taken as pasted input.
    const submit = async (text: string) => {
      session!.write(text);
      await waitForHarnessComposerValue(idlePath, text, { timeoutMs: 60_000 });
      session!.write('\r');
    };

    await submit('tidy the workspace');
    await session.waitForOutput('first turn done', 60_000);
    idle = await waitForHarnessIdleGeneration(idlePath, { after: idle, timeoutMs: 60_000 });

    const visible = session.getVisibleOutput();
    // The bar under the composer names the profile, model and approval mode (this run is YOLO).
    expect(visible, visible).toMatch(/Bare[^\n]*mockprov\/mock-alpha[^\n]*YOLO/);
    expect(visible, visible).not.toContain('isApprovalRejection');
    expect(visible, visible).toContain('Created b.txt and read it back: hi.');
    // Inline code is a chip: padded on the background where a space stood, none before the full stop.
    expect(session.getOutput()).toMatch(/m b\.txt \x1b\[/);
    // The edit and the new content stay visible: the header only names the file.
    expect(visible, visible).toContain('+ beta-line');
    expect(visible, visible).toContain('- alpha-line');
    expect(visible, visible).toContain('+ gamma-line');
    // The first edit appears once, not again as a repeated command line.
    expect(visible, visible).not.toContain('search_replace "');
    // Collapsed by default: one row with the runtime, and no output until expanded with Ctrl+O.
    expect(visible, visible).toMatch(/\S \(\d+ms\)/);
    expect(visible, visible).not.toMatch(/Runtime: \d+ms\s+hi\b/);
    // A failed command is not collapsed: its exit status stays visible without expanding.
    expect(visible, visible).toContain('exit 3');
    session.write('\x0f');
    for (let i = 0; i < 40 && !/Runtime: \d+ms\s+hi\b/.test(session.getVisibleOutput()); i++)
      await new Promise((resolve) => setTimeout(resolve, 250));
    expect(session.getVisibleOutput()).toMatch(/Runtime: \d+ms\s+hi\b/);
    // Quit the way a user does, so the app finishes its writes before the test removes its directories.
    session.write('\x03');
    await session.waitForOutput('Press Ctrl+C again to exit', 30_000);
    session.write('\x03');
    expect((await session.waitForExit(30_000)).exitCode).toBe(0);
  },
);
