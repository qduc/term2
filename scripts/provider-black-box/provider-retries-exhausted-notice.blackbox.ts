import { createServer, type Server } from 'node:http';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { testCliPath } from '../../tests/helpers/terminal-e2e.js';
import { createIsolatedWorkspaceLease, type IsolatedWorkspaceLease } from './provider-test-harness.js';

/**
 * The notice stored with a turn that used up its retries must say whether the
 * provider could not be reached or answered with an error, and count attempts
 * in plain English. `agent.retryAttempts = n` means n retries: n + 1 requests
 * reach the provider, and the notice counts those requests. Each case runs the
 * built CLI headless against a loopback server and reads the notice from the
 * persisted conversation.
 */

/**
 * @qduc/agent-core 0.3.0-alpha.0 sent 2 × (n + 1) requests for n >= 1: up to n
 * silent retries, then a "retrying k/n" turn-level retry that restarted them
 * (`#transient` in its `engine/recovery.ts`). 0.3.0-alpha.1 fixed that for a
 * failed request, and 0.3.0-alpha.2 for a stream cut before any output
 * (`connection_interrupted`) and for n above the recovery budget's default three
 * physical attempts. These cases fail on an engine that multiplies or caps them again.
 */

let server: Server | undefined;
let lease: IsolatedWorkspaceLease | undefined;

afterEach(async () => {
  await lease?.cleanup().catch(() => undefined);
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  lease = server = undefined;
});

type Behaviour = 'http-500' | 'http-503' | 'drop-connection' | 'stream-closed-early';
type Route = 'openai-compatible' | 'openai' | 'codex';

type FailedTurn = { notice: string; requests: string[]; retryLines: string[] };

/**
 * `behaviour` may list one behaviour per request; the last one repeats. `retryAfter` overrides the
 * Retry-After header a 503 sends.
 */
