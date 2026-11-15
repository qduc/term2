import { createServer, type IncomingMessage } from 'node:http';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createIsolatedWorkspaceLease,
  exitInteractive,
  writePtyTextAndSubmit,
  type IsolatedWorkspaceLease,
  type PtyChildDriver,
} from './provider-test-harness.js';

/**
 * A between-turn effort change (`/effort`) on a model with a cache-preserving
 * mechanism keeps the request prefix byte-identical and carries the change as
 * input (src/model/effort-updates.ts); every other path keeps today's request.
 * The mechanism is off unless `agent.cachePreservingEffort` enables it; these
 * fakes are not first-party hosts, so enabled cases use `any-endpoint`.
 * Measured cache behaviour: docs/research/model-effort-step-down-cache-economics.md.
 */

type Captured = { url: string; headers: IncomingMessage['headers']; body: any };
type Fake = { baseUrl: string; requests: Captured[]; close(): Promise<void> };
type FakeOptions = {
  /** 1-based POST number answered 403 (a failed, unanswered turn). */
  readonly failRequest?: number;
  /** Answer 400 to any request that carries an effort item, as an endpoint without support would. */
  readonly rejectEffortItems?: boolean;
  /** With `rejectEffortItems`: the request right after a rejected one also answers 400, for an unrelated reason. */
  readonly alsoRejectRetry?: boolean;
  /** POSTs up to this number answer at length, so a later compaction has something to reduce. */
  readonly longAnswersThrough?: number;
};

const ANTHROPIC_BETA = 'mid-conversation-output-config-2026-07-01';
const SENTINEL = 'term2-effort-update';

const hasEffortItem = (body: any): boolean =>
  (Array.isArray(body?.input) && body.input.some((item: any) => item?.type === 'configuration_update')) ||
  (Array.isArray(body?.messages) &&
    body.messages.some((message: any) => message?.role === 'system' && message.output_config));

async function startFake(options: FakeOptions = {}): Promise<Fake> {
  const requests: Captured[] = [];
  let rejectedAt = -1;
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (req.method !== 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [] }));
      return;
    }
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ url: req.url ?? '', headers: req.headers, body });
    const n = requests.length;
    if (options.failRequest === n) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'permission_error', message: 'fixture refusal' } }));
      return;
    }
    if (options.alsoRejectRetry && n === rejectedAt + 1) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'fixture: unrelated refusal' } }));
      return;
    }
    if (options.rejectEffortItems && hasEffortItem(body)) {
      rejectedAt = n;
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({ error: { type: 'invalid_request_error', message: 'fixture: unsupported effort item' } }),
      );
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'close' });
    const send = (data: unknown, event?: string) =>
      res.write(`${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`);
    const text = `effort fixture answer ${n}` + (n <= (options.longAnswersThrough ?? 0) ? ' padding'.repeat(600) : '');
    if ((req.url ?? '').endsWith('/messages')) {
      send(
        {
          type: 'message_start',
          message: {
            id: `msg_${n}`,
            type: 'message',
            role: 'assistant',
            content: [],
            model: body?.model,
            usage: { input_tokens: 10, output_tokens: 0 },
          },
        },
        'message_start',
      );
      send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, 'content_block_start');
      send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }, 'content_block_delta');
      send({ type: 'content_block_stop', index: 0 }, 'content_block_stop');
      send({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }, 'message_delta');
      send({ type: 'message_stop' }, 'message_stop');
    } else {
      const id = `resp_${n}`;
      send({ type: 'response.created', response: { id, status: 'in_progress' } });
      send({ type: 'response.output_text.delta', delta: text });
      send({
        type: 'response.completed',
        response: {
          id,
          status: 'completed',
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
          usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } },
        },
      });
      res.write('data: [DONE]\n\n');
    }
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake did not bind');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

type Scope = 'off' | 'first-party' | 'any-endpoint';
type Route = { kind: 'openai' | 'anthropic'; model: string; scope?: Scope; fake?: FakeOptions };

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined);
});

