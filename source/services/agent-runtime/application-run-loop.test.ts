import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ApplicationRunLoop, MaxTurnsExceededError, type ApplicationAgent } from './application-run-loop.js';
import type { StreamedModelTurn } from '../../contracts/streamed-model-turn.js';
import type { ToolDefinition } from '../../tools/types.js';

const agent: ApplicationAgent = {
  name: 'test-agent',
  instructions: 'Be concise.',
  model: 'test-model',
  tools: [],
};

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
    const stream = loop.startStream(agent, 'follow up', { previousResponseId: 'resp-before' });
    await stream.completed;

    expect(requests).toEqual([
      expect.objectContaining({ previousResponseId: 'resp-before' }),
      expect.objectContaining({ previousResponseId: 'resp-1' }),
    ]);
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

  it('owns a text turn without an SDK runner', async () => {
    const loop = new ApplicationRunLoop({ resolveModel: () => textModel('hello', 'resp-1') });
    const stream = loop.startStream(agent, 'say hello');

    const events = await collect(stream);
    await stream.completed;

    expect(events).toEqual([
      { type: 'text_delta', text: 'hello' },
      expect.objectContaining({ type: 'run_item_stream_event' }),
    ]);
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
    const stream = loop.startStream({ ...agent, tools: [tool] }, 'do it');
    await stream.completed;

    expect(stream.interruptions).toHaveLength(1);
    const handle = stream.state!;
    handle.approve?.(stream.interruptions![0]);
    const resumed = loop.continueRunStream(handle);
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
    const stream = loop.startStream({ ...agent, tools: [tool] }, 'do it');
    await stream.completed;

    expect(stream.interruptions).toHaveLength(1);
    const handle = stream.state!;
    handle.reject?.(stream.interruptions![0], { message: 'declined by user' });
    const resumed = loop.continueRunStream(handle);
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
    const stream = loop.startStream({ ...agent, tools: [tool] }, 'do both');
    await stream.completed;

    expect(stream.interruptions?.map((item) => (item as { callId?: string }).callId)).toEqual([
      'call-first',
      'call-second',
    ]);

    const firstHandle = stream.state!;
    firstHandle.approve?.(stream.interruptions![0]);
    const afterFirst = loop.continueRunStream(firstHandle);
    await afterFirst.completed;

    expect(modelCalls).toBe(1);
    expect(afterFirst.interruptions?.map((item) => (item as { callId?: string }).callId)).toEqual(['call-second']);

    const secondHandle = afterFirst.state!;
    secondHandle.approve?.(afterFirst.interruptions![0]);
    const resumed = loop.continueRunStream(secondHandle);
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
});
