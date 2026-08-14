import { describe, it, expect, vi } from 'vitest';
import { ConversationOrchestrator } from './conversation-orchestrator.js';
import type { ConversationOrchestratorConfig, MessagePort, UIPort } from './conversation-orchestrator.types.js';
import type { ConversationService } from './conversation-service.js';
import type { ILoggingService } from '../service-interfaces.js';
import type { Message, UserMessage } from '../../types/message.js';
import type { ApprovedToolContext } from '../approval/approval-presentation-policy.js';
import type { NormalizedUsage, UsageAccumulator } from '../../utils/ai/token-usage.js';
import type { ConversationTerminal } from '../../contracts/conversation.js';
import { PendingInteractionState } from '../session/pending-interaction-state.js';
import { ASK_USER_NO_ANSWER_RESULT } from '../../tools/agent/ask-user-constants.js';
import { createSessionCostAccumulator } from '../cost/model-cost.js';

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
  const interaction = new PendingInteractionState();
  return {
    sessionId: 'test-session',
    sendMessage: vi.fn(),
    handleApprovalDecision: vi.fn(),
    abort: vi.fn(),
    interruptFromUser: vi.fn(),
    rewindToTarget: vi.fn(),
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
    isQueueOwningSubmissions: vi.fn(() => false),
    setQueueStateObserver: vi.fn(),
    setQueuedTurnStartObserver: vi.fn(),
    retractSubmission: vi.fn(async () => ({ kind: 'unknown_id' })),
    editSubmission: vi.fn(async () => ({ kind: 'unknown_id' })),
    getPendingInteractionSnapshot: vi.fn(() => interaction.getSnapshot()),
    clearPendingInteraction: vi.fn(() => interaction.clear()),
    presentPendingInteraction: vi.fn((approval) => interaction.present(approval)),
    resolvePendingInteraction: vi.fn((request) => interaction.resolve(request)),
    goToPreviousPendingInteractionQuestion: vi.fn(() => interaction.goToPreviousQuestion()),
    goToNextPendingInteractionQuestion: vi.fn(() => interaction.goToNextQuestion()),
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
    onCostUpdate: vi.fn(),
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
    onQueuedMessageRemoved: vi.fn(),
    onQueuedMessageEdited: vi.fn(),
  };
}

