import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseFixtureEnvelope, type FixtureEnvelopeV1, type WsMessageFrame } from './fixture-envelope.js';
import { plantedWebSocketSecrets, webSocketSelfValidationScenarios } from './fixture-self-validation.js';
import { startProbeWebSocketResponder, type ProbeWebSocketResponder } from './probe-websocket-responder.js';
import { getProbeScenario } from './probe-scenarios.js';
import {
  RecordingLeakError,
  addCodexTokenLiterals,
  addLiteral,
  writeScannedRecording,
  type SensitiveLiteral,
} from './recording-secret-scan.js';
import { replayWebSocketProbeRecording } from './websocket-probe-replay.js';

// The WebSocket capture adapter and the credentialed (Codex / OpenAI-over-WebSocket) recording path of
// `scripts/provider-record.ts`, run as child processes against loopback servers with fake credentials: the
// `--from-fake websocket` self-validation, the live Codex path with a fake login, the secret scan failing on
// a leak, and the replay of a recording through the registry model. No real credential or network.

const recorderPath = fileURLToPath(new URL('../provider-record.ts', import.meta.url));
const repoRoot = resolve(dirname(recorderPath), '..');
const probe = getProbeScenario('tool-continuation-v2');

type RecorderResult = { status: number | null; stdout: string; stderr: string };

const credentialVars = [
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'CODEX_BASE_URL',
  'CODEX_HOME',
  'CHATGPT_LOCAL_HOME',
  'TERM2_CONFIG_DIR',
  'TERM2_RECORDING_DIR',
];

