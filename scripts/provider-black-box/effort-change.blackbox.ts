import { createServer, type IncomingMessage } from 'node:http';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
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
 * input (src/model/effort-updates.ts); every other model keeps today's request.
 * Measured cache behaviour: docs/research/model-effort-step-down-cache-economics.md.
 */

type Captured = { url: string; headers: IncomingMessage['headers']; body: any };
type Fake = { baseUrl: string; requests: Captured[]; close(): Promise<void> };

const ANTHROPIC_BETA = 'mid-conversation-output-config-2026-07-01';

async function startFake(): Promise<Fake> {
  const requests: Captured[] = [];
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
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'close' });
    const send = (data: unknown, event?: string) =>
      res.write(`${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`);
    const text = `effort fixture answer ${n}`;
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

type Route = { kind: 'openai'; model: string } | { kind: 'anthropic'; model: string; perMessageEffort?: boolean };

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined);
});

async function setup(route: Route) {
  const fake = await startFake();
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
            openai: { apiKey: 'fixture-key' },
          },
          app: { liteMode: true },
          ...(route.kind === 'anthropic'
            ? {
                providers: [
                  {
                    id: provider,
                    name: provider,
                    type: 'anthropic',
                    baseUrl: fake.baseUrl,
                    apiKey: 'fixture-key',
                    ...(route.perMessageEffort !== undefined ? { perMessageEffort: route.perMessageEffort } : {}),
                  },
                ],
              }
            : {}),
        }),
      );
    },
  });
  cleanups.push(() => workspace.cleanup());
  return { fake, workspace, provider, env };
}

/** Two turns in one process with `/effort low` between them. */
async function twoTurnsWithEffortChange(workspace: IsolatedWorkspaceLease, provider: string, model: string) {
  const child: PtyChildDriver = await workspace.start({
    args: ['--lite', '--provider', provider, '--model', model],
    env: { TERM2_CONVERSATIONS_DIR: workspace.paths.conversationsDir },
  });
  cleanups.push(() => child.cleanup());
  let idle = await child.waitForIdleInput();
  await writePtyTextAndSubmit(child, 'first effort question');
  await child.waitForVisibleOutput('effort fixture answer 1');
  idle = await child.waitForIdleInput({ after: idle });
  await writePtyTextAndSubmit(child, '/effort low');
  await child.waitForVisibleOutput(`${model} · low`);
  idle = await child.waitForIdleInput({ after: idle });
  await writePtyTextAndSubmit(child, 'second effort question');
  await child.waitForVisibleOutput('effort fixture answer 2');
  await child.waitForIdleInput({ after: idle });
  await exitInteractive(child);
}

