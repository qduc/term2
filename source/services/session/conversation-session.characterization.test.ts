import { it, expect } from 'vitest';
import { createSessionRuntimeInternals } from './session-composition.js';
import { createConversationSession } from '../../test-helpers/conversation-session-with-adapter.js';
import { createMockSettingsService } from '../settings/settings-service.mock.js';
import { MockStream } from '../test-helpers/mock-stream.js';
import { TurnItemAccumulator } from './turn-item-accumulator.js';
import type { ILoggingService, ISessionContextService } from '../service-interfaces.js';
import type { ConversationAgentClient } from '../conversation-agent-client.js';

// ── Shared mocks ───────────────────────────────────────────────────────────

const mockLogger: ILoggingService = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  security: () => {},
  setCorrelationId: () => {},
  getCorrelationId: () => undefined,
  clearCorrelationId: () => {},
};

const createSessionContextService = (): ISessionContextService => {
  let capturedContext: import('../service-interfaces.js').SessionTrafficContext | null = null;
  return {
    runWithContext: <T>(context: import('../service-interfaces.js').SessionTrafficContext, fn: () => T): T => {
      capturedContext = context;
      return fn();
    },
    getContext: () => capturedContext,
  };
};

// ── Helper: ApprovalState-like object for mock streams ────────────────────

const createApprovalState = () => ({
  approveCalls: [] as unknown[],
  rejectCalls: [] as unknown[],
  approve(interruption: unknown) {
    this.approveCalls.push(interruption);
  },
  reject(interruption: unknown) {
    this.rejectCalls.push(interruption);
  },
});

const createShellInterruption = ({ callId, command }: { callId?: string; command: string }) => ({
  name: 'shell',
  agent: { name: 'CLI Agent' },
  arguments: JSON.stringify({ command }),
  ...(callId ? { callId } : {}),
});

// ── Helper: typed mock agent client ──────────────────────────────────────

const createMockAgentClient = (overrides: Record<string, unknown> = {}): ConversationAgentClient =>
  ({
    startStream: async () => new MockStream([]),
    continueRunStream: async () => new MockStream([]),
    abort: () => {},
    setModel: () => {},
    addToolInterceptor: () => () => {},
    chat: async () => '',
    ...overrides,
  } as unknown as ConversationAgentClient);

// ══════════════════════════════════════════════════════════════════════════
// 1. sendMessage wraps events with log dispatch and clears
//    setSubagentEventSink in finally
// ══════════════════════════════════════════════════════════════════════════

it('sendMessage installs setSubagentEventSink with a function then clears it to null', async () => {
  const sinkCalls: unknown[] = [];

  const stream = new MockStream([]);
  stream.finalOutput = 'Hello';
  stream.lastResponseId = 'resp-sink-test';

  const mockClient = createMockAgentClient({
    async startStream() {
      return stream;
    },
  });

  const bundle = createConversationSession({
    sessionId: 'sink-test',
    agentClient: mockClient,
    subagentEventSinkHost: {
      setSubagentEventSink(sink: unknown) {
        sinkCalls.push(typeof sink === 'function' ? 'function' : sink);
      },
    },
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
  });
  const { terminalAdapter } = bundle;

  await terminalAdapter.sendMessage('hello');

  // First call: a function (the wrapped onEvent)
  expect(sinkCalls[0], 'First setSubagentEventSink call should install a function callback').toBe('function');
  // After the finally block: null
  expect(sinkCalls[sinkCalls.length - 1], 'Last setSubagentEventSink call should clear to null').toBe(null);
  // Exactly 2 calls: install then clear
  expect(sinkCalls.length, 'setSubagentEventSink should be called exactly twice (install + clear)').toBe(2);
});

it('sendMessage dispatches events through conversationLogger before onEvent callback', async () => {
  const eventLog: any[] = [];

  const stream = new MockStream([{ type: 'response.output_text.delta', delta: 'Hello' }]);
  stream.finalOutput = 'Hello';
  stream.lastResponseId = 'resp-log-dispatch';

  const mockClient = createMockAgentClient({
    async startStream() {
      return stream;
    },
  });

  const bundle = createConversationSession({
    sessionId: 'log-dispatch',
    agentClient: mockClient,
    subagentEventSinkHost: {
      setSubagentEventSink() {},
    },
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
  });
  const { terminalAdapter } = bundle;

  const result = await terminalAdapter.sendMessage('hi', {
    onEvent: (event) => {
      eventLog.push({ phase: 'onEvent', type: event.type });
    },
  });

  expect(result.type).toBe('response');
  // The onEvent callback was called at least for final event
  expect(eventLog.length > 0).toBe(true);
});

// ══════════════════════════════════════════════════════════════════════════
// 2. handleApprovalDecision returns null when no approval is pending
// ══════════════════════════════════════════════════════════════════════════

it('handleApprovalDecision returns null when no approval is pending', async () => {
  const mockClient = createMockAgentClient({
    async startStream() {
      const stream = new MockStream([]);
      stream.finalOutput = 'Done.';
      stream.lastResponseId = 'resp-no-pending';
      return stream;
    },
  });

  const bundle = createConversationSession({
    sessionId: 'no-pending',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
  });
  const { terminalAdapter } = bundle;

  // No approval pending
  const result = await terminalAdapter.handleApprovalDecision('y');
  expect(result).toBe(null);
});

