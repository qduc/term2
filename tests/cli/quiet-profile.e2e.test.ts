import { afterEach, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestChildEnv, testCliPath } from '../helpers/terminal-e2e.js';
import { resolveSettingsDirectory } from '../../src/config/settings/settings-path.js';

// Built direct CLI. `--quiet` is documented to suppress non-error diagnostics.
// Routine profile labels are absent even without --quiet; real errors remain visible.
const cli = testCliPath(fileURLToPath(new URL('../../dist/src/app/cli.js', import.meta.url)));

let root = '';
let server: http.Server | null = null;

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
  if (root) fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  root = '';
});

async function startProvider(status: number, text: string): Promise<string> {
  server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-alpha' }] }));
      return;
    }
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      if (status !== 200) {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: text } }));
        return;
      }
      const frame = {
        id: 'chatcmpl-quiet',
        choices: [{ delta: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/v1`;
}

function prepare(baseUrl: string): { env: NodeJS.ProcessEnv; workspace: string } {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'term2-quiet-profile-')));
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'w');
  fs.mkdirSync(workspace);
  const env = {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    TERM2_CONVERSATIONS_DIR: path.join(root, 'conversations'),
    DISABLE_LOGGING: '1',
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
  return { env: createTestChildEnv(env), workspace };
}

function run(
  args: string[],
  env: NodeJS.ProcessEnv,
  workspace: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [cli, '-p', 'mockprov', '-m', 'mock-alpha', ...args], {
      cwd: workspace,
      env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

it('omits routine profile lines with and without --quiet, preserving JSON metadata', { timeout: 120_000 }, async () => {
  const baseUrl = await startProvider(200, 'PONG');
  const { env, workspace } = prepare(baseUrl);
  const quiet = await run(['--json', '-q', 'Reply with the single word PONG.'], env, workspace);
  expect(quiet.code).toBe(0);
  expect(quiet.stderr).not.toMatch(/Profile:/);
  expect(quiet.stdout).toContain('"type":"completed"');
  expect(quiet.stdout).toContain('PONG');

  const announced = await run(['--json', 'Reply with the single word PONG.'], env, workspace);
  expect(announced.code).toBe(0);
  expect(announced.stderr).not.toMatch(/Profile:/);
  expect(announced.stdout).toContain('"type":"completed"');
});

it('omits an MCP config notice under --quiet and still prints it otherwise', { timeout: 120_000 }, async () => {
  const baseUrl = await startProvider(200, 'PONG');
  const { env, workspace } = prepare(baseUrl);
  const settingsDir = resolveSettingsDirectory({ homeDir: path.join(root, 'home'), env });
  fs.writeFileSync(path.join(settingsDir, 'mcp.json'), '{');

  const quiet = await run(['--json', '-q', 'Reply with the single word PONG.'], env, workspace);
  expect(quiet.code).toBe(0);
  expect(quiet.stderr).not.toMatch(/^MCP: /m);
  expect(quiet.stderr).not.toMatch(/Profile:/);
  expect(quiet.stdout).toContain('"type":"completed"');

  const announced = await run(['--json', 'Reply with the single word PONG.'], env, workspace);
  expect(announced.code).toBe(0);
  expect(announced.stderr).toMatch(/^MCP: /m);
  expect(announced.stderr).toContain('is not valid JSON');
  expect(announced.stderr).not.toMatch(/Profile:/);
});

it('keeps the fork line under --quiet', { timeout: 120_000 }, async () => {
  const baseUrl = await startProvider(200, 'PONG');
  const { env, workspace } = prepare(baseUrl);
  const created = await run(['--json', '-q', 'Reply with the single word PONG.'], env, workspace);
  expect(created.code).toBe(0);
  const id = fs
    .readdirSync(env.TERM2_CONVERSATIONS_DIR!)
    .find((name) => name.endsWith('.jsonl'))
    ?.slice(0, -'.jsonl'.length);
  expect(id).toBeTruthy();

  const forked = await run(
    ['--json', '-q', '--resume', id!, '--fork', 'Reply with the single word PONG.'],
    env,
    workspace,
  );
  expect(forked.code).toBe(0);
  // The store names files conv_<uuid>; the CLI prints legacy's bare UUID.
  expect(forked.stderr).toContain(`Forked conversation ${id!.replace(/^conv_/, '')} →`);
  expect(forked.stderr).not.toMatch(/Profile:/);
  expect(forked.stdout).toContain('"type":"completed"');
});

it('still prints a plain-mode error under --quiet', { timeout: 120_000 }, async () => {
  const baseUrl = await startProvider(500, 'quiet-boom');
  const { env, workspace } = prepare(baseUrl);
  const failed = await run(['-q', 'Reply with the single word PONG.'], env, workspace);
  expect(failed.code).not.toBe(0);
  expect(failed.stderr).toMatch(/^error /m);
  expect(failed.stderr).not.toMatch(/Profile:/);
  expect(failed.stderr).toContain('quiet-boom');
});

for (const flags of [
  [],
  ['--profile', 'bare'],
  ['--profile', 'standard'],
  ['--profile', 'full'],
  ['--profile', 'lite'],
  ['--lite'],
  ['-l'],
]) {
  it(
    `keeps hidden CLI compatibility and metadata for ${flags.join(' ') || 'default'}`,
    { timeout: 120_000 },
    async () => {
      const { env, workspace } = prepare(await startProvider(200, 'PONG'));
      const settingsFile = path.join(
        resolveSettingsDirectory({ homeDir: path.join(root, 'home'), env }),
        'settings.json',
      );
      const before = fs.readFileSync(settingsFile, 'utf8');
      const result = await run([...flags, '--json', 'Reply PONG'], env, workspace);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).not.toMatch(/Profile:/);
      const events = result.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(events[0]).toMatchObject({
        type: 'session_start',
        activeProfileId: 'builtin:bare',
        activeProfileVersion: '3.0.0',
      });
      expect(events[0].activeProfileDigest).toMatch(/^[a-f0-9]{64}$/);
      const file = fs.readdirSync(env.TERM2_CONVERSATIONS_DIR!).find((name) => name.endsWith('.jsonl'))!;
      const rows = fs
        .readFileSync(path.join(env.TERM2_CONVERSATIONS_DIR!, file), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(rows[0].fact.profile).toMatchObject({
        id: 'builtin:bare',
        version: '3.0.0',
        digest: events[0].activeProfileDigest,
      });
      expect(fs.readFileSync(settingsFile, 'utf8')).toBe(before);
    },
  );
}

it('hides compatibility flags from help and keeps dropped selections invalid', { timeout: 120_000 }, async () => {
  const { env, workspace } = prepare(await startProvider(200, 'PONG'));
  const help = await run(['--help'], env, workspace);
  expect(help.code).toBe(0);
  expect(help.stdout).not.toMatch(/--profile|--lite|profile chooser|non-lite/);
  const refused = await run([], env, workspace);
  expect(refused.code).not.toBe(0);
  expect(refused.stderr).toContain('interactive terminal');
  expect(refused.stderr).not.toMatch(/Profile:/);
  for (const name of ['plan', 'pair', 'mentor', 'orchestrator', 'unknown']) {
    const result = await run(['--profile', name, 'Reply'], env, workspace);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('Profile');
    expect(result.stderr).not.toMatch(/Profile:/);
  }
});
