import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { testCliPath } from '../../tests/helpers/terminal-e2e.js';
import {
  GROK_CONSTANT_CLIENT_VERSION,
  GROK_FIXTURE_MODEL,
  createdFrame,
  grokConfigDir,
  grokEnvironment,
  grokSettings,
  sendJsonError,
  sendSse,
  startGrokFixtureServer,
  startRefusingProxy,
  textFrames,
  writeGrokCredentials,
  writeGrokShim,
  writeGrokVersionCache,
  type GrokFixtureServer,
  type GrokReply,
  type RefusingProxy,
} from './grok-fixture.js';
import {
  createIsolatedWorkspaceLease,
  type BlackBoxRun,
  type IsolatedWorkspaceLease,
} from './provider-test-harness.js';

/**
 * What is specific to Grok: the client-version header and its lookup chain, the
 * proxy's outdated-client rejection, the GROK_BASE_URL override, retry wiring
 * and the emergency Chat Completions lane. Each case runs the built CLI
 * headless (`--json`) against loopback fixtures; credentials come from a real
 * `grok-auth.json`. The lifecycle scenarios are in provider-session-grok.blackbox.ts.
 */

const HOUR_MS = 3_600_000;
/** The hosts `lookupGrokClientVersion` asks, in order, before it falls back. Both are refused here. */
const VERSION_ENDPOINT_HOSTS = ['x.ai:443', 'storage.googleapis.com:443'];

let server: GrokFixtureServer | undefined;
let proxy: RefusingProxy | undefined;
let lease: IsolatedWorkspaceLease | undefined;

afterEach(async () => {
  await lease?.cleanup().catch(() => undefined);
  await proxy?.close().catch(() => undefined);
  await server?.close().catch(() => undefined);
  lease = proxy = server = undefined;
});

type RunOptions = {
  reply: GrokReply;
  /** Written into `TERM2_CACHE_DIR` before the run; omitted means no cache file. */
  cache?: { version: string; ageMs: number };
  /** Output of an installed `grok --version`; omitted means no `grok` on PATH. */
  installedGrok?: string;
  retryAttempts?: number;
  env?: Record<string, string | undefined>;
  baseUrlPath?: string;
  /** Replaces the default `--json` chat run, for commands that are not a turn. */
  args?: string[];
};

type RunResult = { run: BlackBoxRun; events: Array<Record<string, any>> };

async function runGrok(options: RunOptions): Promise<RunResult> {
  server = await startGrokFixtureServer(options.reply);
  proxy = await startRefusingProxy();
  lease = await createIsolatedWorkspaceLease({
    prefix: 'term2-grok-client-',
    prepare: async (root, paths) => {
      await mkdir(paths.logDir, { recursive: true });
      await writeFile(join(paths.logDir, 'settings.json'), grokSettings({ retryAttempts: options.retryAttempts }));
      await writeGrokCredentials(grokConfigDir(paths));
      if (options.cache) await writeGrokVersionCache(paths.cacheDir, options.cache.version, options.cache.ageMs);
      if (options.installedGrok) await writeGrokShim(join(root, 'shim-bin'), options.installedGrok);
    },
  });
  const env = grokEnvironment(lease.paths, {
    server,
    proxy,
    shimDir: options.installedGrok ? join(lease.root, 'shim-bin') : undefined,
    extra: {
      ...(options.baseUrlPath ? { GROK_BASE_URL: server.baseUrl.replace(/\/v1$/, options.baseUrlPath) } : {}),
      ...options.env,
    },
  });
  const run = await lease.runCli({
    cwd: lease.root,
    args: options.args ?? ['--lite', '--provider', 'grok', '--model', GROK_FIXTURE_MODEL, '--json', 'Say hello.'],
    env,
    cliPath: testCliPath(join(process.cwd(), 'dist/cli.js')),
  });
  const events = run.stdout
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, any>);
  return { run, events };
}

const answer =
  (text: string): GrokReply =>
  (_request, number, response) =>
    sendSse(response, textFrames(`resp-grok-client-${number}`, text));

function describeRun({ run, events }: RunResult): string {
  return `exit=${run.exitCode} timedOut=${run.timedOut}\nstderr=${run.stderr.slice(0, 500)}\nevents=${events
    .map((event) => event.type)
    .join(',')}`;
}

function clientVersions(): Array<string | undefined> {
  return server!.requests.map((request) => request.headers['x-grok-client-version']);
}

function expectCompleted(result: RunResult, text: string): void {
  expect(result.run.exitCode, describeRun(result)).toBe(0);
  expect(result.events.find((event) => event.type === 'final')?.finalText).toBe(text);
}