function runRecorder(args: string[], env: Record<string, string> = {}): Promise<RecorderResult> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' };
  for (const name of credentialVars) delete childEnv[name];
  Object.assign(childEnv, env);
  return new Promise((resolvePromise, reject) => {
    const child = spawn('pnpm', ['exec', 'tsx', recorderPath, ...args], { cwd: repoRoot, env: childEnv });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.once('error', reject);
    child.once('close', (status) => {
      clearTimeout(timer);
      resolvePromise({ status, stdout, stderr });
    });
  });
}

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'websocket-recorder-'));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** A fake Codex login as `term2 --codex-login`'s sibling, the Codex CLI, writes it: auth.json and installation_id. */
async function fakeCodexLogin(root: string) {
  const accountId = 'acct-fake-7f3e2d1c0b';
  const accessToken = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
    exp: Math.floor(Date.now() / 1000) + 3600,
    email: 'probe.owner@example.com',
    'https://api.openai.com/auth': { chatgpt_account_id: accountId, chatgpt_user_id: 'user-fake-0a1b2c3d' },
  })}.fakesignaturevalue123`;
  const tokens = { access_token: accessToken, refresh_token: 'fake-refresh-token-abcdef', account_id: accountId };
  const codexHome = join(root, 'codex');
  const home = join(root, 'home');
  await mkdir(codexHome, { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(join(codexHome, 'auth.json'), JSON.stringify({ tokens }));
  await writeFile(join(codexHome, 'installation_id'), 'inst-fake-1234567890');
  const secrets: SensitiveLiteral[] = [];
  addCodexTokenLiterals(secrets, 'fake login', tokens);
  addLiteral(secrets, 'installation id', 'inst-fake-1234567890');
  return {
    secrets,
    env: { HOME: home, CODEX_HOME: codexHome, TERM2_CONFIG_DIR: join(root, 'config') },
  };
}

function codexArgs(out: string, extra: string[] = []) {
  return ['--yes', '--provider', 'codex', '--model', 'gpt-5.3-codex', '--probe', probe.id, '--out', out, ...extra];
}

function expectNoSecrets(text: string, secrets: readonly SensitiveLiteral[]) {
  for (const secret of secrets) expect(text.includes(secret.value), secret.label).toBe(false);
}

function sends(envelope: FixtureEnvelopeV1): any[] {
  return envelope.turns
    .flatMap((turn) => turn.frames)
    .filter((frame): frame is WsMessageFrame => frame.kind === 'ws-message' && frame.direction === 'send')
    .map((frame) => frame.data);
}

async function readRecording(result: RecorderResult, dir: string) {
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  const [file, reportFile] = result.stdout.trim().split('\n');
  for (const path of [file!, reportFile!]) {
    expect(path.startsWith(dir + sep)).toBe(true);
    expect(path.startsWith(repoRoot + sep)).toBe(false);
  }
  const raw = await readFile(file!, 'utf8');
  return { raw, report: await readFile(reportFile!, 'utf8'), envelope: parseFixtureEnvelope(raw) };
}

describe.concurrent('provider:record --from-fake websocket (WebSocket capture self-validation)', () => {
  it.each(webSocketSelfValidationScenarios)('records, scans and replays the %s scenario', (scenario) =>
    withTempDir(async (dir) => {
      const result = await runRecorder(['--from-fake', 'websocket', scenario, '--out', dir]);
      expect(result.status, result.stderr).toBe(0);
      const file = result.stdout.trim();
      expect(file).toBe(join(dir, `fixture-websocket-${scenario}.json`));
      const raw = await readFile(file, 'utf8');
      const envelope = parseFixtureEnvelope(raw);
      expect(envelope.transport).toBe('websocket');
      expect(envelope.capture.probeScenario).toBe(`fake:websocket:${scenario}`);
      const kinds = envelope.turns[0]!.frames.map((frame) => frame.kind);
      expect(kinds[0]).toBe('ws-open');
      expect(kinds.at(-1)).toBe('ws-close');
      const open = envelope.turns[0]!.frames[0]!;
      expect(open).toMatchObject({
        kind: 'ws-open',
        urlPath: '/responses',
        status: 101,
        headers: {
          authorization: '[REDACTED]',
          'chatgpt-account-id': '[REDACTED]',
          'openai-beta': 'responses_websockets=2026-02-06',
        },
      });
      expect(sends(envelope)[0]).toMatchObject({
        type: 'response.create',
        prompt_cache_key: '[REDACTED]',
        client_metadata: { 'x-codex-installation-id': '[REDACTED]', session_id: '[REDACTED]' },
      });
      // Every planted value is gone from what was written.
      for (const value of Object.values(plantedWebSocketSecrets)) expect(raw).not.toContain(value);
      const close = envelope.turns[0]!.frames.at(-1)!;
      expect(close).toMatchObject({ kind: 'ws-close', code: scenario === 'abnormal-close' ? 1006 : 1000 });
    }),
  );
});

describe('recording secret scan', () => {
  it('fails on a planted secret, deletes the file, and names what matched without printing it', () =>
    withTempDir(async (dir) => {
      const planted = 'opaque-account-value-5e6f7a8b';
      const literals: SensitiveLiteral[] = [];
      addLiteral(literals, 'planted account id', planted);
      const file = join(dir, 'leaky.json');
      const content = JSON.stringify({ turns: [{ frames: [{ data: { text: `hello ${planted}` } }] }] });
      const error = await writeScannedRecording(file, content, literals).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(RecordingLeakError);
      expect((error as RecordingLeakError).findings).toEqual([
        { label: 'planted account id', path: '$.turns[0].frames[0].data.text' },
      ]);
      expect((error as Error).message).not.toContain(planted);
      expect(existsSync(file)).toBe(false);
    }));

  it('fails on a JWT-shaped string even when it is not a known literal', () =>
    withTempDir(async (dir) => {
      const jwt = `${encode({ alg: 'HS256' })}.${encode({ sub: 'someone' })}.c2lnbmF0dXJl`;
      const file = join(dir, 'jwt.json');
      const error = await writeScannedRecording(file, JSON.stringify({ note: `token ${jwt}` }), []).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(RecordingLeakError);
      expect((error as RecordingLeakError).findings.map((finding) => finding.label)).toContain('JWT-shaped string');
      expect(existsSync(file)).toBe(false);
    }));
});

describe('provider:record --provider codex with a fake login (live path, loopback)', () => {
  async function withResponder<T>(
    options: Parameters<typeof startProbeWebSocketResponder>[0],
    run: (server: ProbeWebSocketResponder, dir: string) => Promise<T>,
  ): Promise<T> {
    const server = await startProbeWebSocketResponder(options);
    try {
      return await withTempDir((dir) => run(server, dir));
    } finally {
      await server.close();
    }
  }

  it('records the tool continuation over one WebSocket, scrubbed, and the recording replays', () =>
    withResponder({}, async (server, dir) => {
      const login = await fakeCodexLogin(dir);
      const out = join(dir, 'out');
      const result = await runRecorder(codexArgs(out), {
        ...login.env,
        CODEX_BASE_URL: `${server.baseUrl}/backend-api/codex`,
      });
      const { raw, report, envelope } = await readRecording(result, out);
      expect(result.stdout + result.stderr).not.toContain(login.secrets[0]!.value);
      expectNoSecrets(raw, login.secrets);
      expectNoSecrets(report, login.secrets);

      // Two model requests, one socket, the second chained by previous_response_id.
      expect(server.connections).toHaveLength(1);
      expect(server.connections[0]!.requests).toHaveLength(2);
      expect(server.httpRequests).toHaveLength(0);
      expect(envelope).toMatchObject({ provider: 'codex', wireFamily: 'codex-responses', transport: 'websocket' });
      expect(envelope.turns).toHaveLength(1);
      const open = envelope.turns[0]!.frames[0]!;
      expect(open).toMatchObject({
        kind: 'ws-open',
        urlPath: '/backend-api/codex/responses',
        headers: {
          authorization: '[REDACTED]',
          'chatgpt-account-id': '[REDACTED]',
          'session-id': '[REDACTED]',
          'x-codex-turn-metadata': '[REDACTED]',
          originator: 'codex_exec',
        },
      });
      const [first, second] = sends(envelope);
      expect(first.client_metadata['x-codex-installation-id']).toBe('[REDACTED]');
      expect(first.client_metadata['x-codex-turn-metadata']).toBe('[REDACTED]');
      expect(JSON.stringify(first.input)).toContain(probe.prompt);
      expect(second.previous_response_id).toBe('resp_<1>');
      expect(JSON.stringify(second.input)).toContain(probe.followUp);
      expect(JSON.stringify(second.input)).toContain('function_call_output');
      const receives = envelope.turns[0]!.frames.filter(
        (frame): frame is WsMessageFrame => frame.kind === 'ws-message' && frame.direction === 'receive',
      );
      expect(receives.find((frame) => (frame.data as any).type === 'codex.rate_limits')?.data).toEqual({
        type: 'codex.rate_limits',
        plan_type: '[REDACTED]',
        rate_limits: { primary: { used_percent: 0, window_minutes: 0, resets_in_seconds: 0 } },
      });
      expect((receives[0]!.data as any).response).toMatchObject({
        id: 'resp_<1>',
        user: '[REDACTED]',
        prompt_cache_key: '[REDACTED]',
      });
      expect(envelope.turns[0]!.frames.at(-1)).toMatchObject({ kind: 'ws-close', code: 1000 });

      // The recording replays through the registry model with the same probe.
      const replay = await replayWebSocketProbeRecording(envelope);
      expect(replay.firstEvents.some((event) => event.type === 'tool_call' || event.output)).toBe(true);
      expect(replay.secondEvents.filter((event) => event.type === 'text_delta').length).toBeGreaterThan(0);
      expect(replay.secondEvents.at(-1)).toMatchObject({ type: 'completion' });
      expect(replay.server.sessions).toHaveLength(1);
      expect(replay.server.sessions[0]!.sent).toHaveLength(2);
    }));

  it('records Codex over HTTP with --transport http, scrubbed', () =>
    withResponder({ http: true }, async (server, dir) => {
      const login = await fakeCodexLogin(dir);
      const out = join(dir, 'out');
      const result = await runRecorder(codexArgs(out, ['--transport', 'http']), {
        ...login.env,
        CODEX_BASE_URL: `${server.baseUrl}/backend-api/codex`,
      });
      const { raw, envelope } = await readRecording(result, out);
      expectNoSecrets(raw, login.secrets);
      expect(server.httpRequests).toHaveLength(2);
      expect(envelope.transport).toBe('http-sse');
      expect(envelope.turns).toHaveLength(2);
      const request = envelope.turns[0]!.frames[0]!;
      expect(request).toMatchObject({
        kind: 'http-request',
        urlPath: '/backend-api/codex/responses',
        headers: {
          authorization: '[REDACTED]',
          'chatgpt-account-id': '[REDACTED]',
          'x-codex-installation-id': '[REDACTED]',
          'user-agent': '[REDACTED]',
          originator: 'term2',
        },
      });
    }));

  it('fails clearly when there is no Codex login, and writes nothing', () =>
    withTempDir(async (dir) => {
      const home = join(dir, 'home');
      await mkdir(home);
      const out = join(dir, 'out');
      const result = await runRecorder(codexArgs(out), {
        HOME: home,
        CODEX_HOME: join(dir, 'missing-codex'),
        TERM2_CONFIG_DIR: join(dir, 'config'),
        CODEX_BASE_URL: 'http://127.0.0.1:1/backend-api/codex',
      });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('No Codex login found');
      expect(result.stderr).toContain('term2 --codex-login');
      expect(result.stdout).toBe('');
      expect(existsSync(out)).toBe(false);
    }));

  it('exits 3 and keeps nothing when the service echoes an account id the scrubber cannot recognise', () =>
    withResponder({ leak: 'account-id' }, async (server, dir) => {
      const login = await fakeCodexLogin(dir);
      const out = join(dir, 'out');
      const result = await runRecorder(codexArgs(out), {
        ...login.env,
        CODEX_BASE_URL: `${server.baseUrl}/backend-api/codex`,
      });
      expect(result.status, result.stderr).toBe(3);
      expect(result.stderr).toContain('Secret scan failed');
      expect(result.stderr).toMatch(/chatgpt_account_id' at \$\.turns\[0\]\.frames\[\d+\]\.data\.delta/);
      expect(result.stderr).not.toContain('acct-fake-7f3e2d1c0b');
      expect(result.stdout).toBe('');
      expect(await readdir(out)).toEqual([]);
    }));

  it('scrubs an echoed access token at capture time', () =>
    withResponder({ leak: 'bearer' }, async (server, dir) => {
      const login = await fakeCodexLogin(dir);
      const out = join(dir, 'out');
      const result = await runRecorder(codexArgs(out), {
        ...login.env,
        CODEX_BASE_URL: `${server.baseUrl}/backend-api/codex`,
      });
      const { raw, report } = await readRecording(result, out);
      expectNoSecrets(raw, login.secrets);
      expect(report).toContain('credential-shaped string');
    }));

  it('records OpenAI over WebSocket with --transport websocket, and the recording replays', () =>
    withResponder({}, async (server, dir) => {
      const key = 'sk-test-openai-ws-recorder-0123456789';
      const home = join(dir, 'home');
      await mkdir(home);
      const out = join(dir, 'out');
      const result = await runRecorder(
        [
          '--yes',
          '--provider',
          'openai',
          '--transport',
          'websocket',
          '--model',
          'gpt-fixture',
          '--probe',
          'tool-continuation-v1',
          '--out',
          out,
        ],
        {
          HOME: home,
          TERM2_CONFIG_DIR: join(dir, 'config'),
          OPENAI_API_KEY: key,
          OPENAI_BASE_URL: `${server.baseUrl}/v1`,
        },
      );
      const { raw, envelope } = await readRecording(result, out);
      expect(raw).not.toContain(key);
      expect(envelope).toMatchObject({ provider: 'openai', wireFamily: 'openai-responses', transport: 'websocket' });
      expect(envelope.turns[0]!.frames[0]).toMatchObject({
        kind: 'ws-open',
        urlPath: '/v1/responses',
        headers: { authorization: '[REDACTED]' },
      });
      expect(sends(envelope)).toHaveLength(2);
      const replay = await replayWebSocketProbeRecording(envelope);
      expect(replay.secondEvents.at(-1)).toMatchObject({ type: 'completion' });
    }));

  it('refuses --transport websocket for a provider without a WebSocket transport', async () => {
    const result = await runRecorder([
      '--yes',
      '--provider',
      'openrouter',
      '--transport',
      'websocket',
      '--model',
      'fixture',
      '--probe',
      probe.id,
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--transport websocket records the built-in codex and openai providers only');
  });
});
