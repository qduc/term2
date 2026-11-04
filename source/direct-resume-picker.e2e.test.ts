import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  dismissUnlistedSlashMenu,
  testCliPath,
  spawnTerminal,
  createTestChildEnv,
  type TerminalSession,
} from './test-helpers/terminal-e2e.js';
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
let requestBodies: any[] = [];

afterEach(async () => {
  session?.dispose();
  session = null;
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
  if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  root = '';
  requestBodies = [];
});

type Reply = { text?: string; hang?: boolean; partialTool?: boolean };

/** One SSE reply per chat request, in order: a single shell call or plain text. */
async function startProvider(replies: Reply[]): Promise<string> {
  let requests = 0;
  server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-alpha' }, { id: 'mock-beta' }] }));
      return;
    }
    let requestBody = '';
    req.on('data', (chunk) => {
      requestBody += chunk;
    });
    req.on('end', () => {
      requestBodies.push(JSON.parse(requestBody));
      const reply = replies[requests++] ?? { text: 'done' };
      const id = `chatcmpl-${requests}`;
      const frames: object[] = [{ id, choices: [{ delta: { role: 'assistant', content: reply.text } }] }];
      // Tool-call output already seen: a steer waits for the normal boundary instead of interrupting the stream.
      if (reply.partialTool) {
        const call = {
          index: 0,
          id: 'call_p',
          type: 'function',
          function: { name: 'shell', arguments: '{"command":"sl' },
        };
        frames.push({ id, choices: [{ delta: { tool_calls: [call] } }] });
      }
      if (!reply.hang) frames.push({ id, choices: [{ delta: {}, finish_reason: 'stop' }] });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const body = frames.map((frame) => `data: ${JSON.stringify(frame)}\n`).join('\n');
      // A hanging reply streams its text and then never finishes, like a long answer being cut short.
      if (reply.hang) res.write(`${body}\n`);
      else res.end(`${body}\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/v1`;
}

it.each([160, 60])(
  'opens a resume picker with a preview and switches to the selected session at %i columns',
  { timeout: TIMEOUT_MS },
  async (columns) => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-resume-picker-')));
    const home = path.join(root, 'home');
    const workspace = path.join(root, 'w');
    fs.mkdirSync(home);
    fs.mkdirSync(workspace);
    const baseUrl = await startProvider([{ text: 'PREVIOUS-ANSWER' }]);
    const idlePath = path.join(home, 'idle');
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
      }),
    );
    const start = () => spawnTerminal('node', [builtCli], { cwd: workspace, env, cols: columns, rows: 40 });
    const send = async (text: string) => {
      session!.write(text);
      await waitForHarnessComposerValue(idlePath, text, { timeoutMs: 60_000 });
      // `/model ` opens legacy's model menu: Enter picks the highlighted row, so wait until the catalog lists it.
      const picked = /^\/model \S+\/(\S+)$/.exec(text)?.[1];
      if (picked)
        await expect
          .poll(() => session!.getVisibleOutput(), { timeout: 30_000 })
          .toMatch(new RegExp(`❯\\s+(★\\s+)?${picked}|No models match`));
      // Every provider's catalog lands in turn; let the list settle as a person reading it would.
      if (picked) await new Promise((resolve) => setTimeout(resolve, 500));
      await dismissUnlistedSlashMenu(session!, text);
      session!.write('\r');
    };
    session = start();
    const idle = await waitForHarnessIdleGeneration(idlePath, { timeoutMs: 60_000 });
    await send('previous unique prompt');
    await session.waitForOutput('PREVIOUS-ANSWER', 30_000);
    await waitForHarnessIdleGeneration(idlePath, { after: idle, timeoutMs: 60_000 });
    session.write('\x03');
    await session.waitForOutput('Press Ctrl+C again to exit', 30_000);
    session.write('\x03');
    await session.waitForExit(30_000);
    fs.rmSync(idlePath, { force: true });
    session = start();
    await waitForHarnessIdleGeneration(idlePath, { timeoutMs: 60_000 });
    // Legacy's resume menu opens on the typed trigger; the active (empty) session is not listed.
    session.write('/resume ');
    await waitForHarnessComposerValue(idlePath, '/resume ', { timeoutMs: 60_000 });
    await session.waitForOutput('Resume Conversation', 30_000);
    await session.waitForOutput('Initial Prompt:', 30_000);
    const frame = session.getVisibleOutput().slice(session.getVisibleOutput().lastIndexOf('▌ term²'));
    expect(frame).toMatch(/❯ previous unique/);
    // Legacy shows the bare UUID (the head only: a narrow detail column wraps the rest).
    expect(frame).toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/);
    expect(frame).not.toContain('conv_');
    expect(frame).toContain('Updated:');
    expect(frame).toContain('↑↓ navigate │ ⏎ resume │ Esc cancel');
    if (columns > 100) {
      expect(frame).toMatch(/previous unique prompt · \d+ seconds ago · 2 msgs/);
      expect(frame).toContain('Local • 2 msgs • mock-alpha • mode: bare');
      expect(frame).toContain('"previous unique prompt"');
    }
    const offset = session.getVisibleOutput().length;
    session.write('\r');
    const started = Date.now();
    while (Date.now() - started < 30_000 && !session.getVisibleOutput().slice(offset).includes('PREVIOUS-ANSWER'))
      await new Promise((resolve) => setTimeout(resolve, 25));
    expect(session.getVisibleOutput().slice(offset)).toContain('PREVIOUS-ANSWER');
  },
);

