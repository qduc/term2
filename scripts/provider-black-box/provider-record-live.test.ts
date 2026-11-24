import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseFixtureEnvelope } from './fixture-envelope.js';
import {
  startFakeProviderHttpServer,
  type FakeProviderHttpServer,
  type FakeProviderProtocol,
} from './fake-provider-http-server.js';
import { getProbeScenario } from './probe-scenarios.js';
import { resolveProviderRecorderBundle } from './recorder-bundle.js';

// The recorder's LIVE path (`--yes --probe`) had no coverage and drifted from the settings schema until
// `pnpm provider:record --provider openrouter` crashed before sending a request. This runs it as a child
// process against the fake provider on loopback so the next drift fails here. The fake runs in this
// process, so the child must be spawned asynchronously: a synchronous spawn would deadlock the server.

const recorderPath = fileURLToPath(new URL('../provider-record.ts', import.meta.url));
const recorderBundle = resolveProviderRecorderBundle();
const repoRoot = resolve(dirname(recorderPath), '..');
const probe = getProbeScenario('tool-continuation-v1');
const KEY = 'sk-test-recorder-credential-0123456789';

// Names the recorder or the providers read a credential from; none may leak into a case from the host.
const inheritedCredentialVars = [
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENROUTER_API_KEY',
  'OPENROUTER_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'GEMINI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'GOOGLE_API_KEY',
  'OPENCODE_API_KEY',
  'OPENCODE_BASE_URL',
  'TERM2_RECORDING_TRANSPORT',
  'TERM2_RECORDING_DIR',
];

type RecorderResult = { status: number | null; stdout: string; stderr: string };

type Scope = {
  startServer(protocol: FakeProviderProtocol): Promise<FakeProviderHttpServer>;
  outDir(): Promise<string>;
};

/** Per-test servers and output directories, released when the test ends, so cases can run concurrently. */
async function withScope(run: (scope: Scope) => Promise<void>): Promise<void> {
  const servers: FakeProviderHttpServer[] = [];
  const dirs: string[] = [];
  try {
    await run({
      async startServer(protocol) {
        const server = await startFakeProviderHttpServer({ scenario: 'tool-fragments', protocol });
        servers.push(server);
        return server;
      },
      async outDir() {
        const dir = await mkdtemp(join(tmpdir(), 'provider-record-live-'));
        dirs.push(dir);
        return dir;
      },
    });
  } finally {
    await Promise.all(servers.map((server) => server.close()));
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  }
}

function runRecorder(args: string[], env: Record<string, string> = {}): Promise<RecorderResult> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' };
  for (const name of inheritedCredentialVars) delete childEnv[name];
  Object.assign(childEnv, env);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [recorderBundle, ...args], { cwd: repoRoot, env: childEnv });
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

const liveArgs = (provider: string, out: string, extra: string[] = []) => [
  '--yes',
  '--provider',
  provider,
  '--model',
  'fixture-model',
  '--probe',
  probe.id,
  '--out',
  out,
  ...extra,
];

async function readRecording(result: RecorderResult, dir: string) {
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  const file = result.stdout.trim().split('\n').at(-1)!;
  // The recorder must never write inside the repository; this case is the only place that is proven live.
  expect(file.startsWith(dir + sep)).toBe(true);
  expect(file.startsWith(repoRoot + sep)).toBe(false);
  const raw = await readFile(file, 'utf8');
  return { raw, envelope: parseFixtureEnvelope(raw) };
}

type Envelope = ReturnType<typeof parseFixtureEnvelope>;
function requestFrame(envelope: Envelope, turn: number) {
  const frame = envelope.turns[turn]!.frames.find((candidate) => candidate.kind === 'http-request');
  if (frame?.kind !== 'http-request') throw new Error(`turn ${turn} has no request frame`);
  return frame;
}

