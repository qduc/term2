// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import React from 'react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './app.js';
import { renderInAct } from './test-helpers/ink-testing.js';

const mocks = vi.hoisted(() => ({
  bottomAreaProps: null as any,
  useInputHandlers: [] as Array<(input: string, key: Record<string, boolean>) => void>,
  setInput: vi.fn(),
  setMode: vi.fn(),
  setTriggerIndex: vi.fn(),
  setImages: vi.fn(),
  exit: vi.fn(),
  handleApprovalDecision: vi.fn(),
  setWaitingForRejectionReason: vi.fn(),
  setWaitingForAskUserAnswer: vi.fn(),
  stopProcessing: vi.fn(),
  addSystemMessage: vi.fn(),
  sendUserMessage: vi.fn(),
  getUserMessages: vi.fn(() => []),
  undoToUserMessage: vi.fn(),
  setModel: vi.fn(),
  setReasoningEffort: vi.fn(),
  setTemperature: vi.fn(),
  addShellMessage: vi.fn(),
  getSubagentUsage: vi.fn(() => []),
  goToPreviousQuestion: vi.fn(),
  goToNextQuestion: vi.fn(),
  applyRuntimeSetting: vi.fn(),
  toggleShellMode: vi.fn(),
  handleShellSubmit: vi.fn(),
  cycleAppModes: vi.fn(),
  clearConversation: vi.fn(),
  pendingGuards: {
    largeUncachedWarning: null,
    pendingLargeUncachedTurn: null as import('./types/user-turn.js').UserTurn | null,
    pendingLargeUncachedTokens: 0,
    pendingSurgeTurn: null as import('./types/user-turn.js').UserTurn | null,
    pendingSurgeReason: '',
    guardTurn: vi.fn(),
    sendGuardedTurn: vi.fn(async () => true),
    handleLargeUncachedApprove: vi.fn(async () => {}),
    handleLargeUncachedDecline: vi.fn(),
    handleSurgeApprove: vi.fn(async () => {}),
    handleSurgeDecline: vi.fn(),
  },
  handoff: {
    handoffState: null as any,
    startHandoff: vi.fn(),
    confirmHandoff: vi.fn(async () => {}),
    declineHandoff: vi.fn(async () => {}),
    cancelHandoff: vi.fn(),
    submitHandoffInput: vi.fn(async () => false),
  },
  slashCommands: [] as any[],
  slashActionReturnValue: undefined as boolean | void | undefined,
  selectedSkill: null as any,
  conversationState: {
    waitingForApproval: false,
    waitingForRejectionReason: false,
    waitingForAskUserAnswer: false,
    isProcessing: false,
  },
}));

vi.mock('ink', () => ({
  Box: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useApp: () => ({ exit: mocks.exit }),
  useStdout: () => ({ stdout: { write: vi.fn() } }),
  useInput: (handler: (input: string, key: Record<string, boolean>) => void) => {
    mocks.useInputHandlers.push(handler);
  },
}));

vi.mock('./components/layout/BottomArea.js', () => ({
  default: (props: any) => {
    mocks.bottomAreaProps = props;
    return null;
  },
}));

vi.mock('./components/message/MessageList.js', () => ({
  default: () => null,
  EMPTY_RESTORED_STATIC_MESSAGE_IDS: [],
  MESSAGE_HORIZONTAL_PADDING: 0,
}));

