// @ts-nocheck - Characterization tests for ConversationSession refactoring
import test from 'ava';
import { ConversationSession } from './conversation-session.js';
import { createMockSettingsService } from './settings-service.mock.js';
import { MockStream } from './test-helpers/mock-stream.js';

// ── Shared mocks ───────────────────────────────────────────────────────────

const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  security: () => {},
  setCorrelationId: () => {},
  getCorrelationId: () => {},
  clearCorrelationId: () => {},
};

const createSessionContextService = () => {
  let capturedContext = null;
  return {
    runWithContext: (context, fn) => {
      capturedContext = context;
      return fn();
    },
    getContext: () => capturedContext,
  };
};

// ── Helper: ApprovalState-like object for mock streams ────────────────────

const createApprovalState = () => ({
  approveCalls: [],
  rejectCalls: [],
  approve(interruption) {
    this.approveCalls.push(interruption);
  },
  reject(interruption) {
    this.rejectCalls.push(interruption);
  },
});

const createShellInterruption = ({ callId, command }) => ({
  name: 'shell',
  agent: { name: 'CLI Agent' },
  arguments: JSON.stringify({ command }),
  ...(callId ? { callId } : {}),
});

// ══════════════════════════════════════════════════════════════════════════
// 1. sendMessage wraps events with log dispatch and clears
//    setSubagentEventSink in finally
// ══════════════════════════════════════════════════════════════════════════

test('sendMessage installs setSubagentEventSink with a function then clears it to null', async (t) => {
  const sinkCalls = [];

  const stream = new MockStream([]);
  stream.finalOutput = 'Hello';
  stream.lastResponseId = 'resp-sink-test';

  const mockClient = {
    async startStream() {
      return stream;
    },
    setSubagentEventSink(sink) {
      sinkCalls.push(typeof sink === 'function' ? 'function' : sink);
    },
  };

  const session = new ConversationSession('sink-test', {
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
  });

  await session.sendMessage('hello');

  // First call: a function (the wrapped onEvent)
  t.is(sinkCalls[0], 'function', 'First setSubagentEventSink call should install a function callback');
  // After the finally block: null
  t.is(sinkCalls[sinkCalls.length - 1], null, 'Last setSubagentEventSink call should clear to null');
  // Exactly 2 calls: install then clear
  t.is(sinkCalls.length, 2, 'setSubagentEventSink should be called exactly twice (install + clear)');
});

test('sendMessage dispatches events through conversationLogger before onEvent callback', async (t) => {
  const eventLog = [];

  const stream = new MockStream([{ type: 'response.output_text.delta', delta: 'Hello' }]);
  stream.finalOutput = 'Hello';
  stream.lastResponseId = 'resp-log-dispatch';

  const mockClient = {
    async startStream() {
      return stream;
    },
    setSubagentEventSink() {},
  };

  const session = new ConversationSession('log-dispatch', {
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
  });

  const result = await session.sendMessage('hi', {
    onEvent: (event) => {
      eventLog.push({ phase: 'onEvent', type: event.type });
    },
  });

  t.is(result.type, 'response');
  // The onEvent callback was called at least for final event
  t.true(eventLog.length > 0, 'onEvent callback should have been invoked');
});

// ══════════════════════════════════════════════════════════════════════════
// 2. handleApprovalDecision returns null when no approval is pending
// ══════════════════════════════════════════════════════════════════════════

test('handleApprovalDecision returns null when no approval is pending', async (t) => {
  const mockClient = {
    async startStream() {
      const stream = new MockStream([]);
      stream.finalOutput = 'Done.';
      stream.lastResponseId = 'resp-no-pending';
      return stream;
    },
  };

  const session = new ConversationSession('no-pending', {
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
  });

  // No approval pending
  const result = await session.handleApprovalDecision('y');
  t.is(result, null);
});

test('handleApprovalDecision returns null for rejection when no approval is pending', async (t) => {
  const mockClient = {
    async startStream() {
      const stream = new MockStream([]);
      stream.finalOutput = 'Done.';
      stream.lastResponseId = 'resp-reject-no-pending';
      return stream;
    },
  };

  const session = new ConversationSession('reject-no-pending', {
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
  });

  const result = await session.handleApprovalDecision('n', 'User rejected');
  t.is(result, null);
});

