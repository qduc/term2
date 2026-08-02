import { createAgentStream, type AgentStream } from '../agent-stream.js';

export class MockStream<TEvent = unknown> implements AsyncIterable<TEvent> {
  events: TEvent[];
  completed: Promise<unknown>;
  lastResponseId: string;
  interruptions: unknown[];
  state: Record<string, unknown>;
  newItems: unknown[];
  history: unknown[];
  finalOutput: string;
  output: unknown[];

  constructor(events: TEvent[]) {
    this.events = events;
    this.completed = Promise.resolve();
    this.lastResponseId = 'resp_test';
    this.interruptions = [];
    this.state = {};
    this.newItems = [];
    this.history = [];
    this.finalOutput = '';
    this.output = [];
    createAgentStream(this as never);
  }

  get runUsage(): unknown {
    return this.state.usage;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<TEvent, void, unknown> {
    for (const event of this.events) {
      yield event;
    }
  }
}

export function createMockStream<TEvent = unknown>(events: TEvent[]): AgentStream & MockStream<TEvent> {
  return createAgentStream(new MockStream(events) as never) as AgentStream & MockStream<TEvent>;
}