async function failedTurn(
  behaviours: Behaviour | Behaviour[],
  retryAttempts: number,
  route: Route = 'openai-compatible',
  retryAfter = '0.001',
) {
  const requests: string[] = [];
  const sequence = [behaviours].flat();
  server = createServer((request, response) => {
    request.resume();
    // Codex also asks for its model catalog; only model requests are counted.
    if (request.method !== 'POST') {
      response.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      response.end(JSON.stringify({ models: [] }));
      return;
    }
    requests.push(request.url ?? '');
    const behaviour = sequence[Math.min(requests.length, sequence.length) - 1]!;
    if (behaviour === 'drop-connection') {
      request.socket.destroy();
      return;
    }
    // A stream that opens and ends before any output: the engine sees an interrupted connection.
    if (behaviour === 'stream-closed-early') {
      response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
      response.end();
      return;
    }
    // A 1 ms Retry-After keeps the backoff out of the test's wall time; the engine honours it.
    const status = behaviour === 'http-503' ? 503 : 500;
    response.writeHead(status, {
      'content-type': 'application/json',
      'retry-after': behaviour === 'http-503' ? retryAfter : '0',
      connection: 'close',
    });
    response.end(JSON.stringify({ error: { message: 'internal fixture failure' } }));
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const builtIn = route !== 'openai-compatible';
  const provider = builtIn ? route : 'fixture-custom';
  const model = builtIn ? 'gpt-5.6-luna' : 'fixture-chat';
  lease = await createIsolatedWorkspaceLease({
    prefix: 'term2-exhausted-notice-',
    env: { OPENAI_BASE_URL: `http://127.0.0.1:${port}`, CODEX_BASE_URL: `http://127.0.0.1:${port}` },
    prepare: async (_root, paths) => {
      await mkdir(paths.logDir, { recursive: true });
      if (route === 'codex') await writeCodexAuth(paths.codexHome);
      await writeFile(
        join(paths.logDir, 'settings.json'),
        JSON.stringify({
          agent: {
            modelSelection: { model, provider },
            retryAttempts,
            ...(builtIn ? { transport: 'http', openai: { apiKey: 'fixture-key' } } : {}),
          },
          app: { liteMode: true },
          providers: builtIn
            ? []
            : [
                {
                  id: 'fixture-custom',
                  name: 'fixture-custom',
                  type: 'openai-compatible',
                  baseUrl: `http://127.0.0.1:${port}`,
                  apiKey: 'fixture-key',
                },
              ],
        }),
      );
    },
  });
  // Plain output: each retry the user is told about is one `[retry]` line on stderr.
  const run = await lease.runCli({
    cwd: lease.root,
    args: ['--lite', '--provider', provider, '--model', model, 'Say hello.'],
    cliPath: testCliPath(join(process.cwd(), 'dist/cli.js')),
    deadlineMs: 60_000,
  });
  expect(run.exitCode, run.stderr).toBe(1);
  const log = (await readdir(lease.paths.conversationsDir)).find((name) => name.endsWith('.jsonl'))!;
  const rows = (await readFile(join(lease.paths.conversationsDir, log), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const ended = rows.map((row) => row.fact).find((fact) => fact?.type === 'turn_ended');
  expect(ended?.outcome, JSON.stringify(ended)).toBe('failed');
  const retryLines = run.stderr.split('\n').filter((line) => line.startsWith('[retry]'));
  return { notice: String(ended.notice), requests, retryLines } satisfies FailedTurn;
}

/** A Codex CLI login whose token is valid for an hour, so no refresh is attempted. */
async function writeCodexAuth(codexHome: string): Promise<void> {
  await mkdir(codexHome, { recursive: true });
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const jwt = `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
    exp: Math.floor(Date.now() / 1_000) + 3_600,
  })}.fixture`;
  await writeFile(
    join(codexHome, 'auth.json'),
    JSON.stringify({
      tokens: { access_token: jwt, refresh_token: 'fixture-refresh-token', account_id: 'fixture-account' },
    }),
  );
}

describe('notice for a turn that ran out of retries', () => {
  it('says the provider answered with an error, not that it was unreachable, and counts attempts', async () => {
    const { notice, requests } = await failedTurn('http-500', 0);
    expect(requests).toHaveLength(1);
    expect(notice).toContain('fixture-custom answered with an error');
    expect(notice).toMatch(/after 1 attempt\b/);
    expect(notice).not.toContain('Could not reach');
    expect(notice).not.toContain('No model response was received');
    expect(notice).toContain('/retry turn');
  });

  it('says the provider could not be reached when the connection fails', async () => {
    const { notice } = await failedTurn('drop-connection', 0);
    expect(notice).toContain('Could not reach fixture-custom after 1 attempt.');
    expect(notice).toContain('No model response was received.');
    expect(notice).toContain('/retry turn');
  });
});

describe('agent.retryAttempts = n sends n + 1 requests to a provider that keeps failing', () => {
  for (const route of ['openai-compatible', 'openai', 'codex'] as const) {
    for (const retryAttempts of [0, 1, 2]) {
      const requests = retryAttempts + 1;
      it(`${route}: retryAttempts ${retryAttempts} sends ${requests} request(s), one notice per retry`, async () => {
        const turn = await failedTurn('http-503', retryAttempts, route);
        const context = JSON.stringify(turn);
        expect(turn.requests, context).toHaveLength(requests);
        // Every retry is announced as k/n, and the stored notice counts the requests that were sent.
        expect(
          turn.retryLines.map((line) => /\((\d+)\/(\d+)\)/.exec(line)?.slice(1)),
          context,
        ).toEqual(Array.from({ length: retryAttempts }, (_, index) => [`${index + 1}`, `${retryAttempts}`]));
        expect(turn.notice, context).toMatch(new RegExp(`after ${requests} attempts?\\b`));
      });
    }
  }

  const announced = (turn: FailedTurn) => turn.retryLines.map((line) => /\((\d+)\/(\d+)\)/.exec(line)?.slice(1));
  const series = (n: number) => Array.from({ length: n }, (_, index) => [`${index + 1}`, `${n}`]);

  for (const route of ['openai-compatible', 'openai'] as const) {
    for (const retryAttempts of [1, 2]) {
      const requests = retryAttempts + 1;
      it(`${route}: a stream that ends before any output is retried ${retryAttempts} time(s), not twice over`, async () => {
        const turn = await failedTurn('stream-closed-early', retryAttempts, route);
        const context = JSON.stringify(turn);
        expect(turn.requests, context).toHaveLength(requests);
        expect(announced(turn), context).toEqual(series(retryAttempts));
        expect(turn.notice, context).toMatch(new RegExp(`after ${requests} attempts\\b`));
      });
    }
  }

  it('openai-compatible: retryAttempts 4 sends 5 requests, past the default three-attempt budget', async () => {
    const turn = await failedTurn('http-503', 4);
    const context = JSON.stringify(turn);
    expect(turn.requests, context).toHaveLength(5);
    expect(announced(turn), context).toEqual(series(4));
    expect(turn.notice, context).toMatch(/after 5 attempts\b/);
  });

  // A provider that alternates failure modes is still one request failing again: one counter, n + 1 requests.
  for (const [label, sequence] of [
    ['a 503, then streams that end before any output', ['http-503', 'stream-closed-early']],
    ['a stream that ends before any output, then 503s', ['stream-closed-early', 'http-503']],
  ] as const) {
    it(`openai-compatible: ${label} still sends n + 1 requests for retryAttempts 2`, async () => {
      const turn = await failedTurn([...sequence], 2);
      const context = JSON.stringify(turn);
      expect(turn.requests, context).toHaveLength(3);
      expect(announced(turn), context).toEqual(series(2));
      expect(turn.notice, context).toMatch(/after 3 attempts\b/);
    });
  }
});

describe('a retry the 90 s recovery clock cannot fit', () => {
  it('is neither announced nor sent, and the stored notice counts the requests made', async () => {
    // Retry-After 100 s is past the 90 s recovery clock, so the first retry can never be made.
    const turn = await failedTurn('http-503', 3, 'openai-compatible', '100');
    const context = JSON.stringify(turn);
    expect(turn.requests, context).toHaveLength(1);
    expect(turn.retryLines, context).toEqual([]);
    expect(turn.notice, context).toContain('fixture-custom answered with an error after 1 attempt');
    expect(turn.notice, context).toContain('/retry turn');
  });
});
