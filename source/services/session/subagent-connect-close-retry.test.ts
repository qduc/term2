import { it, expect } from 'vitest';
import { AmbiguousModelOutcomeError } from '../retry/retry-errors.js';
import { createSessionRuntime } from './session-composition.js';
import { MockStream } from '../test-helpers/mock-stream.js';
import { ApplicationRunLoop, type ApplicationAgent } from '../agent-runtime/application-run-loop.js';
import type { StreamedModelTurn } from '../../contracts/streamed-model-turn.js';
import {
  mockLogger,
  sessionContextService,
  createMockAgentClient,
} from './test-helpers/conversation-session-fixtures.js';

const CLOSE_ERROR = () =>
  new AmbiguousModelOutcomeError(
    'Codex WebSocket connection closed before a terminal response event. (code=1006 reason="" unsent=0)',
  );

function subagentRuntime(startStream: () => Promise<unknown>) {
  return createSessionRuntime({
    sessionId: 'subagent-close-retry',
    agentClient: createMockAgentClient({ startStream } as never),
    deps: { logger: mockLogger, settingsService: undefined as never, sessionContextService },
    // Subagents run with fresh-start retries disabled (execution-runner.ts).
    retryOptions: { allowFreshStartRetries: false },
  } as never);
}

// The 2026-08-20 incident: a subagent lost its Codex WebSocket and the run died
// outright. A close carrying a recoverable code classifies as chain_recovery,
// which rebuilds from full history rather than replaying the task, so it must
// survive even though the subagent forbids fresh starts.
it('retries a subagent whose websocket closes before any stream exists', async () => {
  let calls = 0;
  const good = new MockStream([{ type: 'text_delta', text: 'ok' }]);
  good.finalOutput = 'ok';
  good.lastResponseId = 'resp-2';

  const runtime = subagentRuntime(async () => {
    calls++;
    if (calls === 1) throw CLOSE_ERROR();
    return good;
  });

  const types: string[] = [];
  try {
    for await (const event of runtime.turns.start({ text: 'go', images: [] } as never)) {
      types.push(event.type);
    }

    expect(calls).toBe(2);
    expect(types).toEqual(['retry', 'text_delta', 'final']);
  } finally {
    await runtime.shutdown();
  }
});

// This is the provider-state variant of the same path: the worker has already
// executed a tool, then the next chained request is rejected before producing a
// frame. The session must rebuild from its reconciled tool history, not let the
// run loop's no-anchor guard become the terminal worker error.
it('recovers a stale chained worker continuation after a completed tool', async () => {
  const requests: any[] = [];
  let rejectOnce = true;
  const model: StreamedModelTurn = {
    async *stream(request: any) {
      requests.push(request);
      if (request.input.some((item: any) => item.type === 'tool_result')) {
        if (rejectOnce) {
          rejectOnce = false;
          throw Object.assign(new Error('Invalid `previous_response_id`.'), { status: 400 });
        }
        yield {
          type: 'completion',
          responseId: 'resp-recovered',
          output: [{ type: 'message', content: [{ type: 'text', text: 'Recovered.' }] }],
        };
        return;
      }
      yield { type: 'tool_call', id: 'worker-call-1', name: 'worker_tool', arguments: '{}' };
      yield { type: 'completion', responseId: 'resp-worker-tool', output: [] };
    },
  };
  const agent: ApplicationAgent = {
    name: 'worker',
    model: 'worker-model',
    instructions: 'Use the worker tool.',
    tools: [
      {
        name: 'worker_tool',
        description: 'Complete one worker action.',
        parameters: { type: 'object' },
        needsApproval: async () => false,
        execute: async () => 'worker result',
        formatCommandMessage: () => [],
      },
    ],
  } as unknown as ApplicationAgent;
  const loop = new ApplicationRunLoop({ resolveModel: () => model });
  let replayBudgetSpent = false;
  const client = createMockAgentClient({
    getProvider() {
      return 'codex';
    },
    supportsConversationChaining() {
      return true;
    },
    async startStream(input: any, options: any) {
      // Characterize the long-turn case from the incident: an earlier recovery
      // in the same logical turn already consumed the one automatic-replay
      // claim. A settled-tool chain recovery must still use its bounded
      // full-history path without claiming that replay slot again.
      if (!replayBudgetSpent) {
        replayBudgetSpent = options.recoveryBudget.claimAutomaticReplay();
      }
      const stream = loop.startStream(agent, input, {
        ...options,
        providerId: 'codex',
        supportsConversationChaining: true,
      });
      void stream.completed.catch(() => undefined);
      return stream;
    },
  });
  const runtime = createSessionRuntime({
    sessionId: 'subagent-stale-chain',
    agentClient: client,
    deps: { logger: mockLogger, settingsService: undefined as never, sessionContextService },
    retryOptions: { allowFreshStartRetries: false },
  } as never);

  const events: any[] = [];
  try {
    for await (const event of runtime.turns.start({ text: 'work', images: [] } as never)) {
      events.push(event);
    }

    expect(requests).toHaveLength(3);
    expect(requests[1].previousResponseId).toBe('resp-worker-tool');
    expect(requests[2].previousResponseId).toBeUndefined();
    expect(requests[2].disableChaining).toBe(true);
    expect(requests[2].input).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'tool_result' })]));
    expect(events.some((event) => event.type === 'retry')).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'final', finalText: 'Recovered.' });
  } finally {
    await runtime.shutdown();
  }
});