vi.mock('./components/ErrorBoundary.js', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('./context/InputContext.js', () => ({
  useInputActions: () => ({
    setInput: mocks.setInput,
    setMode: mocks.setMode,
    setTriggerIndex: mocks.setTriggerIndex,
    setImages: mocks.setImages,
  }),
  useInputState: () => ({
    input: '',
    mode: 'text',
    cursorOffset: 0,
    triggerIndex: null,
    images: [],
  }),
}));

vi.mock('./hooks/use-conversation.js', () => ({
  useConversation: () => ({
    messages: [],
    lastUsage: null,
    lastCodexRateLimit: null,
    pendingApproval: null,
    waitingForApproval: mocks.conversationState.waitingForApproval,
    waitingForRejectionReason: mocks.conversationState.waitingForRejectionReason,
    waitingForAskUserAnswer: mocks.conversationState.waitingForAskUserAnswer,
    currentAskUserQuestionIndex: 0,
    setWaitingForRejectionReason: mocks.setWaitingForRejectionReason,
    setWaitingForAskUserAnswer: mocks.setWaitingForAskUserAnswer,
    isProcessing: mocks.conversationState.isProcessing,
    thinkingStartedAt: null,
    toolCallStreamingInfo: null,
    sendUserMessage: mocks.sendUserMessage,
    handleApprovalDecision: mocks.handleApprovalDecision,
    onTypeAnswer: vi.fn(),
    clearConversation: mocks.clearConversation,
    stopProcessing: mocks.stopProcessing,
    undoLastUserMessage: vi.fn(),
    getUserMessages: mocks.getUserMessages,
    undoToUserMessage: mocks.undoToUserMessage,
    setModel: mocks.setModel,
    setReasoningEffort: mocks.setReasoningEffort,
    setTemperature: mocks.setTemperature,
    addSystemMessage: mocks.addSystemMessage,
    addShellMessage: mocks.addShellMessage,
    getSubagentUsage: mocks.getSubagentUsage,
    goToPreviousQuestion: mocks.goToPreviousQuestion,
    goToNextQuestion: mocks.goToNextQuestion,
  }),
}));

vi.mock('./hooks/use-setting.js', () => ({
  useSetting: () => false,
}));

vi.mock('./hooks/use-runtime-settings.js', () => ({
  useRuntimeSettings: () => mocks.applyRuntimeSetting,
}));

vi.mock('./hooks/use-shell-mode.js', () => ({
  useShellMode: () => ({
    isShellMode: false,
    toggleShellMode: mocks.toggleShellMode,
    handleShellSubmit: mocks.handleShellSubmit,
  }),
}));

vi.mock('./hooks/use-app-commands.js', () => ({
  useAppCommands: ({ onSkillSelected }: { onSkillSelected: (skill: any) => void }) => {
    if (mocks.selectedSkill) {
      onSkillSelected(mocks.selectedSkill);
    }

    return {
      slashCommands:
        mocks.slashCommands.length > 0
          ? mocks.slashCommands
          : [
              {
                name: 'clear',
                description: 'Clear',
                action: vi.fn(() => mocks.slashActionReturnValue),
              },
            ],
      cycleAppModes: mocks.cycleAppModes,
    };
  },
}));

vi.mock('./hooks/use-terminal-focus-notifier.js', () => ({
  useTerminalFocusNotifier: () => ({
    approvalNeeded: vi.fn(),
    turnComplete: vi.fn(),
  }),
}));

vi.mock('./hooks/use-pending-turn-guards.js', () => ({
  usePendingTurnGuards: () => mocks.pendingGuards,
}));

vi.mock('./hooks/use-handoff-flow.js', () => ({
  useHandoffFlow: () => mocks.handoff,
}));

const createServices = () => ({
  conversationService: {
    previewLargeUncachedInput: vi.fn(() => ({ action: 'allow' })),
    previewInputSurge: vi.fn(() => ({ action: 'allow' })),
    setRetryCallback: vi.fn(),
    abort: vi.fn(),
    undoNUserTurns: vi.fn(),
    resetWithNewId: vi.fn(),
    queueModeNotice: vi.fn(),
    addShellContext: vi.fn(),
    listUserTurns: vi.fn(() => []),
  } as any,
  settingsService: {
    get: vi.fn(() => false),
    set: vi.fn(),
    onChange: vi.fn(() => () => {}),
  } as any,
  historyService: {
    getMessages: vi.fn(() => []),
    getTurns: vi.fn(() => []),
    addMessage: vi.fn(),
    clear: vi.fn(),
  } as any,
  loggingService: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    security: vi.fn(),
    setCorrelationId: vi.fn(),
    getCorrelationId: vi.fn(() => undefined),
    clearCorrelationId: vi.fn(),
  } as any,
});

