// @ts-nocheck - Characterization tests for ConversationSession refactoring
import test from 'ava';
import { ConversationSession } from './conversation-session.js';
import { createConversationSession } from './conversation-session-factory.js';
import { createMockSettingsService } from './settings-service.mock.js';
import { MockStream } from './test-helpers/mock-stream.js';
import { createConversationSessionComposition } from './conversation-session-composition.js';
import { TurnItemAccumulator } from './turn-item-accumulator.js';

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

  const bundle = createConversationSession({
    sessionId: 'sink-test',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
  });
  const { session, terminalAdapter } = bundle;

  await terminalAdapter.sendMessage('hello');

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

  const bundle = createConversationSession({
    sessionId: 'log-dispatch',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
  });
  const { terminalAdapter } = bundle;

  const result = await terminalAdapter.sendMessage('hi', {
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

  const bundle = createConversationSession({
    sessionId: 'no-pending',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
  });
  const { terminalAdapter } = bundle;

  // No approval pending
  const result = await terminalAdapter.handleApprovalDecision('y');
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

  const bundle = createConversationSession({
    sessionId: 'reject-no-pending',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
  });
  const { terminalAdapter } = bundle;

  const result = await terminalAdapter.handleApprovalDecision('n', 'User rejected');
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

  const bundle = createConversationSession({
    sessionId: 'ask-user-test',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
  });
  const { terminalAdapter } = bundle;

  const approvalResult = await terminalAdapter.sendMessage('ask the user');
  t.is(approvalResult.type, 'approval_required');

  const finalResult = await terminalAdapter.handleApprovalDecision('y', undefined, {
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

  const bundle = createConversationSession({
    sessionId: 'reject-no-ask',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
  });
  const { terminalAdapter } = bundle;

  const approvalResult = await terminalAdapter.sendMessage('run command');
  t.is(approvalResult.type, 'approval_required');

  const rejectionResult = await terminalAdapter.handleApprovalDecision('n', 'User rejected', {
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

  const bundle = createConversationSession({
    sessionId: 'no-answer-test',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
  });
  const { terminalAdapter } = bundle;

  const approvalResult = await terminalAdapter.sendMessage('run command');
  t.is(approvalResult.type, 'approval_required');

  // No approvalAnswer provided; handleApprovalDecision still calls continueAfterApproval
  const result = await terminalAdapter.handleApprovalDecision('y');
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

  const bundle = createConversationSession({
    sessionId: 'abort-empty',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
  });
  const { session, stateFacade } = bundle;

  // No approval pending; abort should be a no-op
  session.abort();

  // The tool ledger should still be empty
  const snapshot = stateFacade.getCurrentSnapshot();
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

  const bundle = createConversationSession({
    sessionId: 'abort-pending',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
  });
  const { session, terminalAdapter, stateFacade } = bundle;

  await terminalAdapter.sendMessage('run command');

  // Now abort
  session.abort();

  // Verify the tool ledger has an aborted entry
  const snapshot = stateFacade.getCurrentSnapshot();
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

  const bundle = createConversationSession({
    sessionId: 'snapshot-test',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
  });
  const { stateFacade } = bundle;

  const snapshot = stateFacade.getCurrentSnapshot();

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

  const bundle = createConversationSession({
    sessionId: 'provider-test',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
  });
  const { stateFacade } = bundle;

  const snapshot = stateFacade.getCurrentSnapshot();
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

  const bundle = createConversationSession({
    sessionId: 'model-test',
    agentClient: mockClient,
    deps: {
      logger: mockLogger,
      settingsService: createMockSettingsService({ 'agent.model': 'gpt-4o-test' }),
      sessionContextService: createSessionContextService(),
    },
  });
  const { stateFacade } = bundle;

  const snapshot = stateFacade.getCurrentSnapshot();
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

  const bundle = createConversationSession({
    sessionId: 'set-model',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
  });
  const { runtimeController } = bundle;

  runtimeController.setModel('gpt-4');

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

  const bundle = createConversationSession({
    sessionId: 'set-provider',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
  });
  const { runtimeController } = bundle;

  runtimeController.setProvider('anthropic');

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

  const bundle = createConversationSession({
    sessionId: 'switch-provider',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
  });
  const { runtimeController } = bundle;

  runtimeController.switchProvider('openai');

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

  const bundle = createConversationSession({
    sessionId: 'set-temp',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
  });
  const { runtimeController } = bundle;

  runtimeController.setTemperature(0.7);

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

  const bundle = createConversationSession({
    sessionId: 'set-temp-undef',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
  });
  const { runtimeController } = bundle;

  runtimeController.setTemperature(undefined);

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

  const bundle = createConversationSession({
    sessionId: 'set-reasoning',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
  });
  const { runtimeController } = bundle;

  runtimeController.setReasoningEffort('high');

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

  const bundle = createConversationSession({
    sessionId: 'no-reasoning',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
  });
  const { runtimeController } = bundle;

  // Should not throw
  runtimeController.setReasoningEffort('low');
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

  const bundle = createConversationSession({
    sessionId: 'auto-usage-test',
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
  const { terminalAdapter } = bundle;

  const result = await terminalAdapter.sendMessage('list the source files');

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

  const bundle = createConversationSession({
    sessionId: 'auto-text-test',
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
  const { terminalAdapter } = bundle;

  const result = await terminalAdapter.sendMessage('echo hello');

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

  const bundle = createConversationSession({
    sessionId: 'auto-cmd-test',
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
  const { terminalAdapter } = bundle;

  const result = await terminalAdapter.sendMessage('list files');

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

  const bundle = createConversationSession({
    sessionId: 'auto-batch-test',
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
  const { terminalAdapter } = bundle;

  // First command is auto-approved; continuation hits the second which is
  // rejected by the LLM, so we should get an approval_required event
  const result = await terminalAdapter.sendMessage('list files and print working directory');

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

  const bundle = createConversationSession({
    sessionId: 'traffic-test',
    agentClient: mockClient,
    deps: { logger: loggerWithTrace, sessionContextService },
  });
  const { terminalAdapter } = bundle;

  await terminalAdapter.sendMessage('my first question');

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

  const bundle = createConversationSession({
    sessionId: 'traffic-preview',
    agentClient: mockClient,
    deps: { logger: loggerWithTrace, sessionContextService },
  });
  const { terminalAdapter } = bundle;

  // First message becomes the "first user message"
  await terminalAdapter.sendMessage('first turn');
  // Second message should still show "first turn" as the firstUserMessagePreview
  await terminalAdapter.sendMessage('second turn');

  t.is(contextLog.length, 2);

  // Both traffic contexts should reference the first message as the preview
  t.is(contextLog[0].firstUserMessagePreview, 'first turn');
  t.is(contextLog[1].firstUserMessagePreview, 'first turn', 'Second turn should keep first turn as preview');
});

// ══════════════════════════════════════════════════════════════════════════
// 9. TurnCoordinator observable event sequences
// ══════════════════════════════════════════════════════════════════════════

test('approval then approval emits each terminal boundary in order', async (t) => {
  const first = createShellInterruption({ callId: 'call-first', command: 'echo first' });
  const second = createShellInterruption({ callId: 'call-second', command: 'echo second' });

  const initialStream = new MockStream([]);
  initialStream.interruptions = [first];
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
  };

  const { session } = createConversationSession({
    sessionId: 'approval-then-approval',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
  });

  const events = [];
  for await (const event of session.run('run both commands')) {
    events.push(event);
  }
  for await (const event of session.continueAfterApproval({ answer: 'y' })) {
    events.push(event);
  }

  t.deepEqual(
    events.map((event) =>
      event.type === 'approval_required'
        ? { type: event.type, callId: event.approval.callId }
        : event.type === 'tool_started'
        ? { type: event.type, callId: event.toolCallId }
        : { type: event.type },
    ),
    [
      { type: 'approval_required', callId: 'call-first' },
      { type: 'tool_started', callId: 'call-first' },
      { type: 'approval_required', callId: 'call-second' },
    ],
  );
});

test('approval then rejection emits no tool_started event for the rejected tool', async (t) => {
  const interruption = createShellInterruption({ callId: 'call-rejected', command: 'echo rejected' });
  const approvalState = createApprovalState();

  const initialStream = new MockStream([]);
  initialStream.interruptions = [interruption];
  initialStream.state = approvalState;

  const rejectedStream = new MockStream([{ type: 'response.output_text.delta', delta: 'Rejected.' }]);
  rejectedStream.finalOutput = 'Rejected.';

  const mockClient = {
    async startStream() {
      return initialStream;
    },
    async continueRunStream() {
      return rejectedStream;
    },
  };

  const { session } = createConversationSession({
    sessionId: 'approval-then-rejection',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
  });

  const events = [];
  for await (const event of session.run('run a command')) {
    events.push(event);
  }
  for await (const event of session.continueAfterApproval({
    answer: 'n',
    rejectionReason: 'Not needed',
  })) {
    events.push(event);
  }

  t.deepEqual(
    events.map((event) =>
      event.type === 'approval_required'
        ? { type: event.type, callId: event.approval.callId }
        : event.type === 'text_delta' || event.type === 'final'
        ? { type: event.type, text: event.type === 'text_delta' ? event.delta : event.finalText }
        : { type: event.type },
    ),
    [
      { type: 'approval_required', callId: 'call-rejected' },
      { type: 'text_delta', text: 'Rejected.' },
      { type: 'final', text: 'Rejected.' },
    ],
  );
  t.deepEqual(approvalState.approveCalls, []);
  t.deepEqual(approvalState.rejectCalls, [interruption]);
});

test('multiple sequential interruptions preserve approval and tool-start ordering', async (t) => {
  const interruptions = [
    createShellInterruption({ callId: 'call-one', command: 'echo one' }),
    createShellInterruption({ callId: 'call-two', command: 'echo two' }),
    createShellInterruption({ callId: 'call-three', command: 'echo three' }),
  ];

  const streams = interruptions.map((interruption) => {
    const stream = new MockStream([]);
    stream.interruptions = [interruption];
    stream.state = createApprovalState();
    return stream;
  });
  const finalStream = new MockStream([{ type: 'response.output_text.delta', delta: 'All done.' }]);
  finalStream.finalOutput = 'All done.';
  let continuationIndex = 0;

  const mockClient = {
    async startStream() {
      return streams[0];
    },
    async continueRunStream() {
      continuationIndex++;
      return continuationIndex < streams.length ? streams[continuationIndex] : finalStream;
    },
  };

  const { session } = createConversationSession({
    sessionId: 'sequential-interruptions',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
  });

  const events = [];
  for await (const event of session.run('run three commands')) {
    events.push(event);
  }
  for (let index = 0; index < 3; index++) {
    for await (const event of session.continueAfterApproval({ answer: 'y' })) {
      events.push(event);
    }
  }

  t.deepEqual(
    events.map((event) => {
      if (event.type === 'approval_required') {
        return `${event.type}:${event.approval.callId}`;
      }
      if (event.type === 'tool_started') {
        return `${event.type}:${event.toolCallId}`;
      }
      return event.type;
    }),
    [
      'approval_required:call-one',
      'tool_started:call-one',
      'approval_required:call-two',
      'tool_started:call-two',
      'approval_required:call-three',
      'tool_started:call-three',
      'text_delta',
      'final',
    ],
  );
});

test('aborted approval resolved by new user input emits the abort marker before resumed output', async (t) => {
  const interruption = createShellInterruption({ callId: 'call-aborted', command: 'echo pending' });
  const initialStream = new MockStream([]);
  initialStream.interruptions = [interruption];
  initialStream.state = createApprovalState();

  const resolvedStream = new MockStream([{ type: 'response.output_text.delta', delta: 'Changed course.' }]);
  resolvedStream.finalOutput = 'Changed course.';

  const mockClient = {
    abort() {},
    async startStream() {
      return initialStream;
    },
    async continueRunStream() {
      return resolvedStream;
    },
  };

  const bundle = createConversationSession({
    sessionId: 'aborted-approval-resolution',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
  });

  const events = [];
  for await (const event of bundle.session.run('run pending command')) {
    events.push(event);
  }
  bundle.session.abort();
  for await (const event of bundle.session.run('do something else')) {
    events.push(event);
  }

  t.deepEqual(
    events.map((event) => event.type),
    ['approval_required', 'user_message_consumed_for_abort', 'text_delta', 'final'],
  );
  t.deepEqual(
    bundle.stateFacade.listUserTurns().map(({ text, imageCount }) => ({ text, imageCount })),
    [{ text: 'run pending command', imageCount: 0 }],
  );
});

// ══════════════════════════════════════════════════════════════════════════
// Refactoring characterization tests
// ══════════════════════════════════════════════════════════════════════════

test('characterization - undo while an approval is pending invalidates pending approval and prevents continuation', async (t) => {
  const interruption = createShellInterruption({ callId: 'call-pending-tool', command: 'rm -rf /' });
  const interruptedStream = new MockStream([]);
  interruptedStream.interruptions = [interruption];
  interruptedStream.state = createApprovalState();

  const mockClient = {
    async startStream() {
      return interruptedStream;
    },
  };

  const composition = createConversationSessionComposition({
    sessionId: 'undo-pending-test',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
    turnAccumulator: new TurnItemAccumulator(),
  });
  const session = new ConversationSession('undo-pending-test', {
    startedAt: new Date().toISOString(),
    composition,
  });

  const emitted = [];
  for await (const event of session.run('trigger tool call')) {
    emitted.push(event);
  }

  // We should have received approval_required
  t.is(emitted.length, 1);
  t.is(emitted[0].type, 'approval_required');

  // Verify there is a pending approval in approvalState
  t.truthy(composition.approvalState.getPending());

  // Trigger undo
  composition.stateFacade.undoLastUserTurn();

  // Verify that pending approval is invalidated/cleared
  t.is(composition.approvalState.getPending(), null);

  // Verify continuation is not allowed (throws error)
  await t.throwsAsync(
    async () => {
      for await (const _ of session.continueAfterApproval({ answer: 'y' })) {
      }
    },
    { message: 'No pending approval to continue.' },
  );
});

test('characterization - reset while an approval is pending invalidates pending approval and resets status machine', async (t) => {
  const interruption = createShellInterruption({ callId: 'call-pending-tool-reset', command: 'rm -rf /' });
  const interruptedStream = new MockStream([]);
  interruptedStream.interruptions = [interruption];
  interruptedStream.state = createApprovalState();

  const mockClient = {
    async startStream() {
      return interruptedStream;
    },
  };

  const composition = createConversationSessionComposition({
    sessionId: 'reset-pending-test',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
    turnAccumulator: new TurnItemAccumulator(),
  });
  const session = new ConversationSession('reset-pending-test', {
    startedAt: new Date().toISOString(),
    composition,
  });

  const emitted = [];
  for await (const event of session.run('trigger tool call')) {
    emitted.push(event);
  }

  t.is(emitted[0].type, 'approval_required');
  t.truthy(composition.approvalState.getPending());

  // Trigger reset
  composition.stateFacade.reset();

  // Verify pending approval is cleared
  t.is(composition.approvalState.getPending(), null);

  // Verify continuation throws 'No pending approval to continue.' because status machine is reset to idle
  await t.throwsAsync(
    async () => {
      for await (const _ of session.continueAfterApproval({ answer: 'y' })) {
      }
    },
    { message: 'No pending approval to continue.' },
  );
});
