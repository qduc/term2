import { describe, it, expect, vi } from 'vitest';
import { ConversationOrchestrator } from './conversation-orchestrator.js';
import type { ConversationOrchestratorConfig, MessagePort, UIPort } from './conversation-orchestrator.types.js';
import type { ConversationService } from './conversation-service.js';
import type { ILoggingService } from '../service-interfaces.js';
import type { Message } from '../../types/message.js';
import type { ConversationTerminal } from '../../contracts/conversation.js';
import type { ConversationEvent } from './conversation-events.js';
import type { SubagentResult } from '../subagents/types.js';
import { SubagentNotificationStore } from '../subagents/subagent-notification-store.js';
import { PendingInteractionState } from '../session/pending-interaction-state.js';

const response = (text = 'ok'): ConversationTerminal => ({ type: 'response', finalText: text, commandMessages: [] });

const completion = (overrides: Partial<SubagentResult> = {}, async = true): ConversationEvent =>
  ({
    type: 'subagent_completed',
    async,
    result: {
      agentId: 'run-1',
      role: 'explorer',
      status: 'completed',
      finalText: 'found the bug',
      filesChanged: [],
      toolsUsed: [],
      ...overrides,
    },
  } as ConversationEvent);

const question = (
  overrides: Partial<Extract<ConversationEvent, { type: 'subagent_question' }>> = {},
): ConversationEvent =>
  ({
    type: 'subagent_question',
    async: true,
    messageId: 'question-1',
    runId: 'run-1',
    name: 'scan',
    role: 'explorer',
    question: 'Which public API should I use?',
    ...overrides,
  } as ConversationEvent);

const shellCompletion = (
  overrides: Partial<Extract<ConversationEvent, { type: 'background_shell_completed' }>> = {},
): ConversationEvent =>
  ({
    type: 'background_shell_completed',
    jobId: 'shell-1',
    command: 'pnpm test',
    status: 'completed',
    output: 'exit 0\nall tests passed',
    ...overrides,
  } as ConversationEvent);

/** Yield to the event loop so orchestrator-initiated turns can run to completion. */
async function settle(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
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
  };
}

function makeHarness(options: { queueActive?: boolean; injects?: boolean } = {}) {
  const store = new SubagentNotificationStore({ now: () => 1_000 });
  const pendingInteraction = new PendingInteractionState();
  let observer: (() => void) | null = null;
  let queuedTurnStartObserver:
    | ((execution: { requestId: string; input: string; suppressUserMessageDisplay?: boolean }) => void)
    | null = null;

  const service = {
    sessionId: 'test-session',
    sendMessage: vi.fn(async (_input: string, _options?: { suppressUserMessageDisplay?: boolean }) => response()),
    handleApprovalDecision: vi.fn(async () => response()),
    abort: vi.fn(),
    interruptFromUser: vi.fn(),
    isQueueActive: vi.fn(() => options.queueActive === true),
    injectIntoActiveTurn: vi.fn(async (_items: readonly unknown[]) => options.injects !== false),
    setQueueStateObserver: vi.fn(),
    setQueuedTurnStartObserver: vi.fn(
      (next: (execution: { requestId: string; input: string; suppressUserMessageDisplay?: boolean }) => void) => {
        queuedTurnStartObserver = next;
      },
    ),
    setBackgroundSubagentNotificationObserver: vi.fn((next: (() => void) | null) => {
      observer = next;
    }),
    getPendingInteractionSnapshot: vi.fn(() => pendingInteraction.getSnapshot()),
    presentPendingInteraction: vi.fn((approval) => pendingInteraction.present(approval)),
    clearPendingInteraction: vi.fn(() => pendingInteraction.clear()),
    resolvePendingInteraction: vi.fn((request) => pendingInteraction.resolve(request)),
    goToPreviousPendingInteractionQuestion: vi.fn(() => pendingInteraction.goToPreviousQuestion()),
    goToNextPendingInteractionQuestion: vi.fn(() => pendingInteraction.goToNextQuestion()),
    get backgroundSubagentNotifications() {
      return store;
    },
  };

  const config: ConversationOrchestratorConfig = {
    conversationService: service as unknown as ConversationService,
    loggingService: mockLoggingService(),
    messages: makeMessagePort(),
    ui: makeUIPort(),
    approvedContext: { current: null },
  };

  const orchestrator = new ConversationOrchestrator(config);

  return {
    orchestrator,
    config,
    service,
    store,
    /** Mirrors the conversation-scoped background sink installed by composition. */
    emit(event: ConversationEvent) {
      if (store.enqueue(event)) observer?.();
    },
    sentTexts(): string[] {
      return service.sendMessage.mock.calls.map((call) => String((call as unknown[])[0]));
    },
    injectedTexts(): string[] {
      return service.injectIntoActiveTurn.mock.calls.map((call) =>
        String(((call as unknown[])[0] as Array<{ content?: unknown }>)[0]?.content ?? ''),
      );
    },
    startQueuedTurn(input: string, suppressUserMessageDisplay?: boolean) {
      queuedTurnStartObserver?.({ requestId: 'queued-background-notification', input, suppressUserMessageDisplay });
    },
  };
}