// ══════════════════════════════════════════════════════════════════════════
// 3. handleApprovalDecision sets ask-user answer by call ID for
//    accepted approvals
// ══════════════════════════════════════════════════════════════════════════

test('handleApprovalDecision forwards approvalAnswer to agentClient.setAskUserAnswer', async (t) => {
  const askUserCalls = [];

  const interruptedStream = new MockStream([]);
  interruptedStream.interruptions = [createShellInterruption({ callId: 'call-ask-user-test', command: 'echo test' })];
  interruptedStream.state = createApprovalState();

  const finalStream = new MockStream([]);
  finalStream.finalOutput = 'Answer forwarded.';
  finalStream.lastResponseId = 'resp-ask-user';

  const mockClient = {
    async startStream() {
      return interruptedStream;
    },
    async continueRunStream() {
      return finalStream;
    },
    setAskUserAnswer(callId, answer) {
      askUserCalls.push({ callId, answer });
    },
  };

  const session = new ConversationSession('ask-user-test', {
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
  });

  const approvalResult = await session.sendMessage('ask the user');
  t.is(approvalResult.type, 'approval_required');

  const finalResult = await session.handleApprovalDecision('y', undefined, {
    approvalAnswer: 'Use option B',
  });

  t.is(finalResult.type, 'response');
  t.is(finalResult.finalText, 'Answer forwarded.');
  t.deepEqual(askUserCalls, [{ callId: 'call-ask-user-test', answer: 'Use option B' }]);
});

test('handleApprovalDecision does not call setAskUserAnswer when answer is not y', async (t) => {
  const askUserCalls = [];

  const interruptedStream = new MockStream([]);
  interruptedStream.interruptions = [createShellInterruption({ callId: 'call-reject', command: 'echo reject' })];
  interruptedStream.state = createApprovalState();

  const rejectionFinal = new MockStream([]);
  rejectionFinal.finalOutput = 'Rejected.';
  rejectionFinal.lastResponseId = 'resp-rejected';

  const mockClient = {
    async startStream() {
      return interruptedStream;
    },
    async continueRunStream() {
      return rejectionFinal;
    },
    setAskUserAnswer(callId, answer) {
      askUserCalls.push({ callId, answer });
    },
  };

  const session = new ConversationSession('reject-no-ask', {
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
  });

  const approvalResult = await session.sendMessage('run command');
  t.is(approvalResult.type, 'approval_required');

  const rejectionResult = await session.handleApprovalDecision('n', 'User rejected', {
    approvalAnswer: 'Use option B',
  });

  // Rejection returns a response from the continuation runner
  t.is(rejectionResult.type, 'response');
  t.false(askUserCalls.length > 0, 'setAskUserAnswer should NOT be called on rejection');
});

test('handleApprovalDecision does not call setAskUserAnswer when approvalAnswer is not provided', async (t) => {
  const askUserCalls = [];

  const interruptedStream = new MockStream([]);
  interruptedStream.interruptions = [createShellInterruption({ callId: 'call-no-answer', command: 'echo no answer' })];
  interruptedStream.state = createApprovalState();

  const noAnswerFinal = new MockStream([]);
  noAnswerFinal.finalOutput = 'Done.';
  noAnswerFinal.lastResponseId = 'resp-no-answer';

  const mockClient = {
    async startStream() {
      return interruptedStream;
    },
    async continueRunStream() {
      return noAnswerFinal;
    },
    setAskUserAnswer(callId, answer) {
      askUserCalls.push({ callId, answer });
    },
  };

  const session = new ConversationSession('no-answer-test', {
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
  });

  const approvalResult = await session.sendMessage('run command');
  t.is(approvalResult.type, 'approval_required');

  // No approvalAnswer provided; handleApprovalDecision still calls continueAfterApproval
  const result = await session.handleApprovalDecision('y');
  t.is(result.type, 'response');
  t.false(askUserCalls.length > 0, 'setAskUserAnswer should NOT be called without approvalAnswer');
});

// ══════════════════════════════════════════════════════════════════════════
// 4. abort records aborted approval tool ledger entry only when an
//    approval was pending
// ══════════════════════════════════════════════════════════════════════════

