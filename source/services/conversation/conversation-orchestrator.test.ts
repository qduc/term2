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
  } as unknown as ConversationService;
}

function makeMessagePort(): MessagePort {
  let messages: Message[] = [];
  return {
    getMessages: () => messages,
    setMessages: (updater) => {
      messages = updater(messages);
    },
    appendMessages: (additions) => {
      messages = [...messages, ...additions];
    },
    trimMessages: (next) => next,
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
});
