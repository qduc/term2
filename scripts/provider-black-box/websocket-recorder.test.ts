import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseFixtureEnvelope, type FixtureEnvelopeV1, type WsMessageFrame } from './fixture-envelope.js';
import { plantedWebSocketSecrets, webSocketSelfValidationScenarios } from './fixture-self-validation.js';
import {
  plantedResponderIdentity,
  startProbeWebSocketResponder,
  type ProbeWebSocketResponder,
} from './probe-websocket-responder.js';
import { getProbeScenario } from './probe-scenarios.js';
import {
  RecordingLeakError,
  addCodexTokenLiterals,
  addJwtLiterals,
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
const secretScanPath = fileURLToPath(new URL('./recording-secret-scan.ts', import.meta.url));
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
  return runChild('pnpm', ['exec', 'tsx', recorderPath, ...args], env);
}

function runChild(
  command: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<RecorderResult & { signal: NodeJS.Signals | null }> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' };
  for (const name of credentialVars) delete childEnv[name];
  Object.assign(childEnv, env);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: repoRoot, env: childEnv });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.once('error', reject);
    child.once('close', (status, signal) => {
      clearTimeout(timer);
      resolvePromise({ status, signal, stdout, stderr });
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
    name: 'Probe Owner Fullname',
    'https://api.openai.com/auth': { chatgpt_account_id: accountId, chatgpt_user_id: 'user-fake-0a1b2c3d' },
  })}.fakesignaturevalue123`;
  const tokens = { access_token: accessToken, refresh_token: 'fake-refresh-token-abcdef', account_id: accountId };
  const home = join(root, 'home');
  const codexHome = join(home, '.codex');
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

const REDACTED_TEXT = '[REDACTED]';

function leaves(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(leaves);
  if (value && typeof value === 'object') return Object.values(value).flatMap(leaves);
  return [value];
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

describe('recording secret scan: encoded, re-cased and nested copies, and JWT claims', () => {
  const email = 'probe.owner@example.com';
  const token = 'fake-refresh-token-abcdef0123';
  const windowsHome = 'C:\\Users\\probe-owner';
  const literals: SensitiveLiteral[] = [];
  addLiteral(literals, 'email claim', email);
  addLiteral(literals, 'refresh token', token);
  addLiteral(literals, 'home directory path', windowsHome);
  // Encodes to base64 with '+' and '/' (url-safe: '-' and '_') at every offset.
  const opaque = 'opaque~key?>value~~1';
  addLiteral(literals, 'opaque account value', opaque);
  const b64 = (text: string) => Buffer.from(text).toString('base64');
  const cases: Array<[string, unknown]> = [
    ['URL-encoded email', { url: `https://example.invalid/?u=${encodeURIComponent(email)}` }],
    ['upper-cased email', { text: `contact ${email.toUpperCase()}` }],
    ['base64 token', { blob: b64(token) }],
    ['base64 token at an unaligned offset', { blob: b64(`x:${token}:z`) }],
    ['standard base64 value at offset 1', { blob: b64(`a${opaque}`) }],
    ['url-safe base64 value', { blob: Buffer.from(opaque).toString('base64url') }],
    ['url-safe base64 value at offset 2', { blob: Buffer.from(`ab${opaque}`).toString('base64url') }],
    ['base64 email at offset 1', { blob: b64(`a${email}`) }],
    ['double-escaped path in nested JSON', { args: JSON.stringify(JSON.stringify({ home: windowsHome })) }],
    ['nested JSON with a re-cased email', { args: JSON.stringify({ who: email.replace('probe', 'PROBE') }) }],
  ];
  it.each(cases)('fails on a %s and deletes the file', (_label, payload) =>
    withTempDir(async (dir) => {
      const file = join(dir, 'leaky.json');
      const error = await writeScannedRecording(file, JSON.stringify({ data: payload }), literals).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(RecordingLeakError);
      expect((error as Error).message).not.toContain(token);
      expect(await readdir(dir)).toEqual([]);
    }),
  );

  it('passes a recording that only shares short or benign text with the literals', () =>
    withTempDir(async (dir) => {
      const file = join(dir, 'clean.json');
      await writeScannedRecording(file, JSON.stringify({ text: 'probe owner example', n: 'ZmFrZQ' }), literals);
      expect(existsSync(file)).toBe(true);
    }));

  it('takes every string claim of a JWT as a literal, apart from the benign ones', () =>
    withTempDir(async (dir) => {
      const claims = {
        iss: 'https://auth.openai.com',
        aud: ['https://api.openai.com/v1'],
        scp: ['openid', 'profile', 'email'],
        name: 'Probe Owner Fullname',
        given_name: 'Probeowner',
        family_name: 'Fixtureson',
        nickname: 'probey-mc',
        preferred_username: 'probe_owner_99',
        picture: 'https://avatars.example.invalid/u/12345.png',
        groups: ['team-fixture-alpha'],
        amr: ['pwd'],
        sub: 'google-oauth2|104857600000000000001',
        exp: 1893456000,
      };
      const jwt = `${encode({ alg: 'none', typ: 'JWT' })}.${encode(claims)}.c2ln`;
      const jwtLiterals: SensitiveLiteral[] = [];
      addJwtLiterals(jwtLiterals, 'id token', jwt);
      const values = jwtLiterals.map((literal) => literal.value);
      for (const claim of ['name', 'given_name', 'family_name', 'nickname', 'preferred_username', 'picture'] as const)
        expect(values, claim).toContain(claims[claim]);
      expect(values).toContain('team-fixture-alpha');
      // A provider-prefixed subject also yields its bare account number, which a recording could echo alone.
      expect(values).toContain('104857600000000000001');
      for (const benign of [claims.iss, claims.aud[0], 'openid', 'profile', 'email'])
        expect(values, benign).not.toContain(benign);
      // A recording naming the issuer is fine; one carrying the family name is not.
      const ok = join(dir, 'ok.json');
      await writeScannedRecording(ok, JSON.stringify({ note: `issued by ${claims.iss}` }), jwtLiterals);
      expect(existsSync(ok)).toBe(true);
      const bad = join(dir, 'bad.json');
      const error = await writeScannedRecording(bad, JSON.stringify({ note: 'hi FIXTURESON' }), jwtLiterals).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(RecordingLeakError);
      expect((error as RecordingLeakError).findings[0]!.label).toContain("claim 'family_name'");
    }));
});

