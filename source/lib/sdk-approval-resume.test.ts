import { Agent, Runner, RunState, tool } from '@openai/agents';
import type { Model, ModelRequest, ModelResponse, StreamEvent } from '@openai/agents-core';
import { expect, it } from 'vitest';
import { z } from 'zod';

const CALL_ID = 'call-r1-resume';
const DENIED_CALL_ID = 'call-denied-read';
const RETRY_CALL_ID = 'call-retry-after-denied-read';
const SHELL_ARGUMENTS = JSON.stringify({ command: 'cat restricted.txt' });

function approvalModel(): Model {
  return {
    async getResponse(request: ModelRequest): Promise<ModelResponse> {
      const hasToolOutput =
        Array.isArray(request.input) &&
        request.input.some((item: any) => item.type === 'function_call_result' || item.type === 'function_call_output');

      return {
        usage: {
          requests: 1,
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
        } as any,
        output: hasToolOutput
          ? [
              {
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text: 'done' }],
              },
            ]
          : [
              {
                type: 'function_call',
                callId: CALL_ID,
                name: 'approved_tool',
                arguments: JSON.stringify({ value: 'ok' }),
              },
            ],
      } as ModelResponse;
    },
    async *getStreamedResponse(_request: ModelRequest): AsyncIterable<StreamEvent> {},
  };
}

it('preserves the tool call ID in execution details when resuming after approval', async () => {
  let executedCallId: string | undefined;
  const approvedTool = tool({
    name: 'approved_tool',
    description: 'A tool that requires approval.',
    parameters: z.object({ value: z.string() }),
    needsApproval: async () => true,
    execute: async (_input, _context, details) => {
      executedCallId = details?.toolCall?.callId;
      return 'approved';
    },
  });
  const agent = new Agent({
    name: 'approval-resume-test',
    instructions: 'Call the tool.',
    model: 'scripted-model',
    tools: [approvedTool],
  });
  const runner = new Runner({
    modelProvider: {
      getModel: () => approvalModel(),
    },
  });

  const interrupted = await runner.run(agent, 'run the tool');
  expect(interrupted.interruptions).toHaveLength(1);
  expect(executedCallId).toBeUndefined();

  const resumedState = await RunState.fromString(agent, interrupted.state.toString());
  const [approval] = resumedState.getInterruptions();
  resumedState.approve(approval);
  await runner.run(agent, resumedState);

  expect(executedCallId).toBe(CALL_ID);
});

it('does not reuse a denied call ID when the model retries the same tool call', async () => {
  const approvalCalls: Array<{ callId: string | undefined; command: string }> = [];
  const executedCallIds: Array<string | undefined> = [];
  const retryModel: Model = {
    async getResponse(request: ModelRequest): Promise<ModelResponse> {
      const hasToolOutput =
        Array.isArray(request.input) &&
        request.input.some((item: any) => item.type === 'function_call_result' || item.type === 'function_call_output');

      return {
        usage: { requests: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2 } as any,
        output: [
          {
            type: 'function_call',
            callId: hasToolOutput ? RETRY_CALL_ID : DENIED_CALL_ID,
            name: 'shell',
            arguments: SHELL_ARGUMENTS,
          },
        ],
      } as ModelResponse;
    },
    async *getStreamedResponse(_request: ModelRequest): AsyncIterable<StreamEvent> {},
  };
  const shell = tool({
    name: 'shell',
    description: 'Run a shell command.',
    parameters: z.object({ command: z.string() }),
    needsApproval: async (_context, input, callId) => {
      approvalCalls.push({ callId, command: input.command });
      return callId === RETRY_CALL_ID;
    },
    execute: async (_input, _context, details) => {
      executedCallIds.push(details?.toolCall?.callId);
      return 'denied read: restricted.txt is outside the sandbox';
    },
  });
  const agent = new Agent({
    name: 'denied-read-retry-test',
    instructions: 'Call the shell tool.',
    model: 'scripted-model',
    tools: [shell],
  });
  const runner = new Runner({ modelProvider: { getModel: () => retryModel } });

  const interrupted = await runner.run(agent, 'read the restricted file');

  expect(approvalCalls).toEqual([
    { callId: DENIED_CALL_ID, command: 'cat restricted.txt' },
    { callId: RETRY_CALL_ID, command: 'cat restricted.txt' },
  ]);
  expect(executedCallIds).toEqual([DENIED_CALL_ID]);
  expect(interrupted.interruptions).toHaveLength(1);
});

