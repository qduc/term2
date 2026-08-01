import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ApplicationRunLoop, type ApplicationAgent } from './application-run-loop.js';
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
    const tool: ToolDefinition<{ value: string }> = {
      name: 'echo',
      description: 'Echo a value',
      parameters: z.object({ value: z.string() }),
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
