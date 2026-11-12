import { createServer } from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { createProviderRegistry } from '../../src/model/provider.js';
import { RetryRecoveryBudget } from '../../src/model/failure/retry-recovery-budget.js';
import type { Model, ModelRequest } from '../../src/model/index.js';
import { createMockSettingsService } from '../helpers/settings-service.mock.js';

const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  security() {},
  setCorrelationId() {},
  getCorrelationId: () => undefined,
  clearCorrelationId() {},
};
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const cases = [
  ['custom-openai', 'openai', 'fixture', '/v1/chat/completions'],
  ['custom-compatible', 'openai-compatible', 'fixture', '/v1/chat/completions'],
  ['opencode-responses', 'opencode', 'gpt-test', '/v1/responses'],
  ['opencode-chat', 'opencode', 'deepseek-test', '/v1/chat/completions'],
] as const;

async function fixture(statuses: number[]) {
  const receipts: Array<{ url: string; body: Record<string, unknown>; bytes: number }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks);
    const body = JSON.parse(raw.toString());
    receipts.push({ url: request.url ?? '', body, bytes: raw.byteLength });
    const status = statuses.shift() ?? 429;
    if (status !== 200) {
      response.writeHead(status, { 'content-type': 'application/json', 'retry-after': '0.001' });
      response.end(JSON.stringify({ error: { message: 'Fixture rate limit', type: 'rate_limit_error' } }));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (value: unknown) => response.write(`data: ${JSON.stringify(value)}\n\n`);
    if (request.url?.endsWith('/responses')) {
      send({
        type: 'response.completed',
        response: {
          id: 'resp_retry_fixture',
          status: 'completed',
          model: body.model,
          output: [
            {
              type: 'message',
              id: 'msg_retry_fixture',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'ok', annotations: [] }],
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      });
    } else {
      send({
        id: 'chat_retry_fixture',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }],
      });
      send({
        id: 'chat_retry_fixture',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
      response.write('data: [DONE]\n\n');
    }
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  );
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
  return { receipts, baseUrl: `http://127.0.0.1:${address.port}/v1` };
}

function resolveModel(id: string, type: string, model: string, baseUrl: string): Model {
  return createProviderRegistry({
    settings: createMockSettingsService({
      'agent.retryAttempts': 2,
      providers: [{ name: id, type, baseUrl, apiKey: 'fixture' }],
    }),
    logger,
  }).resolve({ provider: id, model });
}

async function collect(model: Model, overrides: Partial<ModelRequest> = {}) {
  const events = [];
  for await (const event of model.stream(
    {
      model: model.ref,
      instructions: 'Keep all instructions and tools.',
      input: [
        {
          type: 'user_message',
          id: 'user_retry_fixture' as ModelRequest['input'][number]['id'],
          content: [{ type: 'text', text: 'Reply ok.' }],
        },
      ],
      tools: [{ name: 'fixture_tool', description: 'Keep this tool.', inputSchema: { type: 'object' } }],
      ...overrides,
    },
    new AbortController().signal,
  ))
    events.push(event);
  return events;
}

it.each(cases)('%s exposes one failed HTTP attempt to the engine recovery owner', async (id, type, name, url) => {
  const wire = await fixture([429]);
  const model = resolveModel(id, type, name, wire.baseUrl);
  await expect(collect(model, { recovery: { budget: new RetryRecoveryBudget() } })).rejects.toMatchObject({
    kind: 'rate_limit',
    retryable: true,
  });
  expect(wire.receipts.map((receipt) => receipt.url)).toEqual([url]);
});

it.each(cases)('%s keeps standalone retries visible and bounded', async (id, type, name) => {
  const wire = await fixture([429, 429, 200]);
  const model = resolveModel(id, type, name, wire.baseUrl);
  const events = await collect(model);
  expect(events.filter((event) => event.type === 'retrying')).toHaveLength(2);
  expect(events.at(-1)?.type).toBe('done');
  expect(wire.receipts).toHaveLength(3);
  expect(
    wire.receipts.every((receipt) => JSON.stringify(receipt.body) === JSON.stringify(wire.receipts[0]!.body)),
  ).toBe(true);
});

it.each(cases)('%s exhausts standalone recovery after three HTTP attempts', async (id, type, name) => {
  const wire = await fixture([]);
  const model = resolveModel(id, type, name, wire.baseUrl);
  await expect(collect(model)).rejects.toMatchObject({ kind: 'rate_limit', retryable: true });
  expect(wire.receipts).toHaveLength(3);
});

it.each(cases)('%s accepts updated instructions on an explicit recovery dispatch', async (id, type, name) => {
  const wire = await fixture([429, 200]);
  const model = resolveModel(id, type, name, wire.baseUrl);
  const budget = new RetryRecoveryBudget();
  await expect(collect(model, { recovery: { budget } })).rejects.toMatchObject({ kind: 'rate_limit' });
  budget.noteRetryableFailure();
  expect(budget.claimPhysicalAttempt()).toBe(true);
  const events = await collect(model, {
    instructions: 'Steered after failure. Keep the tool.',
    recovery: { budget, dispatchClaimed: true },
  });
  expect(events.at(-1)?.type).toBe('done');
  expect(wire.receipts).toHaveLength(2);
  expect(JSON.stringify(wire.receipts[1]!.body)).toContain('Steered after failure. Keep the tool.');
  expect(wire.receipts[1]!.body.tools).toEqual(wire.receipts[0]!.body.tools);
});

it.each(cases)('%s retains recovery for SDK timeout and conflict statuses', async (id, type, name) => {
  for (const status of [408, 409]) {
    const wire = await fixture([status, 200]);
    const events = await collect(resolveModel(id, type, name, wire.baseUrl));
    expect(events.filter((event) => event.type === 'retrying')).toHaveLength(1);
    expect(events.at(-1)?.type).toBe('done');
    expect(wire.receipts).toHaveLength(2);
  }
});
