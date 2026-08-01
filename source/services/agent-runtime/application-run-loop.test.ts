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
