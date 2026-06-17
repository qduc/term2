import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createConversationSession } from './session-composition.js';
import { LoggingService } from '../logging/logging-service.js';

const logger = new LoggingService({ disableLogging: true });

const createSessionContextService = () => ({
  runWithContext: <T>(_context: any, fn: () => T) => fn(),
  getContext: () => null,
});

it('ConversationSession extracts reasoning_content from stream', async () => {
  const mockAgentClient: any = {
    startStream: async () => ({
      [Symbol.asyncIterator]: async function* () {
        yield {
          data: {
            type: 'model',
            event: {
              choices: [
                {
                  delta: {
                    reasoning_content: 'think',
                  },
                },
              ],
            },
          },
        };
        yield {
          data: {
            type: 'model',
            event: {
              choices: [
                {
                  delta: {
                    reasoning_content: 'ing',
                  },
                },
              ],
            },
          },
        };
        yield {
          type: 'text_delta',
          delta: 'Hi',
        };
        yield {
          type: 'final',
        };
      },
      lastResponseId: 'resp-1',
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
