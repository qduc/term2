import { expect, it } from 'vitest';
import { z } from 'zod';
import { ApplicationRunLoop, type ApplicationAgent } from '../services/agent-runtime/application-run-loop.js';
import type { StreamedModelTurn } from '../contracts/streamed-model-turn.js';

const model = (calls: Array<{ id: string; name: string; arguments: string }>): StreamedModelTurn => ({
  async *stream(request) {
    const hasResult = request.input.some((item) => item.type === 'tool_result');
    if (!hasResult && calls.length) {
      const call = calls.shift()!;
      yield { type: 'tool_call', ...call };
      yield { type: 'completion', responseId: 'response-1', output: [{ type: 'tool_call', ...call }] };
      return;
    }
    yield {
      type: 'completion',
      responseId: 'response-2',
      output: [{ type: 'message', content: [{ type: 'text', text: 'done' }] }],
    };
  },
});

const agent = (
  needsApproval: boolean,
  execute: (params: any, _context?: unknown, details?: any) => unknown,
): ApplicationAgent => ({
  name: 'approval-resume-test',
  instructions: 'Call the tool.',
  model: 'scripted-model',
  tools: [
    {
      name: 'approved_tool',
      description: 'A tool that requires approval.',
      parameters: z.object({ value: z.string() }),
      needsApproval: () => needsApproval,
      execute,
      formatCommandMessage: () => [],
    },
  ],
});

it('preserves the tool call ID in execution details when resuming after approval', async () => {
  let executedCallId: string | undefined;
  const loop = new ApplicationRunLoop({
    resolveModel: () => model([{ id: 'call-r1-resume', name: 'approved_tool', arguments: '{"value":"ok"}' }]),
  });
  const stream = loop.startStream(
    agent(true, (_params, _context, details) => {
      executedCallId = details?.toolCall?.callId;
      return 'approved';
    }),
    'run the tool',
  );
  await stream.completed;
  expect(stream.interruptions).toHaveLength(1);
  expect(executedCallId).toBeUndefined();
  const handle = stream.state!;
  handle.approve?.(stream.interruptions![0]);
  const resumed = loop.continueRunStream(handle);
  await resumed.completed;
  expect(executedCallId).toBe('call-r1-resume');
});

it('records completed tool results in the application-owned stream history', async () => {
  const loop = new ApplicationRunLoop({
    resolveModel: () => model([{ id: 'call-cycle', name: 'approved_tool', arguments: '{"value":"ok"}' }]),
  });
  const stream = loop.startStream(
    agent(false, () => 'output'),
    'run the tool',
  );
  await stream.completed;
  expect(stream.history.some((item: any) => item.type === 'function_call_result' && item.callId === 'call-cycle')).toBe(
    true,
  );
});