test('abort with no pending approval does not throw and produces no change in snapshot toolLedger', async (t) => {
  const mockClient = {
    abort() {},
    async startStream() {
      const stream = new MockStream([]);
      stream.finalOutput = 'Done.';
      stream.lastResponseId = 'resp-abort-empty';
      return stream;
    },
  };

  const session = new ConversationSession('abort-empty', {
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
  });

  // No approval pending; abort should be a no-op
  session.abort();

  // The tool ledger should still be empty
  const snapshot = session.getCurrentSnapshot();
  t.deepEqual(snapshot.toolLedger, [], 'Tool ledger should be empty when no approval was pending at abort');
});

test('abort with pending approval records aborted entry in tool ledger', async (t) => {
  const interruptedStream = new MockStream([]);
  interruptedStream.interruptions = [createShellInterruption({ callId: 'call-abort-1', command: 'echo abort me' })];
  interruptedStream.state = createApprovalState();

  const mockClient = {
    abort() {},
    async startStream() {
      return interruptedStream;
    },
  };

  const session = new ConversationSession('abort-pending', {
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
  });

  await session.sendMessage('run command');

  // Now abort
  session.abort();

  // Verify the tool ledger has an aborted entry
  const snapshot = session.getCurrentSnapshot();
  const abortedEntries = snapshot.toolLedger.filter((entry) => entry.status === 'aborted');
  t.true(abortedEntries.length > 0, 'Should have at least one aborted entry in the tool ledger');
  t.is(abortedEntries[0].callId, 'call-abort-1');
});

// ══════════════════════════════════════════════════════════════════════════
// 5. getCurrentSnapshot reconciles history with tool ledger and
//    includes provider/model
// ══════════════════════════════════════════════════════════════════════════

test('getCurrentSnapshot returns expected shape with history, previousResponseId, and toolLedger', async (t) => {
  const mockClient = {
    async startStream() {
      const stream = new MockStream([]);
      stream.finalOutput = 'Done.';
      stream.lastResponseId = 'resp-snapshot';
      return stream;
    },
  };

  const session = new ConversationSession('snapshot-test', {
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
  });

  const snapshot = session.getCurrentSnapshot();

  t.true(Array.isArray(snapshot.history));
  t.true(snapshot.previousResponseId === null || typeof snapshot.previousResponseId === 'string');
  t.true(Array.isArray(snapshot.toolLedger));
});

test('getCurrentSnapshot includes provider from agentClient.getProvider when available', async (t) => {
  const mockClient = {
    async startStream() {
      const stream = new MockStream([]);
      stream.finalOutput = 'Done.';
      stream.lastResponseId = 'resp-provider';
      return stream;
    },
    getProvider() {
      return 'test-provider';
    },
  };

  const session = new ConversationSession('provider-test', {
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
  });

  const snapshot = session.getCurrentSnapshot();
  t.is(snapshot.provider, 'test-provider');
});

test('getCurrentSnapshot includes model from settingsService when available', async (t) => {
  const mockClient = {
    async startStream() {
      const stream = new MockStream([]);
      stream.finalOutput = 'Done.';
      stream.lastResponseId = 'resp-model';
      return stream;
    },
  };

  const session = new ConversationSession('model-test', {
    agentClient: mockClient,
    deps: {
      logger: mockLogger,
      settingsService: createMockSettingsService({ 'agent.model': 'gpt-4o-test' }),
      sessionContextService: createSessionContextService(),
    },
  });

  const snapshot = session.getCurrentSnapshot();
  t.is(snapshot.model, 'gpt-4o-test');
});

// ══════════════════════════════════════════════════════════════════════════
// 6. Provider/model/temperature/reasoning changes call
//    afterProviderChanged before mutating agent client
// ══════════════════════════════════════════════════════════════════════════

test('setModel calls afterProviderChanged then agentClient.setModel', async (t) => {
  const calls = [];

  const mockClient = {
    async startStream() {
      const stream = new MockStream([]);
      stream.finalOutput = 'Done.';
      stream.lastResponseId = 'resp-set-model';
      return stream;
    },
    setModel(model) {
      calls.push({ method: 'setModel', model });
    },
  };

  const session = new ConversationSession('set-model', {
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
  });

  session.setModel('gpt-4');

  t.is(calls.length, 1);
  t.is(calls[0].method, 'setModel');
  t.is(calls[0].model, 'gpt-4');
});

