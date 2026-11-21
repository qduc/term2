import { createServer, type IncomingMessage } from 'node:http';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createIsolatedWorkspaceLease, type IsolatedWorkspaceLease } from './provider-test-harness.js';

/**
 * `native-error` and `incomplete-stream` for the two Core Chat Completions
 * runtime types that used to lean on the `runtime-openai-compatible-chat`
 * representative route: `openai` and `llama.cpp`. Each scenario drives a
 * one-shot headless run of the built CLI against a loopback server and
 * asserts what the user and the conversation log actually receive, not only
 * that the run failed: the exit status, the error text on stderr, the `--json`
 * error event, and the persisted turn (a failed turn, with no completed
 * assistant response). A completing control run proves those assertions can
 * tell a completed turn from a failed one.
 */
export { CHAT_TERMINAL_ERROR_CAPABILITY_EXECUTIONS as EXECUTED_CAPABILITY_SCENARIO_IDS } from './provider-session-capability-manifest.js';

type ChatRow = {
  id: 'runtime-openai-chat' | 'runtime-llama-cpp-chat';
  providerId: string;
  type: 'openai' | 'llama.cpp';
  model: string;
};

const CHAT_ROWS = [
  { id: 'runtime-openai-chat', providerId: 'runtime-openai', type: 'openai', model: 'fixture-openai' },
  { id: 'runtime-llama-cpp-chat', providerId: 'runtime-llama-cpp', type: 'llama.cpp', model: 'fixture-llama-cpp' },
] as const satisfies readonly ChatRow[];

type Mode = 'native-error' | 'incomplete' | 'completed';

const PROMPT = 'fixture terminal-error prompt';
const NATIVE_ERROR_MESSAGE = 'Injected native provider failure';
const PARTIAL = 'PARTIAL-TEXT-BEFORE-TRUNCATION';
const ANSWER = 'fixture completed answer';
const INCOMPLETE_STREAM_MESSAGE = 'Streamed response ended without a finish reason';

type CapturedRequest = { method: string; url: string; body: Record<string, unknown> };
type FixtureServer = { readonly baseUrl: string; readonly requests: CapturedRequest[]; close(): Promise<void> };
type Fact = { type: string; [key: string]: unknown };

const servers: FixtureServer[] = [];
const workspaces: IsolatedWorkspaceLease[] = [];

afterEach(async () => {
  for (const workspace of workspaces.splice(0)) await workspace.cleanup().catch(() => undefined);
  for (const server of servers.splice(0)) await server.close().catch(() => undefined);
});

