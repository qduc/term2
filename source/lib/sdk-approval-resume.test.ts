import { Agent, Runner, RunState, tool } from '@openai/agents';
import type { Model, ModelRequest, ModelResponse, StreamEvent } from '@openai/agents-core';
import { expect, it } from 'vitest';
import { z } from 'zod';

const CALL_ID = 'call-r1-resume';

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