it.each([160])(
  'restores a synthetic saved Codex configuration at %i columns',
  { timeout: TIMEOUT_MS },
  async (columns) => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-resume-picker-')));
    const home = path.join(root, 'home');
    const workspace = path.join(root, 'w');
    fs.mkdirSync(home);
    fs.mkdirSync(workspace);
    const baseUrl = await startProvider([{ text: 'PREVIOUS-ANSWER' }]);
    const idlePath = path.join(home, 'idle');
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
      }),
    );
    const start = () => spawnTerminal('node', [builtCli], { cwd: workspace, env, cols: columns, rows: 40 });
    const send = async (text: string) => {
      session!.write(text);
      await waitForHarnessComposerValue(idlePath, text, { timeoutMs: 60_000 });
      // `/model ` opens legacy's model menu: Enter picks the highlighted row, so wait until the catalog lists it.
      const picked = /^\/model \S+\/(\S+)$/.exec(text)?.[1];
      if (picked)
        await expect
          .poll(() => session!.getVisibleOutput(), { timeout: 30_000 })
          .toMatch(new RegExp(`❯\\s+(★\\s+)?${picked}|No models match`));
      // Every provider's catalog lands in turn; let the list settle as a person reading it would.
      if (picked) await new Promise((resolve) => setTimeout(resolve, 500));
      await dismissUnlistedSlashMenu(session!, text);
      session!.write('\r');
    };
    session = start();
    const idle = await waitForHarnessIdleGeneration(idlePath, { timeoutMs: 60_000 });
    await send('/model mockprov/mock-beta');
    await session.waitForOutput('Set model to mock-beta (mockprov)', 30_000);
    await send('previous unique prompt');
    await session.waitForOutput('PREVIOUS-ANSWER', 30_000);
    await waitForHarnessIdleGeneration(idlePath, { after: idle, timeoutMs: 60_000 });
    session.write('\x03');
    await session.waitForOutput('Press Ctrl+C again to exit', 30_000);
    session.write('\x03');
    await session.waitForExit(30_000);
    const logs = fs.readdirSync(path.join(root, 'conversations')).filter((file) => file.endsWith('.jsonl'));
    const file = path.join(root, 'conversations', logs[0]!);
    const lines = fs
      .readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const changed = lines.find((line) => line.fact?.type === 'configuration_changed');
    changed.fact.configuration.model = { provider: 'codex', model: 'gpt-6.1-terra' };
    changed.fact.configuration.reasoning = 'low';
    changed.fact.intent.modelSelection = { provider: 'codex', model: 'gpt-6.1-terra' };
    fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
    fs.rmSync(idlePath, { force: true });
    session = start();
    await waitForHarnessIdleGeneration(idlePath, { timeoutMs: 60_000 });
    // Legacy's resume menu opens on the typed trigger; the active (empty) session is not listed.
    session!.write('/resume ');
    await waitForHarnessComposerValue(idlePath, '/resume ', { timeoutMs: 60_000 });
    await session!.waitForOutput('Initial Prompt:', 30_000);
    const frame = session.getVisibleOutput().slice(session.getVisibleOutput().lastIndexOf('▌ term²'));
    expect(frame).toMatch(/previous unique prompt · \d+ seconds ago · 2 msgs/);
    // Legacy shows the bare UUID (the head only: a narrow detail column wraps the rest).
    expect(frame).toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/);
    expect(frame).not.toContain('conv_');
    expect(frame).toContain('Local • 2 msgs • gpt-6.1-terra • mode: bare');
    expect(frame).toContain('Updated:');
    const offset = session.getVisibleOutput().length;
    session.write('\r');
    const started = Date.now();
    while (Date.now() - started < 30_000 && !session.getVisibleOutput().slice(offset).includes('PREVIOUS-ANSWER'))
      await new Promise((resolve) => setTimeout(resolve, 25));
    expect(session.getVisibleOutput().slice(offset)).toContain('PREVIOUS-ANSWER');
    expect(session.getVisibleOutput().slice(offset)).toContain('codex/gpt-6.1-terra');
  },
);

