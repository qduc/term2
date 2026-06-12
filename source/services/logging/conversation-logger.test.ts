import test from 'ava';
import { ConversationLogger } from './conversation-logger.js';
import { TurnItemAccumulator } from '../session/turn-item-accumulator.js';

const makeLoggingService = () => {
  const warnings: Array<{ message: string; meta: unknown }> = [];
  return {
    warnings,
    logger: {
      info: () => undefined,
      warn: (message: string, meta?: any) => warnings.push({ message, meta }),
      error: () => undefined,
      debug: () => undefined,
      security: () => undefined,
      setCorrelationId: () => undefined,
      getCorrelationId: () => undefined,
      clearCorrelationId: () => undefined,
    },
  };
};

test('setLogSink updates the sink used by log', (t) => {
  const { logger } = makeLoggingService();
  const sinkA: any[] = [];
  const sinkB: any[] = [];
  const conversationLogger = new ConversationLogger({
    turnAccumulator: new TurnItemAccumulator(),
    logger,
    getAssistantTurnState: () => ({ previousResponseId: null }),
  });

  conversationLogger.setLogSink((event) => sinkA.push(event));
  conversationLogger.log({ type: 'session_cleared' });
  conversationLogger.setLogSink((event) => sinkB.push(event));
  conversationLogger.log({
    type: 'undo',
    removedUserTurns: 1,
    snapshot: { history: [], previousResponseId: null, toolLedger: [] },
  });

  t.deepEqual(sinkA, [{ type: 'session_cleared' }]);
  t.deepEqual(sinkB, [
    { type: 'undo', removedUserTurns: 1, snapshot: { history: [], previousResponseId: null, toolLedger: [] } },
  ]);
});

test('log is a no-op when the sink is null', (t) => {
  const { logger, warnings } = makeLoggingService();
  const conversationLogger = new ConversationLogger({
    turnAccumulator: new TurnItemAccumulator(),
    logger,
    getAssistantTurnState: () => ({ previousResponseId: null }),
  });

  conversationLogger.log({ type: 'session_cleared' });

  t.is(warnings.length, 0);
});

test('log warns when the sink throws', (t) => {
  const { logger, warnings } = makeLoggingService();
  const conversationLogger = new ConversationLogger({
    turnAccumulator: new TurnItemAccumulator(),
    logger,
    getAssistantTurnState: () => ({ previousResponseId: null }),
  });

  conversationLogger.setLogSink(() => {
    throw new Error('boom');
  });
  conversationLogger.log({ type: 'session_cleared' });

  t.is(warnings.length, 1);
  t.is(warnings[0].message, 'Conversation log sink threw');
  t.deepEqual(warnings[0].meta, {
    eventType: 'conversation_log.sink_failed',
    category: 'persistence',
    errorMessage: 'boom',
  });
});

test('dispatchEventToLog accumulates turn items and logs the final assistant turn', (t) => {
  const { logger, warnings } = makeLoggingService();
  const sinkEvents: any[] = [];
  const turnAccumulator = new TurnItemAccumulator();
  const conversationLogger = new ConversationLogger({
    turnAccumulator,
    logger,
    getAssistantTurnState: () => ({
      previousResponseId: 'resp-1',
      model: 'gpt-4.1',
      provider: 'openai',
    }),
  });

  conversationLogger.setLogSink((event) => sinkEvents.push(event));

  conversationLogger.dispatchEventToLog({ type: 'reasoning_delta', delta: 'thinking' });
  conversationLogger.dispatchEventToLog({ type: 'text_delta', delta: 'hello' });
  conversationLogger.dispatchEventToLog({
    type: 'usage_update',
    usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
  });
  conversationLogger.dispatchEventToLog({
    type: 'final',
    finalText: 'ignored because text already exists',
    usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
  });

  t.is(warnings.length, 0);
  t.deepEqual(sinkEvents, [
    {
      type: 'assistant_turn',
      turn: {
        items: [
          { type: 'reasoning', text: 'thinking' },
          { type: 'assistant_text', text: 'hello' },
        ],
      },
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
      displayUsage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
      state: { previousResponseId: 'resp-1', model: 'gpt-4.1', provider: 'openai' },
    },
  ]);
});

test('dispatchEventToLog logs event-specific records', (t) => {
  const { logger } = makeLoggingService();
  const sinkEvents: any[] = [];
  const turnAccumulator = new TurnItemAccumulator();
  const conversationLogger = new ConversationLogger({
    turnAccumulator,
    logger,
    getAssistantTurnState: () => ({ previousResponseId: null }),
  });

  conversationLogger.setLogSink((event) => sinkEvents.push(event));

  conversationLogger.dispatchEventToLog({
    type: 'tool_started',
    toolCallId: 'call-1',
    toolName: 'shell',
    arguments: { command: 'echo hi' },
  });
  conversationLogger.dispatchEventToLog({
    type: 'command_message',
    message: {
      id: 'msg-1',
      sender: 'command',
      status: 'completed',
      command: 'echo hi',
      output: 'hi',
      callId: 'call-1',
      toolName: 'shell',
    },
  });
  conversationLogger.dispatchEventToLog({
    type: 'approval_required',
    approval: {
      toolName: 'shell',
      argumentsText: 'echo hi',
      agentName: 'assistant',
      callId: 'call-1',
    },
  });
  conversationLogger.dispatchEventToLog({
    type: 'subagent_started',
    agentId: 'agent-1',
    role: 'worker',
    task: 'inspect',
  });
  conversationLogger.dispatchEventToLog({
    type: 'subagent_completed',
    result: {
      agentId: 'agent-1',
      role: 'worker',
      status: 'completed',
      finalText: 'done',
      filesChanged: [],
      toolsUsed: [],
    },
  });
  conversationLogger.dispatchEventToLog({
    type: 'error',
    message: 'something failed',
    kind: 'runtime',
    stack: 'stack-trace',
  });

  t.deepEqual(sinkEvents, [
    { type: 'tool_started', toolCallId: 'call-1', toolName: 'shell', arguments: { command: 'echo hi' } },
    {
      type: 'command_message',
      message: {
        id: 'msg-1',
        sender: 'command',
        status: 'completed',
        command: 'echo hi',
        output: 'hi',
        callId: 'call-1',
        toolName: 'shell',
      },
    },
    {
      type: 'approval_required',
      approval: { toolName: 'shell', argumentsText: 'echo hi', agentName: 'assistant', callId: 'call-1' },
    },
    { type: 'subagent_started', agentId: 'agent-1', role: 'worker', task: 'inspect' },
    {
      type: 'subagent_completed',
      result: {
        agentId: 'agent-1',
        role: 'worker',
        status: 'completed',
        finalText: 'done',
        filesChanged: [],
        toolsUsed: [],
      },
    },
    { type: 'error', message: 'something failed', kind: 'runtime', stack: 'stack-trace' },
  ]);
  conversationLogger.dispatchEventToLog({
    type: 'final',
    finalText: 'done',
  });
  t.deepEqual(turnAccumulator.getTurnItems(), []);
  t.deepEqual(sinkEvents.at(-1), {
    type: 'assistant_turn',
    turn: {
      items: [
        { type: 'tool_call', callId: 'call-1', toolName: 'shell', arguments: { command: 'echo hi' } },
        { type: 'tool_result', callId: 'call-1', toolName: 'shell', status: 'completed', output: 'hi' },
        { type: 'assistant_text', text: 'done' },
      ],
    },
    state: { previousResponseId: null },
  });
});