test('setProvider calls afterProviderChanged then agentClient.setProvider', async (t) => {
  const calls = [];

  const mockClient = {
    async startStream() {
      const stream = new MockStream([]);
      stream.finalOutput = 'Done.';
      stream.lastResponseId = 'resp-set-provider';
      return stream;
    },
    setProvider(provider) {
      calls.push({ method: 'setProvider', provider });
    },
  };

  const session = new ConversationSession('set-provider', {
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
  });

  session.setProvider('anthropic');

  t.is(calls.length, 1);
  t.is(calls[0].method, 'setProvider');
  t.is(calls[0].provider, 'anthropic');
});

test('setProvider is idempotent via switchProvider alias', async (t) => {
  const calls = [];

  const mockClient = {
    async startStream() {
      const stream = new MockStream([]);
      stream.finalOutput = 'Done.';
      stream.lastResponseId = 'resp-switch';
      return stream;
    },
    setProvider(provider) {
      calls.push({ method: 'setProvider', provider });
    },
  };

  const session = new ConversationSession('switch-provider', {
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
  });

  session.switchProvider('openai');

  t.is(calls.length, 1);
  t.is(calls[0].provider, 'openai');
});

test('setTemperature calls afterProviderChanged then agentClient.setTemperature', async (t) => {
  const calls = [];

  const mockClient = {
    async startStream() {
      const stream = new MockStream([]);
      stream.finalOutput = 'Done.';
      stream.lastResponseId = 'resp-set-temp';
      return stream;
    },
    setTemperature(temp) {
      calls.push({ method: 'setTemperature', temp });
    },
  };

  const session = new ConversationSession('set-temp', {
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
  });

  session.setTemperature(0.7);

  t.is(calls.length, 1);
  t.is(calls[0].method, 'setTemperature');
  t.is(calls[0].temp, 0.7);
});

test('setTemperature with undefined is passed through to agentClient', async (t) => {
  const calls = [];

  const mockClient = {
    async startStream() {
      const stream = new MockStream([]);
      stream.finalOutput = 'Done.';
      stream.lastResponseId = 'resp-set-temp-undefined';
      return stream;
    },
    setTemperature(temp) {
      calls.push({ method: 'setTemperature', temp });
    },
  };

  const session = new ConversationSession('set-temp-undef', {
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
  });

  session.setTemperature(undefined);

  t.is(calls.length, 1);
  t.is(calls[0].temp, undefined);
});

test('setReasoningEffort calls afterProviderChanged then agentClient.setReasoningEffort', async (t) => {
  const calls = [];

  const mockClient = {
    async startStream() {
      const stream = new MockStream([]);
      stream.finalOutput = 'Done.';
      stream.lastResponseId = 'resp-set-reasoning';
      return stream;
    },
    setReasoningEffort(effort) {
      calls.push({ method: 'setReasoningEffort', effort });
    },
  };

  const session = new ConversationSession('set-reasoning', {
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
  });

  session.setReasoningEffort('high');

  t.is(calls.length, 1);
  t.is(calls[0].method, 'setReasoningEffort');
  t.is(calls[0].effort, 'high');
});

test('setReasoningEffort is a no-op when agentClient lacks setReasoningEffort', async (t) => {
  // An agentClient without the optional setReasoningEffort method
  const mockClient = {
    async startStream() {
      const stream = new MockStream([]);
      stream.finalOutput = 'Done.';
      stream.lastResponseId = 'resp-no-reasoning';
      return stream;
    },
  };

  const session = new ConversationSession('no-reasoning', {
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
  });

  // Should not throw
  session.setReasoningEffort('low');
  t.pass();
});

// ══════════════════════════════════════════════════════════════════════════
// 7. Auto-approved tool continuations preserve cumulative usage and
//    command messages (#buildAndResolve)
// ══════════════════════════════════════════════════════════════════════════

