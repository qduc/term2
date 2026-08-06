import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ApplicationRunLoop,
  MaxTurnsExceededError,
  normalizeApplicationInput,
  type ApplicationAgent,
} from './application-run-loop.js';
import {
  consumeOpenAIRequestPrefixBindingWithOutcome,
  prepareOpenAIRequestPrefixBinding,
  runWithOpenAIRequestPrefixBindingScope,
} from '../../providers/openai-request-prefix-binding.js';
import { isDeepStrictEqual } from 'node:util';
import type { StreamedModelTurn } from '../../contracts/streamed-model-turn.js';
import type { ToolDefinition } from '../../tools/types.js';
import { HarnessInvariantError } from '../../lib/harness-invariant-error.js';

const agent: ApplicationAgent = {
  name: 'test-agent',
  instructions: 'Be concise.',
  model: 'test-model',
  tools: [],
};

describe('normalizeApplicationInput opaque lane', () => {
  it('carries a providerOpaque-marked item through untouched as provider_opaque', () => {
    const history = [
      {
        type: 'compaction',
        id: 'cmp_1',
        encrypted_content: 'opaque-blob',
        providerOpaque: { provider: 'openai' },
      },
    ] as any;
    expect(normalizeApplicationInput(history)).toEqual([
      {
        type: 'provider_opaque',
        provider: 'openai',
        item: { type: 'compaction', id: 'cmp_1', encrypted_content: 'opaque-blob' },
      },
    ]);
  });

  it('strips the internal providerOpaque marker from the carried wire item', () => {
    const history = [{ type: 'compaction', encrypted_content: 'blob', providerOpaque: { provider: 'openai' } }] as any;
    const normalized = normalizeApplicationInput(history);
    expect(normalized).toHaveLength(1);
    expect(normalized[0]).toMatchObject({ type: 'provider_opaque', provider: 'openai' });
    expect(JSON.stringify(normalized)).not.toContain('providerOpaque');
  });

  it('still throws for an unknown item type without the opaque marker', () => {
    expect(() => normalizeApplicationInput([{ type: 'compaction', id: 'cmp_1' }] as any)).toThrow(
      'Unsupported restored input item type: compaction',
    );
  });
});

async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function textModel(text: string, responseId: string): StreamedModelTurn {
  return {
    async *stream() {
      yield { type: 'text_delta', text };
      yield {
        type: 'completion',
        responseId,
        output: [{ type: 'message', content: [{ type: 'text', text }] }],
      };
    },
  };
}