async function setup(route: Route) {
  const fake = await startFake(route.fake);
  cleanups.push(() => fake.close());
  const provider = route.kind === 'openai' ? 'openai' : 'fixture-anthropic-effort';
  const env = route.kind === 'openai' ? { OPENAI_BASE_URL: `${fake.baseUrl}/v1` } : undefined;
  const workspace = await createIsolatedWorkspaceLease({
    prefix: `term2-effort-${route.kind}-`,
    ...(env ? { env } : {}),
    prepare: async (_root, paths) => {
      await mkdir(paths.logDir, { recursive: true });
      await writeFile(
        join(paths.logDir, 'settings.json'),
        JSON.stringify({
          agent: {
            modelSelection: { provider, model: route.model },
            transport: 'http',
            retryAttempts: 0,
            reasoningEffort: 'medium',
            ...(route.scope ? { cachePreservingEffort: route.scope } : {}),
            openai: { apiKey: 'fixture-key' },
          },
          app: { liteMode: true },
          ...(route.kind === 'anthropic'
            ? {
                providers: [
                  { id: provider, name: provider, type: 'anthropic', baseUrl: fake.baseUrl, apiKey: 'fixture-key' },
                ],
              }
            : {}),
        }),
      );
    },
  });
  cleanups.push(() => workspace.cleanup());
  const posts = () =>
    fake.requests.filter((request) => request.url.endsWith(route.kind === 'openai' ? '/responses' : '/messages'));
  return { fake, workspace, provider, posts };
}

/** Drive one interactive process: prompts, `/effort <level>` and `/compact`, each awaited to idle. */
async function drive(
  workspace: IsolatedWorkspaceLease,
  provider: string,
  model: string,
  steps: readonly string[],
  options: { resume?: boolean; expectVisible?: string } = {},
) {
  const resumeId = options.resume
    ? (await readdir(workspace.paths.conversationsDir)).find((name) => name.endsWith('.jsonl'))!.slice(0, -6)
    : undefined;
  const child: PtyChildDriver = await workspace.start({
    args: [
      '--lite',
      '--provider',
      provider,
      '--model',
      model,
      ...(resumeId ? ['--resume', resumeId.replace(/^conv_/, '')] : []),
    ],
    env: { TERM2_CONVERSATIONS_DIR: workspace.paths.conversationsDir },
  });
  cleanups.push(() => child.cleanup());
  let idle = await child.waitForIdleInput();
  for (const step of steps) {
    await writePtyTextAndSubmit(child, step);
    if (step.startsWith('/effort ')) await child.waitForVisibleOutput(`${model} · ${step.slice('/effort '.length)}`);
    if (step === '/compact') await child.waitForVisibleOutput('Context compacted locally');
    idle = await child.waitForIdleInput({ after: idle });
  }
  if (options.expectVisible) await child.waitForVisibleOutput(options.expectVisible);
  await exitInteractive(child);
}

/** Cache markers move to the newest messages by design; they are not part of the prefix identity. */
function withoutCacheControl(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (key, field) => (key === 'cache_control' ? undefined : field)));
}

const textOf = (item: any): string =>
  typeof item?.content === 'string'
    ? item.content
    : (item?.content ?? []).map((part: any) => part?.text ?? '').join('');

/** The effort a request actually runs at: the last in-conversation item, else the top-level value. */
function effective(body: any): string | undefined {
  if (Array.isArray(body.input)) {
    const updates = body.input.filter((item: any) => item?.type === 'configuration_update');
    return updates.at(-1)?.reasoning.effort ?? body.reasoning?.effort;
  }
  const updates = body.messages.filter((message: any) => message.role === 'system' && message.output_config);
  return updates.at(-1)?.output_config.effort ?? body.output_config?.effort;
}

const effortItems = (body: any): number =>
  Array.isArray(body.input)
    ? body.input.filter((item: any) => item?.type === 'configuration_update').length
    : body.messages.filter((message: any) => message.role === 'system' && message.output_config).length;

// The TUI wraps the notice; match its first line.
const FALLBACK_NOTICE = 'This endpoint does not support changing reasoning effort';

