import { it, expect } from 'vitest';
import { AmbiguousModelOutcomeError } from '../retry/retry-errors.js';
import { createSessionRuntime } from './session-composition.js';
import { MockStream } from '../test-helpers/mock-stream.js';
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