describe('ConversationOrchestrator background subagent notifications mid-turn', () => {
  it('hands a settled shell job to the running turn at its next request boundary', async () => {
    const h = makeHarness({ queueActive: true });

    h.emit(shellCompletion());
    await settle();

    expect(h.service.injectIntoActiveTurn).toHaveBeenCalledTimes(1);
    expect(h.injectedTexts()[0]).toContain('Background shell job finished');
    expect(h.injectedTexts()[0]).toContain('pnpm test');
    expect(h.service.sendMessage).not.toHaveBeenCalled();
    expect(h.config.messages.getMessages()).toContainEqual(
      expect.objectContaining({ sender: 'command', toolName: 'background_shell_notification' }),
    );
  });

  it('hands a settled run to the running turn instead of waiting for it to end', async () => {
    const h = makeHarness({ queueActive: true });

    h.emit(completion());
    await settle();

    // The agent that launched the run is still working; it hears at its next
    // request boundary rather than after the whole turn.
    expect(h.service.injectIntoActiveTurn).toHaveBeenCalledTimes(1);
    expect(h.injectedTexts()[0]).toContain('found the bug');
    expect(h.service.sendMessage).not.toHaveBeenCalled();
  });

  it('announces a run in the transcript as soon as it settles, without waiting for delivery', async () => {
    const h = makeHarness({ queueActive: true });

    h.emit(completion({ name: 'code_scan' }));
    await settle();

    const announced = h.config.messages
      .getMessages()
      .filter(
        (message) => message.sender === 'command' && (message as any).command === 'background_subagent_notification',
      );
    expect(announced).toHaveLength(1);
    expect((announced[0] as any).toolArgs).toEqual({
      runs: [{ name: 'code_scan', role: 'explorer', status: 'completed' }],
    });
  });

  it('keeps a run for the idle path when the turn will not take it, and never reports it twice', async () => {
    const h = makeHarness({ queueActive: true, injects: false });

    h.emit(completion());
    await settle();

    expect(h.service.injectIntoActiveTurn).toHaveBeenCalledTimes(1);
    expect(h.service.sendMessage).not.toHaveBeenCalled();
    // Retained, not dropped: the idle path still owes the agent this report.
    expect(h.store.pendingCount).toBe(1);

    h.service.isQueueActive.mockReturnValue(false);
    h.emit(completion({ agentId: 'run-2', finalText: 'second finding' }));
    await settle();

    const sent = h.sentTexts().join('\n');
    expect(sent).toContain('found the bug');
    expect(sent).toContain('second finding');
    // Announced once each, despite passing through both paths.
    const announced = h.config.messages
      .getMessages()
      .filter(
        (message) => message.sender === 'command' && (message as any).command === 'background_subagent_notification',
      );
    expect(announced.flatMap((message) => String((message as any).output).match(/found the bug/g) ?? [])).toHaveLength(
      1,
    );
  });
});