// Scenario ids appear literally in the titles (`<row>.<scenario>`): provider-capability-matrix.test.ts
// matches the ledger against the collected titles. `it.each` with `$id` would quote or mangle them.
describe('Chat Completions runtime types: terminal errors through the shipped CLI', () => {
  for (const row of CHAT_ROWS) {
    it(`${row.id}.native-error exits 1 with the provider message and persists a failed turn without a response`, async () => {
      const plain = await runOneShot(row, 'native-error', { json: false });
      const { result, server } = plain;
      expect(result.timedOut, result.stderr).toBe(false);
      expect(result.exitCode, `stdout=${result.stdout} stderr=${result.stderr}`).toBe(1);
      // The provider's own message reaches the user, once, and nothing is printed as an answer.
      expect(result.stderr.trim()).toBe(`error 500 ${NATIVE_ERROR_MESSAGE}`);
      expect(result.stdout).toBe('');
      assertRoute(row, server);
      // retryAttempts is 0: the 500 is not retried.
      expect(server.requests).toHaveLength(1);

      const facts = await readFacts(plain.workspace);
      assertFailedTurn(facts, {
        message: `500 ${NATIVE_ERROR_MESSAGE}`,
        row,
        // A retryable provider failure carries the way back for the user.
        retryable: true,
      });
      expect(factsOfType(facts, 'text_delta')).toEqual([]);

      const machine = await runOneShot(row, 'native-error', { json: true });
      expect(machine.result.exitCode, machine.result.stderr).toBe(1);
      const events = parseJsonLines(machine.result.stdout);
      expect(events.filter((event) => event.type === 'error')).toEqual([
        {
          type: 'error',
          message: `500 ${NATIVE_ERROR_MESSAGE}`,
          error: `500 ${NATIVE_ERROR_MESSAGE}`,
          code: 'provider',
        },
      ]);
      expect(events.find((event) => event.type === 'final')?.finalText ?? '').toBe('');
      expect(events.find((event) => event.type === 'run_summary')).toMatchObject({ outcome: 'failed' });
      assertFailedTurn(await readFacts(machine.workspace), {
        message: `500 ${NATIVE_ERROR_MESSAGE}`,
        row,
        retryable: true,
      });
    });

    it(`${row.id}.incomplete-stream exits 1 naming the missing finish reason and persists no completed response`, async () => {
      const plain = await runOneShot(row, 'incomplete', { json: false });
      const { result, server } = plain;
      expect(result.timedOut, result.stderr).toBe(false);
      expect(result.exitCode, `stdout=${result.stdout} stderr=${result.stderr}`).toBe(1);
      expect(result.stderr.trim()).toBe(`error ${INCOMPLETE_STREAM_MESSAGE}`);
      // Only what the stream really delivered was printed; nothing was completed on its behalf.
      expect(result.stdout.trim()).toBe(PARTIAL);
      assertRoute(row, server);
      expect(server.requests).toHaveLength(1);

      const facts = await readFacts(plain.workspace);
      assertFailedTurn(facts, { message: INCOMPLETE_STREAM_MESSAGE, row, retryable: false });
      // The streamed text was recorded as a delta of the failed turn, and was not promoted to a response.
      expect(factsOfType(facts, 'text_delta').map((fact) => fact.delta)).toEqual([PARTIAL]);

      const machine = await runOneShot(row, 'incomplete', { json: true });
      expect(machine.result.exitCode, machine.result.stderr).toBe(1);
      const events = parseJsonLines(machine.result.stdout);
      expect(events.filter((event) => event.type === 'error')).toEqual([
        {
          type: 'error',
          message: INCOMPLETE_STREAM_MESSAGE,
          error: INCOMPLETE_STREAM_MESSAGE,
          code: 'provider',
        },
      ]);
      expect(events.find((event) => event.type === 'run_summary')).toMatchObject({ outcome: 'failed' });
      assertFailedTurn(await readFacts(machine.workspace), {
        message: INCOMPLETE_STREAM_MESSAGE,
        row,
        retryable: false,
      });
    });

    // Not a ledger scenario: the same harness, a stream that does finish. It is what makes the
    // two scenarios above meaningful, since it shows a completed turn does look different.
    it(`control: ${row.providerId} completes a well-formed stream with exit 0 and a persisted response`, async () => {
      const { result, server, workspace } = await runOneShot(row, 'completed', { json: false });
      expect(result.exitCode, `stdout=${result.stdout} stderr=${result.stderr}`).toBe(0);
      expect(result.stdout.trim()).toBe(ANSWER);
      expect(result.stderr).toBe('');
      assertRoute(row, server);
      const facts = await readFacts(workspace);
      expect(factsOfType(facts, 'model_response_completed')).toHaveLength(1);
      expect(factsOfType(facts, 'item').length).toBeGreaterThan(0);
      expect(factsOfType(facts, 'turn_ended')).toMatchObject([{ outcome: 'completed' }]);
    });
  }
});

async function runOneShot(row: ChatRow, mode: Mode, options: { json: boolean }) {
  const server = await startServer(mode);
  servers.push(server);
  const workspace = await createIsolatedWorkspaceLease({
    prefix: `term2-${row.id}-${mode}-`,
    prepare: async (_root, paths) => {
      await mkdir(paths.logDir, { recursive: true });
      await writeFile(
        join(paths.logDir, 'settings.json'),
        JSON.stringify({
          agent: {
            modelSelection: { model: row.model, provider: row.providerId },
            transport: 'http',
            retryAttempts: 0,
            maxTurns: 4,
            reasoningEffort: 'medium',
          },
          app: { liteMode: true },
          providers: [
            {
              id: row.providerId,
              name: row.providerId,
              type: row.type,
              baseUrl: server.baseUrl,
              apiKey: 'fixture-key',
            },
          ],
        }),
        'utf8',
      );
    },
  });
  workspaces.push(workspace);
  const result = await workspace.runCli({
    cwd: process.cwd(),
    args: [
      ...(options.json ? ['--json'] : []),
      PROMPT,
      '--provider',
      row.providerId,
      '--model',
      row.model,
      '--reasoning',
      'medium',
    ],
    deadlineMs: 15_000,
  });
  return { result, server, workspace };
}

