import { expect, it } from 'vitest';
import { z } from 'zod';
import { ApplicationRunLoop, type ApplicationAgent } from '../agent-runtime/application-run-loop.js';

function nestedAgent(needsApproval: boolean, calls: string[]): ApplicationAgent {
  return {
    name: 'nested-test-agent',
    instructions: 'Use the nested tool.',
    model: 'nested-model',
    tools: [
      {
        name: 'nested_tool',
        description: 'A nested tool.',
        parameters: z.object({ value: z.string() }),
        needsApproval: () => needsApproval,
        execute: (_params, _context, details) => {
          calls.push((details as any)?.toolCall?.callId ?? 'missing');
          return 'ok';
        },
        formatCommandMessage: () => [],
      },
    ],
  };
}

it('executes a nested application-owned tool with a stable call ID', async () => {
  const calls: string[] = [];
  const loop = new ApplicationRunLoop({
    resolveModel: async () => ({
      async *stream(request) {
        if (request.input.some((item) => item.type === 'tool_result')) {
          yield {
            type: 'completion',
            responseId: 'response-2',
            output: [{ type: 'message', content: [{ type: 'text', text: 'done' }] }],
          };
        } else {
          const call = { id: 'nested-call-1', name: 'nested_tool', arguments: '{"value":"x"}' };
          yield { type: 'tool_call', ...call };
          yield { type: 'completion', responseId: 'response-1', output: [{ type: 'tool_call', ...call }] };
        }
      },
    }),
  });
  const stream = loop.startStream(nestedAgent(false, calls), 'delegate');
  await stream.completed;
  expect(calls).toEqual(['nested-call-1']);
  expect(stream.finalOutput).toBe('done');
});

it('pauses and resumes an application-owned nested tool approval', async () => {
  const calls: string[] = [];
  const loop = new ApplicationRunLoop({
    resolveModel: async () => ({
      async *stream(request) {
        if (request.input.some((item) => item.type === 'tool_result')) {
          yield {
            type: 'completion',
            responseId: 'response-2',
            output: [{ type: 'message', content: [{ type: 'text', text: 'approved' }] }],
          };
        } else {
          const call = { id: 'nested-call-approval', name: 'nested_tool', arguments: '{"value":"x"}' };
          yield { type: 'tool_call', ...call };
          yield { type: 'completion', responseId: 'response-1', output: [{ type: 'tool_call', ...call }] };
        }
      },
    }),
  });
  const stream = loop.startStream(nestedAgent(true, calls), 'delegate');
  await stream.completed;
  expect(stream.interruptions).toHaveLength(1);
  const handle = stream.state!;
  handle.approve?.(stream.interruptions![0]);
  const resumed = loop.continueRunStream(handle);
  await resumed.completed;
  expect(calls).toEqual(['nested-call-approval']);
  expect(resumed.finalOutput).toBe('approved');
});