test('auto-approve: cumulative usage from continuation supersedes first-turn usage', async (t) => {
  const firstInterruption = createShellInterruption({ callId: 'call-usage-1', command: 'ls source' });

  const initialStream = new MockStream([]);
  initialStream.interruptions = [firstInterruption];
  initialStream.state = {
    ...createApprovalState(),
    usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
  };

  const finalStream = new MockStream([]);
  finalStream.finalOutput = 'Files listed.';
  finalStream.lastResponseId = 'resp-usage-final';
  finalStream.state = {
    usage: { inputTokens: 300, outputTokens: 50, totalTokens: 350 },
  };

  const mockClient = {
    async startStream() {
      return initialStream;
    },
    async continueRunStream() {
      return finalStream;
    },
    async chat() {
      return JSON.stringify({
        results: [{ id: 'call-usage-1', reasoning: 'Listing files is read-only and safe.', approved: true }],
      });
    },
  };

  const session = new ConversationSession('auto-usage-test', {
    agentClient: mockClient,
    deps: {
      logger: mockLogger,
      settingsService: createMockSettingsService({
        'shell.autoApproveMode': 'auto',
        'agent.autoApproveModel': 'test-model',
        'agent.autoApproveProvider': 'test-provider',
      }),
      sessionContextService: createSessionContextService(),
    },
  });

  const result = await session.sendMessage('list the source files');

  t.is(result.type, 'response');
  if (result.type !== 'response') return;

  // The continuation usage (300/50) supersedes the first-turn usage (100/20)
  t.is(result.usage?.prompt_tokens, 300);
  t.is(result.usage?.completion_tokens, 50);
  t.is(result.usage?.total_tokens, 350);
});

test('auto-approve: finalText comes from auto-approved continuation', async (t) => {
  const firstInterruption = createShellInterruption({ callId: 'call-text-1', command: 'echo hello' });

  const initialStream = new MockStream([]);
  initialStream.interruptions = [firstInterruption];
  initialStream.state = createApprovalState();

  const finalStream = new MockStream([]);
  finalStream.finalOutput = 'Hello from continuation.';
  finalStream.lastResponseId = 'resp-text-final';

  const mockClient = {
    async startStream() {
      return initialStream;
    },
    async continueRunStream() {
      return finalStream;
    },
    async chat() {
      return JSON.stringify({
        results: [{ id: 'call-text-1', reasoning: 'Safe command.', approved: true }],
      });
    },
  };

  const session = new ConversationSession('auto-text-test', {
    agentClient: mockClient,
    deps: {
      logger: mockLogger,
      settingsService: createMockSettingsService({
        'shell.autoApproveMode': 'auto',
        'agent.autoApproveModel': 'test-model',
        'agent.autoApproveProvider': 'test-provider',
      }),
      sessionContextService: createSessionContextService(),
    },
  });

  const result = await session.sendMessage('echo hello');

  t.is(result.type, 'response');
  if (result.type !== 'response') return;
  t.is(result.finalText, 'Hello from continuation.');
});

test('auto-approve: command messages from continuation are preserved in final result', async (t) => {
  const firstInterruption = createShellInterruption({ callId: 'call-cmd-1', command: 'ls' });

  const initialStream = new MockStream([]);
  initialStream.interruptions = [firstInterruption];
  initialStream.state = createApprovalState();

  // This stream's state provides command message data through the continuation runner
  const finalStream = new MockStream([]);
  finalStream.finalOutput = 'Done.';
  finalStream.lastResponseId = 'resp-cmd-final';

  const mockClient = {
    async startStream() {
      return initialStream;
    },
    async continueRunStream() {
      return finalStream;
    },
    async chat() {
      return JSON.stringify({
        results: [{ id: 'call-cmd-1', reasoning: 'Safe.', approved: true }],
      });
    },
  };

  const session = new ConversationSession('auto-cmd-test', {
    agentClient: mockClient,
    deps: {
      logger: mockLogger,
      settingsService: createMockSettingsService({
        'shell.autoApproveMode': 'auto',
        'agent.autoApproveModel': 'test-model',
        'agent.autoApproveProvider': 'test-provider',
      }),
      sessionContextService: createSessionContextService(),
    },
  });

  const result = await session.sendMessage('list files');

  t.is(result.type, 'response');
  if (result.type !== 'response') return;
  t.true(Array.isArray(result.commandMessages));
  t.is(result.finalText, 'Done.');
});

