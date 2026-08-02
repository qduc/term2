import { expect, it, vi } from 'vitest';
import type { Message } from '../../types/message.js';
import { splitStaticHistory } from '../../components/message/MessageList.js';
import { createConversationEventHandler } from '../../utils/conversation/conversation-event-handler.js';
import { createStreamingState } from '../../utils/conversation/conversation-utils.js';
import type { ConversationAgentClient } from '../conversation-agent-client.js';
import type { ConversationEvent } from '../conversation/conversation-events.js';
import { createConversationRuntime } from '../conversation/conversation-runtime-factory.js';
import { ToolOwnershipRegistry } from '../approval/tool-ownership-registry.js';

const managerInstances = vi.hoisted(
  () => [] as Array<{ onEvent?: (event: ConversationEvent) => void; startRunAsync: (request: any) => any }>,
);

vi.mock('../subagents/subagent-manager.js', () => ({
  SubagentManager: class {
    onEvent?: (event: ConversationEvent) => void;

    constructor(deps: { onEvent?: (event: ConversationEvent) => void }) {
      this.onEvent = deps.onEvent;
      managerInstances.push(this);
    }

    startRunAsync(request: { role: string; task: string }) {
      this.onEvent?.({
        type: 'subagent_started',
        agentId: 'background-run-1',
        role: request.role,
        task: request.task,
        parentTool: 'run_subagent_async',
        async: true,
      } as ConversationEvent);
      return {
        runId: 'background-run-1',
        role: request.role,
        task: request.task,
        status: 'running',
      };
    }

    resetMentorSession() {}
    clearCache() {}
    cancelAllAsyncRuns() {}
    resetAsyncRuns() {}
    abortAsyncRun() {}
  },
}));

const { SubagentBridge } = await import('../../lib/subagent-bridge.js');

const noop = () => {};
const logger = {
  info: noop,
  warn: noop,
  error: noop,
  debug: noop,
  security: noop,
  setCorrelationId: noop,
  getCorrelationId: () => undefined,
  clearCorrelationId: noop,
};
const settings = { get: () => undefined, set: noop };
const sessionContextService = {
  runWithContext: <T>(_context: unknown, fn: () => T) => fn(),
  getContext: () => null,
};

it('projects background lifecycle without making the foreground message history dynamic', async () => {
  managerInstances.length = 0;
  const bridge = new SubagentBridge({
    logger: logger as any,
    settings: settings as any,
    sessionContextService: sessionContextService as any,
    chat: async () => '',
    createClient: () => ({}),
    toolOwnership: new ToolOwnershipRegistry(),
  });

  const client = {
    async startStream() {
      await bridge.runSubagentAsync({ role: 'explorer', task: 'inspect the project' });
      return {
        interruptions: [],
        state: null,
        history: [],
        newItems: [],
        finalOutput: 'Background explorer created.',
        lastResponseId: null,
        async *[Symbol.asyncIterator]() {
          yield {
            type: 'item',
            item: {
              rawItem: {
                type: 'function_call',
                callId: 'async-call-1',
                name: 'run_subagent_async',
                arguments: JSON.stringify({ role: 'explorer', task: 'inspect the project' }),
              },
            },
          };
          yield {
            type: 'item',
            item: {
              rawItem: {
                type: 'function_call_result',
                callId: 'async-call-1',
                name: 'run_subagent_async',
                output: JSON.stringify({
                  runId: 'background-run-1',
                  role: 'explorer',
                  task: 'inspect the project',
                  status: 'running',
                }),
              },
            },
          };
          yield { type: 'text_delta', text: 'Background explorer created.' };
        },
      };
    },
    abort: noop,
    continueRunStream: noop,
    setModel: noop,
    addToolInterceptor: noop,
    chat: noop,
    setSubagentEventSink: (sink: ((event: ConversationEvent) => void) | null) => bridge.setEventSink(sink),
    setBackgroundSubagentEventSink: (sink: ((event: ConversationEvent) => void) | null) =>
      bridge.setBackgroundEventSink(sink),
  } as unknown as ConversationAgentClient;

  const { runtime, adapter } = createConversationRuntime({
    sessionId: 'background-ui-routing',
    agentClient: client,
    toolOwnership: new ToolOwnershipRegistry(),
    deps: { logger: logger as any, sessionContextService: sessionContextService as any },
  });
  const loggedEvents: Array<{ type: string }> = [];
  runtime.logs.setLogSink((event) => loggedEvents.push(event));

  let messages: Message[] = [];
  const handler = createConversationEventHandler(
    {
      botResponseUpdater: { push: noop, cancel: noop, flush: noop },
      reasoningUpdater: { push: noop, cancel: noop, flush: noop },
      appendMessages: (additions) => {
        messages = [...messages, ...additions];
      },
      setMessages: (update) => {
        messages = update(messages);
      },
      createMessageId: () => 'main-acknowledgement',
      trimMessages: (next) => next,
      annotateCommandMessage: (message) => message,
    },
    createStreamingState(),
  );

  await adapter.sendMessage('delegate this', { onEvent: handler });
  expect(runtime.backgroundSubagentTasks.getSnapshot()).toEqual([
    expect.objectContaining({
      runId: 'background-run-1',
      role: 'explorer',
      task: 'inspect the project',
      status: 'running',
    }),
  ]);

  const manager = managerInstances[0];
  manager.onEvent?.({
    type: 'subagent_tool_started',
    agentId: 'background-run-1',
    role: 'explorer',
    toolCallId: 'read-call-1',
    toolName: 'shell',
    arguments: { command: 'pnpm test' },
  } as ConversationEvent);
  expect(runtime.backgroundSubagentTasks.getSnapshot()).toEqual([
    expect.objectContaining({
      runId: 'background-run-1',
      status: 'running',
      lastTool: { label: 'pnpm test', state: 'running' },
    }),
  ]);
  manager.onEvent?.({
    type: 'subagent_completed',
    async: true,
    result: {
      agentId: 'background-run-1',
      role: 'explorer',
      status: 'completed',
      finalText: 'done',
      filesChanged: [],
      toolsUsed: [],
    },
  } as ConversationEvent);

  expect(runtime.backgroundSubagentNotifications.pendingCount).toBe(1);
  expect(loggedEvents.map((event) => event.type).filter((type) => type.startsWith('subagent_'))).toEqual([
    'subagent_started',
    'subagent_tool_started',
    'subagent_completed',
  ]);
  expect(messages.filter((message) => message.sender === 'subagent')).toEqual([]);
  // The launch itself stays in the transcript as a finalized command message;
  // only the live lifecycle is kept out of the foreground history.
  expect(messages.filter((message) => message.sender === 'command')).toEqual([
    expect.objectContaining({
      sender: 'command',
      toolName: 'run_subagent_async',
      callId: 'async-call-1',
      status: 'completed',
    }),
  ]);
  expect(runtime.backgroundSubagentTasks.getSnapshot()).toEqual([
    expect.objectContaining({
      status: 'completed',
      runId: 'background-run-1',
    }),
  ]);

  const { history, active } = splitStaticHistory(messages);
  expect(active).toEqual([]);
  expect(history).toEqual([
    expect.objectContaining({
      sender: 'command',
      toolName: 'run_subagent_async',
      status: 'completed',
    }),
    expect.objectContaining({
      id: 'main-acknowledgement',
      sender: 'bot',
      status: 'finalized',
      text: 'Background explorer created.',
    }),
  ]);

  runtime.dispose();
});
