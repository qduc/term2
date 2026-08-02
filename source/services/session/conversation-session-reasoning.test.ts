import { it, expect } from 'vitest';
import { createConversationSession } from './session-composition.js';
import { LoggingService } from '../logging/logging-service.js';
import { createAgentStream } from '../agent-stream.js';

const logger = new LoggingService({ disableLogging: true });

const createSessionContextService = () => ({
  runWithContext: <T>(_context: any, fn: () => T) => fn(),
  getContext: () => null,
});

it('ConversationSession extracts reasoning_content from stream', async () => {
  const mockAgentClient: any = {
    startStream: async () =>
      createAgentStream({
        [Symbol.asyncIterator]: async function* () {
          yield { type: 'reasoning_delta', text: 'think' };
          yield { type: 'reasoning_delta', text: 'ing' };
          yield { type: 'text_delta', text: 'Hi' };
        },
        lastResponseId: 'resp-1',
        completed: Promise.resolve(undefined),
        history: [],
        newItems: [],
        output: [],
      }),
  };

  const turnCoordinator = createConversationSession({
    sessionId: 'test-session',
    agentClient: mockAgentClient,
    deps: { logger, sessionContextService: createSessionContextService() as any },
  } as any).turnCoordinator;

  const events: any[] = [];
  for await (const event of turnCoordinator.start('hi')) {
    events.push(event);
  }

  const reasoningEvents = events.filter((e) => e.type === 'reasoning_delta');
  expect(reasoningEvents.length).toBe(2);
  expect(reasoningEvents[0].delta).toBe('think');
  expect(reasoningEvents[1].delta).toBe('ing');
  expect(reasoningEvents[1].fullText).toBe('thinking');
});