it('grants a finite extension when the paused run returns its budget interaction terminal', async () => {
  const cfg = makeConfig();
  const orchestrator = new ConversationOrchestrator(cfg);
  const grant = vi.fn(() => ({ granted: true, extensionsGranted: 1 }));
  (cfg.conversationService as any).grantRunBudgetExtension = grant;
  vi.mocked(cfg.conversationService.sendMessage).mockImplementation(async (_input: any, options: any) => {
    options.onEvent({
      type: 'run_budget',
      evidence: { type: 'tool_stall', toolName: 'read_file', argumentsText: '{"path":"a"}', count: 3, threshold: 3 },
    });
    const approval = {
      agentName: 'System',
      toolName: 'max_turns_exceeded',
      argumentsText: 'Repeated tool call',
      rawInterruption: { type: 'run_budget_interaction' },
      isMaxTurnsPrompt: true,
      runBudgetEvent: {
        type: 'tool_stall' as const,
        toolName: 'read_file',
        argumentsText: '{"path":"a"}',
        count: 3,
        threshold: 3,
      },
    };
    cfg.conversationService.presentPendingInteraction?.(approval);
    return { type: 'approval_required', approval };
  });

  await orchestrator.sendUserMessage('go');

  const interaction = cfg.conversationService.getPendingInteractionSnapshot?.();
  expect(interaction?.approval).toMatchObject({
    toolName: 'max_turns_exceeded',
    runBudgetEvent: { type: 'tool_stall' },
  });
  await orchestrator.handleApprovalDecision('y', undefined, undefined, interaction!.interactionId);
  expect(grant).toHaveBeenCalledOnce();
  expect(cfg.conversationService.handleApprovalDecision).toHaveBeenCalledWith('y', undefined, expect.any(Object));
});

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
    (cfg.conversationService as any).isQueueActive = undefined;
    (cfg.conversationService as any).setQueuedTurnStartObserver = undefined;
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
    expect(cfg.ui.onTurnEnd).toHaveBeenCalled();
  });

  // `costRecords` is an optional field re-declared at every hop between the run
  // loop and the status bar, so any hop that forgets to copy it fails silently:
  // no type error, and every per-hop unit test still passes. This test pins the
  // last hop end-of-chain — a terminal that carries records must leave the
  // session accumulator with a priced summary, which is what the status bar
  // renders from.
  it('feeds a terminal cost record into the session cost accumulator', async () => {
    const costAccumulator = createSessionCostAccumulator();
    const cfg = makeConfig({ costAccumulator });
    (cfg.conversationService as any).isQueueActive = undefined;
    (cfg.conversationService as any).setQueuedTurnStartObserver = undefined;
    const terminal: ConversationTerminal = {
      type: 'response',
      finalText: 'ok',
      commandMessages: [],
      costRecords: [
        {
          requestId: 'req-1',
          provider: 'openrouter',
          model: 'deepseek/deepseek-v4-flash',
          serviceTier: 'standard',
          outcome: 'completed',
          usdMicros: 3450,
          source: 'catalog',
        },
      ],
    };

    vi.mocked(cfg.conversationService.sendMessage).mockResolvedValue(terminal);

    await new ConversationOrchestrator(cfg).sendUserMessage('hello');

    // 'estimated' rather than 'known': a catalog-priced record is an estimate.
    expect(costAccumulator.getSummary()).toMatchObject({ knownUsdMicros: 3450, pricedRequests: 1, state: 'estimated' });
  });

  it('forwards live reasoning and tool-call indicators to the UI port', async () => {
    const cfg = makeConfig();
    (cfg.conversationService as any).isQueueActive = undefined;
    (cfg.conversationService as any).setQueuedTurnStartObserver = undefined;
    const terminal: ConversationTerminal = { type: 'response', finalText: 'ok', commandMessages: [] };

    vi.mocked(cfg.conversationService.sendMessage).mockImplementation(async (_input: any, options: any) => {
      options.onEvent({ type: 'reasoning_delta', delta: 'Thinking' });
      options.onEvent({ type: 'tool_call_streaming_delta', toolName: 'shell', argumentCharCount: 12 });
      return terminal;
    });

    await new ConversationOrchestrator(cfg).sendUserMessage('hello');

    expect(cfg.ui.onStreamingThinkingStarted).toHaveBeenCalled();
    expect(cfg.ui.onStreamingToolInfo).toHaveBeenCalledWith({ toolName: 'shell', argumentCharCount: 12 });
  });

  // The run loop emits one cost_update event per dispatched model request, so
  // the status bar can show per-request cost before the turn ends. This test
  // pins the hop from that event into the accumulator and the UI callback.
  it('feeds a per-request cost_update event into the accumulator and notifies the UI', async () => {
    const costAccumulator = createSessionCostAccumulator();
    const cfg = makeConfig({ costAccumulator });
    (cfg.conversationService as any).isQueueActive = undefined;
    (cfg.conversationService as any).setQueuedTurnStartObserver = undefined;
    const terminal: ConversationTerminal = { type: 'response', finalText: 'ok', commandMessages: [] };

    vi.mocked(cfg.conversationService.sendMessage).mockImplementation(async (_input: any, options: any) => {
      options.onEvent({
        type: 'cost_update',
        record: {
          requestId: 'req-1',
          provider: 'openai',
          model: 'gpt-4.1',
          serviceTier: 'standard',
          outcome: 'completed',
          usdMicros: 3450,
          source: 'catalog',
        },
      });
      return terminal;
    });

    await new ConversationOrchestrator(cfg).sendUserMessage('hello');

    expect(costAccumulator.getSummary()).toMatchObject({ knownUsdMicros: 3450, pricedRequests: 1, state: 'estimated' });
    expect(cfg.ui.onCostUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ knownUsdMicros: 3450, pricedRequests: 1, state: 'estimated' }),
    );
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

    expect(cfg.messages.trimMessages).toHaveBeenCalled();
  });

  it('suppresses abort-like send errors', async () => {
    const cfg = makeConfig();
    (cfg.conversationService as any).isQueueActive = undefined;
    (cfg.conversationService as any).setQueuedTurnStartObserver = undefined;
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

  it('stops processing by interrupting and clearing transient state', () => {
    const cfg = makeConfig();
    const orchestrator = new ConversationOrchestrator(cfg);

    orchestrator.stopProcessing();

    expect(cfg.conversationService.interruptFromUser).toHaveBeenCalled();
    expect(cfg.ui.onResetTransient).toHaveBeenCalled();
  });

  it('stopProcessing is a user interrupt, so background subagent runs are cancelled', () => {
    const cfg = makeConfig();
    const orchestrator = new ConversationOrchestrator(cfg);

    orchestrator.stopProcessing();

    expect(cfg.conversationService.interruptFromUser).toHaveBeenCalledTimes(1);
    expect(cfg.conversationService.abort).not.toHaveBeenCalled();
  });

  it('rewindToTarget aborts the foreground turn only after the domain accepts the target', () => {
    const cfg = makeConfig();
    const orchestrator = new ConversationOrchestrator(cfg);
    const messages = cfg.messages as ReturnType<typeof makeMessagePort>;
    messages.appendMessages([createMessage('u1', 'user', 'hello'), createBotMessage('b1', 'hi')]);
    vi.mocked(cfg.conversationService.rewindToTarget).mockReturnValue({ text: 'hello' });

    orchestrator.rewindToTarget('target-1' as any, 0);

    expect(cfg.conversationService.rewindToTarget).toHaveBeenCalledWith('target-1');
    expect(cfg.conversationService.abort).toHaveBeenCalledTimes(1);
    expect(cfg.conversationService.interruptFromUser).not.toHaveBeenCalled();
  });

  it('retryLastToolOutput aborts the turn without cancelling background subagent runs', async () => {
    const cfg = makeConfig();
    const orchestrator = new ConversationOrchestrator(cfg);
    vi.mocked(cfg.conversationService.peekLastToolOutput).mockReturnValue(null);

    await orchestrator.retryLastToolOutput();

    expect(cfg.conversationService.abort).toHaveBeenCalledTimes(1);
    expect(cfg.conversationService.interruptFromUser).not.toHaveBeenCalled();
  });

  it('rewinds to the last user turn', () => {
    const cfg = makeConfig();
    const orchestrator = new ConversationOrchestrator(cfg);
    const messages = cfg.messages as ReturnType<typeof makeMessagePort>;
    messages.appendMessages([createMessage('u1', 'user', 'hello'), createBotMessage('b1', 'hi')]);
    vi.mocked(cfg.conversationService.rewindToTarget).mockReturnValue({ text: 'hello' });

    const result = orchestrator.rewindToTarget('target-1' as any, 0);

    expect(result).toEqual({ text: 'hello' });
    expect(cfg.conversationService.rewindToTarget).toHaveBeenCalledWith('target-1');
    expect(cfg.ui.onResetTransient).toHaveBeenCalled();
  });

  it('rewindToTarget preserves images so a rewound multimodal turn can be resent', () => {
    const cfg = makeConfig();
    const orchestrator = new ConversationOrchestrator(cfg);
    const messages = cfg.messages as ReturnType<typeof makeMessagePort>;
    messages.appendMessages([createMessage('u1', 'user', 'look at this'), createBotMessage('b1', 'hi')]);
    const images = [{ id: 'img-1', data: 'abc', mimeType: 'image/png', byteSize: 3, displayNumber: 1 }];
    vi.mocked(cfg.conversationService.rewindToTarget).mockReturnValue({ text: 'look at this', images } as any);

    const result = orchestrator.rewindToTarget('target-1' as any, 0);

    expect(result).toEqual({ text: 'look at this', images });
  });

  it('rewindToTarget leaves the UI intact when the domain rejects a stale target', () => {
    const cfg = makeConfig();
    const orchestrator = new ConversationOrchestrator(cfg);
    const messages = cfg.messages as ReturnType<typeof makeMessagePort>;
    messages.appendMessages([createMessage('u1', 'user', 'hello'), createBotMessage('b1', 'hi')]);

    vi.mocked(cfg.conversationService.rewindToTarget).mockReturnValue(null);

    expect(orchestrator.rewindToTarget('stale-target' as any, 0)).toBeNull();
    expect(cfg.conversationService.rewindToTarget).toHaveBeenCalledWith('stale-target');
    expect(cfg.conversationService.abort).not.toHaveBeenCalled();
    expect(cfg.messages.setMessages).not.toHaveBeenCalled();
    expect(cfg.ui.onResetTransient).not.toHaveBeenCalled();
  });

  it('returns false when retryLastToolOutput has nothing to retry', async () => {
    const cfg = makeConfig();
    const orchestrator = new ConversationOrchestrator(cfg);

    vi.mocked(cfg.conversationService.peekLastToolOutput).mockReturnValue(null);

    await expect(orchestrator.retryLastToolOutput()).resolves.toBe(false);
  });

  it('rewinds to an earlier turn and discards every turn from there on', () => {
    const cfg = makeConfig();
    const orchestrator = new ConversationOrchestrator(cfg);
    const messages = cfg.messages as ReturnType<typeof makeMessagePort>;
    messages.appendMessages([
      createMessage('u1', 'user', 'first'),
      createBotMessage('b1', 'reply'),
      createMessage('u2', 'user', 'second'),
    ]);
    vi.mocked(cfg.conversationService.rewindToTarget).mockReturnValue({ text: 'first' });

    const restored = orchestrator.rewindToTarget('target-1' as any, 0);

    expect(restored).toEqual({ text: 'first' });
    expect(cfg.conversationService.rewindToTarget).toHaveBeenCalledWith('target-1');
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

    vi.mocked(cfg.conversationService.sendMessage).mockImplementation(async () => {
      cfg.conversationService.presentPendingInteraction(approvalTerminal.approval);
      return approvalTerminal;
    });

    await orchestrator.sendUserMessage('ask');
    const interactionId = cfg.conversationService.getPendingInteractionSnapshot()?.interactionId;
    expect(interactionId).toBeDefined();
    await orchestrator.handleApprovalDecision('y', undefined, 'first', interactionId!);

    expect(cfg.conversationService.getPendingInteractionSnapshot()).toMatchObject({
      askUserAnswers: ['first'],
      currentAskUserQuestionIndex: 1,
    });
    expect(cfg.conversationService.handleApprovalDecision).not.toHaveBeenCalled();
  });

  it('cancelling ask_user records a no-answer result and ends the turn there', async () => {
    // Escape used to abort, which threw the whole paused segment away — the
    // question never reached history, so the next user message looked as if
    // the model had never asked.
    const cfg = makeConfig();
    const orchestrator = new ConversationOrchestrator(cfg);
    const approval = {
      agentName: 'agent',
      toolName: 'ask_user',
      argumentsText: JSON.stringify({ questions: [{ question: 'one' }, { question: 'two' }] }),
      rawInterruption: null,
      callId: 'ask-1',
    };
    const interaction = cfg.conversationService.presentPendingInteraction(approval);

    await orchestrator.cancelAskUser(interaction.interactionId);

    expect(cfg.conversationService.handleApprovalDecision).toHaveBeenCalledWith(
      'y',
      undefined,
      expect.objectContaining({
        approvalAnswer: ASK_USER_NO_ANSWER_RESULT,
        stopAfterApprovalResolution: true,
      }),
    );
    expect(cfg.conversationService.getPendingInteractionSnapshot()).toBeNull();
  });

  it('ignores a late approval A decision after continuation presents approval B', async () => {
    const cfg = makeConfig();
    const orchestrator = new ConversationOrchestrator(cfg);
    const approvalA = {
      agentName: 'agent',
      toolName: 'shell',
      argumentsText: 'A',
      rawInterruption: null,
      callId: 'approval-a',
    };
    const approvalB = { ...approvalA, argumentsText: 'B', callId: 'approval-b' };
    const interactionA = cfg.conversationService.presentPendingInteraction(approvalA);
    const interactionB = cfg.conversationService.presentPendingInteraction(approvalB);

    await orchestrator.handleApprovalDecision('y', undefined, undefined, interactionA.interactionId);

    expect(cfg.conversationService.handleApprovalDecision).not.toHaveBeenCalled();
    expect(cfg.conversationService.getPendingInteractionSnapshot()).toMatchObject({
      interactionId: interactionB.interactionId,
      approval: { callId: 'approval-b' },
    });
  });

  it('routes a queued message to onQueuedMessagePending instead of appending when a turn is in flight', async () => {
    const cfg = makeConfig();
    vi.mocked(cfg.conversationService.isQueueActive).mockReturnValue(true);
    vi.mocked(cfg.conversationService.isQueueOwningSubmissions).mockReturnValue(true);
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
    (cfg.conversationService as any).isQueueActive = undefined;
    (cfg.conversationService as any).setQueuedTurnStartObserver = undefined;
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

  it('keeps a submission pending while the foreground queue is paused', async () => {
    const cfg = makeConfig();
    vi.mocked(cfg.conversationService.isQueueActive).mockReturnValue(false);
    vi.mocked(cfg.conversationService.isQueueOwningSubmissions).mockReturnValue(true);
    vi.mocked(cfg.conversationService.sendMessage).mockResolvedValue({
      type: 'response',
      finalText: 'ok',
      commandMessages: [],
    });
    const orchestrator = new ConversationOrchestrator(cfg);

    await orchestrator.sendUserMessage('while paused');

    expect(cfg.ui.onQueuedMessagePending).toHaveBeenCalledWith(expect.any(String), 'while paused');
    expect(cfg.messages.appendMessages).not.toHaveBeenCalled();
  });

  it('does not begin an owned turn for deferred queue work until the queue starts it', async () => {
    const cfg = makeConfig();
    vi.mocked(cfg.conversationService.isQueueOwningSubmissions).mockReturnValue(true);
    let release!: (terminal: ConversationTerminal) => void;
    const settled = new Promise<ConversationTerminal>((resolve) => {
      release = resolve;
    });
    vi.mocked(cfg.conversationService.sendMessage).mockReturnValue(settled as any);
    const orchestrator = new ConversationOrchestrator(cfg);
    const observer = vi.mocked(cfg.conversationService.setQueuedTurnStartObserver).mock.calls[0]?.[0] as (execution: {
      requestId: string;
      input: string;
    }) => void;

    const inFlight = orchestrator.sendUserMessage('deferred');
    await Promise.resolve();
    await Promise.resolve();

    expect(cfg.ui.onQueuedMessagePending).toHaveBeenCalledTimes(1);
    expect(cfg.ui.onTurnStart).not.toHaveBeenCalled();
    expect(cfg.ui.onTurnEnd).not.toHaveBeenCalled();

    const pendingCalls = vi.mocked(cfg.ui.onQueuedMessagePending!).mock.calls;
    const pendingCall = pendingCalls[0];
    if (!pendingCall) throw new Error('queued-message callback did not receive an id');
    const pendingId = pendingCall[0] as string;
    observer({ requestId: pendingId, input: 'deferred' });
    expect(cfg.ui.onTurnStart).toHaveBeenCalledOnce();
    expect(cfg.messages.appendMessages).toHaveBeenCalledTimes(1);

    release({ type: 'response', finalText: 'ok', commandMessages: [] });
    await inFlight;
    expect(cfg.ui.onTurnEnd).toHaveBeenCalledOnce();
  });

  it('does not end a turn when deferred queue work is removed before it starts', async () => {
    const cfg = makeConfig();
    vi.mocked(cfg.conversationService.isQueueOwningSubmissions).mockReturnValue(true);
    const abortError = Object.assign(new Error('Queued message was removed'), { name: 'AbortError' });
    vi.mocked(cfg.conversationService.sendMessage).mockRejectedValue(abortError);
    const orchestrator = new ConversationOrchestrator(cfg);

    await orchestrator.sendUserMessage('never-started');

    expect(cfg.ui.onQueuedMessagePending).toHaveBeenCalledTimes(1);
    expect(cfg.ui.onQueuedMessageRemoved).toHaveBeenCalledTimes(1);
    expect(cfg.ui.onTurnStart).not.toHaveBeenCalled();
    expect(cfg.ui.onTurnEnd).not.toHaveBeenCalled();
    expect(cfg.messages.appendMessages).not.toHaveBeenCalled();
  });

  it('delivers a steer into the running turn and shows it at the moment the turn takes it', async () => {
    const cfg = makeConfig();
    vi.mocked(cfg.conversationService.isQueueOwningSubmissions).mockReturnValue(true);
    const steerActiveTurn = vi.fn(async () => true);
    (cfg.conversationService as any).steerActiveTurn = steerActiveTurn;
    const orchestrator = new ConversationOrchestrator(cfg);

    await orchestrator.sendUserMessage('change direction', { busyMode: 'steer' });

    expect(steerActiveTurn).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'change direction' }),
      expect.objectContaining({ id: expect.any(String) }),
    );
    // No second turn is submitted: the message belongs to the turn in flight.
    expect(cfg.conversationService.sendMessage).not.toHaveBeenCalled();
    const appended = vi.mocked(cfg.messages.appendMessages).mock.calls[0]?.[0]?.[0] as any;
    expect(appended.sender).toBe('user');
    expect(appended.text).toBe('change direction');
    expect(cfg.ui.onQueuedMessageStarted).toHaveBeenCalledWith(appended.id);
  });

  it('falls back to queueing a steer the running turn cannot take', async () => {
    const cfg = makeConfig();
    vi.mocked(cfg.conversationService.isQueueOwningSubmissions).mockReturnValue(true);
    (cfg.conversationService as any).steerActiveTurn = vi.fn(async () => false);
    vi.mocked(cfg.conversationService.sendMessage).mockResolvedValue({
      type: 'response',
      finalText: 'ok',
      commandMessages: [],
    });
    const orchestrator = new ConversationOrchestrator(cfg);

    await orchestrator.sendUserMessage('too late to steer', { busyMode: 'steer' });

    expect(cfg.conversationService.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'too late to steer' }),
      expect.objectContaining({ busyMode: 'steer' }),
    );
    expect(cfg.ui.onQueuedMessagePending).toHaveBeenCalledTimes(1);
  });

  it('clears a delivered queue row even when the queue-start observer never fires', async () => {
    const cfg = makeConfig();
    vi.mocked(cfg.conversationService.isQueueOwningSubmissions).mockReturnValue(true);
    (cfg.conversationService as any).steerActiveTurn = vi.fn(async () => false);
    vi.mocked(cfg.conversationService.sendMessage).mockResolvedValue({
      type: 'response',
      finalText: 'ok',
      commandMessages: [],
    });
    const orchestrator = new ConversationOrchestrator(cfg);

    await orchestrator.sendUserMessage('already sent', { busyMode: 'steer' });

    const pendingId = vi.mocked(cfg.ui.onQueuedMessagePending!).mock.calls[0]?.[0];
    expect(pendingId).toBeDefined();
    expect(cfg.ui.onQueuedMessageStarted).toHaveBeenCalledWith(pendingId);
  });

  it('clears a matching pending row when a suppressed queued turn starts', async () => {
    const cfg = makeConfig();
    vi.mocked(cfg.conversationService.isQueueOwningSubmissions).mockReturnValue(true);
    let release!: (terminal: ConversationTerminal) => void;
    vi.mocked(cfg.conversationService.sendMessage).mockReturnValue(
      new Promise<ConversationTerminal>((resolve) => {
        release = resolve;
      }) as any,
    );
    const orchestrator = new ConversationOrchestrator(cfg);
    const observer = vi.mocked(cfg.conversationService.setQueuedTurnStartObserver).mock.calls[0]?.[0] as (execution: {
      requestId: string;
      input: string;
      suppressUserMessageDisplay?: boolean;
    }) => void;

    const inFlight = orchestrator.sendUserMessage('visible until started');
    await Promise.resolve();
    await Promise.resolve();
    const pendingId = vi.mocked(cfg.ui.onQueuedMessagePending!).mock.calls[0]?.[0];
    expect(pendingId).toBeDefined();

    observer({ requestId: pendingId!, input: 'visible until started', suppressUserMessageDisplay: true });
    expect(cfg.ui.onQueuedMessageStarted).toHaveBeenCalledWith(pendingId);
    expect(cfg.messages.appendMessages).not.toHaveBeenCalled();

    release({ type: 'response', finalText: 'ok', commandMessages: [] });
    await inFlight;
  });

  it('reports a rejected queue submission instead of letting the pending message vanish', async () => {
    const cfg = makeConfig();
    vi.mocked(cfg.conversationService.isQueueOwningSubmissions).mockReturnValue(true);
    vi.mocked(cfg.conversationService.sendMessage).mockRejectedValue(
      new Error('Foreground queue rejected message: capacity'),
    );
    const orchestrator = new ConversationOrchestrator(cfg);

    await orchestrator.sendUserMessage('dropped-by-queue');

    expect(cfg.ui.onQueuedMessageRemoved).toHaveBeenCalledTimes(1);
    const appended = vi.mocked(cfg.messages.appendMessages).mock.calls[0]?.[0]?.[0] as any;
    expect(appended.sender).toBe('bot');
    expect(appended.text).toContain('capacity');
    // The text the user typed is never silently lost.
    expect(appended.text).toContain('dropped-by-queue');
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
    expect(cfg.ui.onTurnStart).toHaveBeenCalledOnce();
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
    expect(cfg.ui.onQueuedMessageStarted).toHaveBeenCalledWith(directlyAppendedId);
    // The direct submission already started the UI lifecycle; its queue-start
    // notification must not begin it a second time.
    expect(cfg.ui.onTurnStart).toHaveBeenCalledOnce();
  });

  it('retractPendingSubmission removes the UI row only when the mutation applies', async () => {
    const cfg = makeConfig();
    const orchestrator = new ConversationOrchestrator(cfg);
    vi.mocked(cfg.conversationService.retractSubmission).mockResolvedValueOnce({
      kind: 'applied',
      stage: 'queued',
    });

    await expect(orchestrator.retractPendingSubmission('queued-1')).resolves.toEqual({
      kind: 'applied',
      stage: 'queued',
    });
    expect(cfg.ui.onQueuedMessageRemoved).toHaveBeenCalledWith('queued-1');

    vi.mocked(cfg.ui.onQueuedMessageRemoved!).mockClear();
    vi.mocked(cfg.conversationService.retractSubmission).mockResolvedValueOnce({
      kind: 'too_late',
      stage: 'started',
    });

    await expect(orchestrator.retractPendingSubmission('queued-2')).resolves.toEqual({
      kind: 'too_late',
      stage: 'started',
    });
    expect(cfg.ui.onQueuedMessageRemoved).not.toHaveBeenCalled();
  });

  it('editPendingSubmission updates the UI row only when the mutation applies', async () => {
    const cfg = makeConfig();
    const orchestrator = new ConversationOrchestrator(cfg);
    vi.mocked(cfg.conversationService.editSubmission).mockResolvedValueOnce({
      kind: 'applied',
      stage: 'pending_steer',
    });

    await expect(orchestrator.editPendingSubmission('steer-1', { text: 'edited text' })).resolves.toEqual({
      kind: 'applied',
      stage: 'pending_steer',
    });
    expect(cfg.ui.onQueuedMessageEdited).toHaveBeenCalledWith('steer-1', 'edited text');

    vi.mocked(cfg.ui.onQueuedMessageEdited!).mockClear();
    vi.mocked(cfg.conversationService.editSubmission).mockResolvedValueOnce({
      kind: 'unknown_id',
    });

    await expect(orchestrator.editPendingSubmission('unknown', { text: 'ignored' })).resolves.toEqual({
      kind: 'unknown_id',
    });
    expect(cfg.ui.onQueuedMessageEdited).not.toHaveBeenCalled();
  });

  it('uses the edited pending-steer turn when the steer is later admitted', async () => {
    const cfg = makeConfig();
    vi.mocked(cfg.conversationService.isQueueOwningSubmissions).mockReturnValue(true);
    let resolveSteer!: (value: boolean) => void;
    const steerActiveTurn = vi.fn(() => new Promise<boolean>((resolve) => (resolveSteer = resolve)));
    (cfg.conversationService as any).steerActiveTurn = steerActiveTurn;
    vi.mocked(cfg.conversationService.editSubmission).mockResolvedValue({
      kind: 'applied',
      stage: 'pending_steer',
    });
    const orchestrator = new ConversationOrchestrator(cfg);

    const sendPromise = orchestrator.sendUserMessage('original', { busyMode: 'steer' });
    await Promise.resolve();
    await Promise.resolve();
    const id = vi.mocked(cfg.ui.onQueuedMessagePending!).mock.calls[0]?.[0];
    expect(id).toBeDefined();

    await orchestrator.editPendingSubmission(id!, { text: 'edited' });
    resolveSteer(true);
    await sendPromise;

    const appended = vi.mocked(cfg.messages.appendMessages).mock.calls[0]?.[0]?.[0] as UserMessage;
    expect(appended.text).toBe('edited');
    expect(cfg.ui.onQueuedMessageStarted).toHaveBeenCalledWith(id);
  });

  it('does not resubmit a steer that was retracted while it was pending', async () => {
    const cfg = makeConfig();
    vi.mocked(cfg.conversationService.isQueueOwningSubmissions).mockReturnValue(true);
    let resolveSteer!: (value: boolean) => void;
    const steerActiveTurn = vi.fn(() => new Promise<boolean>((resolve) => (resolveSteer = resolve)));
    (cfg.conversationService as any).steerActiveTurn = steerActiveTurn;
    vi.mocked(cfg.conversationService.retractSubmission).mockResolvedValue({
      kind: 'applied',
      stage: 'pending_steer',
    });
    const orchestrator = new ConversationOrchestrator(cfg);

    const sendPromise = orchestrator.sendUserMessage('cancel me', { busyMode: 'steer' });
    await Promise.resolve();
    await Promise.resolve();
    const id = vi.mocked(cfg.ui.onQueuedMessagePending!).mock.calls[0]?.[0];
    expect(id).toBeDefined();

    await orchestrator.retractPendingSubmission(id!);
    resolveSteer(false);
    await sendPromise;

    expect(cfg.conversationService.sendMessage).not.toHaveBeenCalled();
    expect(cfg.ui.onQueuedMessageRemoved).toHaveBeenCalledTimes(1);
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

  it('does not retain directly-appended id across a rewind to an earlier turn', async () => {
    const cfg = makeConfig();
    vi.mocked(cfg.conversationService.isQueueActive).mockReturnValue(false);
    vi.mocked(cfg.conversationService.sendMessage).mockResolvedValue({
      type: 'response',
      finalText: 'ok',
      commandMessages: [],
    });
    const orchestrator = new ConversationOrchestrator(cfg);
    await orchestrator.sendUserMessage('first');
    await orchestrator.sendUserMessage('second');

    const firstAppendCall = vi.mocked(cfg.messages.appendMessages).mock.calls[0]!;
    const directlyAppendedId = (firstAppendCall[0]![0] as any).id as string;

    vi.mocked(cfg.conversationService.rewindToTarget).mockReturnValue({ text: 'first' });
    orchestrator.rewindToTarget('target-1' as any, 0);

    const setObserver = vi.mocked(cfg.conversationService.setQueuedTurnStartObserver);
    const observer = setObserver.mock.calls[0]?.[0] as (execution: { requestId: string; input: string }) => void;
    expect(observer).toBeDefined();
    const beforeCalls = vi.mocked(cfg.messages.appendMessages).mock.calls.length;
    observer({ requestId: directlyAppendedId, input: 'first' });
    expect(vi.mocked(cfg.messages.appendMessages).mock.calls.length).toBe(beforeCalls + 1);
  });

  it('does not retain directly-appended id across a rewind to the last turn', async () => {
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

    vi.mocked(cfg.conversationService.rewindToTarget).mockReturnValue({ text: 'first' });
    orchestrator.rewindToTarget('target-1' as any, 0);

    const setObserver = vi.mocked(cfg.conversationService.setQueuedTurnStartObserver);
    const observer = setObserver.mock.calls[0]?.[0] as (execution: { requestId: string; input: string }) => void;
    expect(observer).toBeDefined();
    const beforeCalls = vi.mocked(cfg.messages.appendMessages).mock.calls.length;
    observer({ requestId: directlyAppendedId, input: 'first' });
    expect(vi.mocked(cfg.messages.appendMessages).mock.calls.length).toBe(beforeCalls + 1);
  });

  // A command row opens as `running` on tool_started and closes only when a
  // command message for the same callId arrives. Before this sweep,
  // `stopProcessing` was the only site in the codebase that ever cleared one,
  // so every other way a turn can end -- stream error, retry, a tool whose
  // result never rendered -- left the row running for the rest of the session.
  // That is not cosmetic: a running command is the first message that cannot
  // render statically, so one stranded row keeps every later message
  // re-rendering outside Ink's Static region.
  describe('stranded command rows', () => {
    const runningRow = (id: string, overrides: Partial<Message> = {}) =>
      createMessage(id, 'command' as Message['sender'], '', {
        status: 'running',
        callId: id,
        toolName: 'cancel_shell_job',
        ...overrides,
      } as Partial<Message>);

    function configWithoutQueue(): ConversationOrchestratorConfig {
      const cfg = makeConfig();
      (cfg.conversationService as any).isQueueActive = undefined;
      (cfg.conversationService as any).setQueuedTurnStartObserver = undefined;
      return cfg;
    }

    const commandRows = (cfg: ConversationOrchestratorConfig) =>
      cfg.messages.getMessages().filter((message) => message.sender === 'command');

    it('aborts a row left running when the turn fails', async () => {
      const cfg = configWithoutQueue();
      cfg.messages.appendMessages([runningRow('call-stranded')]);
      vi.mocked(cfg.conversationService.sendMessage).mockRejectedValue(new Error('stream ended'));

      await new ConversationOrchestrator(cfg).sendUserMessage('hello');

      expect(commandRows(cfg)).toMatchObject([{ callId: 'call-stranded', status: 'aborted' }]);
    });

    it('warns once, naming the tool, so the next such bug is greppable', async () => {
      const cfg = configWithoutQueue();
      cfg.messages.appendMessages([runningRow('call-stranded')]);
      vi.mocked(cfg.conversationService.sendMessage).mockRejectedValue(new Error('stream ended'));

      const orchestrator = new ConversationOrchestrator(cfg);
      await orchestrator.sendUserMessage('hello');
      await orchestrator.sendUserMessage('again');

      const warnings = vi
        .mocked(cfg.loggingService.warn)
        .mock.calls.filter(([message]) => String(message).includes('running'));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.[1]).toMatchObject({ tools: ['cancel_shell_job'], callIds: ['call-stranded'] });
    });

    it('leaves a resolved row untouched and stays quiet', async () => {
      const cfg = configWithoutQueue();
      cfg.messages.appendMessages([runningRow('call-done', { status: 'completed' } as Partial<Message>)]);
      vi.mocked(cfg.conversationService.sendMessage).mockResolvedValue({
        type: 'response',
        finalText: 'ok',
        commandMessages: [],
      });

      await new ConversationOrchestrator(cfg).sendUserMessage('hello');

      expect(commandRows(cfg)).toMatchObject([{ callId: 'call-done', status: 'completed' }]);
      expect(cfg.loggingService.warn).not.toHaveBeenCalled();
    });

    // A turn that parks on an approval closes and reopens around the prompt, so
    // reaching endTurn does not mean the work finished. Sweeping there would
    // abort the sibling of a parallel tool call that is still legitimately
    // running. (The awaiting tool's own row is hidden during the prompt by
    // `filterPendingCommandMessagesForApproval`, which is separate behavior.)
    it('spares live rows while an approval is outstanding', async () => {
      const cfg = configWithoutQueue();
      cfg.messages.appendMessages([runningRow('call-awaiting'), runningRow('call-parallel')]);
      vi.mocked(cfg.conversationService.getPendingInteractionSnapshot).mockReturnValue({
        approval: { callId: 'call-awaiting', toolName: 'cancel_shell_job' },
      } as any);
      vi.mocked(cfg.conversationService.sendMessage).mockResolvedValue({
        type: 'approval_required',
        approval: { callId: 'call-awaiting', toolName: 'cancel_shell_job' },
      } as unknown as ConversationTerminal);

      await new ConversationOrchestrator(cfg).sendUserMessage('hello');

      expect(commandRows(cfg)).toMatchObject([{ callId: 'call-parallel', status: 'running' }]);
      expect(cfg.loggingService.warn).not.toHaveBeenCalled();
    });
  });
});
