import test from 'ava';
import { ConversationSession } from './conversation-session.js';
import { LoggingService } from './logging-service.js';

const logger = new LoggingService({ disableLogging: true });

test('ConversationSession extracts reasoning_content from stream', async (t) => {
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

  const session = new ConversationSession('test-session', {
    agentClient: mockAgentClient,
    deps: { logger },
  } as any);

  const events: any[] = [];
  for await (const event of session.run('hi')) {
    events.push(event);
  }

  const reasoningEvents = events.filter((e) => e.type === 'reasoning_delta');
  t.is(reasoningEvents.length, 2);
  t.is(reasoningEvents[0].delta, 'think');
  t.is(reasoningEvents[1].delta, 'ing');
  t.is(reasoningEvents[1].fullText, 'thinking');
});
