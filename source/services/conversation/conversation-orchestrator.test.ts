import { describe, it, expect, vi } from 'vitest';
import { ConversationOrchestrator } from './conversation-orchestrator.js';
import type { ConversationOrchestratorConfig, MessagePort, UIPort } from './conversation-orchestrator.types.js';
import type { ConversationService } from './conversation-service.js';
import type { ILoggingService } from '../service-interfaces.js';
import type { Message } from '../../types/message.js';
import type { ApprovedToolContext } from '../approval/approval-presentation-policy.js';
import type { NormalizedUsage, UsageAccumulator } from '../../utils/ai/token-usage.js';
import type { ConversationTerminal } from '../../contracts/conversation.js';

function createMessage(id: string, sender: Message['sender'], text: string, overrides: Partial<Message> = {}): Message {
  return { id, sender, text, ...overrides } as Message;
}

function createBotMessage(id: string, text: string): Message {
  return { id, sender: 'bot', text, status: 'finalized' } as Message;
}

function mockLoggingService(): ILoggingService {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    setCorrelationId: vi.fn(),
    getCorrelationId: vi.fn(),
    clearCorrelationId: vi.fn(),
  } as unknown as ILoggingService;
}

function mockConversationService(): ConversationService {
  return {
    sessionId: 'test-session',
    sendMessage: vi.fn(),
    handleApprovalDecision: vi.fn(),
    abort: vi.fn(),
    undoLastUserTurn: vi.fn(),
    undoNUserTurns: vi.fn(),
    peekLastToolOutput: vi.fn(),
    retryLastToolOutput: vi.fn(),
    resetWithNewId: vi.fn(),
    setModel: vi.fn(),
    setReasoningEffort: vi.fn(),
    setTemperature: vi.fn(),
    setProvider: vi.fn(),
    switchProvider: vi.fn(),
    setRetryCallback: vi.fn(),
    addShellContext: vi.fn(),
    queueModeNotice: vi.fn(),
    getCurrentSnapshot: vi.fn(),
    setLogSink: vi.fn(),
    listUserTurns: vi.fn(),
    previewLargeUncachedInput: vi.fn(),
    previewInputSurge: vi.fn(),
    exportState: vi.fn(),
    importState: vi.fn(),
    isQueueActive: vi.fn(() => false),
    setQueueStateObserver: vi.fn(),
    setQueuedTurnStartObserver: vi.fn(),
    removeLastQueuedItem: vi.fn(async () => null),
  } as unknown as ConversationService;
}

function makeMessagePort(): MessagePort {
  let messages: Message[] = [];
  return {
    getMessages: vi.fn(() => messages),
    setMessages: vi.fn((updater) => {
      messages = updater(messages);
    }),
    appendMessages: vi.fn((additions) => {
      messages = [...messages, ...additions];
    }),
    trimMessages: vi.fn((next) => next),
  };
}

function makeUIPort(): UIPort {
  return {
    onTurnStart: vi.fn(),
    onTurnEnd: vi.fn(),
    onApprovalRequested: vi.fn(),
    onApprovalResolved: vi.fn(),
    onUsageUpdate: vi.fn(),
    onRateLimitUpdate: vi.fn(),
    onRateLimitClear: vi.fn(),
    onResetTransient: vi.fn(),
    onResetAll: vi.fn(),
    onStreamingThinkingStarted: vi.fn(),
    onStreamingThinkingCleared: vi.fn(),
    onStreamingToolInfo: vi.fn(),
    onAskUserAnswerSubmitted: vi.fn(),
    onAskUserAdvanceToNext: vi.fn(),
    onAskUserGoBack: vi.fn(),
    onQueueStateChange: vi.fn(),
    onQueuedMessagePending: vi.fn(),
    onQueuedMessageStarted: vi.fn(),
    onRemoveLastPendingMessage: vi.fn(),
  };
}

function makeUsageAccumulator(): UsageAccumulator {
  let current: NormalizedUsage = {};
  return {
    add: vi.fn((usage?: NormalizedUsage | null) => {
      if (usage) current = { ...current, ...usage };
    }),
    reset: vi.fn(() => {
      current = {};
    }),
    get: vi.fn(() => current),
  } as unknown as UsageAccumulator;
}

function makeConfig(overrides: Partial<ConversationOrchestratorConfig> = {}): ConversationOrchestratorConfig {
  const approvedContext: { current: ApprovedToolContext | null } = { current: null };
  return {
    conversationService: mockConversationService(),
    loggingService: mockLoggingService(),
    messages: makeMessagePort(),
    ui: makeUIPort(),
    approvedContext,
    usageAccumulator: makeUsageAccumulator(),
    subagentUsageAccumulator: makeUsageAccumulator(),
    ...overrides,
  };
}