/** A new process resumes the conversation (full-history request) for a third turn at the current effort. */
async function resumeInteractive(workspace: IsolatedWorkspaceLease, provider: string, model: string) {
  const id = (await readdir(workspace.paths.conversationsDir)).find((name) => name.endsWith('.jsonl'))!.slice(0, -6);
  const child: PtyChildDriver = await workspace.start({
    args: ['--lite', '--provider', provider, '--model', model, '--resume', id.replace(/^conv_/, '')],
    env: { TERM2_CONVERSATIONS_DIR: workspace.paths.conversationsDir },
  });
  cleanups.push(() => child.cleanup());
  const idle = await child.waitForIdleInput();
  await writePtyTextAndSubmit(child, 'third effort question');
  await child.waitForVisibleOutput('effort fixture answer 3');
  await child.waitForIdleInput({ after: idle });
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

describe('cache-preserving effort change', () => {
  it('GPT-6 on the Responses path keeps the anchor and top-level effort, adding only configuration_update', async () => {
    const { fake, workspace } = await setup({ kind: 'openai', model: 'gpt-6-sol' });
    await twoTurnsWithEffortChange(workspace, 'openai', 'gpt-6-sol');
    const [first, second] = fake.requests.filter((request) => request.url.endsWith('/responses'));
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
    expect(delta.filter((item) => item.type === 'configuration_update')).toHaveLength(1);

    // Resume (new process, full history): the marker is rebuilt from the log at the same place.
    await resumeInteractive(workspace, 'openai', 'gpt-6-sol');
    const third = fake.requests.filter((request) => request.url.endsWith('/responses'))[2]!;
    expect(third.body.previous_response_id).toBeUndefined();
    expect(third.body.reasoning).toEqual(first!.body.reasoning);
    expect(third.body.instructions).toBe(first!.body.instructions);
    expect(third.body.tools).toEqual(first!.body.tools);
    const full = third.body.input as any[];
    const types = full.map((item) => (item.type === 'message' ? `${item.role}:${textOf(item).slice(-22)}` : item.type));
    const firstQuestion = types.findIndex((entry) => entry.endsWith('first effort question'));
    const secondQuestion = types.findIndex((entry) => entry.endsWith('second effort question'));
    expect(full[secondQuestion - 1]).toEqual({ type: 'configuration_update', reasoning: { effort: 'low' } });
    expect(
      full.slice(firstQuestion, secondQuestion + 1).filter((item) => item.type === 'configuration_update'),
    ).toHaveLength(1);
    // The resumed full request's opening equals the original first request's input.
    expect(full.slice(0, (first!.body.input as any[]).length)).toEqual(first!.body.input);
  });

  it('a pre-GPT-6 Responses model keeps today: anchor dropped, effort top-level, no configuration_update', async () => {
    const { fake, workspace } = await setup({ kind: 'openai', model: 'gpt-5.6-sol' });
    await twoTurnsWithEffortChange(workspace, 'openai', 'gpt-5.6-sol');
    const [first, second] = fake.requests.filter((request) => request.url.endsWith('/responses'));
    expect(first!.body.reasoning.effort).toBe('medium');
    expect(second!.body.reasoning.effort).toBe('low');
    expect(second!.body.previous_response_id).toBeUndefined();
    expect(JSON.stringify(second!.body)).not.toContain('configuration_update');
  });

  it('Claude Haiku 5.5 keeps the prefix byte-identical and adds only the effort message and beta', async () => {
    const { fake, workspace, provider } = await setup({
      kind: 'anthropic',
      model: 'claude-haiku-5-5',
      perMessageEffort: true,
    });
    await twoTurnsWithEffortChange(workspace, provider, 'claude-haiku-5-5');
    const [first, second] = fake.requests.filter((request) => request.url.endsWith('/messages'));
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
    expect(JSON.stringify(second!.body)).not.toContain('term2-effort-update');

    // Resume rebuilds the identical prefix, effort message included.
    await resumeInteractive(workspace, provider, 'claude-haiku-5-5');
    const third = fake.requests.filter((request) => request.url.endsWith('/messages'))[2]!;
    const { messages: thirdMessages, ...thirdRest } = third.body;
    expect(withoutCacheControl(thirdRest)).toEqual(withoutCacheControl(firstRest));
    const resumed = withoutCacheControl(thirdMessages) as any[];
    expect(isDeepStrictEqual(resumed.slice(0, stripped.length), stripped)).toBe(true);
    expect(String(third.headers['anthropic-beta'])).toContain(ANTHROPIC_BETA);
  });

  it('a Claude endpoint without per-message effort keeps today: effort top-level, no effort message or beta', async () => {
    const { fake, workspace, provider } = await setup({ kind: 'anthropic', model: 'claude-haiku-5-5' });
    await twoTurnsWithEffortChange(workspace, provider, 'claude-haiku-5-5');
    const [first, second] = fake.requests.filter((request) => request.url.endsWith('/messages'));
    expect(first!.body.output_config).toEqual({ effort: 'medium' });
    expect(second!.body.output_config).toEqual({ effort: 'low' });
    expect(second!.body.messages.some((message: any) => message.role === 'system')).toBe(false);
    expect(String(second!.headers['anthropic-beta'] ?? '')).not.toContain(ANTHROPIC_BETA);
  });
});