/** The two exchanges of the tool continuation: the probe prompt, then its tool result and follow-up. */
function expectToolContinuation(envelope: Envelope, server: FakeProviderHttpServer) {
  expect(envelope.turns).toHaveLength(2);
  expect(server.requests).toHaveLength(2);
  for (const turn of envelope.turns) {
    const kinds = turn.frames.map((frame) => frame.kind);
    expect(kinds[0]).toBe('http-request');
    expect(kinds).toContain('http-response-head');
    expect(kinds).toContain('sse-event');
  }
  expect(envelope.capture.probeScenario).toBe(probe.id);
  expect(envelope.capture.model).toBe('fixture-model');
  expect(envelope.transport).toBe('http-sse');
  const first = JSON.stringify(requestFrame(envelope, 0).body);
  const second = JSON.stringify(requestFrame(envelope, 1).body);
  expect(first).toContain(probe.prompt);
  expect(first).not.toContain(probe.followUp);
  expect(second).toContain(probe.prompt);
  expect(second).toContain(probe.followUp);
  // The tool result the probe feeds back, as the JSON text the AI SDK and chat adapters both accept.
  expect(second).toContain(JSON.stringify(JSON.stringify(probe.toolResult)).slice(1, -1));
}

/**
 * The recorder redacts credential-bearing REQUEST headers when it captures them (sanitizeHeaders in
 * fixture-recorder.ts), before `provider:fixture:prepare` runs. Response headers are not redacted at
 * capture time, so the fake server sends none that carry the key.
 */
function expectKeyRedactedAtCapture(raw: string, envelope: Envelope, header: string) {
  expect(raw).not.toContain(KEY);
  for (const turn of [0, 1]) expect(requestFrame(envelope, turn).headers[header]).toBe('[REDACTED]');
}