describe('Grok client version lookup chain (x-grok-client-version)', () => {
  it('uses a fresh cache and never reaches for the version endpoints', async () => {
    const result = await runGrok({ reply: answer('hello'), cache: { version: '4.5.6', ageMs: HOUR_MS } });
    expectCompleted(result, 'hello');
    expect(clientVersions(), 'x-grok-client-version header per request').toEqual(['4.5.6']);
    // Fresh cache: the chain stopped at its first step.
    expect(proxy!.connects).toEqual([]);
  });

  it('prefers a stale cache over an installed grok when the endpoints are unreachable', async () => {
    const result = await runGrok({
      reply: answer('hello'),
      cache: { version: '2.2.2', ageMs: 7 * HOUR_MS },
      installedGrok: 'grok 7.7.7',
    });
    expectCompleted(result, 'hello');
    expect(clientVersions(), 'x-grok-client-version header per request').toEqual(['2.2.2']);
    // The stale cache triggered the online step, which was refused on both mirrors, in order.
    expect(proxy!.connects).toEqual(VERSION_ENDPOINT_HOSTS);
  });

  it.skipIf(process.platform === 'win32')(
    'asks the installed grok when there is no cache and the endpoints are unreachable',
    async () => {
      const result = await runGrok({ reply: answer('hello'), installedGrok: 'grok 7.7.7 (build abc)' });
      expectCompleted(result, 'hello');
      expect(clientVersions(), 'x-grok-client-version header per request').toEqual(['7.7.7']);
      expect(proxy!.connects).toEqual(VERSION_ENDPOINT_HOSTS);
    },
  );

  it('falls back to the built-in constant when nothing else answers', async () => {
    const result = await runGrok({ reply: answer('hello') });
    expectCompleted(result, 'hello');
    expect(clientVersions(), 'x-grok-client-version header per request').toEqual([GROK_CONSTANT_CLIENT_VERSION]);
    expect(proxy!.connects).toEqual(VERSION_ENDPOINT_HOSTS);
  });
});

