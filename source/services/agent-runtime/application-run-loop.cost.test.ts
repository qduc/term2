import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ApplicationRunLoop, type ApplicationAgent } from './application-run-loop.js';
import type { StreamedModelTurn, StreamedModelUsage } from '../../contracts/streamed-model-turn.js';
import type { ToolDefinition } from '../../tools/types.js';
import type { ModelRequestCost } from '../../services/cost/model-cost.js';
import { parseUsdMicros } from '../../services/cost/model-cost.js';

const agent: ApplicationAgent = {
  name: 'cost-agent',
  instructions: 'Be concise.',
  model: 'gpt-4.1',
  tools: [],
};

const USAGE: StreamedModelUsage = { inputTokens: 1000, outputTokens: 200, cachedInputTokens: 100 };

async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function completionModel(options?: { usage?: StreamedModelUsage; costUsd?: number | string }): StreamedModelTurn {
  return {
    async *stream() {
      yield {
        type: 'completion',
        responseId: 'resp-1',
        output: [{ type: 'message', content: [{ type: 'text', text: 'hi' }] }],
        ...(options?.usage ? { usage: options.usage } : {}),
        ...(options?.costUsd !== undefined ? { costUsd: options.costUsd } : {}),
      };
    },
  };
}

function toolLoopModel(toolName: string): { model: StreamedModelTurn; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    model: {
      async *stream() {
        calls += 1;
        if (calls === 1) {
          yield { type: 'tool_call', id: 'call-1', name: toolName, arguments: '{}' };
          yield { type: 'completion', responseId: 'resp-loop-1', output: [], usage: USAGE };
          return;
        }
        yield {
          type: 'completion',
          responseId: 'resp-loop-2',
          output: [{ type: 'message', content: [{ type: 'text', text: 'done' }] }],
          usage: USAGE,
        };
      },
    },
  };
}