it.each([160])(
  'preserves resumed request through rollover and later model change at %i columns',
  { timeout: TIMEOUT_MS },
  async (columns) => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-resume-picker-')));
    const home = path.join(root, 'home');
    const workspace = path.join(root, 'w');
    fs.mkdirSync(home);
    fs.mkdirSync(workspace);
    const baseUrl = await startProvider([{ text: 'PREVIOUS-ANSWER' }]);
    const idlePath = path.join(home, 'idle');
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
      }),
    );
    const start = () => spawnTerminal('node', [builtCli], { cwd: workspace, env, cols: columns, rows: 40 });
    const send = async (text: string) => {
      session!.write(text);
      await waitForHarnessComposerValue(idlePath, text, { timeoutMs: 60_000 });
      // `/model ` opens legacy's model menu: Enter picks the highlighted row, so wait until the catalog lists it.
      const picked = /^\/model \S+\/(\S+)$/.exec(text)?.[1];
      if (picked)
        await expect
          .poll(() => session!.getVisibleOutput(), { timeout: 30_000 })
          .toMatch(new RegExp(`❯\\s+(★\\s+)?${picked}|No models match`));
      // Every provider's catalog lands in turn; let the list settle as a person reading it would.
      if (picked) await new Promise((resolve) => setTimeout(resolve, 500));
      await dismissUnlistedSlashMenu(session!, text);
      session!.write('\r');
    };
    session = start();
    const idle = await waitForHarnessIdleGeneration(idlePath, { timeoutMs: 60_000 });
    await send('/model mockprov/mock-beta');
    await session.waitForOutput('Set model to mock-beta (mockprov)', 30_000);
    await send('previous unique prompt');
    await session.waitForOutput('PREVIOUS-ANSWER', 30_000);
    await waitForHarnessIdleGeneration(idlePath, { after: idle, timeoutMs: 60_000 });
    session.write('\x03');
    await session.waitForOutput('Press Ctrl+C again to exit', 30_000);
    session.write('\x03');
    await session.waitForExit(30_000);
    const logs = fs.readdirSync(path.join(root, 'conversations')).filter((file) => file.endsWith('.jsonl'));
    const file = path.join(root, 'conversations', logs[0]!);
    const lines = fs
      .readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const changed = lines.find((line) => line.fact?.type === 'configuration_changed');
    delete changed.fact.configuration.temperature;
    changed.fact.configuration.reasoning = 'low';
    delete changed.fact.intent.temperature;
    fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
    const settingsFile = path.join(settingsDir, 'settings.json');
    const localSettings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    localSettings.agent.temperature = 0.7;
    fs.writeFileSync(settingsFile, JSON.stringify(localSettings));
    fs.rmSync(idlePath, { force: true });
    session = start();
    await waitForHarnessIdleGeneration(idlePath, { timeoutMs: 60_000 });
    // Legacy's resume menu opens on the typed trigger; the active (empty) session is not listed.
    session!.write('/resume ');
    await waitForHarnessComposerValue(idlePath, '/resume ', { timeoutMs: 60_000 });
    await session!.waitForOutput('Initial Prompt:', 30_000);
    const frame = session.getVisibleOutput().slice(session.getVisibleOutput().lastIndexOf('▌ term²'));
    expect(frame).toMatch(/previous unique prompt · \d+ seconds ago · 2 msgs/);
    // Legacy shows the bare UUID (the head only: a narrow detail column wraps the rest).
    expect(frame).toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/);
    expect(frame).not.toContain('conv_');
    expect(frame).toContain('Local • 2 msgs • mock-beta • mode: bare');
    expect(frame).toContain('Updated:');
    const offset = session.getVisibleOutput().length;
    session.write('\r');
    const started = Date.now();
    while (Date.now() - started < 30_000 && !session.getVisibleOutput().slice(offset).includes('PREVIOUS-ANSWER'))
      await new Promise((resolve) => setTimeout(resolve, 25));
    expect(session.getVisibleOutput().slice(offset)).toContain('PREVIOUS-ANSWER');
    expect(session.getVisibleOutput().slice(offset)).toContain('mockprov/mock-beta');
    let generation = await waitForHarnessIdleGeneration(idlePath, { timeoutMs: 60_000 });
    await send('resumed request');
    await session.waitForOutput('done', 30_000);
    generation = await waitForHarnessIdleGeneration(idlePath, { after: generation, timeoutMs: 60_000 });
    expect(requestBodies.at(-1)).toMatchObject({ model: 'mock-beta', reasoning_effort: 'low' });
    expect(requestBodies.at(-1)).not.toHaveProperty('temperature');
    await send('/model mockprov/mock-alpha');
    await session.waitForOutput('Set model to mock-alpha (mockprov)', 30_000);
    const priorRequests = requestBodies.length;
    await send('after model change');
    const deadline = Date.now() + 30_000;
    while (requestBodies.length === priorRequests && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 25));
    expect(requestBodies.length).toBeGreaterThan(priorRequests);
    await waitForHarnessIdleGeneration(idlePath, { after: generation, timeoutMs: 60_000 });
    expect(requestBodies.at(-1).model).toBe('mock-alpha');
  },
);