describe('recording files are only ever kept after a passing scan', () => {
  it('leaves no file under the final name when the process dies between writing and scanning', () =>
    withTempDir(async (dir) => {
      const file = join(dir, 'recording.json');
      const script = join(dir, 'crash.mts');
      // The literal's value is read during the scan; once anything is on disk, reading it kills the process.
      await writeFile(
        script,
        `import { readdirSync } from 'node:fs';
import { writeScannedRecording } from ${JSON.stringify(secretScanPath)};
const dir = ${JSON.stringify(dir)};
const literal = {
  label: 'crash trigger',
  get value() {
    if (readdirSync(dir).some((name) => name !== 'crash.mts')) process.kill(process.pid, 'SIGKILL');
    return 'never-present-literal-value';
  },
};
await writeScannedRecording(${JSON.stringify(file)}, '{"ok":true}\\n', [literal]);
console.log('scan finished');
`,
      );
      const result = await runChild(process.execPath, ['--import', 'tsx', script]);
      expect(result.signal, `${result.stdout}\n${result.stderr}`).toBe('SIGKILL');
      expect(existsSync(file)).toBe(false);
    }));

  it('removes its unscanned temporary files when interrupted (Ctrl-C) between writing and scanning', () =>
    withTempDir(async (dir) => {
      const script = join(dir, 'interrupt.mts');
      // While the first file is scanned, Ctrl-C arrives; blocking briefly makes sure it is pending before the
      // scan awaits its read of the second file, so the handler runs with both temporary files on disk.
      await writeFile(
        script,
        `import { readdirSync } from 'node:fs';
import { writeScannedRecordings } from ${JSON.stringify(secretScanPath)};
const dir = ${JSON.stringify(dir)};
let sent = false;
const literal = {
  label: 'interrupt trigger',
  get value() {
    if (!sent && readdirSync(dir).some((name) => name.endsWith('.unscanned'))) {
      sent = true;
      process.kill(process.pid, 'SIGINT');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
    return 'never-present-literal-value';
  },
};
await writeScannedRecordings(
  [
    { file: ${JSON.stringify(join(dir, 'recording.json'))}, content: '{"ok":true}\\n' },
    { file: ${JSON.stringify(join(dir, 'recording.redactions.json'))}, content: '{"redactions":[]}\\n' },
  ],
  [literal],
);
await new Promise((resolve) => setTimeout(resolve, 5_000));
console.log('scan finished');
`,
      );
      const result = await runChild(process.execPath, ['--import', 'tsx', script]);
      expect(result.signal, `${result.stdout}\n${result.stderr}`).toBe('SIGINT');
      expect(readdirSync(dir)).toEqual(['interrupt.mts']);
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

  it('redacts unknown identity fields and every value of a non-response event, and the recording replays', () =>
    withResponder({ identity: true }, async (server, dir) => {
      const login = await fakeCodexLogin(dir);
      const out = join(dir, 'out');
      const result = await runRecorder(codexArgs(out), {
        ...login.env,
        CODEX_BASE_URL: `${server.baseUrl}/backend-api/codex`,
      });
      const { raw, envelope } = await readRecording(result, out);
      for (const [label, value] of Object.entries(plantedResponderIdentity.strings))
        expect(raw.toLowerCase().includes(value.toLowerCase()), label).toBe(false);
      for (const [label, value] of Object.entries(plantedResponderIdentity.numbers))
        expect(raw.includes(String(value)), label).toBe(false);
      const receives = envelope.turns[0]!.frames.filter(
        (frame): frame is WsMessageFrame => frame.kind === 'ws-message' && frame.direction === 'receive',
      );
      const codexEvents = receives.map((frame) => frame.data as any).filter((data) => /^codex\./.test(data.type));
      expect(codexEvents.map((event) => event.type)).toEqual(
        expect.arrayContaining(['codex.rate_limits', 'codex.probe_notice']),
      );
      for (const event of codexEvents) {
        const { type: _type, ...rest } = event;
        for (const leaf of leaves(rest)) expect([REDACTED_TEXT, 0, true, false, null]).toContain(leaf);
      }
      const created = receives.find((frame) => (frame.data as any).type === 'response.created')!.data as any;
      expect(created.response.id).toBe('resp_<1>');
      expect(created.response.request_id).not.toBe(plantedResponderIdentity.strings.request_id);
      const replay = await replayWebSocketProbeRecording(envelope);
      expect(replay.secondEvents.at(-1)).toMatchObject({ type: 'completion' });
    }));

  it('exits 3 when the service echoes a JWT display-name claim', () =>
    withResponder({ leak: 'jwt-name' }, async (server, dir) => {
      const login = await fakeCodexLogin(dir);
      const out = join(dir, 'out');
      const result = await runRecorder(codexArgs(out), {
        ...login.env,
        CODEX_BASE_URL: `${server.baseUrl}/backend-api/codex`,
      });
      expect(result.status, result.stderr).toBe(3);
      expect(result.stderr).toContain("claim 'name'");
      expect(result.stderr).not.toContain('Probe Owner Fullname');
      expect(await readdir(out)).toEqual([]);
    }));

  it('scrubs a WebSocket close reason like a message body', () =>
    withResponder({ closeReason: '{"user_id":"user-close-identity-0001"}' }, async (server, dir) => {
      const login = await fakeCodexLogin(dir);
      const out = join(dir, 'out');
      const result = await runRecorder(codexArgs(out), {
        ...login.env,
        CODEX_BASE_URL: `${server.baseUrl}/backend-api/codex`,
      });
      const { raw, envelope } = await readRecording(result, out);
      expect(raw).not.toContain('user-close-identity-0001');
      expect(envelope.turns[0]!.frames.at(-1)).toMatchObject({
        kind: 'ws-close',
        reason: JSON.stringify({ user_id: REDACTED_TEXT }),
      });
    }));

  it('keeps an earlier recording at the final path when a new one fails the scan, and leaves no temp file', () =>
    withResponder({ leak: 'account-id' }, async (server, dir) => {
      const login = await fakeCodexLogin(dir);
      const out = join(dir, 'out');
      await mkdir(out);
      const earlier = join(out, 'codex-websocket-tool-continuation-v2.json');
      const earlierReport = join(out, 'codex-websocket-tool-continuation-v2.redactions.json');
      await writeFile(earlier, '{"earlier":"recording"}\n');
      await writeFile(earlierReport, '{"earlier":"report"}\n');
      const result = await runRecorder(codexArgs(out), {
        ...login.env,
        CODEX_BASE_URL: `${server.baseUrl}/backend-api/codex`,
      });
      expect(result.status, result.stderr).toBe(3);
      expect(await readFile(earlier, 'utf8')).toBe('{"earlier":"recording"}\n');
      expect(await readFile(earlierReport, 'utf8')).toBe('{"earlier":"report"}\n');
      expect((await readdir(out)).sort()).toEqual([
        'codex-websocket-tool-continuation-v2.json',
        'codex-websocket-tool-continuation-v2.redactions.json',
      ]);
    }));

  it('names the endpoint before any request and prints paths under the home directory as ~', () =>
    withResponder({}, async (server, dir) => {
      const login = await fakeCodexLogin(dir);
      const out = join(login.env.HOME, 'recordings');
      const result = await runRecorder(codexArgs(out), {
        ...login.env,
        CODEX_BASE_URL: `${server.baseUrl}/backend-api/codex`,
      });
      expect(result.status, result.stderr).toBe(0);
      const wsUrl = `${server.baseUrl.replace(/^http:/, 'ws:')}/backend-api/codex/responses`;
      expect(result.stderr).toContain(`Recording codex via ${wsUrl}`);
      expect(result.stderr).toContain('using the Codex login from ~/.codex/auth.json');
      expect(result.stdout.trim().split('\n')).toEqual([
        '~/recordings/codex-websocket-tool-continuation-v2.json',
        '~/recordings/codex-websocket-tool-continuation-v2.redactions.json',
      ]);
      expect(result.stdout + result.stderr).not.toContain(login.env.HOME);
      expect(existsSync(join(out, 'codex-websocket-tool-continuation-v2.json'))).toBe(true);

      // The endpoint line comes before the first request: it is printed even when no request can be made.
      const unreachable = await runRecorder(codexArgs(join(dir, 'unreachable')), {
        ...login.env,
        CODEX_BASE_URL: 'http://127.0.0.1:1/backend-api/codex',
      });
      expect(unreachable.status).toBe(2);
      expect(unreachable.stderr).toContain('Recording codex via ws://127.0.0.1:1/backend-api/codex/responses');
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