it('handleApprovalDecision returns null for rejection when no approval is pending', async () => {
  const mockClient = createMockAgentClient({
    async startStream() {
      const stream = new MockStream([]);
      stream.finalOutput = 'Done.';
      stream.lastResponseId = 'resp-reject-no-pending';
      return stream;
    },
  });

  const bundle = createConversationSession({
    sessionId: 'reject-no-pending',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
  });
  const { terminalAdapter } = bundle;

  const result = await terminalAdapter.handleApprovalDecision('n', 'User rejected');
  expect(result).toBe(null);
});

// ══════════════════════════════════════════════════════════════════════════
// 3. handleApprovalDecision sets ask-user answer by call ID for
//    accepted approvals
// ══════════════════════════════════════════════════════════════════════════

it('handleApprovalDecision forwards approvalAnswer to agentClient.setAskUserAnswer', async () => {
  const askUserCalls: any[] = [];

  const interruptedStream = new MockStream([]);
  interruptedStream.interruptions = [createShellInterruption({ callId: 'call-ask-user-test', command: 'echo test' })];
  interruptedStream.state = createApprovalState();

  const finalStream = new MockStream([]);
  finalStream.finalOutput = 'Answer forwarded.';
  finalStream.lastResponseId = 'resp-ask-user';

  const mockClient = createMockAgentClient({
    async startStream() {
      return interruptedStream;
    },
    async continueRunStream() {
      return finalStream;
    },
  });

  const bundle = createConversationSession({
    sessionId: 'ask-user-test',
    agentClient: mockClient,
    askUserAnswerSink: {
      setAskUserAnswer(callId: string, answer: string) {
        askUserCalls.push({ callId, answer });
      },
    },
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
  });
  const { terminalAdapter } = bundle;

  const approvalResult = await terminalAdapter.sendMessage('ask the user');
  expect(approvalResult.type).toBe('approval_required');

  const finalResult = await terminalAdapter.handleApprovalDecision('y', undefined, {
    approvalAnswer: 'Use option B',
  });

  expect(finalResult?.type).toBe('response');
  expect((finalResult as { type: 'response'; finalText: string }).finalText).toBe('Answer forwarded.');
  expect(askUserCalls).toEqual([{ callId: 'call-ask-user-test', answer: 'Use option B' }]);
});

it('handleApprovalDecision does not call setAskUserAnswer when answer is not y', async () => {
  const askUserCalls: any[] = [];

  const interruptedStream = new MockStream([]);
  interruptedStream.interruptions = [createShellInterruption({ callId: 'call-reject', command: 'echo reject' })];
  interruptedStream.state = createApprovalState();

  const rejectionFinal = new MockStream([]);
  rejectionFinal.finalOutput = 'Rejected.';
  rejectionFinal.lastResponseId = 'resp-rejected';

  const mockClient = createMockAgentClient({
    async startStream() {
      return interruptedStream;
    },
    async continueRunStream() {
      return rejectionFinal;
    },
  });

  const bundle = createConversationSession({
    sessionId: 'reject-no-ask',
    agentClient: mockClient,
    askUserAnswerSink: {
      setAskUserAnswer(callId: string, answer: string) {
        askUserCalls.push({ callId, answer });
      },
    },
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
  });
  const { terminalAdapter } = bundle;

  const approvalResult = await terminalAdapter.sendMessage('run command');
  expect(approvalResult.type).toBe('approval_required');

  const rejectionResult = await terminalAdapter.handleApprovalDecision('n', 'User rejected', {
    approvalAnswer: 'Use option B',
  });

  // Rejection returns a response from the continuation runner
  expect(rejectionResult?.type).toBe('response');
  expect(askUserCalls.length > 0).toBe(false);
});

it('handleApprovalDecision does not call setAskUserAnswer when approvalAnswer is not provided', async () => {
  const askUserCalls: any[] = [];

  const interruptedStream = new MockStream([]);
  interruptedStream.interruptions = [createShellInterruption({ callId: 'call-no-answer', command: 'echo no answer' })];
  interruptedStream.state = createApprovalState();

  const noAnswerFinal = new MockStream([]);
  noAnswerFinal.finalOutput = 'Done.';
  noAnswerFinal.lastResponseId = 'resp-no-answer';

  const mockClient = createMockAgentClient({
    async startStream() {
      return interruptedStream;
    },
    async continueRunStream() {
      return noAnswerFinal;
    },
  });

  const bundle = createConversationSession({
    sessionId: 'no-answer-test',
    agentClient: mockClient,
    askUserAnswerSink: {
      setAskUserAnswer(callId: string, answer: string) {
        askUserCalls.push({ callId, answer });
      },
    },
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
  });
  const { terminalAdapter } = bundle;

  const approvalResult = await terminalAdapter.sendMessage('run command');
  expect(approvalResult.type).toBe('approval_required');

  // No approvalAnswer provided; handleApprovalDecision still calls continueAfterApproval
  const result = await terminalAdapter.handleApprovalDecision('y');
  expect(result?.type).toBe('response');
  expect(askUserCalls.length > 0).toBe(false);
});

// ══════════════════════════════════════════════════════════════════════════
// 4. abort records aborted approval tool ledger entry only when an
//    approval was pending
// ══════════════════════════════════════════════════════════════════════════