/** The request reached this row's own adapter: its path, model and reasoning spelling. */
function assertRoute(row: ChatRow, server: FixtureServer): void {
  const [request] = server.requests;
  expect(request, `${row.id}: no provider request captured`).toBeDefined();
  expect(request!.method).toBe('POST');
  expect(request!.url).toBe('/chat/completions');
  expect(request!.body.model).toBe(row.model);
  expect(request!.body.stream).toBe(true);
  if (row.type === 'llama.cpp') {
    expect(request!.body.reasoning_effort, `${row.id} reasoning spelling`).toBeUndefined();
    expect(request!.body.chat_template_kwargs, `${row.id} reasoning spelling`).toMatchObject({
      reasoning_effort: 'medium',
    });
  } else {
    expect(request!.body.reasoning_effort, `${row.id} reasoning spelling`).toBe('medium');
    expect(request!.body.chat_template_kwargs).toBeUndefined();
  }
}

/** One turn, begun with the user's prompt on this row's route, that ended failed with no completed response. */
function assertFailedTurn(
  facts: readonly Fact[],
  expected: { message: string; row: ChatRow; retryable: boolean },
): void {
  const started = factsOfType(facts, 'turn_started');
  expect(started).toHaveLength(1);
  expect(JSON.stringify(started[0]!.input)).toContain(PROMPT);
  expect(started[0]!.requestConfiguration).toMatchObject({
    provider: expected.row.providerId,
    model: expected.row.model,
  });
  const ended = factsOfType(facts, 'turn_ended');
  expect(ended).toHaveLength(1);
  expect(ended[0]).toMatchObject({
    outcome: 'failed',
    error: { kind: 'provider', message: expected.message, retryable: expected.retryable },
  });
  if (expected.retryable) expect(String(ended[0]!.notice)).toContain('/retry turn');
  else expect(ended[0]!.notice).toBeUndefined();
  expect(factsOfType(facts, 'queue_settled')).toMatchObject([{ outcome: 'failed' }]);
  // What a completed turn writes and a failed one must not.
  expect(factsOfType(facts, 'model_response_completed')).toEqual([]);
  expect(factsOfType(facts, 'item')).toEqual([]);
}

function factsOfType(facts: readonly Fact[], type: string): Fact[] {
  return facts.filter((fact) => fact.type === type);
}

async function readFacts(workspace: IsolatedWorkspaceLease): Promise<Fact[]> {
  const dir = workspace.paths.conversationsDir;
  const files = (await readdir(dir)).filter((name) => name.endsWith('.jsonl'));
  expect(files, `exactly one conversation persisted under ${dir}`).toHaveLength(1);
  const text = await readFile(join(dir, files[0]!), 'utf8');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { fact: Fact }).fact);
}

function parseJsonLines(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .split('\n')
    .filter((line) => line.trim().startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function startServer(mode: Mode): Promise<FixtureServer> {
  const requests: CapturedRequest[] = [];
  const server = createServer(async (request, response) => {
    requests.push({
      method: request.method ?? 'GET',
      url: request.url ?? '/',
      body: JSON.parse((await readBody(request)) || '{}') as Record<string, unknown>,
    });
    if (mode === 'native-error') {
      response.writeHead(500, { 'content-type': 'application/json', connection: 'close' });
      response.end(JSON.stringify({ error: { type: 'fixture_error', message: NATIVE_ERROR_MESSAGE } }));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'close' });
    const chunk = (delta: Record<string, unknown>, finishReason: string | null) =>
      `data: ${JSON.stringify({
        id: 'chat_fixture',
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`;
    if (mode === 'incomplete') {
      // Text, then the connection ends cleanly: no finish_reason chunk and no [DONE].
      response.write(chunk({ role: 'assistant', content: PARTIAL }, null));
      response.end();
      return;
    }
    response.write(chunk({ role: 'assistant', content: ANSWER }, 'stop'));
    response.write('data: [DONE]\n\n');
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
    server.listen(0, '127.0.0.1');
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Chat terminal-error fixture server did not bind');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function readBody(request: IncomingMessage): Promise<string> {
  let body = '';
  request.setEncoding('utf8');
  for await (const chunk of request) body += chunk;
  return body;
}