describe('ApplicationRunLoop', () => {
  it.each(['root', 'continuation'] as const)(
    'binds the exact %s application request at the OpenAI boundary',
    async (mode) => {
      const history = [
        { type: 'message', role: 'user', content: 'run the tool' },
        { type: 'function_call', callId: 'call-1', name: 'lookup', arguments: '{}' },
        { type: 'function_call_result', callId: 'call-1', name: 'lookup', output: 'done' },
      ] as any;
      const bindingOutcomes: unknown[] = [];
      const model: StreamedModelTurn = {
        async *stream(request) {
          bindingOutcomes.push(consumeOpenAIRequestPrefixBindingWithOutcome(request.input));
          yield { type: 'completion', responseId: 'resp-bind', output: [] };
        },
      };
      const canonical = normalizeApplicationInput(history);
      const preparation = {
        prepare: (request: any) => {
          if (isDeepStrictEqual(canonical, request.input)) {
            prepareOpenAIRequestPrefixBinding(
              { snapshotIdentity: 'history', snapshotRevision: 3, lineage: 0 },
              request.input,
            );
          }
        },
        run: <T>(operation: () => Promise<T>) => runWithOpenAIRequestPrefixBindingScope(operation),
      };
      const loop = new ApplicationRunLoop({ resolveModel: () => model });
      const first = loop.startStream(agent, history, { requestPreparation: preparation });
      await first.completed;
      if (mode === 'continuation') {
        const continued = loop.continueRunStream(first.state!, { requestPreparation: preparation });
        await continued.completed;
      }

      expect(bindingOutcomes).toEqual([
        { binding: { snapshotIdentity: 'history', snapshotRevision: 3, lineage: 0 } },
        ...(mode === 'continuation'
          ? [{ binding: { snapshotIdentity: 'history', snapshotRevision: 3, lineage: 0 } }]
          : []),
      ]);
    },
  );

  it('fails closed when the canonical request differs from the supplied snapshot', async () => {
    const model: StreamedModelTurn = {
      async *stream(request) {
        yield { type: 'completion', responseId: 'resp-mismatch', output: [] };
        expect(consumeOpenAIRequestPrefixBindingWithOutcome(request.input)).toEqual({
          outcome: 'not_prepared',
        });
      },
    };
    const loop = new ApplicationRunLoop({ resolveModel: () => model });
    const preparation = {
      prepare: () => {},
      run: <T>(operation: () => Promise<T>) => runWithOpenAIRequestPrefixBindingScope(operation),
    };
    const stream = loop.startStream(agent, 'different request', { requestPreparation: preparation });
    await stream.completed;
  });

  it('forwards live reasoning and tool-argument progress as application events', async () => {
    const model: StreamedModelTurn = {
      async *stream() {
        yield { type: 'reasoning_delta' as const, text: 'Thinking' };
        yield { type: 'tool_call_streaming_delta' as const, toolName: 'shell', argumentCharCount: 12 };
        yield { type: 'completion' as const, responseId: 'resp-live', output: [] };
      },
    };
    const loop = new ApplicationRunLoop({ resolveModel: () => model });
    const stream = loop.startStream(agent, 'hello');

    await expect(collect(stream)).resolves.toEqual([
      { type: 'reasoning_delta', text: 'Thinking' },
      { type: 'tool_call_streaming_delta', toolName: 'shell', argumentCharCount: 12 },
    ]);
  });

  it('forwards Codex ChatGPT-plan rate limits as provider model events', async () => {
    const model: StreamedModelTurn = {
      async *stream() {
        yield {
          type: 'codex_rate_limits' as const,
          rateLimits: {
            allowed: true,
            limit_reached: false,
            primary: { used_percent: 11, window_minutes: 300, reset_after_seconds: 60, reset_at: 1_700_000_000 },
            secondary: {
              used_percent: 14,
              window_minutes: 10_080,
              reset_after_seconds: 120,
              reset_at: 1_700_000_100,
            },
          },
        };
        yield { type: 'completion' as const, responseId: 'resp-limits', output: [] };
      },
    };

    const stream = new ApplicationRunLoop({ resolveModel: () => model }).startStream(agent, 'prompt');
    await collect(stream);

    expect(stream.output).toContainEqual({
      type: 'codex_rate_limits',
      rateLimits: expect.objectContaining({
        primary: expect.objectContaining({ window_minutes: 300 }),
        secondary: expect.objectContaining({ window_minutes: 10_080 }),
      }),
    });
  });

  it('retains display deltas and provider items in distinct terminal event shapes', async () => {
    const stream = new ApplicationRunLoop({
      resolveModel: () => textModel('streamed answer', 'resp-delta'),
    }).startStream(agent, 'prompt');

    await collect(stream);

    expect(stream.output).toEqual([
      { type: 'text_delta', text: 'streamed answer' },
      {
        type: 'item',
        item: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'streamed answer' }],
        },
      },
    ]);
    expect(stream.newItems).toEqual(stream.output);
  });

  it('forwards the previous response id to the first turn and chains internal follow-up turns', async () => {
    const requests: Array<{ previousResponseId?: string | null; input: unknown }> = [];
    let calls = 0;
    const model: StreamedModelTurn = {
      async *stream(request) {
        requests.push({ previousResponseId: request.previousResponseId, input: request.input });
        calls++;
        if (calls === 1) {
          yield { type: 'tool_call', id: 'call-1', name: 'missing-tool', arguments: '{}' };
          yield { type: 'completion', responseId: 'resp-1', output: [] };
          return;
        }
        yield { type: 'completion', responseId: 'resp-2', output: [] };
      },
    };

    const loop = new ApplicationRunLoop({ resolveModel: () => model });
    const stream = loop.startStream(agent, 'follow up', {
      previousResponseId: 'resp-before',
      providerId: 'openai',
      supportsConversationChaining: true,
    });
    await stream.completed;

    expect(requests).toEqual([
      expect.objectContaining({ previousResponseId: 'resp-before' }),
      expect.objectContaining({ previousResponseId: 'resp-1' }),
    ]);
  });

  it.each([
    ['openai', 'codex'],
    ['codex', 'openai'],
  ] as const)('does not forward a response ID across %s to %s continuation', async (origin, current) => {
    const requests: Array<{ previousResponseId?: string | null }> = [];
    let calls = 0;
    const model: StreamedModelTurn = {
      async *stream(request) {
        requests.push({ previousResponseId: request.previousResponseId });
        calls += 1;
        yield { type: 'completion', responseId: calls === 1 ? `resp-${origin}` : `resp-${current}`, output: [] };
      },
    };
    const loop = new ApplicationRunLoop({ resolveModel: () => model });
    const first = loop.startStream(agent, 'prompt', {
      providerId: origin,
      supportsConversationChaining: true,
    });
    await first.completed;
    const continued = loop.continueRunStream(first.state!, {
      providerId: current,
      supportsConversationChaining: true,
    });
    await continued.completed;

    expect(requests).toEqual([{}, {}]);
    expect(continued.lastResponseId).toBe(`resp-${current}`);
  });

  it('fails closed for a legacy continuation without response provenance', async () => {
    const requests: Array<{ previousResponseId?: string | null }> = [];
    const model: StreamedModelTurn = {
      async *stream(request) {
        requests.push({ previousResponseId: request.previousResponseId });
        yield { type: 'completion', responseId: 'resp-legacy', output: [] };
      },
    };
    const loop = new ApplicationRunLoop({ resolveModel: () => model });
    const first = loop.startStream(agent, 'prompt', { supportsConversationChaining: true });
    await first.completed;
    const continued = loop.continueRunStream(first.state!, {
      previousResponseId: 'resp-untrusted',
      providerId: 'openai',
      supportsConversationChaining: true,
    });
    await continued.completed;

    expect(requests).toEqual([{}, {}]);
  });

  it('commits native reasoning as one canonical item before a streamed tool continuation', async () => {
    const requests: Array<Parameters<StreamedModelTurn['stream']>[0]> = [];
    let calls = 0;
    const model: StreamedModelTurn = {
      async *stream(request) {
        requests.push(request);
        calls++;
        if (calls === 1) {
          yield {
            type: 'reasoning_delta',
            id: 'rs_codex',
            text: 'Use the lookup tool.',
            providerMetadata: { codex: { encrypted_content: 'cipher' } },
          };
          yield { type: 'tool_call', id: 'call_codex', name: 'lookup', arguments: '{}' };
          yield {
            type: 'completion',
            responseId: 'resp_codex_tool',
            output: [{ type: 'tool_call', id: 'call_codex', name: 'lookup', arguments: '{}' }],
          };
          return;
        }
        yield { type: 'completion', responseId: 'resp_codex_done', output: [] };
      },
    };
    const loop = new ApplicationRunLoop({ resolveModel: () => model });
    const stream = loop.startStream(
      {
        ...agent,
        tools: [
          {
            name: 'lookup',
            parameters: { type: 'object' },
            needsApproval: async () => false,
            execute: async () => 'fixture result',
          },
        ] as any,
      },
      'look this up',
    );
    await stream.completed;

    expect(requests[1]?.input).toEqual(
      expect.arrayContaining([
        {
          type: 'reasoning',
          id: 'rs_codex',
          text: 'Use the lookup tool.',
          providerMetadata: { codex: { encrypted_content: 'cipher' } },
        },
        { type: 'tool_call', id: 'call_codex', name: 'lookup', arguments: '{}' },
        { type: 'tool_result', id: 'call_codex', output: 'fixture result' },
      ]),
    );
    const reasoningItems = stream.newItems
      .filter((event: any) => event?.type === 'item')
      .map((event: any) => event.item)
      .filter((item: any) => item?.type === 'reasoning');
    expect(reasoningItems).toEqual([
      {
        type: 'reasoning',
        id: 'rs_codex',
        content: [{ type: 'reasoning_text', text: 'Use the lookup tool.' }],
        providerData: { codex: { encrypted_content: 'cipher' } },
      },
    ]);
  });

  it.each([
    ['Codex', { codex: { encrypted_content: 'cipher' } }],
    ['OpenAI', { openai: { encrypted_content: 'cipher' } }],
    ['Chat', { reasoning_content: 'native chat reasoning' }],
  ])('commits no-tool native %s reasoning for stateless replay exactly once', async (_provider, providerMetadata) => {
    const requests: Array<Parameters<StreamedModelTurn['stream']>[0]> = [];
    let calls = 0;
    const model: StreamedModelTurn = {
      async *stream(request) {
        requests.push(request);
        calls++;
        if (calls === 1) {
          yield {
            type: 'completion',
            responseId: 'resp-native-reasoning',
            output: [
              {
                type: 'reasoning',
                id: 'rs-no-tool',
                text: 'Native reasoning before the answer.',
                providerMetadata,
              },
              { type: 'message', content: [{ type: 'text', text: 'Answer.' }] },
            ],
          };
          return;
        }
        yield { type: 'completion', responseId: 'resp-replayed', output: [] };
      },
    };
    const loop = new ApplicationRunLoop({ resolveModel: () => model });
    const first = loop.startStream(agent, 'first prompt');
    await first.completed;

    const nativeReasoningText =
      (providerMetadata as { reasoning_content?: string }).reasoning_content ?? 'Native reasoning before the answer.';
    expect(first.history.filter((item: any) => item.role === 'assistant' || item.type === 'reasoning')).toEqual([
      {
        type: 'reasoning',
        id: 'rs-no-tool',
        content: [{ type: 'reasoning_text', text: nativeReasoningText }],
        providerData: providerMetadata,
      },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Answer.' }],
      },
    ]);
    expect(first.output.filter((item: any) => item?.type === 'item' && item.item?.type === 'reasoning')).toHaveLength(
      1,
    );

    const replay = loop.startStream(agent, first.history as any);
    await replay.completed;
    expect(requests[1]?.input).toEqual(
      expect.arrayContaining([
        {
          type: 'reasoning',
          id: 'rs-no-tool',
          text: nativeReasoningText,
          providerMetadata,
        },
        { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'Answer.' }] },
      ]),
    );
  });

  it('keeps generic display reasoning out of canonical native replay history', async () => {
    const model: StreamedModelTurn = {
      async *stream() {
        yield {
          type: 'completion',
          responseId: 'resp-generic-reasoning',
          output: [
            {
              type: 'reasoning',
              text: 'Provider display reasoning.',
              providerMetadata: { anthropic: { thinking: 'opaque' } },
            },
            { type: 'message', content: [{ type: 'text', text: 'Answer.' }] },
          ],
        };
      },
    };
    const stream = new ApplicationRunLoop({ resolveModel: () => model }).startStream(agent, 'prompt');
    await stream.completed;

    expect(stream.history.filter((item: any) => item.type === 'reasoning')).toEqual([]);
    expect(stream.history).toEqual(
      expect.arrayContaining([
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Answer.' }],
        },
      ]),
    );
  });

  it('forwards providerData as providerOptions and omits it when absent', async () => {
    const requests: unknown[] = [];
    const model: StreamedModelTurn = {
      async *stream(request) {
        requests.push(request);
        yield { type: 'completion', responseId: 'resp-settings', output: [] };
      },
    };

    await collect(
      new ApplicationRunLoop({ resolveModel: () => model }).startStream(
        {
          ...agent,
          modelSettings: { providerData: { nested: { option: 'value' }, scalar: true } },
        },
        'with provider data',
      ),
    );
    await collect(new ApplicationRunLoop({ resolveModel: () => model }).startStream(agent, 'without provider data'));

    expect(requests[0]).toEqual(
      expect.objectContaining({
        providerOptions: { nested: { option: 'value' }, scalar: true },
      }),
    );
    expect(requests[1]).not.toHaveProperty('providerOptions');
  });

  it('projects application maxTokens and typed Codex options on initial and internal turns', async () => {
    const requests: Array<Parameters<StreamedModelTurn['stream']>[0]> = [];
    let calls = 0;
    const model: StreamedModelTurn = {
      async *stream(request) {
        requests.push(request);
        calls++;
        if (calls === 1) {
          yield { type: 'tool_call', id: 'call-1', name: 'missing-tool', arguments: '{}' };
          yield { type: 'completion', responseId: 'resp-1', output: [] };
          return;
        }
        yield { type: 'completion', responseId: 'resp-2', output: [] };
      },
    };

    await collect(
      new ApplicationRunLoop({ resolveModel: () => model }).startStream(
        {
          ...agent,
          modelSettings: {
            maxTokens: 321,
            codex: { promptCacheKey: 'session-a', include: ['reasoning.encrypted_content'] },
          },
        },
        'continue',
      ),
    );

    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request).toMatchObject({
        maxTokens: 321,
        codex: { promptCacheKey: 'session-a', include: ['reasoning.encrypted_content'] },
      });
      expect(request).not.toHaveProperty('temperature');
    }
  });

  it('normalizes restored provider content arrays into typed turn inputs', async () => {
    const requests: Array<Parameters<StreamedModelTurn['stream']>[0]> = [];
    const model: StreamedModelTurn = {
      async *stream(request) {
        requests.push(request);
        yield { type: 'completion', responseId: 'resp-restored', output: [] };
      },
    };
    const restoredHistory = [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'first persisted prompt' }],
      },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'persisted answer' }],
      },
      {
        type: 'reasoning',
        id: 'reasoning-restored',
        content: [{ type: 'reasoning_text', text: 'persisted reasoning' }],
        providerData: { signature: 'fixture-signature' },
      },
      {
        type: 'function_call',
        callId: 'call-restored',
        name: 'shell',
        arguments: '{"command":"printf fixture"}',
      },
      {
        type: 'function_call_output',
        callId: 'call-restored',
        output: [{ type: 'text', text: 'persisted tool result' }],
      },
    ];

    const stream = new ApplicationRunLoop({ resolveModel: () => model }).startStream(agent, restoredHistory);
    await stream.completed;

    expect(requests[0]?.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'text', text: 'first persisted prompt' }],
      },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'persisted answer' }],
      },
      {
        type: 'reasoning',
        id: 'reasoning-restored',
        text: 'persisted reasoning',
        providerMetadata: { signature: 'fixture-signature' },
      },
      {
        type: 'tool_call',
        id: 'call-restored',
        name: 'shell',
        arguments: '{"command":"printf fixture"}',
      },
      {
        type: 'tool_result',
        id: 'call-restored',
        output: [{ type: 'text', text: 'persisted tool result' }],
      },
    ]);
  });

  it('rejects unsupported restored content parts instead of stringifying them', () => {
    expect(() =>
      new ApplicationRunLoop({ resolveModel: () => textModel('unused', 'resp-unused') }).startStream(agent, {
        type: 'message',
        role: 'user',
        content: [{ type: 'unsupported_part', value: 'fixture' }],
      }),
    ).toThrow('Unsupported restored input message content: unsupported_part');
  });

  it('exposes authoritative completion usage on its stream contract', async () => {
    const model: StreamedModelTurn = {
      async *stream() {
        yield {
          type: 'completion',
          responseId: 'resp-usage',
          output: [{ type: 'message', content: [{ type: 'text', text: 'done' }] }],
          usage: { inputTokens: 21, outputTokens: 4, cachedInputTokens: 3 },
        };
      },
    };
    const stream = new ApplicationRunLoop({ resolveModel: () => model }).startStream(agent, 'measure this');

    await stream.completed;

    expect(stream.runUsage).toEqual({ inputTokens: 21, outputTokens: 4, totalTokens: 25, cachedInputTokens: 3 });
  });

  it('accumulates usage across internal tool model completions including cache counters', async () => {
    let turns = 0;
    const model: StreamedModelTurn = {
      async *stream() {
        turns++;
        if (turns === 1) {
          yield { type: 'tool_call', id: 'call-usage', name: 'usage_tool', arguments: '{}' };
          yield {
            type: 'completion',
            responseId: 'resp-tool',
            output: [{ type: 'tool_call', id: 'call-usage', name: 'usage_tool', arguments: '{}' }],
            usage: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 4, cacheWriteTokens: 1 },
          };
          return;
        }
        yield {
          type: 'completion',
          responseId: 'resp-final',
          output: [{ type: 'message', content: [{ type: 'text', text: 'done' }] }],
          usage: { inputTokens: 20, outputTokens: 3, cachedInputTokens: 5, cacheWriteTokens: 2 },
        };
      },
    };
    const tool: ToolDefinition = {
      name: 'usage_tool',
      description: 'Reports usage',
      parameters: z.object({}),
      needsApproval: () => false,
      execute: () => 'ok',
      formatCommandMessage: () => [],
    };
    const stream = new ApplicationRunLoop({ resolveModel: () => model }).startStream(
      { ...agent, tools: [tool] },
      'use the tool',
    );

    await stream.completed;

    expect(stream.runUsage).toEqual({
      inputTokens: 30,
      outputTokens: 5,
      totalTokens: 38,
      cachedInputTokens: 9,
      cacheWriteTokens: 3,
    });
  });

  it('owns a text turn without an SDK runner', async () => {
    const loop = new ApplicationRunLoop({ resolveModel: () => textModel('hello', 'resp-1') });
    const stream = loop.startStream(agent, 'say hello', {
      providerId: 'openai',
      supportsConversationChaining: true,
    });

    const events = await collect(stream);
    await stream.completed;

    expect(events).toEqual([{ type: 'text_delta', text: 'hello' }, expect.objectContaining({ type: 'item' })]);
    expect(stream.finalOutput).toBe('hello');
    expect(stream.lastResponseId).toBe('resp-1');
  });

  it('executes a tool and feeds its result into the next model turn', async () => {
    let calls = 0;
    const parameters = z.object({ value: z.string() });
    const tool: ToolDefinition<typeof parameters> = {
      name: 'echo',
      description: 'Echo a value',
      parameters,
      needsApproval: () => false,
      execute: ({ value }) => value,
      formatCommandMessage: () => [],
    };
    const loop = new ApplicationRunLoop({
      resolveModel: () => {
        calls++;
        return calls === 1
          ? {
              async *stream() {
                yield { type: 'tool_call', id: 'call-1', name: 'echo', arguments: '{"value":"ok"}' };
                yield { type: 'completion', responseId: 'resp-tool', output: [] };
              },
            }
          : textModel('done', 'resp-done');
      },
    });
    const stream = loop.startStream({ ...agent, tools: [tool] }, 'use echo');
    await collect(stream);

    expect(calls).toBe(2);
    expect(stream.history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'function_call', callId: 'call-1' }),
        expect.objectContaining({ type: 'function_call_result', callId: 'call-1', output: 'ok' }),
      ]),
    );
    expect(stream.finalOutput).toBe('done');
  });

  it('admits a steer as a user message after the tool result, before the next request', async () => {
    const requests: Array<Parameters<StreamedModelTurn['stream']>[0]> = [];
    let toolStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      toolStarted = resolve;
    });
    const parameters = z.object({});
    const tool: ToolDefinition<typeof parameters> = {
      name: 'work',
      description: 'Does work',
      parameters,
      needsApproval: () => false,
      execute: () => {
        toolStarted();
        return 'tool output';
      },
      formatCommandMessage: () => [],
    };
    let calls = 0;
    const loop = new ApplicationRunLoop({
      resolveModel: () => {
        calls++;
        return calls === 1
          ? {
              async *stream(request) {
                requests.push(request);
                yield { type: 'tool_call', id: 'call-1', name: 'work', arguments: '{}' };
                yield { type: 'completion', responseId: 'resp-1', output: [] };
              },
            }
          : {
              async *stream(request) {
                requests.push(request);
                yield { type: 'completion', responseId: 'resp-2', output: [] };
              },
            };
      },
    });

    const stream = loop.startStream({ ...agent, tools: [tool] }, 'do the work');
    await started;
    await expect(loop.steer([{ type: 'message', role: 'user', content: 'actually, do it differently' }])).resolves.toBe(
      true,
    );
    await collect(stream);

    // The steer reaches the model on the request that follows the tool result,
    // as a user message in its own right — never folded into the result.
    const secondRequest = requests[1]!.input as any[];
    const toolResultIndex = secondRequest.findIndex((item) => item.type === 'tool_result');
    const steerIndex = secondRequest.findIndex(
      (item) => item.type === 'message' && item.role === 'user' && JSON.stringify(item).includes('differently'),
    );
    expect(toolResultIndex).toBeGreaterThanOrEqual(0);
    expect(steerIndex).toBeGreaterThan(toolResultIndex);
    expect(secondRequest[toolResultIndex].output).toBe('tool output');

    // It is canonical history, so persistence and retries carry it too.
    expect(stream.history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'message', role: 'user', content: 'actually, do it differently' }),
      ]),
    );
  });

  it('holds a steer offered during an approval pause and admits it when the turn resumes', async () => {
    // The turn pauses at every approval and resumes as a new segment. A user
    // typing into that visible gap was previously refused outright, because
    // the steer's lifetime was the segment rather than the turn.
    const requests: Array<Parameters<StreamedModelTurn['stream']>[0]> = [];
    const tool: ToolDefinition = {
      name: 'danger',
      description: 'Requires approval',
      parameters: z.object({}),
      needsApproval: () => true,
      execute: () => 'approved result',
      formatCommandMessage: () => [],
    };
    let calls = 0;
    const loop = new ApplicationRunLoop({
      resolveModel: () => {
        calls++;
        return calls === 1
          ? {
              async *stream(request) {
                requests.push(request);
                yield { type: 'tool_call', id: 'call-approval', name: 'danger', arguments: '{}' };
                yield { type: 'completion', responseId: 'resp-pending', output: [] };
              },
            }
          : {
              async *stream(request) {
                requests.push(request);
                yield { type: 'completion', responseId: 'resp-resumed', output: [] };
              },
            };
      },
    });

    const stream = loop.startStream({ ...agent, tools: [tool] }, 'do it');
    await collect(stream);
    expect(stream.interruptions).toHaveLength(1);

    // The segment has ended, but the turn has not: the steer must wait, not
    // resolve false, so the caller does not fall back to a separate turn.
    const steered = loop.steer([{ type: 'message', role: 'user', content: 'wait, check the config first' }]);
    let settledEarly = false;
    void steered.then(() => {
      settledEarly = true;
    });
    await Promise.resolve();
    expect(settledEarly).toBe(false);

    const handle = stream.state! as any;
    handle.approve?.({});
    const resumed = loop.continueRunStream(stream.state!);
    await expect(steered).resolves.toBe(true);
    await collect(resumed);

    // It lands after the approved tool's result, on the resumed segment's request.
    const resumedRequest = requests[1]!.input as any[];
    const toolResultIndex = resumedRequest.findIndex((item) => item.type === 'tool_result');
    const steerIndex = resumedRequest.findIndex(
      (item) => item.type === 'message' && item.role === 'user' && JSON.stringify(item).includes('check the config'),
    );
    expect(toolResultIndex).toBeGreaterThanOrEqual(0);
    expect(steerIndex).toBeGreaterThan(toolResultIndex);
  });

  it('settles a steer waiting on a paused turn when the turn is aborted instead of resumed', async () => {
    const tool: ToolDefinition = {
      name: 'danger',
      description: 'Requires approval',
      parameters: z.object({}),
      needsApproval: () => true,
      execute: () => 'approved result',
      formatCommandMessage: () => [],
    };
    const loop = new ApplicationRunLoop({
      resolveModel: () => ({
        async *stream() {
          yield { type: 'tool_call', id: 'call-approval', name: 'danger', arguments: '{}' };
          yield { type: 'completion', responseId: 'resp-pending', output: [] };
        },
      }),
    });

    const stream = loop.startStream({ ...agent, tools: [tool] }, 'do it');
    await collect(stream);

    const steered = loop.steer([{ type: 'message', role: 'user', content: 'never admitted' }]);
    // An abandoned turn never resumes, so the caller must not wait forever.
    loop.abort();
    await expect(steered).resolves.toBe(false);
  });

  it('settles a steer waiting on a paused turn when a new turn starts instead', async () => {
    const tool: ToolDefinition = {
      name: 'danger',
      description: 'Requires approval',
      parameters: z.object({}),
      needsApproval: () => true,
      execute: () => 'approved result',
      formatCommandMessage: () => [],
    };
    let calls = 0;
    const loop = new ApplicationRunLoop({
      resolveModel: () => {
        calls++;
        return calls === 1
          ? {
              async *stream() {
                yield { type: 'tool_call', id: 'call-approval', name: 'danger', arguments: '{}' };
                yield { type: 'completion', responseId: 'resp-pending', output: [] };
              },
            }
          : textModel('fresh', 'resp-fresh');
      },
    });

    const stream = loop.startStream({ ...agent, tools: [tool] }, 'do it');
    await collect(stream);

    const steered = loop.steer([{ type: 'message', role: 'user', content: 'aimed at the old turn' }]);
    // The steer belonged to the abandoned turn and must not leak into this one.
    await collect(loop.startStream(agent, 'something else entirely'));
    await expect(steered).resolves.toBe(false);
  });

  it('reports a steer as unadmitted when the turn has no request boundary left', async () => {
    const loop = new ApplicationRunLoop({ resolveModel: () => textModel('done', 'resp-1') });
    const stream = loop.startStream(agent, 'answer me');
    await collect(stream);

    await expect(loop.steer([{ type: 'message', role: 'user', content: 'too late' }])).resolves.toBe(false);
  });

  it('settles a steer the run never reached rather than leaving the caller waiting', async () => {
    let releaseModel!: () => void;
    const modelReleased = new Promise<void>((resolve) => {
      releaseModel = resolve;
    });
    const loop = new ApplicationRunLoop({
      resolveModel: () => ({
        async *stream() {
          await modelReleased;
          yield { type: 'completion', responseId: 'resp-1', output: [] };
        },
      }),
    });
    const stream = loop.startStream(agent, 'answer me');
    const steered = loop.steer([{ type: 'message', role: 'user', content: 'never admitted' }]);
    releaseModel();
    await collect(stream);

    // The turn ended without another request, so the caller must send it itself.
    await expect(steered).resolves.toBe(false);
  });

  it('records an unknown-tool rejection once in canonical history, output, and continuation input', async () => {
    const requests: Array<Parameters<StreamedModelTurn['stream']>[0]> = [];
    let calls = 0;
    const model: StreamedModelTurn = {
      async *stream(request) {
        requests.push(request);
        calls++;
        if (calls === 1) {
          yield { type: 'tool_call', id: 'call-unknown', name: 'unknown_tool', arguments: '{}' };
          yield { type: 'completion', responseId: 'resp-unknown', output: [] };
          return;
        }
        yield { type: 'completion', responseId: 'resp-after-unknown', output: [] };
      },
    };
    const stream = new ApplicationRunLoop({ resolveModel: () => model }).startStream(agent, 'try an unknown tool');
    await stream.completed;

    const historyForCall = stream.history.filter((item: any) => item.callId === 'call-unknown');
    expect(historyForCall).toEqual([
      { type: 'function_call', callId: 'call-unknown', name: 'unknown_tool', arguments: '{}' },
      {
        type: 'function_call_result',
        callId: 'call-unknown',
        name: 'unknown_tool',
        output: 'Unknown tool: unknown_tool',
      },
    ]);
    const outputResults = stream.output.filter(
      (item: any) => item?.type === 'item' && item.item?.type === 'function_call_result',
    );
    expect(outputResults).toEqual([
      {
        type: 'item',
        item: historyForCall[1],
      },
    ]);
    expect(requests[1]?.input).toEqual(
      expect.arrayContaining([
        { type: 'tool_call', id: 'call-unknown', name: 'unknown_tool', arguments: '{}' },
        { type: 'tool_result', id: 'call-unknown', output: 'Unknown tool: unknown_tool' },
      ]),
    );
  });

  it('preserves omitted schema-default parameters for executor fallbacks', async () => {
    const parameters = z.object({ heading: z.string().default('main') });
    let received: unknown;
    const tool: ToolDefinition<typeof parameters> = {
      name: 'defaulted',
      description: 'Uses an executor fallback for omitted arguments.',
      parameters,
      needsApproval: () => false,
      execute: (params) => {
        received = params;
        return 'fallback result';
      },
      formatCommandMessage: () => [],
    };
    let calls = 0;
    const loop = new ApplicationRunLoop({
      resolveModel: () => {
        calls++;
        return calls === 1
          ? {
              async *stream() {
                yield { type: 'tool_call', id: 'call-default', name: 'defaulted', arguments: '{}' };
                yield { type: 'completion', responseId: 'resp-default', output: [] };
              },
            }
          : textModel('done', 'resp-default-done');
      },
    });

    await collect(loop.startStream({ ...agent, tools: [tool] }, 'use the tool'));

    expect(received).toEqual({});
  });

  it('exposes approval as an opaque continuation and resumes after approval', async () => {
    const tool: ToolDefinition = {
      name: 'danger',
      description: 'Requires approval',
      parameters: z.object({}),
      needsApproval: () => true,
      execute: () => 'approved result',
      formatCommandMessage: () => [],
    };
    let calls = 0;
    const loop = new ApplicationRunLoop({
      resolveModel: () => {
        calls++;
        return calls === 1
          ? {
              async *stream() {
                yield { type: 'tool_call', id: 'call-approval', name: 'danger', arguments: '{}' };
                yield { type: 'completion', responseId: 'resp-pending', output: [] };
              },
            }
          : textModel('resumed', 'resp-resumed');
      },
    });
    const stream = loop.startStream({ ...agent, tools: [tool] }, 'do it');
    await collect(stream);

    expect(stream.interruptions).toHaveLength(1);
    const handle = stream.state! as any;
    expect(handle.kind).toBe('continuation');
    handle.approve?.({});
    const resumed = loop.continueRunStream(stream.state!);
    await collect(resumed);

    expect(calls).toBe(2);
    expect(resumed.finalOutput).toBe('resumed');
  });

  it('anchors an approved terminal tool call to its producing response', async () => {
    const requests: Array<Parameters<StreamedModelTurn['stream']>[0]> = [];
    let modelCalls = 0;
    let executions = 0;
    const tool: ToolDefinition = {
      name: 'danger',
      description: 'Requires approval',
      parameters: z.object({}),
      needsApproval: () => true,
      execute: () => {
        executions++;
        return 'approved result';
      },
      formatCommandMessage: () => [],
    };
    const model: StreamedModelTurn = {
      async *stream(request) {
        requests.push(request);
        modelCalls++;
        if (modelCalls === 1) {
          yield {
            type: 'completion',
            responseId: 'response-producing-tool',
            output: [{ type: 'tool_call', id: 'call-terminal', name: 'danger', arguments: '{}' }],
          };
          return;
        }
        yield {
          type: 'completion',
          responseId: 'response-resumed',
          output: [{ type: 'message', content: [{ type: 'text', text: 'resumed' }] }],
        };
      },
    };

    const loop = new ApplicationRunLoop({ resolveModel: () => model });
    const stream = loop.startStream({ ...agent, tools: [tool] }, 'do it', {
      providerId: 'openai',
      supportsConversationChaining: true,
    });
    await stream.completed;

    expect(stream.interruptions).toHaveLength(1);
    const handle = stream.state!;
    handle.approve?.(stream.interruptions![0]);
    const resumed = loop.continueRunStream(handle, {
      providerId: 'openai',
      supportsConversationChaining: true,
    });
    await resumed.completed;

    expect(requests[0].previousResponseId).toBeUndefined();
    expect(requests[1].previousResponseId).toBe('response-producing-tool');
    expect(requests[1].input.filter((item) => item.type === 'tool_result' && item.id === 'call-terminal')).toHaveLength(
      1,
    );
    expect(executions).toBe(1);
    expect(resumed.finalOutput).toBe('resumed');
  });

  it('anchors a rejected streamed tool call to its producing response without executing it', async () => {
    const requests: Array<Parameters<StreamedModelTurn['stream']>[0]> = [];
    let modelCalls = 0;
    let executions = 0;
    const tool: ToolDefinition = {
      name: 'danger',
      description: 'Requires approval',
      parameters: z.object({}),
      needsApproval: () => true,
      execute: () => {
        executions++;
        return 'must not execute';
      },
      formatCommandMessage: () => [],
    };
    const model: StreamedModelTurn = {
      async *stream(request) {
        requests.push(request);
        modelCalls++;
        if (modelCalls === 1) {
          yield { type: 'tool_call', id: 'call-streamed', name: 'danger', arguments: '{}' };
          yield { type: 'completion', responseId: 'response-producing-rejection', output: [] };
          return;
        }
        yield {
          type: 'completion',
          responseId: 'response-after-rejection',
          output: [{ type: 'message', content: [{ type: 'text', text: 'resumed' }] }],
        };
      },
    };

    const loop = new ApplicationRunLoop({ resolveModel: () => model });
    const stream = loop.startStream({ ...agent, tools: [tool] }, 'do it', {
      providerId: 'openai',
      supportsConversationChaining: true,
    });
    await stream.completed;

    expect(stream.interruptions).toHaveLength(1);
    const handle = stream.state!;
    handle.reject?.(stream.interruptions![0], { message: 'declined by user' });
    const resumed = loop.continueRunStream(handle, {
      providerId: 'openai',
      supportsConversationChaining: true,
    });
    await resumed.completed;

    expect(requests[0].previousResponseId).toBeUndefined();
    expect(requests[1].previousResponseId).toBe('response-producing-rejection');
    const results = requests[1].input.filter((item) => item.type === 'tool_result' && item.id === 'call-streamed');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ output: 'declined by user' });
    expect(executions).toBe(0);
    expect(resumed.finalOutput).toBe('resumed');
  });

  it('preserves later streamed tool calls while the first approval is pending', async () => {
    const requests: Array<Parameters<StreamedModelTurn['stream']>[0]> = [];
    let modelCalls = 0;
    const executions: string[] = [];
    const tool: ToolDefinition = {
      name: 'danger',
      description: 'Requires approval',
      parameters: z.object({}),
      needsApproval: () => true,
      execute: (_params, _context, details) => {
        const callId = (details as { toolCall?: { callId?: string } } | undefined)?.toolCall?.callId;
        executions.push(callId ?? 'unknown');
        return 'approved result';
      },
      formatCommandMessage: () => [],
    };
    const model: StreamedModelTurn = {
      async *stream(request) {
        requests.push(request);
        modelCalls++;
        if (modelCalls === 1) {
          yield { type: 'tool_call', id: 'call-first', name: 'danger', arguments: '{}' };
          yield { type: 'tool_call', id: 'call-second', name: 'danger', arguments: '{}' };
          yield { type: 'completion', responseId: 'response-producing-two-tools', output: [] };
          return;
        }
        yield {
          type: 'completion',
          responseId: 'response-after-two-tools',
          output: [{ type: 'message', content: [{ type: 'text', text: 'done' }] }],
        };
      },
    };

    const loop = new ApplicationRunLoop({ resolveModel: () => model });
    const stream = loop.startStream({ ...agent, tools: [tool] }, 'do both', {
      providerId: 'openai',
      supportsConversationChaining: true,
    });
    await stream.completed;

    expect(stream.interruptions?.map((item) => (item as { callId?: string }).callId)).toEqual([
      'call-first',
      'call-second',
    ]);

    const firstHandle = stream.state!;
    firstHandle.approve?.(stream.interruptions![0]);
    const afterFirst = loop.continueRunStream(firstHandle, {
      providerId: 'openai',
      supportsConversationChaining: true,
    });
    await afterFirst.completed;

    expect(modelCalls).toBe(1);
    expect(afterFirst.interruptions?.map((item) => (item as { callId?: string }).callId)).toEqual(['call-second']);

    const secondHandle = afterFirst.state!;
    secondHandle.approve?.(afterFirst.interruptions![0]);
    const resumed = loop.continueRunStream(secondHandle, {
      providerId: 'openai',
      supportsConversationChaining: true,
    });
    await resumed.completed;

    expect(modelCalls).toBe(2);
    expect(requests[1].previousResponseId).toBe('response-producing-two-tools');
    expect(requests[1].input.filter((item) => item.type === 'tool_result').map((item) => item.id)).toEqual([
      'call-first',
      'call-second',
    ]);
    expect(executions).toEqual(['call-first', 'call-second']);
    expect(resumed.finalOutput).toBe('done');
  });

  it('fails closed for an approval interruption with an unknown call id', async () => {
    let modelCalls = 0;
    let executions = 0;
    const tool: ToolDefinition = {
      name: 'danger',
      description: 'Requires approval',
      parameters: z.object({}),
      needsApproval: () => true,
      execute: () => {
        executions++;
        return 'must not execute';
      },
      formatCommandMessage: () => [],
    };
    const model: StreamedModelTurn = {
      async *stream() {
        modelCalls++;
        if (modelCalls === 1) {
          yield { type: 'tool_call', id: 'call-pending', name: 'danger', arguments: '{}' };
          yield { type: 'completion', responseId: 'response-pending', output: [] };
          return;
        }
        yield {
          type: 'completion',
          responseId: 'response-should-not-run',
          output: [{ type: 'message', content: [{ type: 'text', text: 'unsafe continuation' }] }],
        };
      },
    };

    const loop = new ApplicationRunLoop({ resolveModel: () => model });
    const stream = loop.startStream({ ...agent, tools: [tool] }, 'do it');
    await stream.completed;

    const staleInterruption = { ...(stream.interruptions![0] as Record<string, unknown>), callId: 'call-stale' };
    const handle = stream.state!;
    handle.approve?.(staleInterruption);
    const resumed = loop.continueRunStream(handle);

    await expect(resumed.completed).rejects.toThrow('call-stale');
    expect(modelCalls).toBe(1);
    expect(executions).toBe(0);
  });
});