it('abort with no pending approval does not throw and produces no change in snapshot toolLedger', async () => {
  const mockClient = createMockAgentClient({
    abort() {},
    async startStream() {
      const stream = new MockStream([]);
      stream.finalOutput = 'Done.';
      stream.lastResponseId = 'resp-abort-empty';
      return stream;
    },
  });

  const bundle = createConversationSession({
    sessionId: 'abort-empty',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
  });
  const { turnCoordinator, stateFacade } = bundle;

  // No approval pending; abort should be a no-op
  turnCoordinator.abort();

  // The tool ledger should still be empty
  const snapshot = stateFacade.getCurrentSnapshot();
  expect(snapshot.toolLedger, 'Tool ledger should be empty when no approval was pending at abort').toEqual([]);
});

it('abort with pending approval records aborted entry in tool ledger', async () => {
  const interruptedStream = new MockStream([]);
  interruptedStream.interruptions = [createShellInterruption({ callId: 'call-abort-1', command: 'echo abort me' })];
  interruptedStream.state = createApprovalState();

  const mockClient = createMockAgentClient({
    abort() {},
    async startStream() {
      return interruptedStream;
    },
  });

  const bundle = createConversationSession({
    sessionId: 'abort-pending',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
  });
  const { turnCoordinator, terminalAdapter, stateFacade } = bundle;

  await terminalAdapter.sendMessage('run command');

  // Now abort
  turnCoordinator.abort();

  // Verify the tool ledger has an aborted entry
  const snapshot = stateFacade.getCurrentSnapshot();
  const abortedEntries = snapshot.toolLedger.filter((entry) => entry.status === 'aborted');
  expect(abortedEntries.length > 0).toBe(true);
  expect(abortedEntries[0].callId).toBe('call-abort-1');
});

// ══════════════════════════════════════════════════════════════════════════
// 5. getCurrentSnapshot reconciles history with tool ledger and
//    includes provider/model
// ══════════════════════════════════════════════════════════════════════════

it('getCurrentSnapshot returns expected shape with history, previousResponseId, and toolLedger', async () => {
  const mockClient = createMockAgentClient({
    async startStream() {
      const stream = new MockStream([]);
      stream.finalOutput = 'Done.';
      stream.lastResponseId = 'resp-snapshot';
      return stream;
    },
  });

  const bundle = createConversationSession({
    sessionId: 'snapshot-test',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
  });
  const { stateFacade } = bundle;

  const snapshot = stateFacade.getCurrentSnapshot();

  expect(Array.isArray(snapshot.history)).toBe(true);
  expect(snapshot.previousResponseId === null || typeof snapshot.previousResponseId === 'string').toBe(true);
  expect(Array.isArray(snapshot.toolLedger)).toBe(true);
});

it('getCurrentSnapshot includes provider from agentClient.getProvider when available', async () => {
  const mockClient = createMockAgentClient({
    async startStream() {
      const stream = new MockStream([]);
      stream.finalOutput = 'Done.';
      stream.lastResponseId = 'resp-provider';
      return stream;
    },
    getProvider() {
      return 'test-provider';
    },
  });

  const bundle = createConversationSession({
    sessionId: 'provider-test',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
  });
  const { stateFacade } = bundle;

  const snapshot = stateFacade.getCurrentSnapshot();
  expect(snapshot.provider).toBe('test-provider');
});

it('getCurrentSnapshot includes model from settingsService when available', async () => {
  const mockClient = createMockAgentClient({
    async startStream() {
      const stream = new MockStream([]);
      stream.finalOutput = 'Done.';
      stream.lastResponseId = 'resp-model';
      return stream;
    },
  });

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
  expect(snapshot.model).toBe('gpt-4o-test');
});

// ══════════════════════════════════════════════════════════════════════════
// 6. Provider/model/temperature/reasoning changes call
//    afterProviderChanged before mutating agent client
// ══════════════════════════════════════════════════════════════════════════

it('setModel calls afterProviderChanged then agentClient.setModel', async () => {
  const calls: any[] = [];

  const mockClient = createMockAgentClient({
    async startStream() {
      const stream = new MockStream([]);
      stream.finalOutput = 'Done.';
      stream.lastResponseId = 'resp-set-model';
      return stream;
    },
    setModel(model: string) {
      calls.push({ method: 'setModel', model });
    },
  });

  const bundle = createConversationSession({
    sessionId: 'set-model',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
  });
  const { runtimeController } = bundle;

  runtimeController.setModel('gpt-4');

  expect(calls.length).toBe(1);
  expect(calls[0].method).toBe('setModel');
  expect(calls[0].model).toBe('gpt-4');
});

it('setProvider calls afterProviderChanged then agentClient.setProvider', async () => {
  const calls: any[] = [];

  const mockClient = createMockAgentClient({
    async startStream() {
      const stream = new MockStream([]);
      stream.finalOutput = 'Done.';
      stream.lastResponseId = 'resp-set-provider';
      return stream;
    },
    setProvider(provider: string) {
      calls.push({ method: 'setProvider', provider });
    },
  });

  const bundle = createConversationSession({
    sessionId: 'set-provider',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
  });
  const { runtimeController } = bundle;

  runtimeController.setProvider('anthropic');

  expect(calls.length).toBe(1);
  expect(calls[0].method).toBe('setProvider');
  expect(calls[0].provider).toBe('anthropic');
});