it.each([160])('a failed resume leaves the composer usable at %i columns', { timeout: TIMEOUT_MS }, async (columns) => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-resume-picker-')));
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'w');
  fs.mkdirSync(home);
  fs.mkdirSync(workspace);
  const baseUrl = await startProvider([{ text: 'PREVIOUS-ANSWER' }]);
  const idlePath = path.join(home, 'idle');
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
    }),
  );
  const start = () => spawnTerminal('node', [builtCli], { cwd: workspace, env, cols: columns, rows: 40 });
  const send = async (text: string) => {
    session!.write(text);
    await waitForHarnessComposerValue(idlePath, text, { timeoutMs: 60_000 });
    // `/model ` opens legacy's model menu: Enter picks the highlighted row, so wait until the catalog lists it.
    const picked = /^\/model \S+\/(\S+)$/.exec(text)?.[1];
    if (picked)
      await expect
        .poll(() => session!.getVisibleOutput(), { timeout: 30_000 })
        .toMatch(new RegExp(`❯\\s+(★\\s+)?${picked}|No models match`));
    // Every provider's catalog lands in turn; let the list settle as a person reading it would.
    if (picked) await new Promise((resolve) => setTimeout(resolve, 500));
    await dismissUnlistedSlashMenu(session!, text);
    session!.write('\r');
  };
  session = start();
  const idle = await waitForHarnessIdleGeneration(idlePath, { timeoutMs: 60_000 });
  await send('/model mockprov/mock-beta');
  await session.waitForOutput('Set model to mock-beta (mockprov)', 30_000);
  await send('previous unique prompt');
  await session.waitForOutput('PREVIOUS-ANSWER', 30_000);
  await waitForHarnessIdleGeneration(idlePath, { after: idle, timeoutMs: 60_000 });
  session.write('\x03');
  await session.waitForOutput('Press Ctrl+C again to exit', 30_000);
  session.write('\x03');
  await session.waitForExit(30_000);
  const logs = fs.readdirSync(path.join(root, 'conversations')).filter((file) => file.endsWith('.jsonl'));
  const file = path.join(root, 'conversations', logs[0]!);
  const lines = fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const changed = lines.find((line) => line.fact?.type === 'configuration_changed');
  changed.fact.configuration.model = { provider: 'codex', model: 'gpt-6.1-terra' };
  changed.fact.configuration.reasoning = 'low';
  changed.fact.profile.digest = 'wrong-digest';
  changed.fact.intent.modelSelection = { provider: 'codex', model: 'gpt-6.1-terra' };
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  fs.rmSync(idlePath, { force: true });
  session = start();
  await waitForHarnessIdleGeneration(idlePath, { timeoutMs: 60_000 });
  // Legacy's resume menu opens on the typed trigger; the active (empty) session is not listed.
  session!.write('/resume ');
  await waitForHarnessComposerValue(idlePath, '/resume ', { timeoutMs: 60_000 });
  await session!.waitForOutput('Initial Prompt:', 30_000);
  const frame = session.getVisibleOutput().slice(session.getVisibleOutput().lastIndexOf('▌ term²'));
  expect(frame).toMatch(/previous unique prompt · \d+ seconds ago · 2 msgs/);
  // Legacy shows the bare UUID (the head only: a narrow detail column wraps the rest).
  expect(frame).toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/);
  expect(frame).not.toContain('conv_');
  expect(frame).toContain('Local • 2 msgs • gpt-6.1-terra • mode: bare');
  expect(frame).toContain('Updated:');
  const offset = session.getVisibleOutput().length;
  session.write('\r');
  await session.waitForOutput('direct runtime did not restore the stored profile/reasoning', 30_000);
  await send('/help');
  await session.waitForOutput('/retry-tool — Retry the last tool call', 30_000);
});