const fireInput = async (input: string, key: Record<string, boolean>) => {
  await act(async () => {
    for (const handler of mocks.useInputHandlers) {
      handler(input, key);
    }
    await Promise.resolve();
  });
};

beforeEach(() => {
  mocks.bottomAreaProps = null;
  mocks.useInputHandlers = [];
  mocks.setInput.mockReset();
  mocks.setMode.mockReset();
  mocks.setTriggerIndex.mockReset();
  mocks.setImages.mockReset();
  mocks.exit.mockReset();
  mocks.handleApprovalDecision.mockReset();
  mocks.setWaitingForRejectionReason.mockReset();
  mocks.setWaitingForAskUserAnswer.mockReset();
  mocks.stopProcessing.mockReset();
  mocks.addSystemMessage.mockReset();
  mocks.sendUserMessage.mockReset();
  mocks.getUserMessages.mockReset();
  mocks.getUserMessages.mockReturnValue([]);
  mocks.undoToUserMessage.mockReset();
  mocks.setModel.mockReset();
  mocks.setReasoningEffort.mockReset();
  mocks.setTemperature.mockReset();
  mocks.addShellMessage.mockReset();
  mocks.getSubagentUsage.mockReset();
  mocks.getSubagentUsage.mockReturnValue([]);
  mocks.goToPreviousQuestion.mockReset();
  mocks.goToNextQuestion.mockReset();
  mocks.applyRuntimeSetting.mockReset();
  mocks.toggleShellMode.mockReset();
  mocks.handleShellSubmit.mockReset();
  mocks.cycleAppModes.mockReset();
  mocks.clearConversation.mockReset();
  mocks.pendingGuards.largeUncachedWarning = null;
  mocks.pendingGuards.pendingLargeUncachedTurn = null;
  mocks.pendingGuards.pendingLargeUncachedTokens = 0;
  mocks.pendingGuards.pendingSurgeTurn = null;
  mocks.pendingGuards.pendingSurgeReason = '';
  mocks.pendingGuards.guardTurn.mockReset();
  mocks.pendingGuards.sendGuardedTurn.mockReset();
  mocks.pendingGuards.sendGuardedTurn.mockResolvedValue(true);
  mocks.pendingGuards.handleLargeUncachedApprove.mockReset();
  mocks.pendingGuards.handleLargeUncachedDecline.mockReset();
  mocks.pendingGuards.handleSurgeApprove.mockReset();
  mocks.pendingGuards.handleSurgeDecline.mockReset();
  mocks.handoff.handoffState = null;
  mocks.handoff.startHandoff.mockReset();
  mocks.handoff.confirmHandoff.mockReset();
  mocks.handoff.declineHandoff.mockReset();
  mocks.handoff.cancelHandoff.mockReset();
  mocks.handoff.submitHandoffInput.mockReset();
  mocks.handoff.submitHandoffInput.mockResolvedValue(false);
  mocks.slashCommands = [];
  mocks.slashActionReturnValue = undefined;
  mocks.selectedSkill = null;
  mocks.conversationState.waitingForApproval = false;
  mocks.conversationState.waitingForRejectionReason = false;
  mocks.conversationState.waitingForAskUserAnswer = false;
  mocks.conversationState.isProcessing = false;
});