describe('cache-preserving effort change', () => {
  it('is off by default: GPT-6 keeps today, anchor dropped and effort top-level', async () => {
    const { workspace, posts } = await setup({ kind: 'openai', model: 'gpt-6-sol' });
    await drive(workspace, 'openai', 'gpt-6-sol', ['first effort question', '/effort low', 'second effort question']);
    const [, second] = posts();
    expect(second!.body.reasoning.effort).toBe('low');
    expect(second!.body.previous_response_id).toBeUndefined();
    expect(JSON.stringify(second!.body)).not.toContain('configuration_update');
  });

  it('first-party scope keeps today on an OpenAI base-URL override', async () => {
    const { workspace, posts } = await setup({ kind: 'openai', model: 'gpt-6-sol', scope: 'first-party' });
    await drive(workspace, 'openai', 'gpt-6-sol', ['first effort question', '/effort low', 'second effort question']);
    const [, second] = posts();
    expect(second!.body.reasoning.effort).toBe('low');
    expect(JSON.stringify(second!.body)).not.toContain('configuration_update');
  });

  it('GPT-6 on the Responses path keeps the anchor and top-level effort, adding only configuration_update', async () => {
    const { workspace, posts } = await setup({ kind: 'openai', model: 'gpt-6-sol', scope: 'any-endpoint' });
    await drive(workspace, 'openai', 'gpt-6-sol', ['first effort question', '/effort low', 'second effort question']);
    const [first, second] = posts();
    expect(first!.body.reasoning.effort).toBe('medium');
    expect(JSON.stringify(first!.body.input)).not.toContain('configuration_update');
    // Same envelope, so continuity keeps the anchor and sends only the new turn.
    expect(second!.body.previous_response_id).toBe('resp_1');
    expect(second!.body.reasoning).toEqual(first!.body.reasoning);
    expect(second!.body.instructions).toBe(first!.body.instructions);
    expect(second!.body.tools).toEqual(first!.body.tools);
    const delta = second!.body.input as any[];
    const userIndex = delta.findIndex((item) => textOf(item).includes('second effort question'));
    expect(userIndex).toBeGreaterThan(0);
    expect(delta[userIndex - 1]).toEqual({ type: 'configuration_update', reasoning: { effort: 'low' } });
    expect(effortItems(second!.body)).toBe(1);

    // Resume (new process, full history): the marker is rebuilt from the log at the same place.
    await drive(workspace, 'openai', 'gpt-6-sol', ['third effort question'], { resume: true });
    const third = posts()[2]!;
    expect(third.body.previous_response_id).toBeUndefined();
    expect(third.body.reasoning).toEqual(first!.body.reasoning);
    expect(third.body.instructions).toBe(first!.body.instructions);
    expect(third.body.tools).toEqual(first!.body.tools);
    const full = third.body.input as any[];
    const secondQuestion = full.findIndex((item) => textOf(item).endsWith('second effort question'));
    expect(full[secondQuestion - 1]).toEqual({ type: 'configuration_update', reasoning: { effort: 'low' } });
    expect(effortItems(third.body)).toBe(1);
    expect(full.slice(0, (first!.body.input as any[]).length)).toEqual(first!.body.input);
  });

  it('a pre-GPT-6 Responses model keeps today: anchor dropped, effort top-level, no configuration_update', async () => {
    const { workspace, posts } = await setup({ kind: 'openai', model: 'gpt-5.6-sol', scope: 'any-endpoint' });
    await drive(workspace, 'openai', 'gpt-5.6-sol', ['first effort question', '/effort low', 'second effort question']);
    const [first, second] = posts();
    expect(first!.body.reasoning.effort).toBe('medium');
    expect(second!.body.reasoning.effort).toBe('low');
    expect(second!.body.previous_response_id).toBeUndefined();
    expect(JSON.stringify(second!.body)).not.toContain('configuration_update');
  });

  it('a compaction starts afresh: no stale marker, and every request runs at the selected effort', async () => {
    const { workspace, posts } = await setup({
      kind: 'openai',
      model: 'gpt-6-sol',
      scope: 'any-endpoint',
      fake: { longAnswersThrough: 3 },
    });
    await drive(workspace, 'openai', 'gpt-6-sol', [
      'warmup one',
      'warmup two',
      'first effort question',
      '/effort low',
      'second effort question',
      '/compact',
      'third effort question',
      '/effort high',
      'fourth effort question',
    ]);
    const requests = posts();
    const turn = (needle: string) => requests.find((request) => JSON.stringify(request.body).includes(needle))!;
    const [second, third, fourth] = ['second', 'third', 'fourth'].map((word) => turn(`${word} effort question`));
    expect(effective(second!.body)).toBe('low');
    // After the compaction the next turn's effort is the top-level value, with no marker before the summary.
    expect(third!.body.reasoning.effort).toBe('low');
    expect(effortItems(third!.body)).toBe(0);
    expect(effective(fourth!.body)).toBe('high');
    expect(fourth!.body.reasoning.effort).toBe('low');
    expect(effortItems(fourth!.body)).toBe(1);
    const log = await readFile(
      join(
        workspace.paths.conversationsDir,
        (await readdir(workspace.paths.conversationsDir)).find((name) => name.endsWith('.jsonl'))!,
      ),
      'utf8',
    );
    expect(log).not.toContain('effort_update');
  });

  it('GPT-6: an endpoint that rejects configuration_update falls back once, says so, and stays off after resume', async () => {
    const { workspace, posts } = await setup({
      kind: 'openai',
      model: 'gpt-6-sol',
      scope: 'any-endpoint',
      fake: { rejectEffortItems: true },
    });
    await drive(
      workspace,
      'openai',
      'gpt-6-sol',
      ['first effort question', '/effort low', 'second effort question', '/effort high', 'third effort question'],
      { expectVisible: FALLBACK_NOTICE },
    );
    const requests = posts();
    const rejected = requests.filter((request) => hasEffortItem(request.body));
    expect(rejected).toHaveLength(1);
    const retried = requests[requests.indexOf(rejected[0]!) + 1]!;
    expect(retried.body.reasoning.effort).toBe('low');
    expect(effortItems(retried.body)).toBe(0);
    expect(requests.at(-1)!.body.reasoning.effort).toBe('high');
    expect(effortItems(requests.at(-1)!.body)).toBe(0);
    await drive(workspace, 'openai', 'gpt-6-sol', ['/effort medium', 'fourth effort question'], { resume: true });
    const after = posts().at(-1)!;
    expect(after.body.reasoning.effort).toBe('medium');
    expect(effortItems(after.body)).toBe(0);
    expect(posts().filter((request) => hasEffortItem(request.body))).toHaveLength(1);
  });

  it('GPT-6: a retry that also fails still switches markers off for the session, across a registry rebuild', async () => {
    const { workspace, posts } = await setup({
      kind: 'openai',
      model: 'gpt-6-sol',
      scope: 'any-endpoint',
      fake: { rejectEffortItems: true, alsoRejectRetry: true },
    });
    await drive(workspace, 'openai', 'gpt-6-sol', [
      'first effort question',
      '/effort low',
      'second effort question',
      '/effort high',
      'third effort question',
    ]);
    const requests = posts();
    // first, rejected marker request, its failing retry (no marker), then the third turn.
    expect(requests).toHaveLength(4);
    expect(effortItems(requests[1]!.body)).toBe(1);
    expect(effortItems(requests[2]!.body)).toBe(0);
    expect(requests[2]!.body.reasoning.effort).toBe('low');
    // The second /effort rebuilt the registry: it still sends no marker, and the effort is top-level.
    expect(effortItems(requests[3]!.body)).toBe(0);
    expect(requests[3]!.body.reasoning.effort).toBe('high');
    await drive(workspace, 'openai', 'gpt-6-sol', ['/effort medium', 'fourth effort question'], { resume: true });
    const after = posts().at(-1)!;
    expect(effortItems(after.body)).toBe(0);
    expect(after.body.reasoning.effort).toBe('medium');
    expect(posts().filter((request) => hasEffortItem(request.body))).toHaveLength(1);
  });

  it('Claude Haiku 5.5 keeps the prefix byte-identical and adds only the effort message and beta', async () => {
    const { workspace, provider, posts } = await setup({
      kind: 'anthropic',
      model: 'claude-haiku-5-5',
      scope: 'any-endpoint',
    });
    await drive(workspace, provider, 'claude-haiku-5-5', [
      'first effort question',
      '/effort low',
      'second effort question',
    ]);
    const [first, second] = posts();
    expect(first!.body.output_config).toEqual({ effort: 'medium' });
    expect(first!.body.thinking).toEqual({ type: 'adaptive' });
    expect(String(first!.headers['anthropic-beta'] ?? '')).not.toContain(ANTHROPIC_BETA);
    // Everything outside messages is unchanged, the top-level effort included.
    const { messages: firstMessages, ...firstRest } = first!.body;
    const { messages: secondMessages, ...secondRest } = second!.body;
    expect(withoutCacheControl(secondRest)).toEqual(withoutCacheControl(firstRest));
    expect(String(second!.headers['anthropic-beta'])).toContain(ANTHROPIC_BETA);
    // The earlier conversation is an exact prefix; the effort message precedes the new user turn.
    const stripped = withoutCacheControl(secondMessages) as any[];
    expect(stripped.slice(0, firstMessages.length)).toEqual(withoutCacheControl(firstMessages));
    const tail = stripped.slice(firstMessages.length);
    expect(tail.map((message) => message.role)).toEqual(['assistant', 'system', 'user']);
    expect(tail[1]).toEqual({ role: 'system', content: [], output_config: { effort: 'low' } });
    expect(textOf(tail[2])).toContain('second effort question');
    expect(JSON.stringify(second!.body)).not.toContain(SENTINEL);

    // Resume rebuilds the identical prefix, effort message included.
    await drive(workspace, provider, 'claude-haiku-5-5', ['third effort question'], { resume: true });
    const third = posts()[2]!;
    const { messages: thirdMessages, ...thirdRest } = third.body;
    expect(withoutCacheControl(thirdRest)).toEqual(withoutCacheControl(firstRest));
    const resumed = withoutCacheControl(thirdMessages) as any[];
    expect(isDeepStrictEqual(resumed.slice(0, stripped.length), stripped)).toBe(true);
    expect(String(third.headers['anthropic-beta'])).toContain(ANTHROPIC_BETA);
  });

  it('Claude: a turn that got no answer, then another change, places both effort messages', async () => {
    const { workspace, provider, posts } = await setup({
      kind: 'anthropic',
      model: 'claude-haiku-5-5',
      scope: 'any-endpoint',
      fake: { failRequest: 2 },
    });
    await drive(workspace, provider, 'claude-haiku-5-5', [
      'first effort question',
      '/effort low',
      'second effort question',
      '/effort high',
      'third effort question',
      'fourth effort question',
    ]);
    const requests = posts();
    const third = requests.find((request) => JSON.stringify(request.body).includes('third effort question'))!;
    expect(third).toBeDefined();
    expect(JSON.stringify(third.body)).not.toContain(SENTINEL);
    const roles = third.body.messages.map((message: any) =>
      message.role === 'system' ? `system:${message.output_config.effort}` : message.role,
    );
    expect(roles).toEqual(['user', 'assistant', 'system:low', 'user', 'system:high', 'user']);
    expect(third.body.output_config).toEqual({ effort: 'medium' });
    expect(effective(third.body)).toBe('high');
    const fourth = requests.at(-1)!;
    expect(textOf(fourth.body.messages.at(-1))).toContain('fourth effort question');
    expect(effective(fourth.body)).toBe('high');
  });

  it('Claude: an endpoint that rejects the effort message falls back once and continues', async () => {
    const { workspace, provider, posts } = await setup({
      kind: 'anthropic',
      model: 'claude-haiku-5-5',
      scope: 'any-endpoint',
      fake: { rejectEffortItems: true },
    });
    await drive(
      workspace,
      provider,
      'claude-haiku-5-5',
      ['first effort question', '/effort low', 'second effort question', '/effort high', 'third effort question'],
      { expectVisible: FALLBACK_NOTICE },
    );
    const requests = posts();
    expect(requests.filter((request) => hasEffortItem(request.body))).toHaveLength(1);
    const retried = requests[requests.findIndex((request) => hasEffortItem(request.body)) + 1]!;
    expect(retried.body.output_config).toEqual({ effort: 'low' });
    expect(String(retried.headers['anthropic-beta'] ?? '')).not.toContain(ANTHROPIC_BETA);
    expect(requests.at(-1)!.body.output_config).toEqual({ effort: 'high' });
    expect(JSON.stringify(requests)).not.toContain(SENTINEL);
  });

  it('first-party scope keeps today on an Anthropic-format endpoint that is not api.anthropic.com', async () => {
    const { workspace, provider, posts } = await setup({
      kind: 'anthropic',
      model: 'claude-haiku-5-5',
      scope: 'first-party',
    });
    await drive(workspace, provider, 'claude-haiku-5-5', [
      'first effort question',
      '/effort low',
      'second effort question',
    ]);
    const [first, second] = posts();
    expect(first!.body.output_config).toEqual({ effort: 'medium' });
    expect(second!.body.output_config).toEqual({ effort: 'low' });
    expect(second!.body.messages.some((message: any) => message.role === 'system')).toBe(false);
    expect(String(second!.headers['anthropic-beta'] ?? '')).not.toContain(ANTHROPIC_BETA);
  });
});
