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
    expect(record.requestId).toBe('req-1-1');
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
    expect(records[0]!.requestId).toBe('req-1-1');
    expect(records[1]!.requestId).toBe('req-2-2');
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
    expect(ids[0]).toBe('req-1-1');
    expect(ids[1]).toBe('req-2-2');
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
});