describe('ConversationOrchestrator', () => {
  it('sends a user message and applies a response', async () => {
    const cfg = makeConfig();
    // No queue support in this test: the immediate-append path must run.
    cfg.conversationService.isQueueActive = undefined;
    cfg.conversationService.setQueuedTurnStartObserver = undefined;
    const orchestrator = new ConversationOrchestrator(cfg);
    const terminal: ConversationTerminal = { type: 'response', finalText: 'ok', commandMessages: [] };

    vi.mocked(cfg.conversationService.sendMessage).mockResolvedValue(terminal);

    await orchestrator.sendUserMessage('hello');

    expect(cfg.messages.appendMessages).toHaveBeenCalledTimes(1);
    expect(cfg.conversationService.sendMessage).toHaveBeenCalledWith(
      { text: 'hello' },
      expect.objectContaining({ bypassInputSurgeGuard: undefined }),
    );
    expect(cfg.ui.onTurnStart).toHaveBeenCalled();
    expect(cfg.ui.onApprovalResolved).toHaveBeenCalled();
    expect(cfg.ui.onTurnEnd).toHaveBeenCalled();
  });

  it('requests approval for approval_required terminals', async () => {
    const cfg = makeConfig();
    const orchestrator = new ConversationOrchestrator(cfg);
    const terminal: ConversationTerminal = {
      type: 'approval_required',
      approval: {
        agentName: 'agent',
        toolName: 'bash',
        argumentsText: 'ls',
        rawInterruption: null,
      },
    };

    vi.mocked(cfg.conversationService.sendMessage).mockResolvedValue(terminal);

    await orchestrator.sendUserMessage('run ls');

    expect(cfg.ui.onApprovalRequested).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'bash' }));
  });

  it('suppresses abort-like send errors', async () => {
    const cfg = makeConfig();
    cfg.conversationService.isQueueActive = undefined;
    cfg.conversationService.setQueuedTurnStartObserver = undefined;
    const orchestrator = new ConversationOrchestrator(cfg);
    const abortError = new Error('aborted');
    abortError.name = 'AbortError';

    vi.mocked(cfg.conversationService.sendMessage).mockRejectedValue(abortError);

    await orchestrator.sendUserMessage('hello');

    expect(cfg.messages.appendMessages).toHaveBeenCalledTimes(1);
    expect(cfg.ui.onTurnEnd).toHaveBeenCalled();
  });

  it('clears conversation through onClear when provided', async () => {
    const onClear = vi.fn();
    const cfg = makeConfig({ onClear });
    const orchestrator = new ConversationOrchestrator(cfg);

    await orchestrator.clearConversation();

    expect(onClear).toHaveBeenCalled();
    expect(cfg.messages.setMessages).toHaveBeenCalled();
    expect(cfg.ui.onResetAll).toHaveBeenCalled();
  });

  it('falls back to resetWithNewId when onClear is absent', async () => {
    const cfg = makeConfig({ onClear: undefined });
    const orchestrator = new ConversationOrchestrator(cfg);

    await orchestrator.clearConversation();

    expect(cfg.conversationService.resetWithNewId).toHaveBeenCalled();
  });

  it('stops processing by aborting and clearing transient state', () => {
    const cfg = makeConfig();
    const orchestrator = new ConversationOrchestrator(cfg);

    orchestrator.stopProcessing();

    expect(cfg.conversationService.abort).toHaveBeenCalled();
    expect(cfg.ui.onResetTransient).toHaveBeenCalled();
  });

  it('undoes the last undoable user message', () => {
    const cfg = makeConfig();
    const orchestrator = new ConversationOrchestrator(cfg);
    const messages = cfg.messages as ReturnType<typeof makeMessagePort>;
    messages.appendMessages([createMessage('u1', 'user', 'hello'), createBotMessage('b1', 'hi')]);
    vi.mocked(cfg.conversationService.undoLastUserTurn).mockReturnValue({ text: 'hello' });

    const result = orchestrator.undoLastUserMessage();

    expect(result).toEqual({ text: 'hello' });
    expect(cfg.conversationService.abort).toHaveBeenCalled();
    expect(cfg.conversationService.undoLastUserTurn).toHaveBeenCalled();
    expect(cfg.ui.onResetTransient).toHaveBeenCalled();
  });

  it('returns false when retryLastToolOutput has nothing to retry', async () => {
    const cfg = makeConfig();
    const orchestrator = new ConversationOrchestrator(cfg);

    vi.mocked(cfg.conversationService.peekLastToolOutput).mockReturnValue(null);

    await expect(orchestrator.retryLastToolOutput()).resolves.toBe(false);
  });

  it('undoes to a user message index', () => {
    const cfg = makeConfig();
    const orchestrator = new ConversationOrchestrator(cfg);
    const messages = cfg.messages as ReturnType<typeof makeMessagePort>;
    messages.appendMessages([
      createMessage('u1', 'user', 'first'),
      createBotMessage('b1', 'reply'),
      createMessage('u2', 'user', 'second'),
    ]);
    vi.mocked(cfg.conversationService.undoNUserTurns).mockReturnValue({ text: 'second' });

    const restored = orchestrator.undoToUserMessage(2);

    expect(restored).toBe('second');
    expect(cfg.conversationService.abort).toHaveBeenCalled();
    expect(cfg.conversationService.undoNUserTurns).toHaveBeenCalled();
  });

  it('moves through ask-user questions', async () => {
    const cfg = makeConfig();
    const orchestrator = new ConversationOrchestrator(cfg);
    const approvalTerminal: ConversationTerminal = {
      type: 'approval_required',
      approval: {
        agentName: 'agent',
        toolName: 'ask_user',
        argumentsText: JSON.stringify({ questions: [{ question: 'one' }, { question: 'two' }] }),
        rawInterruption: null,
      },
    };

    vi.mocked(cfg.conversationService.sendMessage).mockResolvedValue(approvalTerminal);

    await orchestrator.sendUserMessage('ask');
    await orchestrator.handleApprovalDecision('y', undefined, 'first');

    expect(cfg.ui.onAskUserAnswerSubmitted).toHaveBeenCalledWith('first');
    expect(cfg.ui.onAskUserAdvanceToNext).toHaveBeenCalledWith(1);
    expect(cfg.conversationService.handleApprovalDecision).not.toHaveBeenCalled();
  });

  it('routes a queued message to onQueuedMessagePending instead of appending when a turn is in flight', async () => {
    const cfg = makeConfig();
    vi.mocked(cfg.conversationService.isQueueActive).mockReturnValue(true);
    // Return a never-resolving promise that we can settle from the test
    // so the orchestrator's sendUserMessage promise resolves.
    let release!: () => void;
    const settled = new Promise<ConversationTerminal>((resolve) => {
      release = () => resolve({ type: 'response', finalText: 'ok', commandMessages: [] });
    });
    vi.mocked(cfg.conversationService.sendMessage).mockReturnValue(settled as any);
    const orchestrator = new ConversationOrchestrator(cfg);

    const inFlight = orchestrator.sendUserMessage('follow-up');

    // Yield to the event loop so the microtask chain inside sendUserMessage
    // can run before we resolve the network response.
    await Promise.resolve();
    await Promise.resolve();

    expect(cfg.ui.onQueuedMessagePending).toHaveBeenCalledTimes(1);
    expect(cfg.ui.onQueuedMessagePending).toHaveBeenCalledWith(expect.any(String), 'follow-up');
    expect(cfg.messages.appendMessages).not.toHaveBeenCalled();

    release();
    await inFlight;
  });

  it('appends immediately when no queue infrastructure is available', async () => {
    const cfg = makeConfig();
    // Simulate a service without queue support: both isQueueActive and the
    // observer registration must be unavailable for the immediate-append path.
    cfg.conversationService.isQueueActive = undefined;
    cfg.conversationService.setQueuedTurnStartObserver = undefined;
    vi.mocked(cfg.conversationService.sendMessage).mockResolvedValue({
      type: 'response',
      finalText: 'ok',
      commandMessages: [],
    });
    const orchestrator = new ConversationOrchestrator(cfg);

    await orchestrator.sendUserMessage('first');

    expect(cfg.ui.onQueuedMessagePending).not.toHaveBeenCalled();
    expect(cfg.messages.appendMessages).toHaveBeenCalledTimes(1);
  });

  it('appends directly when queue is wired up but no turn is in flight', async () => {
    const cfg = makeConfig();
    // Queue infrastructure is available, but no turn is in flight yet.
    vi.mocked(cfg.conversationService.isQueueActive).mockReturnValue(false);
    vi.mocked(cfg.conversationService.sendMessage).mockResolvedValue({
      type: 'response',
      finalText: 'ok',
      commandMessages: [],
    });
    const orchestrator = new ConversationOrchestrator(cfg);

    await orchestrator.sendUserMessage('first');

    // When no turn is in flight, append directly — no pending indicator needed.
    expect(cfg.ui.onQueuedMessagePending).not.toHaveBeenCalled();
    expect(cfg.messages.appendMessages).toHaveBeenCalledTimes(1);
    const appended = vi.mocked(cfg.messages.appendMessages).mock.calls[0]?.[0]?.[0] as any;
    expect(appended.sender).toBe('user');
    expect(appended.text).toBe('first');

    // The orchestrator must pass its message id as preferredMessageId so the
    // adapter's queued-turn-start observer fires with the same id later.
    const sendMsg = vi.mocked(cfg.conversationService.sendMessage).mock.calls[0]?.[1] as any;
    expect(sendMsg.preferredMessageId).toBe(appended.id);
  });

  it('appends a queued message into the list when the queue fires its start observer', async () => {
    const cfg = makeConfig();
    const orchestrator = new ConversationOrchestrator(cfg);
    // Capture the observer that the orchestrator registered so we can fire it.
    const setObserver = vi.mocked(cfg.conversationService.setQueuedTurnStartObserver);
    const observer = setObserver.mock.calls[0]?.[0] as (execution: { requestId: string; input: string }) => void;
    expect(observer).toBeDefined();

    observer({ requestId: 'req-7', input: 'queued-then-started' });

    expect(cfg.messages.appendMessages).toHaveBeenCalledTimes(1);
    const appended = vi.mocked(cfg.messages.appendMessages).mock.calls[0]?.[0]?.[0] as any;
    expect(appended.sender).toBe('user');
    expect(appended.id).toBe('req-7');
    expect(appended.text).toBe('queued-then-started');
    expect(cfg.ui.onQueuedMessageStarted).toHaveBeenCalledWith('req-7');
  });

  it('does not double-append when the observer fires for an already-directly-appended message', async () => {
    const cfg = makeConfig();
    // Simulate: queue is idle, so the message was appended directly.
    vi.mocked(cfg.conversationService.isQueueActive).mockReturnValue(false);
    vi.mocked(cfg.conversationService.sendMessage).mockResolvedValue({
      type: 'response',
      finalText: 'ok',
      commandMessages: [],
    });
    const orchestrator = new ConversationOrchestrator(cfg);
    await orchestrator.sendUserMessage('first');

    // Capture the observer that the orchestrator registered.
    const setObserver = vi.mocked(cfg.conversationService.setQueuedTurnStartObserver);
    const observer = setObserver.mock.calls[0]?.[0] as (execution: { requestId: string; input: string }) => void;
    expect(observer).toBeDefined();

    // Get the id from the direct append.
    const firstAppendCall = vi.mocked(cfg.messages.appendMessages).mock.calls[0]!;
    const directlyAppendedId = (firstAppendCall[0][0] as any).id as string;
    expect(directlyAppendedId).toBeTruthy();

    // Now the queue observer fires with the same id (this happens during sendMessage).
    // The dedup guard should prevent a second append.
    const appendCountBefore = vi.mocked(cfg.messages.appendMessages).mock.calls.length;
    observer({ requestId: directlyAppendedId, input: 'first' });
    expect(vi.mocked(cfg.messages.appendMessages).mock.calls.length).toBe(appendCountBefore);
    expect(cfg.ui.onQueuedMessageStarted).not.toHaveBeenCalled();
  });

  it('cancels the last queued message and returns its text', async () => {
    const cfg = makeConfig();
    const orchestrator = new ConversationOrchestrator(cfg);
    vi.mocked(cfg.conversationService.removeLastQueuedItem).mockResolvedValue({ text: 'restored message' });

    const restored = await orchestrator.removeLastQueuedPendingMessage();

    expect(restored).toBe('restored message');
    expect(cfg.conversationService.removeLastQueuedItem).toHaveBeenCalledTimes(1);
    expect(cfg.ui.onRemoveLastPendingMessage).toHaveBeenCalledTimes(1);
  });

  it('does not retain directly-appended id across clearConversation', async () => {
    const cfg = makeConfig();
    vi.mocked(cfg.conversationService.isQueueActive).mockReturnValue(false);
    vi.mocked(cfg.conversationService.sendMessage).mockResolvedValue({
      type: 'response',
      finalText: 'ok',
      commandMessages: [],
    });
    const orchestrator = new ConversationOrchestrator(cfg);
    await orchestrator.sendUserMessage('first');

    const firstAppendCall = vi.mocked(cfg.messages.appendMessages).mock.calls[0]!;
    const directlyAppendedId = (firstAppendCall[0][0] as any).id as string;

    // After clearConversation, the orchestrator must not retain the directly-
    // appended id. A later observer firing with that same id should treat it
    // as a fresh, not-already-appended message and append it normally.
    await orchestrator.clearConversation();

    const setObserver = vi.mocked(cfg.conversationService.setQueuedTurnStartObserver);
    const observer = setObserver.mock.calls[0]?.[0] as (execution: { requestId: string; input: string }) => void;
    expect(observer).toBeDefined();
    const beforeCalls = vi.mocked(cfg.messages.appendMessages).mock.calls.length;
    observer({ requestId: directlyAppendedId, input: 'first' });
    expect(vi.mocked(cfg.messages.appendMessages).mock.calls.length).toBe(beforeCalls + 1);
  });

  it('does not retain directly-appended id across stopProcessing', async () => {
    const cfg = makeConfig();
    vi.mocked(cfg.conversationService.isQueueActive).mockReturnValue(false);
    vi.mocked(cfg.conversationService.sendMessage).mockResolvedValue({
      type: 'response',
      finalText: 'ok',
      commandMessages: [],
    });
    const orchestrator = new ConversationOrchestrator(cfg);
    await orchestrator.sendUserMessage('first');

    const firstAppendCall = vi.mocked(cfg.messages.appendMessages).mock.calls[0]!;
    const directlyAppendedId = (firstAppendCall[0][0] as any).id as string;

    orchestrator.stopProcessing();

    const setObserver = vi.mocked(cfg.conversationService.setQueuedTurnStartObserver);
    const observer = setObserver.mock.calls[0]?.[0] as (execution: { requestId: string; input: string }) => void;
    expect(observer).toBeDefined();
    const beforeCalls = vi.mocked(cfg.messages.appendMessages).mock.calls.length;
    observer({ requestId: directlyAppendedId, input: 'first' });
    expect(vi.mocked(cfg.messages.appendMessages).mock.calls.length).toBe(beforeCalls + 1);
  });

  it('does not retain directly-appended id across undoLastUserMessage', async () => {
    const cfg = makeConfig();
    vi.mocked(cfg.conversationService.isQueueActive).mockReturnValue(false);
    vi.mocked(cfg.conversationService.sendMessage).mockResolvedValue({
      type: 'response',
      finalText: 'ok',
      commandMessages: [],
    });
    const orchestrator = new ConversationOrchestrator(cfg);
    await orchestrator.sendUserMessage('first');

    const firstAppendCall = vi.mocked(cfg.messages.appendMessages).mock.calls[0]!;
    const directlyAppendedId = (firstAppendCall[0][0] as any).id as string;

    vi.mocked(cfg.conversationService.undoLastUserTurn).mockReturnValue({ text: 'first' });
    orchestrator.undoLastUserMessage();

    const setObserver = vi.mocked(cfg.conversationService.setQueuedTurnStartObserver);
    const observer = setObserver.mock.calls[0]?.[0] as (execution: { requestId: string; input: string }) => void;
    expect(observer).toBeDefined();
    const beforeCalls = vi.mocked(cfg.messages.appendMessages).mock.calls.length;
    observer({ requestId: directlyAppendedId, input: 'first' });
    expect(vi.mocked(cfg.messages.appendMessages).mock.calls.length).toBe(beforeCalls + 1);
  });

  it('returns null and skips the UI hook when no queued message can be cancelled', async () => {
    const cfg = makeConfig();
    const orchestrator = new ConversationOrchestrator(cfg);
    vi.mocked(cfg.conversationService.removeLastQueuedItem).mockResolvedValue(null);

    const restored = await orchestrator.removeLastQueuedPendingMessage();

    expect(restored).toBeNull();
    expect(cfg.ui.onRemoveLastPendingMessage).not.toHaveBeenCalled();
  });

  it('returns null and skips the adapter when the service cannot cancel queued items', async () => {
    const cfg = makeConfig();
    (cfg.conversationService as any).removeLastQueuedItem = undefined;
    const orchestrator = new ConversationOrchestrator(cfg);

    const restored = await orchestrator.removeLastQueuedPendingMessage();

    expect(restored).toBeNull();
    expect(cfg.ui.onRemoveLastPendingMessage).not.toHaveBeenCalled();
  });
});