describe('ApplicationRunLoop turn budget', () => {
  /** A tool the model can call forever, so only the budget can stop the run. */
  const loopingTool: ToolDefinition = {
    name: 'again',
    description: 'Always callable',
    parameters: z.object({}),
    needsApproval: () => false,
    execute: () => 'ok',
    formatCommandMessage: () => [],
  };

  function toolCallingModel(callId: string): StreamedModelTurn {
    return {
      async *stream() {
        yield { type: 'tool_call', id: callId, name: 'again', arguments: '{}' };
        yield { type: 'completion', responseId: `resp-${callId}`, output: [] };
      },
    };
  }

  it('stops a runaway tool loop at maxTurns instead of running forever', async () => {
    let calls = 0;
    const loop = new ApplicationRunLoop({
      resolveModel: () => {
        calls++;
        return toolCallingModel(`call-${calls}`);
      },
    });

    const stream = loop.startStream({ ...agent, tools: [loopingTool] }, 'go', { maxTurns: 3 });

    await expect(stream.completed).rejects.toThrow(MaxTurnsExceededError);
    expect(calls).toBe(3);
  });

  it('runs unbounded when no maxTurns is given', async () => {
    let calls = 0;
    const loop = new ApplicationRunLoop({
      resolveModel: () => {
        calls++;
        return calls <= 4 ? toolCallingModel(`call-${calls}`) : textModel('done', 'resp-final');
      },
    });

    const stream = loop.startStream({ ...agent, tools: [loopingTool] }, 'go');
    await stream.completed;

    expect(calls).toBe(5);
    expect(stream.finalOutput).toBe('done');
  });

  it('keeps spending one budget across an approval pause rather than restarting it', async () => {
    // Only the first call pauses, so the resumed run is free to spend turns.
    let approvalChecks = 0;
    const approvedTool: ToolDefinition = { ...loopingTool, needsApproval: () => approvalChecks++ === 0 };
    let calls = 0;
    const loop = new ApplicationRunLoop({
      resolveModel: () => {
        calls++;
        return toolCallingModel(`call-${calls}`);
      },
    });

    // Turn 1 pauses for approval; the resumed run gets turn 2, and turn 3 is
    // over budget. A budget that reset on resume would never trip.
    const stream = loop.startStream({ ...agent, tools: [approvedTool] }, 'go', { maxTurns: 2 });
    await stream.completed;
    expect(stream.interruptions).toHaveLength(1);

    const handle = stream.state! as any;
    handle.approve?.({});
    const resumed = loop.continueRunStream(stream.state!);

    await expect(resumed.completed).rejects.toThrow(MaxTurnsExceededError);
    expect(calls).toBe(2);
  });

  it('reports the run turn budget to tools so they can warn the model', async () => {
    const seen: Array<{ count: number; max?: number }> = [];
    const reportingTool: ToolDefinition = {
      ...loopingTool,
      execute: (_params, context) => {
        seen.push((context as { turn: { count: number; max?: number } }).turn);
        return 'ok';
      },
    };
    let calls = 0;
    const loop = new ApplicationRunLoop({
      resolveModel: () => {
        calls++;
        return calls <= 2 ? toolCallingModel(`call-${calls}`) : textModel('done', 'resp-final');
      },
    });

    const stream = loop.startStream({ ...agent, tools: [reportingTool] }, 'go', { maxTurns: 10 });
    await stream.completed;

    expect(seen).toEqual([
      { count: 1, max: 10 },
      { count: 2, max: 10 },
    ]);
  });
  it('reports a throwing tool as tool output and lets the run continue', async () => {
    let calls = 0;
    const parameters = z.object({});
    const tool: ToolDefinition<typeof parameters> = {
      name: 'grep',
      description: 'Search',
      parameters,
      needsApproval: () => false,
      execute: () => {
        throw new Error('Search failed: rg: /root/src: No such file or directory');
      },
      formatCommandMessage: () => [],
    };
    const loop = new ApplicationRunLoop({
      resolveModel: () => {
        calls++;
        return calls === 1
          ? {
              async *stream() {
                yield { type: 'tool_call', id: 'call-1', name: 'grep', arguments: '{}' };
                yield { type: 'completion', responseId: 'resp-tool', output: [] };
              },
            }
          : textModel('recovered', 'resp-done');
      },
    });

    const stream = loop.startStream({ ...agent, tools: [tool] }, 'search');
    await collect(stream);
    await stream.completed;

    // The model gets a second turn, and the transcript keeps a result for the
    // call it already recorded.
    expect(calls).toBe(2);
    expect(stream.history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'function_call', callId: 'call-1' }),
        expect.objectContaining({
          type: 'function_call_result',
          callId: 'call-1',
          output: 'Error: Search failed: rg: /root/src: No such file or directory',
        }),
      ]),
    );
    expect(stream.finalOutput).toBe('recovered');
  });

  it('stops inviting retries once an identical call fails repeatedly', async () => {
    let calls = 0;
    const parameters = z.object({ path: z.string() });
    const tool: ToolDefinition<typeof parameters> = {
      name: 'grep',
      description: 'Search',
      parameters,
      needsApproval: () => false,
      execute: () => {
        throw new Error('Search failed: no such file');
      },
      formatCommandMessage: () => [],
    };
    const loop = new ApplicationRunLoop({
      resolveModel: () => {
        calls++;
        return calls <= 3
          ? {
              async *stream() {
                yield {
                  type: 'tool_call',
                  id: `call-${calls}`,
                  name: 'grep',
                  arguments: '{"path":"/root/src"}',
                };
                yield { type: 'completion', responseId: `resp-${calls}`, output: [] };
              },
            }
          : textModel('gave up', 'resp-done');
      },
    });

    const stream = loop.startStream({ ...agent, tools: [tool] }, 'search');
    await collect(stream);
    await stream.completed;

    const outputs = (stream.history as any[])
      .filter((item) => item.type === 'function_call_result')
      .map((item) => item.output as string);

    expect(outputs).toHaveLength(3);
    expect(outputs[0]).toBe('Error: Search failed: no such file');
    expect(outputs[1]).toBe('Error: Search failed: no such file');
    expect(outputs[2]).toContain('failed 3 times with the same error');
    expect(outputs[2]).toContain('Do not call grep with these arguments again');
  });

  it('still fails the run when a tool reports a harness invariant violation', async () => {
    const parameters = z.object({});
    const tool: ToolDefinition<typeof parameters> = {
      name: 'shell',
      description: 'Run a command',
      parameters,
      needsApproval: () => false,
      execute: () => {
        throw new HarnessInvariantError('Root shell denied-read handling requires an SDK tool call ID');
      },
      formatCommandMessage: () => [],
    };
    const loop = new ApplicationRunLoop({
      resolveModel: () => ({
        async *stream() {
          yield { type: 'tool_call', id: 'call-1', name: 'shell', arguments: '{}' };
          yield { type: 'completion', responseId: 'resp-tool', output: [] };
        },
      }),
    });

    const stream = loop.startStream({ ...agent, tools: [tool] }, 'run it');
    await expect(stream.completed).rejects.toThrow(HarnessInvariantError);
  });

  it('still fails the run when a tool is cancelled', async () => {
    const parameters = z.object({});
    const tool: ToolDefinition<typeof parameters> = {
      name: 'shell',
      description: 'Run a command',
      parameters,
      needsApproval: () => false,
      execute: () => {
        const error = new Error('The operation was aborted');
        error.name = 'AbortError';
        throw error;
      },
      formatCommandMessage: () => [],
    };
    const loop = new ApplicationRunLoop({
      resolveModel: () => ({
        async *stream() {
          yield { type: 'tool_call', id: 'call-1', name: 'shell', arguments: '{}' };
          yield { type: 'completion', responseId: 'resp-tool', output: [] };
        },
      }),
    });

    const stream = loop.startStream({ ...agent, tools: [tool] }, 'run it');
    await expect(stream.completed).rejects.toThrow('The operation was aborted');
  });
});