it('retains completed tool outputs from every streamed model cycle when the next request fails', async () => {
  const firstCallId = 'call-stream-first';
  const secondCallId = 'call-stream-second';
  let requestCount = 0;
  const model: Model = {
    async getResponse(): Promise<ModelResponse> {
      throw new Error('This regression must use the streaming model path.');
    },
    async *getStreamedResponse(_request: ModelRequest): AsyncIterable<StreamEvent> {
      requestCount++;
      if (requestCount === 3) {
        throw new Error('transport disconnected after two completed tool cycles');
      }

      const callId = requestCount === 1 ? firstCallId : secondCallId;
      yield {
        type: 'response_done',
        response: {
          id: `response-${requestCount}`,
          usage: { requests: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          output: [
            {
              type: 'function_call',
              callId,
              name: 'cycle_tool',
              arguments: JSON.stringify({ cycle: requestCount }),
            },
          ],
        },
      } as StreamEvent;
    },
  };
  const executedCallIds: string[] = [];
  const cycleTool = tool({
    name: 'cycle_tool',
    description: 'Completes one scripted tool cycle.',
    parameters: z.object({ cycle: z.number() }),
    execute: async (_input, _context, details) => {
      const callId = details?.toolCall?.callId;
      if (callId) executedCallIds.push(callId);
      return `output for ${callId}`;
    },
  });
  const agent = new Agent({
    name: 'streamed-transport-recovery-test',
    instructions: 'Call the scripted tool twice.',
    model: 'scripted-model',
    tools: [cycleTool],
  });
  const runner = new Runner({ modelProvider: { getModel: () => model } });

  const stream = await runner.run(agent, 'run both cycles', { stream: true });
  const events: any[] = [];
  const iteration = (async () => {
    for await (const event of stream) {
      events.push(event);
    }
  })();

  await Promise.all([
    expect(iteration).rejects.toThrow('transport disconnected after two completed tool cycles'),
    expect(stream.completed).rejects.toThrow('transport disconnected after two completed tool cycles'),
  ]);
  expect(executedCallIds).toEqual([firstCallId, secondCallId]);

  const completedResultCallIds = (items: unknown[]) =>
    items
      .filter((item: any) => {
        const rawItem = item.rawItem ?? item;
        return [
          'function_call_result',
          'function_call_output',
          'function_call_output_result',
          'tool_call_output_item',
        ].includes(rawItem.type);
      })
      .map((item: any) => (item.rawItem ?? item).callId);
  expect(completedResultCallIds(stream.history)).toEqual(expect.arrayContaining([firstCallId, secondCallId]));
  expect(completedResultCallIds(stream.newItems)).toEqual(expect.arrayContaining([firstCallId, secondCallId]));
  expect(completedResultCallIds(stream.output)).toEqual(expect.arrayContaining([firstCallId, secondCallId]));
  const eventResultCallIds = events
    .filter(
      (event) =>
        event.type === 'run_item_stream_event' &&
        [
          'function_call_result',
          'function_call_output',
          'function_call_output_result',
          'tool_call_output_item',
        ].includes(event.item.rawItem?.type),
    )
    .map((event) => event.item.rawItem.callId);
  expect(eventResultCallIds).toEqual(expect.arrayContaining([firstCallId, secondCallId]));
});