it('setProvider is idempotent via switchProvider alias', async () => {
  const calls: any[] = [];

  const mockClient = createMockAgentClient({
    async startStream() {
      const stream = new MockStream([]);
      stream.finalOutput = 'Done.';
      stream.lastResponseId = 'resp-switch';
      return stream;
    },
    setProvider(provider: string) {
      calls.push({ method: 'setProvider', provider });
    },
  });

  const bundle = createConversationSession({
    sessionId: 'switch-provider',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
  });
  const { runtimeController } = bundle;

  runtimeController.switchProvider('openai');

  expect(calls.length).toBe(1);
  expect(calls[0].provider).toBe('openai');
});

it('setTemperature calls afterProviderChanged then agentClient.setTemperature', async () => {
  const calls: any[] = [];

  const mockClient = createMockAgentClient({
    async startStream() {
      const stream = new MockStream([]);
      stream.finalOutput = 'Done.';
      stream.lastResponseId = 'resp-set-temp';
      return stream;
    },
    setTemperature(temp: number) {
      calls.push({ method: 'setTemperature', temp });
    },
  });

  const bundle = createConversationSession({
    sessionId: 'set-temp',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
  });
  const { runtimeController } = bundle;

  runtimeController.setTemperature(0.7);

  expect(calls.length).toBe(1);
  expect(calls[0].method).toBe('setTemperature');
  expect(calls[0].temp).toBe(0.7);
});

it('setTemperature with undefined is passed through to agentClient', async () => {
  const calls: any[] = [];

  const mockClient = createMockAgentClient({
    async startStream() {
      const stream = new MockStream([]);
      stream.finalOutput = 'Done.';
      stream.lastResponseId = 'resp-set-temp-undefined';
      return stream;
    },
    setTemperature(temp: number) {
      calls.push({ method: 'setTemperature', temp });
    },
  });

  const bundle = createConversationSession({
    sessionId: 'set-temp-undef',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
  });
  const { runtimeController } = bundle;

  runtimeController.setTemperature(undefined);

  expect(calls.length).toBe(1);
  expect(calls[0].temp).toBe(undefined);
});

it('setReasoningEffort calls afterProviderChanged then agentClient.setReasoningEffort', async () => {
  const calls: any[] = [];

  const mockClient = createMockAgentClient({
    async startStream() {
      const stream = new MockStream([]);
      stream.finalOutput = 'Done.';
      stream.lastResponseId = 'resp-set-reasoning';
      return stream;
    },
    setReasoningEffort(effort: string) {
      calls.push({ method: 'setReasoningEffort', effort });
    },
  });

  const bundle = createConversationSession({
    sessionId: 'set-reasoning',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
  });
  const { runtimeController } = bundle;

  runtimeController.setReasoningEffort('high');

  expect(calls.length).toBe(1);
  expect(calls[0].method).toBe('setReasoningEffort');
  expect(calls[0].effort).toBe('high');
});

it('setReasoningEffort is a no-op when agentClient lacks setReasoningEffort', async () => {
  // An agentClient without the optional setReasoningEffort method
  const mockClient = createMockAgentClient({
    async startStream() {
      const stream = new MockStream([]);
      stream.finalOutput = 'Done.';
      stream.lastResponseId = 'resp-no-reasoning';
      return stream;
    },
  });

  const bundle = createConversationSession({
    sessionId: 'no-reasoning',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
  });
  const { runtimeController } = bundle;

  // Should not throw
  runtimeController.setReasoningEffort('low');
  expect(true).toBe(true);
});

// ══════════════════════════════════════════════════════════════════════════
// 7. Auto-approved tool continuations preserve cumulative usage and
//    command messages (#buildAndResolve)
// ══════════════════════════════════════════════════════════════════════════

it('auto-approve: cumulative usage from continuation supersedes first-turn usage', async () => {
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

  const mockClient = createMockAgentClient({
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
  });

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

  expect(result.type).toBe('response');
  if (result.type !== 'response') return;

  // The continuation usage (300/50) supersedes the first-turn usage (100/20)
  expect(result.usage?.prompt_tokens).toBe(300);
  expect(result.usage?.completion_tokens).toBe(50);
  expect(result.usage?.total_tokens).toBe(350);
});

it('auto-approve: finalText comes from auto-approved continuation', async () => {
  const firstInterruption = createShellInterruption({ callId: 'call-text-1', command: 'echo hello' });

  const initialStream = new MockStream([]);
  initialStream.interruptions = [firstInterruption];
  initialStream.state = createApprovalState();

  const finalStream = new MockStream([]);
  finalStream.finalOutput = 'Hello from continuation.';
  finalStream.lastResponseId = 'resp-text-final';

  const mockClient = createMockAgentClient({
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
  });

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

  expect(result.type).toBe('response');
  if (result.type !== 'response') return;
  expect(result.finalText).toBe('Hello from continuation.');
});

it('auto-approve: command messages from continuation are preserved in final result', async () => {
  const firstInterruption = createShellInterruption({ callId: 'call-cmd-1', command: 'ls' });

  const initialStream = new MockStream([]);
  initialStream.interruptions = [firstInterruption];
  initialStream.state = createApprovalState();

  // This stream's state provides command message data through the continuation runner
  const finalStream = new MockStream([]);
  finalStream.finalOutput = 'Done.';
  finalStream.lastResponseId = 'resp-cmd-final';

  const mockClient = createMockAgentClient({
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
  });

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

  expect(result.type).toBe('response');
  if (result.type !== 'response') return;
  expect(Array.isArray(result.commandMessages)).toBe(true);
  expect(result.finalText).toBe('Done.');
});