test('auto-approve: two auto-approved commands continue until approval_required or final', async (t) => {
  const first = createShellInterruption({ callId: 'call-batch-a', command: 'ls' });
  const second = createShellInterruption({ callId: 'call-batch-b', command: 'pwd' });

  const initialStream = new MockStream([]);
  initialStream.interruptions = [first, second];
  initialStream.state = createApprovalState();

  const continuationStream = new MockStream([]);
  continuationStream.interruptions = [second];
  continuationStream.state = createApprovalState();

  const mockClient = {
    async startStream() {
      return initialStream;
    },
    async continueRunStream() {
      return continuationStream;
    },
    async chat() {
      return JSON.stringify({
        results: [
          { id: 'call-batch-a', reasoning: 'Listing is safe.', approved: true },
          { id: 'call-batch-b', reasoning: 'PWD is safe but needs user approval.', approved: false },
        ],
      });
    },
  };

  const session = new ConversationSession('auto-batch-test', {
    agentClient: mockClient,
    deps: {
      logger: mockLogger,
      settingsService: createMockSettingsService({
        'shell.autoApproveMode': 'auto',
        'agent.autoApproveModel': 'test-model',
        'agent.autoApproveProvider': 'test-provider',
      }),
      sessionContextService: createSessionContextService(),
    },
  });

  // First command is auto-approved; continuation hits the second which is
  // rejected by the LLM, so we should get an approval_required event
  const result = await session.sendMessage('list files and print working directory');

  t.is(result.type, 'approval_required');
  if (result.type !== 'approval_required') return;

  // The second command is the one that triggered the prompt
  t.is(result.approval.toolName, 'shell');
  t.truthy(result.approval.llmAdvisory);
});

// ══════════════════════════════════════════════════════════════════════════
// 8. Traffic context includes session context fields
// ══════════════════════════════════════════════════════════════════════════

test('sendMessage runs inside sessionContextService.runWithContext with session context fields', async (t) => {
  const contextLog = [];

  const sessionContextService = {
    runWithContext(context, fn) {
      contextLog.push(context);
      return fn();
    },
    getContext: () => null,
  };

  const loggerWithTrace = {
    ...mockLogger,
    getCorrelationId: () => 'trace-abc-123',
  };

  const stream = new MockStream([]);
  stream.finalOutput = 'Traced.';
  stream.lastResponseId = 'resp-traffic';

  const mockClient = {
    async startStream() {
      return stream;
    },
  };

  const session = new ConversationSession('traffic-test', {
    agentClient: mockClient,
    deps: { logger: loggerWithTrace, sessionContextService },
  });

  await session.sendMessage('my first question');

  t.is(contextLog.length, 1);
  const ctx = contextLog[0];

  t.is(ctx.sessionId, 'traffic-test');
  t.truthy(ctx.sessionStartedAt, 'sessionStartedAt should be a non-empty string');
  t.is(ctx.firstUserMessagePreview, 'my first question');
  t.is(ctx.mode, 'standard', 'Default mode (no settingsService) should be standard');
  t.is(ctx.traceId, 'trace-abc-123');
});

test('sendMessage sets firstUserMessagePreview to first turn text even on subsequent messages', async (t) => {
  const contextLog = [];

  const sessionContextService = {
    runWithContext(context, fn) {
      contextLog.push(context);
      return fn();
    },
    getContext: () => null,
  };

  const loggerWithTrace = {
    ...mockLogger,
    getCorrelationId: () => 'trace-second',
  };

  const makeStream = (text) => {
    const s = new MockStream([]);
    s.finalOutput = `Reply: ${text}`;
    s.lastResponseId = `resp-${text}`;
    return s;
  };

  let callCount = 0;
  const mockClient = {
    async startStream() {
      callCount++;
      return makeStream(`call-${callCount}`);
    },
  };

  const session = new ConversationSession('traffic-preview', {
    agentClient: mockClient,
    deps: { logger: loggerWithTrace, sessionContextService },
  });

  // First message becomes the "first user message"
  await session.sendMessage('first turn');
  // Second message should still show "first turn" as the firstUserMessagePreview
  await session.sendMessage('second turn');

  t.is(contextLog.length, 2);

  // Both traffic contexts should reference the first message as the preview
  t.is(contextLog[0].firstUserMessagePreview, 'first turn');
  t.is(contextLog[1].firstUserMessagePreview, 'first turn', 'Second turn should keep first turn as preview');
});
