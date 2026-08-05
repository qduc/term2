import { describe, expect, it, vi } from 'vitest';
import { ApplicationRunLoop, type ApplicationAgent } from './application-run-loop.js';
import type { StreamedModelTurn } from '../../contracts/streamed-model-turn.js';
import type { AnyToolDefinition, ToolExecutionLifecyclePort } from '../../tools/types.js';

const tool = (execute: AnyToolDefinition['execute']): AnyToolDefinition => ({
  name: 'lookup',
  description: 'lookup',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  needsApproval: () => false,
  execute,
  formatCommandMessage: () => [],
});

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _event of stream) {
    // Drain the application stream so physical execution can progress.
  }
}

function modelWithTool(callId = 'call-1'): StreamedModelTurn {
  let requestCount = 0;
  return {
    async *stream() {
      requestCount += 1;
      if (requestCount === 1) {
        yield { type: 'tool_call', id: callId, name: 'lookup', arguments: '{}' };
        yield { type: 'completion', responseId: 'response-1', output: [] };
        return;
      }
      yield {
        type: 'completion',
        responseId: 'response-2',
        output: [{ type: 'message', content: [{ type: 'text', text: 'done' }] }],
      };
    },
  };
}

describe('ApplicationRunLoop tool lifecycle', () => {
  it('emits one before and after event for a physical invocation', async () => {
    const lifecycle: ToolExecutionLifecyclePort = {
      before: vi.fn(),
      after: vi.fn(),
      error: vi.fn(),
    };
    const agent: ApplicationAgent = {
      name: 'test-agent',
      instructions: 'Use the tool.',
      model: 'test-model',
      tools: [tool(async () => 'result')],
    };
    const model = modelWithTool();
    const stream = new ApplicationRunLoop({
      resolveModel: () => model,
      toolLifecycle: lifecycle,
    }).startStream(agent, 'use lookup', { sessionId: 'session-1', turnId: 'turn-1' });

    await drain(stream);
    await stream.completed;

    expect(lifecycle.before).toHaveBeenCalledTimes(1);
    expect(lifecycle.after).toHaveBeenCalledTimes(1);
    expect(lifecycle.error).not.toHaveBeenCalled();
    expect(lifecycle.before).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-1',
        turnId: 'turn-1',
        toolCallId: 'call-1',
        toolName: 'lookup',
        attempt: 1,
      }),
    );
  });

  it('reports converted tool failures as tool errors without aborting the run', async () => {
    const lifecycle: ToolExecutionLifecyclePort = {
      before: vi.fn(),
      after: vi.fn(),
      error: vi.fn(),
    };
    const agent: ApplicationAgent = {
      name: 'test-agent',
      instructions: 'Use the tool.',
      model: 'test-model',
      tools: [
        tool(async () => {
          throw new Error('no result');
        }),
      ],
    };
    const model = modelWithTool();
    const stream = new ApplicationRunLoop({
      resolveModel: () => model,
      toolLifecycle: lifecycle,
    }).startStream(agent, 'use lookup');

    await drain(stream);
    await stream.completed;

    expect(lifecycle.error).toHaveBeenCalledWith(
      expect.objectContaining({ toolCallId: 'call-1' }),
      expect.any(Error),
      expect.any(Number),
      true,
    );
    expect(lifecycle.after).not.toHaveBeenCalled();
  });
});