describe('App orchestration', () => {
  it.sequential('ignores submit while waiting for approval', async () => {
    mocks.conversationState.waitingForApproval = true;
    const services = createServices();

    await renderInAct(<App {...services} sessionId="session-1" generateId={() => 'session-2'} />);

    await act(async () => {
      await mocks.bottomAreaProps.onSubmit({ text: 'hello', images: [] });
    });

    expect(mocks.pendingGuards.sendGuardedTurn).not.toHaveBeenCalled();
    expect(mocks.handleApprovalDecision).not.toHaveBeenCalled();
  });

  it.sequential('routes rejection-reason submit through handleApprovalDecision', async () => {
    mocks.conversationState.waitingForRejectionReason = true;
    const services = createServices();

    await renderInAct(<App {...services} sessionId="session-1" generateId={() => 'session-2'} />);

    await act(async () => {
      await mocks.bottomAreaProps.onSubmit({ text: 'needs review', images: [] });
    });

    expect(mocks.setWaitingForRejectionReason).toHaveBeenCalledWith(false);
    expect(mocks.setInput).toHaveBeenCalledWith('');
    expect(mocks.handleApprovalDecision).toHaveBeenCalledWith('n', 'needs review');
  });

  it.sequential('clears input after slash command actions unless they return false', async () => {
    const commandAction = vi.fn(() => true);
    mocks.slashCommands = [{ name: 'clear', description: 'Clear', action: commandAction }];
    const services = createServices();

    await renderInAct(<App {...services} sessionId="session-1" generateId={() => 'session-2'} />);

    await act(async () => {
      await mocks.bottomAreaProps.onSubmit({ text: '/clear now', images: [] });
    });

    expect(commandAction).toHaveBeenCalledWith('now');
    expect(mocks.setInput).toHaveBeenCalledWith('');
    expect(mocks.pendingGuards.sendGuardedTurn).not.toHaveBeenCalled();
  });

  it.sequential('keeps input when a slash command explicitly returns false', async () => {
    const commandAction = vi.fn(() => false);
    mocks.slashCommands = [{ name: 'clear', description: 'Clear', action: commandAction }];
    const services = createServices();

    await renderInAct(<App {...services} sessionId="session-1" generateId={() => 'session-2'} />);

    await act(async () => {
      await mocks.bottomAreaProps.onSubmit({ text: '/clear now', images: [] });
    });

    expect(commandAction).toHaveBeenCalledWith('now');
    expect(mocks.setInput).not.toHaveBeenCalledWith('');
    expect(mocks.pendingGuards.sendGuardedTurn).not.toHaveBeenCalled();
  });

  it.sequential('attaches a pending skill before sending a normal message', async () => {
    mocks.selectedSkill = {
      name: 'Refactor',
      description: 'Refactor app.tsx',
      body: 'Use the refactor skill.',
    };
    const services = createServices();

    await renderInAct(<App {...services} sessionId="session-1" generateId={() => 'session-2'} />);

    await act(async () => {
      await mocks.bottomAreaProps.onSubmit({ text: 'Ship it', images: [] });
    });

    expect(mocks.pendingGuards.sendGuardedTurn).toHaveBeenCalledWith({
      text: 'Ship it',
      images: [],
      skill: {
        name: 'Refactor',
        description: 'Refactor app.tsx',
        body: 'Use the refactor skill.',
      },
    });
  });

  it.sequential('falls through unknown slash commands to guarded send', async () => {
    const services = createServices();

    await renderInAct(<App {...services} sessionId="session-1" generateId={() => 'session-2'} />);

    await act(async () => {
      await mocks.bottomAreaProps.onSubmit({ text: '/unknown command', images: [] });
    });

    expect(mocks.pendingGuards.sendGuardedTurn).toHaveBeenCalledWith({
      text: '/unknown command',
      images: [],
    });
  });

  it.sequential('ignores Shift+Tab when a large uncached turn is pending', async () => {
    mocks.pendingGuards.pendingLargeUncachedTurn = { text: 'large', images: [] };
    const services = createServices();

    await renderInAct(<App {...services} sessionId="session-1" generateId={() => 'session-2'} />);

    await fireInput('\u001b[Z', { shift: true, tab: true });

    expect(mocks.cycleAppModes).not.toHaveBeenCalled();
    expect(mocks.toggleShellMode).not.toHaveBeenCalled();
  });

  it.sequential('cancels handoff on Escape when entering the handoff message', async () => {
    mocks.handoff.handoffState = {
      capturedText: 'code',
      stage: 'entering_message',
    };
    const services = createServices();

    await renderInAct(<App {...services} sessionId="session-1" generateId={() => 'session-2'} />);

    await fireInput('', { escape: true });

    expect(mocks.handoff.cancelHandoff).toHaveBeenCalledTimes(1);
  });
});