describe.concurrent('provider recorder live path against a loopback provider', () => {
  it('records the built-in openrouter provider through OPENROUTER_BASE_URL', () =>
    withScope(async ({ startServer, outDir }) => {
      const server = await startServer('chat-completions');
      const dir = await outDir();
      const result = await runRecorder(liveArgs('openrouter', dir), {
        OPENROUTER_API_KEY: KEY,
        OPENROUTER_BASE_URL: `${server.baseUrl}/api/v1`,
      });
      const { raw, envelope } = await readRecording(result, dir);

      expect(envelope.provider).toBe('openrouter');
      expect(envelope.wireFamily).toBe('openai-chat');
      expect(envelope.capture.sdkPackage).toBe('openai');
      expectToolContinuation(envelope, server);
      expect(requestFrame(envelope, 0).urlPath).toBe('/api/v1/chat/completions');
      expect(server.requests[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
      expectKeyRedactedAtCapture(raw, envelope, 'authorization');
      const second = requestFrame(envelope, 1).body as { messages: any[] };
      expect(second.messages.at(-3)).toMatchObject({
        role: 'assistant',
        tool_calls: [{ id: 'call_fake', function: { name: 'fixture' } }],
      });
      expect(second.messages.at(-2)).toMatchObject({ role: 'tool', tool_call_id: 'call_fake' });
    }));

  it.each([
    ['openai-compatible', 'compat-openrouter'],
    // A custom provider of type `openai` is served by the Chat Completions adapter, not Responses.
    ['openai', 'openai-type-openrouter'],
  ] as const)('records --type %s against the chosen base URL as Chat Completions', (type, provider) =>
    withScope(async ({ startServer, outDir }) => {
      const server = await startServer('chat-completions');
      const dir = await outDir();
      const result = await runRecorder(
        liveArgs(provider, dir, [
          '--type',
          type,
          '--base-url',
          `${server.baseUrl}/api/v1`,
          '--api-key-env',
          'TEST_KEY',
        ]),
        { TEST_KEY: KEY },
      );
      const { raw, envelope } = await readRecording(result, dir);

      expect(envelope.provider).toBe(provider);
      expect(envelope.wireFamily).toBe('openai-chat');
      expect(envelope.capture.sdkPackage).toBe('openai');
      expectToolContinuation(envelope, server);
      expect(requestFrame(envelope, 0).urlPath).toBe('/api/v1/chat/completions');
      expect(server.requests[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
      expectKeyRedactedAtCapture(raw, envelope, 'authorization');
    }),
  );

  it('records --type anthropic against the chosen base URL as Messages', () =>
    withScope(async ({ startServer, outDir }) => {
      const server = await startServer('anthropic');
      const dir = await outDir();
      const result = await runRecorder(
        liveArgs('anthropic-openrouter', dir, [
          '--type',
          'anthropic',
          '--base-url',
          `${server.baseUrl}/api/v1`,
          '--api-key-env',
          'TEST_KEY',
        ]),
        { TEST_KEY: KEY },
      );
      const { raw, envelope } = await readRecording(result, dir);

      expect(envelope.provider).toBe('anthropic-openrouter');
      expect(envelope.wireFamily).toBe('anthropic');
      expect(envelope.capture.sdkPackage).toBe('@ai-sdk/anthropic');
      expectToolContinuation(envelope, server);
      expect(requestFrame(envelope, 0).urlPath).toBe('/api/v1/messages');
      // This type sends the key as x-api-key, not Authorization.
      expect(server.requests[0]!.headers['x-api-key']).toBe(KEY);
      expect(server.requests[0]!.headers.authorization).toBeUndefined();
      expectKeyRedactedAtCapture(raw, envelope, 'x-api-key');
      const second = requestFrame(envelope, 1).body as { messages: any[] };
      expect(JSON.stringify(second.messages)).toContain('"type":"tool_use"');
      expect(JSON.stringify(second.messages)).toContain('"tool_use_id":"toolu_fake"');
    }));
});

describe.concurrent('provider recorder usage errors', () => {
  // Usage errors exit before anything is created, so this directory is never made.
  const unusedOut = join(tmpdir(), 'provider-record-live-unused');
  const typedBase = ['--type', 'openai-compatible', '--base-url', 'http://127.0.0.1:1/v1', '--api-key-env', 'TEST_KEY'];
  const expectUsageError = (result: RecorderResult, message: string) => {
    expect(result.status, result.stdout).toBe(2);
    expect(result.stderr).toContain(message);
    // Nothing is written or announced on a usage error.
    expect(result.stdout).toBe('');
  };

  it('requires --base-url and --api-key-env with --type', async () => {
    expectUsageError(
      await runRecorder(liveArgs('custom', unusedOut, ['--type', 'openai-compatible']), { TEST_KEY: KEY }),
      '--type requires both --base-url and --api-key-env',
    );
    expectUsageError(
      await runRecorder(
        liveArgs('custom', unusedOut, ['--type', 'openai-compatible', '--base-url', 'http://127.0.0.1:1/v1']),
        {
          TEST_KEY: KEY,
        },
      ),
      '--type requires both --base-url and --api-key-env',
    );
  });

  it('rejects --base-url or --api-key-env without --type, and an unknown --type', async () => {
    expectUsageError(
      await runRecorder(liveArgs('custom', unusedOut, ['--base-url', 'http://127.0.0.1:1/v1']), { TEST_KEY: KEY }),
      '--base-url only apply together with --type',
    );
    expectUsageError(
      await runRecorder(liveArgs('custom', unusedOut, ['--api-key-env', 'TEST_KEY']), { TEST_KEY: KEY }),
      '--api-key-env only apply together with --type',
    );
    const unknown = typedBase.map((value) => (value === 'openai-compatible' ? 'mystery' : value));
    expectUsageError(
      await runRecorder(liveArgs('custom', unusedOut, unknown), { TEST_KEY: KEY }),
      "--type must be one of openai, openai-compatible, llama.cpp, anthropic, google, opencode (got 'mystery')",
    );
  });

  it('reads the key from --api-key-env only', async () => {
    // Every other credential the recorder knows is present; the named variable is not.
    const result = await runRecorder(liveArgs('custom', unusedOut, typedBase), {
      OPENROUTER_API_KEY: KEY,
      OPENAI_API_KEY: KEY,
      ANTHROPIC_API_KEY: KEY,
    });
    expectUsageError(result, 'environment variable TEST_KEY (from --api-key-env) is not set');
  });

  it('refuses --type with an id that is already a registered provider', async () => {
    const result = await runRecorder(liveArgs('openrouter', unusedOut, typedBase), { TEST_KEY: KEY });
    expectUsageError(result, "--provider 'openrouter' is already a registered provider");
  });

  it('refuses the typed flags with --from-fake', async () => {
    const result = await runRecorder(['--from-fake', 'chat-completions', 'success', '--out', unusedOut, ...typedBase], {
      TEST_KEY: KEY,
    });
    expectUsageError(result, 'apply to live recording only');
  });
});
