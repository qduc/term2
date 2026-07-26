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
    onRemoveLastPendingMessage: vi.fn(),
  };
}

function makeHarness() {
  const store = new SubagentNotificationStore({ now: () => 1_000 });
  let observer: (() => void) | null = null;

  const service = {
    sessionId: 'test-session',
    sendMessage: vi.fn(async () => response()),
    handleApprovalDecision: vi.fn(async () => response()),
    abort: vi.fn(),
    interruptFromUser: vi.fn(),
    isQueueActive: vi.fn(() => false),
    setQueueStateObserver: vi.fn(),
    setQueuedTurnStartObserver: vi.fn(),
    setBackgroundSubagentNotificationObserver: vi.fn((next: (() => void) | null) => {
      observer = next;
    }),
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
  };
}

describe('ConversationOrchestrator background subagent notifications', () => {
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
    expect(text).toContain('get_subagent_result');
    expect(text).toContain('concise');
    expect(h.store.pendingCount).toBe(0);
    expect(h.config.ui.onTurnStart).toHaveBeenCalledTimes(1);
    expect(h.config.ui.onTurnEnd).toHaveBeenCalledTimes(1);
  });

  it('does not start a turn for a completion that is not an async run', async () => {
    const h = makeHarness();

    h.emit(completion({}, false));
    await settle();

    expect(h.service.sendMessage).not.toHaveBeenCalled();
    expect(h.config.ui.onTurnStart).not.toHaveBeenCalled();
  });

  it('defers delivery until the in-flight turn reaches a terminal state, then delivers once', async () => {
    const h = makeHarness();
    let releaseUserTurn: (terminal: ConversationTerminal) => void = () => {};
    h.service.sendMessage.mockImplementationOnce(
      () => new Promise<ConversationTerminal>((resolve) => (releaseUserTurn = resolve)),
    );

    const userTurn = h.orchestrator.sendUserMessage('hello');
    await settle(1);

    h.emit(completion());
    await settle();

    expect(h.service.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.store.pendingCount).toBe(1);

    releaseUserTurn(response());
    await userTurn;
    await settle();

    expect(h.service.sendMessage).toHaveBeenCalledTimes(2);
    expect(h.sentTexts()[1]).toContain('run-1');
    expect(h.store.pendingCount).toBe(0);
  });

  it('does not start a turn while an approval is pending and leaves the approval flow intact', async () => {
    const h = makeHarness();
    const approval: ConversationTerminal = {
      type: 'approval_required',
      approval: { agentName: 'agent', toolName: 'bash', argumentsText: 'ls', rawInterruption: null },
    };
    h.service.sendMessage.mockResolvedValueOnce(approval);

    await h.orchestrator.sendUserMessage('run ls');
    h.emit(completion());
    await settle();

    expect(h.service.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.service.handleApprovalDecision).not.toHaveBeenCalled();
    expect(h.config.ui.onApprovalRequested).toHaveBeenCalledTimes(1);
    expect(h.store.pendingCount).toBe(1);

    await h.orchestrator.handleApprovalDecision('y');
    await settle();

    expect(h.service.handleApprovalDecision).toHaveBeenCalledTimes(1);
    expect(h.service.sendMessage).toHaveBeenCalledTimes(2);
    expect(h.sentTexts()[1]).toContain('run-1');
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

  it('drains several completions that arrived during a turn into a single turn', async () => {
    const h = makeHarness();
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