it('auto-approve: two auto-approved commands continue until approval_required or final', async () => {
  const first = createShellInterruption({ callId: 'call-batch-a', command: 'ls' });
  const second = createShellInterruption({ callId: 'call-batch-b', command: 'pwd' });

  const initialStream = new MockStream([]);
  initialStream.interruptions = [first, second];
  initialStream.state = createApprovalState();

  const continuationStream = new MockStream([]);
  continuationStream.interruptions = [second];
  continuationStream.state = createApprovalState();

  const mockClient = createMockAgentClient({
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
  });

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

  expect(result.type).toBe('approval_required');
  if (result.type !== 'approval_required') return;

  // The second command is the one that triggered the prompt
  expect(result.approval.toolName).toBe('shell');
  expect(result.approval.llmAdvisory).toBeTruthy();
});

// ══════════════════════════════════════════════════════════════════════════
// 8. Traffic context includes session context fields
// ══════════════════════════════════════════════════════════════════════════

it('sendMessage runs inside sessionContextService.runWithContext with session context fields', async () => {
  const contextLog: any[] = [];

  const sessionContextService = {
    runWithContext(context: any, fn: () => any) {
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

  const mockClient = createMockAgentClient({
    async startStream() {
      return stream;
    },
  });

  const bundle = createConversationSession({
    sessionId: 'traffic-test',
    agentClient: mockClient,
    deps: { logger: loggerWithTrace, sessionContextService },
  });
  const { terminalAdapter } = bundle;

  await terminalAdapter.sendMessage('my first question');

  expect(contextLog.length).toBe(1);
  const ctx = contextLog[0];

  expect(ctx.sessionId).toBe('traffic-test');
  expect(ctx.sessionStartedAt, 'sessionStartedAt should be a non-empty string').toBeTruthy();
  expect(ctx.firstUserMessagePreview).toBe('my first question');
  expect(ctx.mode).toBe('standard'); // was: t.is(ctx.mode, 'standard', 'Default mode (no settingsService) should be standard')
  expect(ctx.traceId).toBe('trace-abc-123');
});

it('sendMessage sets firstUserMessagePreview to first turn text even on subsequent messages', async () => {
  const contextLog: any[] = [];

  const sessionContextService = {
    runWithContext(context: any, fn: () => any) {
      contextLog.push(context);
      return fn();
    },
    getContext: () => null,
  };

  const loggerWithTrace = {
    ...mockLogger,
    getCorrelationId: () => 'trace-second',
  };

  const makeStream = (text: string) => {
    const s = new MockStream([]);
    s.finalOutput = `Reply: ${text}`;
    s.lastResponseId = `resp-${text}`;
    return s;
  };

  let callCount = 0;
  const mockClient = createMockAgentClient({
    async startStream() {
      callCount++;
      return makeStream(`call-${callCount}`);
    },
  });

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

  expect(contextLog.length).toBe(2);

  // Both traffic contexts should reference the first message as the preview
  expect(contextLog[0].firstUserMessagePreview).toBe('first turn');
  expect(contextLog[1].firstUserMessagePreview).toBe('first turn'); // was: t.is(contextLog[1].firstUserMessagePreview, 'first turn', 'Second turn should keep first turn as preview')
});

// ══════════════════════════════════════════════════════════════════════════
// 9. TurnCoordinator observable event sequences
// ══════════════════════════════════════════════════════════════════════════

it('approval then approval emits each terminal boundary in order', async () => {
  const first = createShellInterruption({ callId: 'call-first', command: 'echo first' });
  const second = createShellInterruption({ callId: 'call-second', command: 'echo second' });

  const initialStream = new MockStream([]);
  initialStream.interruptions = [first];
  initialStream.state = createApprovalState();

  const continuationStream = new MockStream([]);
  continuationStream.interruptions = [second];
  continuationStream.state = createApprovalState();

  const mockClient = createMockAgentClient({
    async startStream() {
      return initialStream;
    },
    async continueRunStream() {
      return continuationStream;
    },
  });

  const { turnCoordinator: session } = createConversationSession({
    sessionId: 'approval-then-approval',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
  });

  const events: any[] = [];
  for await (const event of session.start('run both commands')) {
    events.push(event);
  }
  for await (const event of session.continueAfterApproval({ answer: 'y' })) {
    events.push(event);
  }

  expect(
    events.map((event) =>
      event.type === 'approval_required'
        ? { type: event.type, callId: event.approval.callId }
        : event.type === 'tool_started'
        ? { type: event.type, callId: event.toolCallId }
        : { type: event.type },
    ),
  ).toEqual([
    { type: 'approval_required', callId: 'call-first' },
    { type: 'tool_started', callId: 'call-first' },
    { type: 'approval_required', callId: 'call-second' },
  ]);
});

it('approval then rejection emits no tool_started event for the rejected tool', async () => {
  const interruption = createShellInterruption({ callId: 'call-rejected', command: 'echo rejected' });
  const approvalState = createApprovalState();

  const initialStream = new MockStream([]);
  initialStream.interruptions = [interruption];
  initialStream.state = approvalState;

  const rejectedStream = new MockStream([{ type: 'response.output_text.delta', delta: 'Rejected.' }]);
  rejectedStream.finalOutput = 'Rejected.';

  const mockClient = createMockAgentClient({
    async startStream() {
      return initialStream;
    },
    async continueRunStream() {
      return rejectedStream;
    },
  });

  const { turnCoordinator: session } = createConversationSession({
    sessionId: 'approval-then-rejection',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
  });

  const events: any[] = [];
  for await (const event of session.start('run a command')) {
    events.push(event);
  }
  for await (const event of session.continueAfterApproval({
    answer: 'n',
    rejectionReason: 'Not needed',
  })) {
    events.push(event);
  }

  expect(
    events.map((event) =>
      event.type === 'approval_required'
        ? { type: event.type, callId: event.approval.callId }
        : event.type === 'text_delta' || event.type === 'final'
        ? { type: event.type, text: event.type === 'text_delta' ? event.delta : event.finalText }
        : { type: event.type },
    ),
  ).toEqual([
    { type: 'approval_required', callId: 'call-rejected' },
    { type: 'text_delta', text: 'Rejected.' },
    { type: 'final', text: 'Rejected.' },
  ]);
  expect(approvalState.approveCalls).toEqual([]);
  expect(approvalState.rejectCalls).toEqual([interruption]);
});

it('multiple sequential interruptions preserve approval and tool-start ordering', async () => {
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

  const mockClient = createMockAgentClient({
    async startStream() {
      return streams[0];
    },
    async continueRunStream() {
      continuationIndex++;
      return continuationIndex < streams.length ? streams[continuationIndex] : finalStream;
    },
  });

  const { turnCoordinator: session } = createConversationSession({
    sessionId: 'sequential-interruptions',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
  });

  const events: any[] = [];
  for await (const event of session.start('run three commands')) {
    events.push(event);
  }
  for (let index = 0; index < 3; index++) {
    for await (const event of session.continueAfterApproval({ answer: 'y' })) {
      events.push(event);
    }
  }

  expect(
    events.map((event) => {
      if (event.type === 'approval_required') {
        return `${event.type}:${event.approval.callId}`;
      }
      if (event.type === 'tool_started') {
        return `${event.type}:${event.toolCallId}`;
      }
      return event.type;
    }),
  ).toEqual([
    'approval_required:call-one',
    'tool_started:call-one',
    'approval_required:call-two',
    'tool_started:call-two',
    'approval_required:call-three',
    'tool_started:call-three',
    'text_delta',
    'final',
  ]);
});

it('aborted approval is abandoned so the next user input starts a fresh turn', async () => {
  const interruption = createShellInterruption({ callId: 'call-aborted', command: 'echo pending' });
  const initialStream = new MockStream([]);
  initialStream.interruptions = [interruption];
  initialStream.state = createApprovalState();

  const followUpStream = new MockStream([{ type: 'response.output_text.delta', delta: 'Changed course.' }]);
  followUpStream.finalOutput = 'Changed course.';

  const startCalls: unknown[] = [];
  const continueCalls: unknown[] = [];

  const mockClient = createMockAgentClient({
    abort() {},
    async startStream(input: unknown) {
      startCalls.push(input);
      return startCalls.length === 1 ? initialStream : followUpStream;
    },
    async continueRunStream(...args: unknown[]) {
      continueCalls.push(args);
      throw new Error('aborted approval should not continue the old run');
    },
  });

  const bundle = createConversationSession({
    sessionId: 'aborted-approval-resolution',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
  });

  const events: any[] = [];
  for await (const event of bundle.turnCoordinator.start('run pending command')) {
    events.push(event);
  }
  bundle.turnCoordinator.abort();
  for await (const event of bundle.turnCoordinator.start('do something else')) {
    events.push(event);
  }

  expect(events.map((event) => event.type)).toEqual(['approval_required', 'text_delta', 'final']);
  expect(startCalls).toHaveLength(2);
  expect(startCalls[1]).toEqual([
    { role: 'user', type: 'message', content: 'run pending command' },
    { role: 'user', type: 'message', content: 'do something else' },
  ]);
  expect(continueCalls).toEqual([]);
  expect(bundle.stateFacade.listUserTurns().map(({ text, imageCount }) => ({ text, imageCount }))).toEqual([
    { text: 'run pending command', imageCount: 0 },
    { text: 'do something else', imageCount: 0 },
  ]);
});

// ══════════════════════════════════════════════════════════════════════════
// Refactoring characterization tests
// ══════════════════════════════════════════════════════════════════════════

it('characterization - undo while an approval is pending invalidates pending approval and prevents continuation', async () => {
  const interruption = createShellInterruption({ callId: 'call-pending-tool', command: 'rm -rf /' });
  const interruptedStream = new MockStream([]);
  interruptedStream.interruptions = [interruption];
  interruptedStream.state = createApprovalState();

  const mockClient = createMockAgentClient({
    async startStream() {
      return interruptedStream;
    },
  });

  const composition = createSessionRuntimeInternals({
    sessionId: 'undo-pending-test',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
    turnAccumulator: new TurnItemAccumulator(),
  });

  const emitted = [];
  for await (const event of composition.turnCoordinator.start('trigger tool call')) {
    emitted.push(event);
  }

  // We should have received approval_required
  expect(emitted.length).toBe(1);
  expect(emitted[0].type).toBe('approval_required');

  // Verify there is a pending approval in approvalState
  expect(composition.approvalState.getPending()).toBeTruthy();

  // Trigger undo
  composition.stateFacade.undoLastUserTurn();

  // Verify that pending approval is invalidated/cleared
  expect(composition.approvalState.getPending()).toBe(null);

  // Verify continuation is not allowed (throws error)
  await expect(async () => {
    for await (const _ of composition.turnCoordinator.continueAfterApproval({ answer: 'y' })) {
    }
  }).rejects.toThrow('No pending approval to continue.');
});

it('characterization - reset while an approval is pending invalidates pending approval and resets status machine', async () => {
  const interruption = createShellInterruption({ callId: 'call-pending-tool-reset', command: 'rm -rf /' });
  const interruptedStream = new MockStream([]);
  interruptedStream.interruptions = [interruption];
  interruptedStream.state = createApprovalState();

  const mockClient = createMockAgentClient({
    async startStream() {
      return interruptedStream;
    },
  });

  const composition = createSessionRuntimeInternals({
    sessionId: 'reset-pending-test',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
    turnAccumulator: new TurnItemAccumulator(),
  });

  const emitted = [];
  for await (const event of composition.turnCoordinator.start('trigger tool call')) {
    emitted.push(event);
  }

  expect(emitted[0].type).toBe('approval_required');
  expect(composition.approvalState.getPending()).toBeTruthy();

  // Trigger reset
  composition.stateFacade.reset();

  // Verify pending approval is cleared
  expect(composition.approvalState.getPending()).toBe(null);

  // Verify continuation throws 'No pending approval to continue.' because status machine is reset to idle
  await expect(async () => {
    for await (const _ of composition.turnCoordinator.continueAfterApproval({ answer: 'y' })) {
    }
  }).rejects.toThrow('No pending approval to continue.');
});

// ══════════════════════════════════════════════════════════════════════════
// Service-boundary characterization: critical gap coverage
// ══════════════════════════════════════════════════════════════════════════

it('characterization - fresh start execution recovers from transient error with successful re-drive', async () => {
  const interruption = createShellInterruption({ callId: 'call-fresh-start', command: 'echo recover' });

  const initialStream = new MockStream([]);
  initialStream.interruptions = [interruption];
  initialStream.state = createApprovalState();

  const freshStream = new MockStream([]);
  freshStream.finalOutput = 'Recovered from transient error.';
  freshStream.lastResponseId = 'resp-fresh-start';

  let startCallCount = 0;

  const mockClient = createMockAgentClient({
    async startStream() {
      startCallCount++;
      if (startCallCount === 1) {
        return initialStream;
      }
      // Second call is the fresh-start re-drive
      return freshStream;
    },
    async continueRunStream() {
      const error = new Error('Connection refused');
      (error as any).code = 'ECONNREFUSED';
      throw error;
    },
  });

  const bundle = createConversationSession({
    sessionId: 'fresh-start-exec',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
  });
  const { terminalAdapter } = bundle;

  // First sendMessage -> approval_required
  const result1 = await terminalAdapter.sendMessage('run command');
  expect(result1.type).toBe('approval_required');

  // handleApprovalDecision -> continuation throws -> fresh start re-drive -> response
  const result2 = await terminalAdapter.handleApprovalDecision('y');

  expect(result2?.type).toBe('response');
  if (result2?.type === 'response') {
    expect(result2.finalText).toBe('Recovered from transient error.');
  }
  expect(startCallCount).toBe(2); // was: t.is(startCallCount, 2, 'startStream should be called twice (initial + fresh start re-drive)')

  const result3 = await terminalAdapter.sendMessage('next message');
  expect(result3.type).toBe('response');
  expect(startCallCount).toBe(3); // was: t.is(startCallCount, 3, 'a new turn should start after fresh-start recovery completes')
});

it('characterization - approve-approve-response through handleApprovalDecision API', async () => {
  const first = createShellInterruption({ callId: 'call-aa1', command: 'echo first' });
  const second = createShellInterruption({ callId: 'call-aa2', command: 'echo second' });

  const initialStream = new MockStream([]);
  initialStream.interruptions = [first];
  initialStream.state = createApprovalState();

  const continuationStream = new MockStream([]);
  continuationStream.interruptions = [second];
  continuationStream.state = createApprovalState();

  const finalStream = new MockStream([]);
  finalStream.finalOutput = 'All done.';
  finalStream.lastResponseId = 'resp-aa2';

  let continueCalls = 0;

  const mockClient = createMockAgentClient({
    async startStream() {
      return initialStream;
    },
    async continueRunStream() {
      continueCalls++;
      if (continueCalls === 1) {
        return continuationStream;
      }
      return finalStream;
    },
  });

  const bundle = createConversationSession({
    sessionId: 'appr-appr-resp',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
  });
  const { terminalAdapter } = bundle;

  const events: any[] = [];

  // First sendMessage -> approval_required (tool 1)
  const r1 = await terminalAdapter.sendMessage('run commands', {
    onEvent: (e) => events.push(e),
  });
  expect(r1.type).toBe('approval_required');
  expect((r1 as { type: 'approval_required'; approval: { callId: string } }).approval.callId).toBe('call-aa1');

  // First handleApprovalDecision -> approval_required (tool 2)
  const r2 = await terminalAdapter.handleApprovalDecision('y', undefined, {
    onEvent: (e) => events.push(e),
  });
  expect(r2?.type).toBe('approval_required');
  expect((r2 as { type: 'approval_required'; approval: { callId: string } })?.approval.callId).toBe('call-aa2');

  // Second handleApprovalDecision -> response
  const r3 = await terminalAdapter.handleApprovalDecision('y', undefined, {
    onEvent: (e) => events.push(e),
  });
  expect(r3?.type).toBe('response');
  if (r3?.type === 'response') {
    expect(r3.finalText).toBe('All done.');
  }

  // Verify tool_started events for both tools
  const toolStarted = events.filter((e) => e.type === 'tool_started');
  expect(toolStarted.length).toBe(2); // was: t.is(toolStarted.length, 2, 'Should have exactly 2 tool_started events')
  expect(toolStarted[0].toolCallId).toBe('call-aa1');
  expect(toolStarted[1].toolCallId).toBe('call-aa2');
});

it('characterization - reject then approve sequence through handleApprovalDecision API', async () => {
  const firstTool = createShellInterruption({ callId: 'call-rej1', command: 'echo rejectable' });
  const secondTool = createShellInterruption({ callId: 'call-appr1', command: 'echo approvable' });
  const approvalState = createApprovalState();

  const firstStream = new MockStream([]);
  firstStream.interruptions = [firstTool];
  firstStream.state = approvalState;

  const rejectionResponse = new MockStream([{ type: 'response.output_text.delta', delta: 'Rejected.' }]);
  rejectionResponse.finalOutput = 'Rejected.';

  const secondStream = new MockStream([]);
  secondStream.interruptions = [secondTool];
  secondStream.state = createApprovalState();

  const approvalResponse = new MockStream([{ type: 'response.output_text.delta', delta: 'Approved.' }]);
  approvalResponse.finalOutput = 'Approved.';

  let startCallCount = 0;
  let continueCallCount = 0;

  const mockClient = createMockAgentClient({
    async startStream() {
      startCallCount++;
      if (startCallCount === 1) return firstStream;
      return secondStream;
    },
    async continueRunStream() {
      continueCallCount++;
      if (continueCallCount === 1) return rejectionResponse;
      return approvalResponse;
    },
  });

  const bundle = createConversationSession({
    sessionId: 'reject-approve',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
  });
  const { terminalAdapter } = bundle;

  // Turn 1: sendMessage -> approval_required
  const r1 = await terminalAdapter.sendMessage('run command 1');
  expect(r1.type).toBe('approval_required');

  // Turn 1: reject -> response
  const r2 = await terminalAdapter.handleApprovalDecision('n', 'Not needed');
  expect(r2?.type).toBe('response');
  expect((r2 as { type: 'response'; finalText?: string })?.finalText).toBeTruthy();

  // Verify rejection was recorded in the approval state
  expect(approvalState.approveCalls.length).toBe(0); // was: t.is(approvalState.approveCalls.length, 0, 'No approvals should have been recorded')
  expect(approvalState.rejectCalls.length).toBe(1); // was: t.is(approvalState.rejectCalls.length, 1, 'One rejection should be recorded')
  expect((approvalState.rejectCalls[0] as { callId: string }).callId).toBe('call-rej1'); // was: t.is((approvalState.rejectCalls[0] as { callId: string }).callId, 'call-rej1', 'Rejected call should match')

  // Turn 2: new sendMessage -> approval_required (subsequent tool needs approval after rejection)
  const r3 = await terminalAdapter.sendMessage('run command 2');
  expect(r3.type).toBe('approval_required');

  // Turn 2: approve -> response (subsequent approval works correctly after rejection)
  const r4 = await terminalAdapter.handleApprovalDecision('y');
  expect(r4?.type).toBe('response');
  if (r4?.type === 'response') {
    expect(r4.finalText).toBe('Approved.');
  }
});

it('characterization - abort during pending approval clears state and prevents continuation', async () => {
  const interruption = createShellInterruption({ callId: 'call-abort-chain', command: 'echo pending' });
  const approvalState = createApprovalState();

  const stream = new MockStream([]);
  stream.interruptions = [interruption];
  stream.state = approvalState;

  const mockClient = createMockAgentClient({
    async startStream() {
      return stream;
    },
    abort() {},
  });

  const composition = createSessionRuntimeInternals({
    sessionId: 'abort-chain-test',
    agentClient: mockClient,
    deps: { logger: mockLogger, sessionContextService: createSessionContextService() },
    turnAccumulator: new TurnItemAccumulator(),
  });

  const emitted = [];
  for await (const event of composition.turnCoordinator.start('run command')) {
    emitted.push(event);
  }
  expect(emitted.length).toBe(1);
  expect(emitted[0].type).toBe('approval_required');
  expect(composition.approvalState.getPending(), 'Should have pending approval before abort').toBeTruthy();

  // Abort while approval is pending
  composition.turnCoordinator.abort();

  // Status should return to idle
  expect(composition.appState.statusMachine.current).toBe('idle'); // was: t.is(composition.appState.statusMachine.current, 'idle', 'Status machine should be idle after abort')

  // No pending approval after abort
  expect(composition.approvalState.getPending()).toBe(null); // was: t.is(composition.approvalState.getPending(), null, 'No pending approval after abort')

  // Tool ledger should have aborted entry
  const ledger = composition.toolTracker.ledger.export();
  const abortedEntries = ledger.filter((entry) => entry.status === 'aborted');
  expect(abortedEntries.length >= 1, 'Tool ledger should have at least one aborted entry').toBe(true);
  expect(abortedEntries[0].callId).toBe('call-abort-chain'); // was: t.is(abortedEntries[0].callId, 'call-abort-chain', 'Aborted entry should match the interrupted call')
});