describe('ApplicationRunLoop cost records', () => {
  it('settles one priced catalog record for one completed request with usage', async () => {
    const loop = new ApplicationRunLoop({ resolveModel: () => completionModel({ usage: USAGE }) });
    const stream = loop.startStream(agent, 'hello', { providerId: 'openai' });
    const completed = await stream.completed;
    const records = (completed as { costRecords?: ModelRequestCost[] }).costRecords ?? [];
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.provider).toBe('openai');
    expect(record.model).toBe('gpt-4.1');
    expect(record.serviceTier).toBe('standard');
    expect(record.outcome).toBe('completed');
    expect(record.source).toBe('catalog');
    // 900 uncached * $2 + 100 cached * $0.5 + 200 output * $8 = 3450 micros.
    expect(record.usdMicros).toBe(3450);
    // Request ids are process-wide monotonic, so only the shape is pinned here.
    expect(record.requestId).toMatch(/^req-\d+$/);
    // Exposed on the stream too.
    expect(stream.runCostRecords).toHaveLength(1);
  });

  it('prefers a provider-reported USD charge over the catalog estimate without adding both', async () => {
    const loop = new ApplicationRunLoop({
      resolveModel: () => completionModel({ usage: USAGE, costUsd: '0.00002772' }),
    });
    const stream = loop.startStream(agent, 'hello', { providerId: 'openai' });
    const records = (await stream.completed) as { costRecords?: ModelRequestCost[] };
    expect(records.costRecords).toHaveLength(1);
    expect(records.costRecords![0]!.source).toBe('provider');
    expect(records.costRecords![0]!.usdMicros).toBe(parseUsdMicros('0.00002772'));
  });

  it('records OpenRouter numeric response cost as exact provider cost', async () => {
    const loop = new ApplicationRunLoop({
      resolveModel: () => completionModel({ usage: USAGE, costUsd: 0.000123 }),
    });
    const stream = loop.startStream(agent, 'hello', { providerId: 'openrouter' });
    const records = (await stream.completed) as { costRecords?: ModelRequestCost[] };
    expect(records.costRecords).toHaveLength(1);
    expect(records.costRecords![0]!.source).toBe('provider');
    expect(records.costRecords![0]!.provider).toBe('openrouter');
    expect(records.costRecords![0]!.usdMicros).toBe(123);
  });

  it('records a completed request without usage as an unpriced marker', async () => {
    const loop = new ApplicationRunLoop({ resolveModel: () => completionModel() });
    const stream = loop.startStream(agent, 'hello', { providerId: 'openai' });
    const records = ((await stream.completed) as { costRecords?: ModelRequestCost[] }).costRecords ?? [];
    expect(records).toHaveLength(1);
    expect(records[0]!.usdMicros).toBeUndefined();
    expect(records[0]!.unpricedReason).toBe('missing_usage');
    expect(records[0]!.outcome).toBe('completed');
  });

  it('records one unpriced marker per dispatched request across a tool loop', async () => {
    const echoTool: ToolDefinition = {
      name: 'echo',
      description: 'echo',
      parameters: z.object({}),
      needsApproval: () => false,
      execute: () => 'ok',
      formatCommandMessage: () => [],
    };
    const { model, calls } = toolLoopModel('echo');
    const loop = new ApplicationRunLoop({ resolveModel: () => model });
    const stream = loop.startStream({ ...agent, tools: [echoTool] }, 'loop', { providerId: 'openai' });
    await collect(stream);
    expect(calls()).toBe(2);
    const records = stream.runCostRecords as ModelRequestCost[];
    expect(records).toHaveLength(2);
    expect(records[0]!.requestId).toMatch(/^req-\d+$/);
    expect(records[1]!.requestId).toMatch(/^req-\d+$/);
    expect(records[0]!.requestId).not.toBe(records[1]!.requestId);
    expect(records[0]!.usdMicros).toBe(3450);
    expect(records[1]!.usdMicros).toBe(3450);
  });

  it('preserves records across an approval continuation without duplicating', async () => {
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
        calls += 1;
        if (calls === 1) {
          return {
            async *stream() {
              yield { type: 'tool_call', id: 'call-approval', name: 'danger', arguments: '{}' };
              yield { type: 'completion', responseId: 'resp-pending', output: [], usage: USAGE };
            },
          };
        }
        return {
          async *stream() {
            yield {
              type: 'completion',
              responseId: 'resp-resumed',
              output: [{ type: 'message', content: [{ type: 'text', text: 'ok' }] }],
              usage: USAGE,
            };
          },
        };
      },
    });

    const stream = loop.startStream({ ...agent, tools: [tool] }, 'do it', { providerId: 'openai' });
    await collect(stream);
    expect(stream.interruptions).toHaveLength(1);

    const handle = stream.state! as any;
    handle.approve?.({});
    const resumed = loop.continueRunStream(stream.state!, { providerId: 'openai' });
    await collect(resumed);

    const records = resumed.runCostRecords as ModelRequestCost[];
    expect(records).toHaveLength(2);
    const ids = records.map((record) => record.requestId);
    expect(new Set(ids).size).toBe(2);
    expect(ids[0]).toMatch(/^req-\d+$/);
    expect(ids[1]).toMatch(/^req-\d+$/);
  });

  it('records a cancelled dispatch as an unpriced cancelled marker', async () => {
    const loop = new ApplicationRunLoop({
      resolveModel: () => ({
        async *stream() {
          throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        },
      }),
    });
    const stream = loop.startStream(agent, 'hello', { providerId: 'openai' });
    await expect(stream.completed).rejects.toThrow();
    const records = (stream.runCostRecords ?? []) as ModelRequestCost[];
    expect(records).toHaveLength(1);
    expect(records[0]!.outcome).toBe('cancelled');
    expect(records[0]!.unpricedReason).toBe('missing_usage');
  });

  it('emits a cost_update event for every dispatched request during a tool loop', async () => {
    const echoTool: ToolDefinition = {
      name: 'echo',
      description: 'echo',
      parameters: z.object({}),
      needsApproval: () => false,
      execute: () => 'ok',
      formatCommandMessage: () => [],
    };
    const { model, calls } = toolLoopModel('echo');
    const loop = new ApplicationRunLoop({ resolveModel: () => model });
    const stream = loop.startStream({ ...agent, tools: [echoTool] }, 'loop', { providerId: 'openai' });
    const events = await collect(stream);
    expect(calls()).toBe(2);
    const updates = events.filter(
      (event): event is { type: 'cost_update'; record: ModelRequestCost } =>
        (event as { type?: string }).type === 'cost_update',
    );
    expect(updates).toHaveLength(2);
    expect(updates[0]!.record.requestId).toMatch(/^req-\d+$/);
    expect(updates[1]!.record.requestId).toMatch(/^req-\d+$/);
    expect(updates[0]!.record.requestId).not.toBe(updates[1]!.record.requestId);
    expect(updates[0]!.record.usdMicros).toBe(3450);
    expect(updates[1]!.record.usdMicros).toBe(3450);
  });

  it('emits a cost_update marker when dispatch fails, before the run error', async () => {
    const loop = new ApplicationRunLoop({
      resolveModel: () => ({
        async *stream() {
          throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        },
      }),
    });
    const stream = loop.startStream(agent, 'hello', { providerId: 'openai' });
    const events: unknown[] = [];
    await expect(
      (async () => {
        for await (const event of stream) events.push(event);
      })(),
    ).rejects.toThrow();
    // Observe the same failure on the terminal promise so it is not unhandled.
    await expect(stream.completed).rejects.toThrow();
    const updates = events.filter(
      (event): event is { type: 'cost_update'; record: ModelRequestCost } =>
        (event as { type?: string }).type === 'cost_update',
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]!.record.outcome).toBe('cancelled');
    expect(updates[0]!.record.unpricedReason).toBe('missing_usage');
  });

  it('keeps request ids unique across separate runs so session dedup cannot drop records', async () => {
    const loop = new ApplicationRunLoop({ resolveModel: () => completionModel({ usage: USAGE }) });
    const first = loop.startStream(agent, 'one', { providerId: 'openai' });
    await collect(first);
    const second = loop.startStream(agent, 'two', { providerId: 'openai' });
    await collect(second);
    const firstRecords = first.runCostRecords as ModelRequestCost[];
    const secondRecords = second.runCostRecords as ModelRequestCost[];
    expect(firstRecords).toHaveLength(1);
    expect(secondRecords).toHaveLength(1);
    expect(firstRecords[0]!.requestId).not.toBe(secondRecords[0]!.requestId);
  });
});