describe('Grok proxy contract', () => {
  it('honours GROK_BASE_URL, including its path prefix', async () => {
    const result = await runGrok({
      reply: answer('hello'),
      cache: { version: '4.5.6', ageMs: 0 },
      baseUrlPath: '/grok-proxy-prefix/v1',
    });
    expect(
      server!.requests.map((request) => request.url),
      'request paths seen by the loopback server',
    ).toEqual(['/grok-proxy-prefix/v1/responses']);
    expectCompleted(result, 'hello');
  });

  it('turns an outdated-client 426 into a failed run: one request, no retries, no completion', async () => {
    const result = await runGrok({
      // Retries are on, as in a default install: a retryable status would be sent again.
      retryAttempts: 2,
      cache: { version: '4.5.6', ageMs: 0 },
      reply: (_request, _number, response) => sendJsonError(response, 426, 'Your Grok CLI version is outdated'),
    });
    expect(
      server!.requests.length,
      `requests the server saw (a retry loop would raise this)\n${describeRun(result)}`,
    ).toBe(1);
    expect(clientVersions(), 'x-grok-client-version header per request').toEqual(['4.5.6']);
    expect(result.run.exitCode, describeRun(result)).toBe(1);
    // The proxy's status and message stay visible; the remedy is asserted in the case below.
    expect(result.events.find((event) => event.type === 'error')).toMatchObject({
      message: expect.stringContaining('426 Your Grok CLI version is outdated'),
      code: 'provider',
    });
    expect(result.events.find((event) => event.type === 'final')?.finalText).toBe('');
    expect(result.events.find((event) => event.type === 'run_summary')).toMatchObject({
      outcome: 'failed',
      requests: { total: 1, completed: 0, failed: 1 },
    });
  });

  it('tells the user what a 426 means in Term2 terms and what to do, keeping the original status text', async () => {
    const result = await runGrok({
      cache: { version: '4.5.6', ageMs: 0 },
      reply: (_request, _number, response) => sendJsonError(response, 426, 'Your Grok CLI version is outdated'),
    });
    const message = String(result.events.find((event) => event.type === 'error')?.message);
    expect(message, describeRun(result)).toContain('426 Your Grok CLI version is outdated');
    expect(message).toContain('Term2 sent 4.5.6');
    expect(message).toContain(join(lease!.paths.cacheDir, 'grok-client-version.json'));
    expect(message).toContain('update Term2');
  });

  it('names no other provider when a Grok Responses stream ends without a completion', async () => {
    const result = await runGrok({
      cache: { version: '4.5.6', ageMs: 0 },
      reply: (_request, _number, response) =>
        sendSse(response, [createdFrame('resp-grok-cut'), { type: 'response.output_text.delta', delta: 'PARTIAL' }]),
    });
    const message = String(result.events.find((event) => event.type === 'error')?.message);
    expect(message, describeRun(result)).toContain('ended without a completion');
    expect(message).not.toContain('OpenAI');
  });

  it('asks the model list from GROK_BASE_URL, including its path prefix', async () => {
    const result = await runGrok({
      cache: { version: '4.5.6', ageMs: 0 },
      baseUrlPath: '/grok-proxy-prefix/v1',
      args: ['--list-models', 'grok', '--refresh'],
      reply: (_request, _number, response) => {
        response.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
        response.end(JSON.stringify({ data: [{ id: 'grok-fixture-listed' }] }));
      },
    });
    expect(
      server!.requests.map((request) => request.url),
      `request paths seen by the loopback server\n${describeRun(result)}\nstdout=${result.run.stdout}`,
    ).toEqual(['/grok-proxy-prefix/v1/models']);
    expect(result.run.stdout).toContain('grok-fixture-listed');
  });

  it('recovers from a transient 503 and sends the same Grok headers on the replayed request', async () => {
    const result = await runGrok({
      retryAttempts: 2,
      cache: { version: '4.5.6', ageMs: 0 },
      reply: (_request, number, response) =>
        number === 1
          ? sendJsonError(response, 503, 'overloaded')
          : sendSse(response, textFrames('resp-grok-retry', 'recovered')),
    });
    expectCompleted(result, 'recovered');
    expect(server!.requests).toHaveLength(2);
    const [first, retry] = server!.requests;
    for (const request of [first!, retry!]) {
      expect(request.headers['x-grok-client-version']).toBe('4.5.6');
      expect(request.headers.authorization).toMatch(/^Bearer /);
    }
    expect(retry!.headers['x-grok-conv-id']).toBe(first!.headers['x-grok-conv-id']);
  });

  // agent-core 0.3.0-alpha.0 sends 2 × (n + 1); see PINNED_ENGINE_MULTIPLIES_RETRIES in provider-retries-exhausted-notice.
  const pinnedEngineMultipliesRetries =
    (JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { dependencies: Record<string, string> })
      .dependencies['@qduc/agent-core'] === '0.3.0-alpha.0';
  it.skipIf(pinnedEngineMultipliesRetries)(
    'sends retryAttempts + 1 requests to a proxy that keeps answering 503',
    async () => {
      const result = await runGrok({
        retryAttempts: 1,
        cache: { version: '4.5.6', ageMs: 0 },
        reply: (_request, _number, response) => {
          // A 1 ms Retry-After keeps the backoff out of the test's wall time.
          response.writeHead(503, { 'content-type': 'application/json', 'retry-after': '0.001', connection: 'close' });
          response.end(JSON.stringify({ error: { message: 'overloaded' } }));
        },
      });
      expect(server!.requests.length, `requests the server saw\n${describeRun(result)}`).toBe(2);
      expect(result.run.exitCode, describeRun(result)).toBe(1);
      expect(result.events.find((event) => event.type === 'run_summary')).toMatchObject({
        outcome: 'failed',
        requests: { total: 2, completed: 0, failed: 2 },
      });
    },
  );
});

describe('Grok emergency Chat Completions lane (TERM2_GROK_API=chat, Experimental)', () => {
  it('switches the route to /chat/completions and still carries the Grok headers', async () => {
    const result = await runGrok({
      cache: { version: '4.5.6', ageMs: 0 },
      env: { TERM2_GROK_API: 'chat' },
      reply: (_request, _number, response) => {
        response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
        response.write(
          `data: ${JSON.stringify({
            id: 'chat-grok',
            choices: [{ index: 0, delta: { role: 'assistant', content: 'chat-lane-reply' }, finish_reason: 'stop' }],
          })}\n\n`,
        );
        response.write('data: [DONE]\n\n');
        response.end();
      },
    });
    const [request] = server!.requests;
    expect(server!.requests).toHaveLength(1);
    expect(request!.url, 'request path with TERM2_GROK_API=chat').toBe('/v1/chat/completions');
    expect(request!.body.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: 'user' })]));
    expect(request!.body).not.toHaveProperty('input');
    expect(request!.headers['x-grok-client-version']).toBe('4.5.6');
    expectCompleted(result, 'chat-lane-reply');
  });
});