describe('ConversationOrchestrator background subagent notifications', () => {
  it('delivers a question as an idle-gated system turn with reply routing and no user message', async () => {
    const h = makeHarness();

    h.emit(question());
    await settle();

    expect(h.service.sendMessage).toHaveBeenCalledTimes(1);
    const text = h.sentTexts()[0];
    expect(text).toContain('question-1');
    expect(text).toContain('target: scan');
    expect(text).toContain('reply_to: messageId');
    expect(text).toContain('Decide the answer, investigate it yourself, or escalate');
    expect(text).toContain('no direct user channel');
    expect(h.config.messages.getMessages().some((message) => message.sender === 'user')).toBe(false);
  });

  it('shows distinct questions from one run independently by message id', async () => {
    const h = makeHarness();

    h.emit(question({ messageId: 'question-1' }));
    await settle();
    h.emit(question({ messageId: 'question-2', question: 'Should I update callers too?' }));
    await settle();

    const display = h.config.messages
      .getMessages()
      .filter((message) => message.sender === 'command')
      .map((message: any) => message.output)
      .join('\n');
    expect(display).toContain('question-1');
    expect(display).toContain('question-2');
  });

  it('starts one system turn when a background run settles while the conversation is idle', async () => {
    const h = makeHarness();

    h.emit(completion());
    await settle();

    expect(h.service.sendMessage).toHaveBeenCalledTimes(1);
    const text = h.sentTexts()[0];
    expect(text).toContain('run-1');
    expect(text).toContain('explorer');
    expect(text).toContain('completed');
    expect(text).toContain('found the bug');
    expect(text).toContain('do not need to call get_subagent_result');
    expect(text).toContain('concise');
    expect(h.store.pendingCount).toBe(0);
    expect(h.config.ui.onTurnStart).toHaveBeenCalledTimes(1);
    expect(h.config.ui.onTurnEnd).toHaveBeenCalledTimes(1);
    expect(h.config.messages.getMessages()).toContainEqual(
      expect.objectContaining({
        sender: 'command',
        toolName: 'background_subagent_notification',
        status: 'completed',
        success: true,
      }),
    );
  });

  it('tells the orchestrator to assess the result and continue instead of only announcing completion', async () => {
    const h = makeHarness();

    h.emit(completion());
    await settle();

    const text = h.sentTexts()[0].toLowerCase();
    expect(text).toContain('assess');
    expect(text).toContain('continue');
    expect(text).toContain('your own words');
  });

  it('does not start a turn for a completion that is not an async run', async () => {
    const h = makeHarness();

    h.emit(completion({}, false));
    await settle();

    expect(h.service.sendMessage).not.toHaveBeenCalled();
    expect(h.config.ui.onTurnStart).not.toHaveBeenCalled();
  });

  it('renders a completion as tool activity instead of a user message when its queued turn starts', async () => {
    const h = makeHarness();
    h.service.sendMessage.mockImplementation(
      async (input: string, options?: { suppressUserMessageDisplay?: boolean }) => {
        h.startQueuedTurn(input, options?.suppressUserMessageDisplay);
        return response();
      },
    );

    h.emit(completion());
    await settle();

    expect(h.config.messages.getMessages().some((message) => message.sender === 'user')).toBe(false);
    expect(h.config.messages.getMessages()).toContainEqual(
      expect.objectContaining({ sender: 'command', toolName: 'background_subagent_notification' }),
    );
  });

  it('hands a question to the in-flight parent turn rather than holding it for idle', async () => {
    const h = makeHarness();
    let releaseUserTurn: (terminal: ConversationTerminal) => void = () => {};
    h.service.sendMessage.mockImplementationOnce(
      () => new Promise<ConversationTerminal>((resolve) => (releaseUserTurn = resolve)),
    );

    const userTurn = h.orchestrator.sendUserMessage('hello');
    await settle(1);

    h.emit(question());
    await settle();

    // The parent turn is the one blocking on this answer, so it hears now.
    expect(h.service.injectIntoActiveTurn).toHaveBeenCalledTimes(1);
    expect(h.injectedTexts()[0]).toContain('question-1');
    expect(h.store.pendingCount).toBe(0);

    releaseUserTurn(response());
    await userTurn;
    await settle();

    // Already delivered, so the turn boundary does not repeat it.
    expect(h.service.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('holds a question for idle when the in-flight turn will not take it', async () => {
    const h = makeHarness({ injects: false });
    let releaseUserTurn: (terminal: ConversationTerminal) => void = () => {};
    h.service.sendMessage.mockImplementationOnce(
      () => new Promise<ConversationTerminal>((resolve) => (releaseUserTurn = resolve)),
    );

    const userTurn = h.orchestrator.sendUserMessage('hello');
    await settle(1);

    h.emit(question());
    await settle();

    expect(h.service.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.store.pendingCount).toBe(1);

    releaseUserTurn(response());
    await userTurn;
    await settle();

    expect(h.service.sendMessage).toHaveBeenCalledTimes(2);
    expect(h.sentTexts()[1]).toContain('question-1');
    expect(h.store.pendingCount).toBe(0);
  });

  it('holds a question while an approval is pending and leaves the approval flow intact', async () => {
    const h = makeHarness();
    const approval: ConversationTerminal = {
      type: 'approval_required',
      approval: { agentName: 'agent', toolName: 'bash', argumentsText: 'ls', rawInterruption: null },
    };
    h.service.sendMessage.mockImplementationOnce(async () => {
      h.service.presentPendingInteraction(approval.approval);
      return approval;
    });

    await h.orchestrator.sendUserMessage('run ls');
    h.emit(question());
    await settle();

    expect(h.service.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.service.handleApprovalDecision).not.toHaveBeenCalled();
    expect(h.config.ui.onApprovalRequested).toHaveBeenCalledTimes(1);
    expect(h.store.pendingCount).toBe(1);

    const interactionId = h.service.getPendingInteractionSnapshot()?.interactionId;
    expect(interactionId).toBeDefined();
    await h.orchestrator.handleApprovalDecision('y', undefined, undefined, interactionId!);
    await settle();

    expect(h.service.handleApprovalDecision).toHaveBeenCalledTimes(1);
    expect(h.service.sendMessage).toHaveBeenCalledTimes(2);
    expect(h.sentTexts()[1]).toContain('question-1');
  });

  it('announces a replayed completion for the same run only once', async () => {
    const h = makeHarness();

    h.emit(completion());
    h.emit(completion());
    await settle();

    expect(h.service.sendMessage).toHaveBeenCalledTimes(1);
    const occurrences = h.sentTexts()[0].split('run-1').length - 1;
    expect(occurrences).toBe(1);
  });

  it('drains several completions that arrived during a turn the turn would not take', async () => {
    const h = makeHarness({ injects: false });
    let releaseUserTurn: (terminal: ConversationTerminal) => void = () => {};
    h.service.sendMessage.mockImplementationOnce(
      () => new Promise<ConversationTerminal>((resolve) => (releaseUserTurn = resolve)),
    );

    const userTurn = h.orchestrator.sendUserMessage('hello');
    await settle(1);

    h.emit(completion({ agentId: 'run-1' }));
    h.emit(completion({ agentId: 'run-2', role: 'worker', finalText: 'shipped it' }));
    await settle();

    releaseUserTurn(response());
    await userTurn;
    await settle();

    expect(h.service.sendMessage).toHaveBeenCalledTimes(2);
    expect(h.sentTexts()[1]).toContain('run-1');
    expect(h.sentTexts()[1]).toContain('run-2');
  });

  it('carries the status and error text of failed and cancelled runs', async () => {
    const h = makeHarness();

    h.emit(completion({ agentId: 'run-fail', status: 'failed', finalText: '', error: 'boom exploded' }));
    await settle();
    h.emit(completion({ agentId: 'run-cancel', status: 'cancelled', finalText: '', error: 'user cancelled' }));
    await settle();

    expect(h.service.sendMessage).toHaveBeenCalledTimes(2);
    expect(h.sentTexts()[0]).toContain('failed');
    expect(h.sentTexts()[0]).toContain('boom exploded');
    expect(h.sentTexts()[1]).toContain('cancelled');
    expect(h.sentTexts()[1]).toContain('user cancelled');

    const announced = h.config.messages
      .getMessages()
      .filter(
        (message) => message.sender === 'command' && (message as any).command === 'background_subagent_notification',
      );
    expect((announced[0] as any).toolArgs.runs[0]).toEqual({
      role: 'explorer',
      status: 'failed',
      error: 'boom exploded',
    });
  });

  it('does not announce background runs that the user’s own stop just cancelled', async () => {
    const h = makeHarness();
    // interruptFromUser cancels live background runs, and each cancellation
    // emits its own async completion event.
    h.service.interruptFromUser.mockImplementation(() => {
      h.emit(completion({ status: 'cancelled', finalText: '', error: 'The subagent run was aborted.' }));
    });

    h.orchestrator.stopProcessing();
    await settle();

    expect(h.service.sendMessage).not.toHaveBeenCalled();
    expect(h.store.pendingCount).toBe(0);
  });

  it('retains notifications when the delivery turn fails and redelivers them on the next attempt', async () => {
    const h = makeHarness();
    h.service.sendMessage.mockRejectedValueOnce(new Error('turn not admitted'));

    h.emit(completion());
    await settle();

    expect(h.service.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.store.pendingCount).toBe(1);

    // A failed delivery must not retry itself in a loop.
    await settle();
    expect(h.service.sendMessage).toHaveBeenCalledTimes(1);

    await h.orchestrator.sendUserMessage('hello');
    await settle();

    expect(h.service.sendMessage).toHaveBeenCalledTimes(3);
    expect(h.sentTexts()[2]).toContain('run-1');
    expect(h.store.pendingCount).toBe(0);
  });
});
