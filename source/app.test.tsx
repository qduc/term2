// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import React from 'react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from './app.js';
import { renderInAct } from './test-helpers/ink-testing.js';

const mocks = vi.hoisted(() => ({
  bottomAreaProps: null as any,
  useInputHandler: null as ((input: string, key: Record<string, boolean>) => void) | null,
  setInput: vi.fn(),
  replaceInput: vi.fn(),
  setMode: vi.fn(),
  setTriggerIndex: vi.fn(),
  setImages: vi.fn(),
  setInputAndCursor: vi.fn(),
  exit: vi.fn(),
  handleApprovalDecision: vi.fn(),
  submitApprovalDecision: vi.fn(),
  submitConversationTurn: vi.fn(async () => false),
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
    completeHandoffWithEffort: vi.fn(async () => {}),
    confirmStandardMode: vi.fn(async () => {}),
    declineStandardMode: vi.fn(async () => {}),
  },
  slashCommands: [] as any[],
  slashActionReturnValue: undefined as boolean | void | undefined,
  clearConversationCallback: null as null | (() => Promise<void>),
  messageListMounts: 0,
  stdoutWrite: vi.fn(),
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
  useStdout: () => ({ stdout: { write: mocks.stdoutWrite } }),
  useInput: (handler: (input: string, key: Record<string, boolean>) => void) => {
    mocks.useInputHandler = handler;
  },
}));

vi.mock('./components/layout/BottomArea.js', () => ({
  default: (props: any) => {
    mocks.bottomAreaProps = props;
    return null;
  },
}));

vi.mock('./components/message/MessageList.js', () => {
  const MockMessageList = () => {
    React.useEffect(() => {
      mocks.messageListMounts += 1;
    }, []);
    return null;
  };
  return {
    default: MockMessageList,
    detectStaticCommitBlocker: vi.fn(() => null),
    EMPTY_RESTORED_STATIC_MESSAGE_IDS: [],
    MESSAGE_HORIZONTAL_PADDING: 0,
  };
});

vi.mock('./components/ErrorBoundary.js', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('./context/InputContext.js', () => ({
  useInputActions: () => ({
    setInput: mocks.setInput,
    replaceInput: mocks.replaceInput,
    setMode: mocks.setMode,
    setTriggerIndex: mocks.setTriggerIndex,
    setImages: mocks.setImages,
    setInputAndCursor: mocks.setInputAndCursor,
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
    submitConversationTurn: mocks.submitConversationTurn,
    submitApprovalDecision: mocks.submitApprovalDecision,
    handleApprovalDecision: mocks.handleApprovalDecision,
    onTypeAnswer: vi.fn(),
    clearConversation: mocks.clearConversation,
    stopProcessing: mocks.stopProcessing,
    undoLastUserMessage: vi.fn(),
    retryLastToolOutput: vi.fn(async () => false),
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
  useAppCommands: ({
    clearConversation,
    onSkillSelected,
  }: {
    clearConversation: () => Promise<void>;
    onSkillSelected: (skill: any) => void;
  }) => {
    mocks.clearConversationCallback = clearConversation;
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

vi.mock('./hooks/use-app-keyboard-shortcuts.js', () => ({
  useAppKeyboardShortcuts: vi.fn(),
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

beforeEach(() => {
  mocks.bottomAreaProps = null;
  mocks.useInputHandler = null;
  mocks.setInput.mockReset();
  mocks.replaceInput.mockReset();
  mocks.setMode.mockReset();
  mocks.setTriggerIndex.mockReset();
  mocks.setImages.mockReset();
  mocks.exit.mockReset();
  mocks.handleApprovalDecision.mockReset();
  mocks.submitApprovalDecision.mockReset();
  mocks.submitConversationTurn.mockReset();
  mocks.submitConversationTurn.mockResolvedValue(false);
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
  mocks.clearConversationCallback = null;
  mocks.messageListMounts = 0;
  mocks.stdoutWrite.mockReset();
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
  mocks.handoff.completeHandoffWithEffort.mockReset();
  mocks.handoff.confirmStandardMode.mockReset();
  mocks.handoff.declineStandardMode.mockReset();
  mocks.slashCommands = [];
  mocks.slashActionReturnValue = undefined;
  mocks.selectedSkill = null;
  mocks.conversationState.waitingForApproval = false;
  mocks.conversationState.waitingForRejectionReason = false;
  mocks.conversationState.waitingForAskUserAnswer = false;
  mocks.conversationState.isProcessing = false;
});

describe('App orchestration', () => {
  it.sequential('remounts MessageList when clearing conversation without clearing the terminal', async () => {
    const services = createServices();

    await renderInAct(
      <App {...services} sessionId="session-1" terminalTitleBase="term2" generateId={() => 'session-2'} />,
    );

    expect(mocks.messageListMounts).toBe(1);
    expect(mocks.clearConversationCallback).not.toBeNull();

    await act(async () => {
      await mocks.clearConversationCallback?.();
    });

    expect(mocks.clearConversation).toHaveBeenCalledTimes(1);
    expect(mocks.messageListMounts).toBe(2);
    expect(mocks.stdoutWrite).not.toHaveBeenCalled();
  });

  it.sequential('ignores submit while waiting for approval', async () => {
    mocks.conversationState.waitingForApproval = true;
    mocks.submitConversationTurn.mockResolvedValue(true);
    const services = createServices();

    await renderInAct(
      <App {...services} sessionId="session-1" terminalTitleBase="term2" generateId={() => 'session-2'} />,
    );

    await act(async () => {
      await mocks.bottomAreaProps.onSubmit({ text: 'hello', images: [] });
    });

    expect(mocks.submitConversationTurn).toHaveBeenCalledWith({ text: 'hello', images: [] });
    expect(mocks.pendingGuards.sendGuardedTurn).not.toHaveBeenCalled();
    expect(mocks.handleApprovalDecision).not.toHaveBeenCalled();
  });

  it.sequential('routes rejection-reason submit through useConversation', async () => {
    mocks.conversationState.waitingForRejectionReason = true;
    mocks.submitConversationTurn.mockResolvedValue(true);
    const services = createServices();

    await renderInAct(
      <App {...services} sessionId="session-1" terminalTitleBase="term2" generateId={() => 'session-2'} />,
    );

    await act(async () => {
      await mocks.bottomAreaProps.onSubmit({ text: 'needs review', images: [] });
    });

    expect(mocks.submitConversationTurn).toHaveBeenCalledWith({ text: 'needs review', images: [] });
    expect(mocks.setWaitingForRejectionReason).not.toHaveBeenCalled();
    expect(mocks.replaceInput).not.toHaveBeenCalled();
    expect(mocks.handleApprovalDecision).not.toHaveBeenCalled();
  });

  it.sequential('clears input after slash command actions unless they return false', async () => {
    const commandAction = vi.fn(() => true);
    mocks.slashCommands = [{ name: 'clear', description: 'Clear', action: commandAction }];
    const services = createServices();

    await renderInAct(
      <App {...services} sessionId="session-1" terminalTitleBase="term2" generateId={() => 'session-2'} />,
    );

    await act(async () => {
      await mocks.bottomAreaProps.onSubmit({ text: '/clear now', images: [] });
    });

    expect(commandAction).toHaveBeenCalledWith('now');
    expect(mocks.replaceInput).toHaveBeenCalledWith('');
    expect(mocks.pendingGuards.sendGuardedTurn).not.toHaveBeenCalled();
  });

  it.sequential('keeps input when a slash command explicitly returns false', async () => {
    const commandAction = vi.fn(() => false);
    mocks.slashCommands = [{ name: 'clear', description: 'Clear', action: commandAction }];
    const services = createServices();

    await renderInAct(
      <App {...services} sessionId="session-1" terminalTitleBase="term2" generateId={() => 'session-2'} />,
    );

    await act(async () => {
      await mocks.bottomAreaProps.onSubmit({ text: '/clear now', images: [] });
    });

    expect(commandAction).toHaveBeenCalledWith('now');
    expect(mocks.replaceInput).not.toHaveBeenCalledWith('');
    expect(mocks.pendingGuards.sendGuardedTurn).not.toHaveBeenCalled();
  });

  it.sequential('attaches a pending skill before sending a normal message', async () => {
    mocks.selectedSkill = {
      name: 'Refactor',
      description: 'Refactor app.tsx',
      body: 'Use the refactor skill.',
    };
    const services = createServices();

    await renderInAct(
      <App {...services} sessionId="session-1" terminalTitleBase="term2" generateId={() => 'session-2'} />,
    );

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

    await renderInAct(
      <App {...services} sessionId="session-1" terminalTitleBase="term2" generateId={() => 'session-2'} />,
    );

    await act(async () => {
      await mocks.bottomAreaProps.onSubmit({ text: '/unknown command', images: [] });
    });

    expect(mocks.pendingGuards.sendGuardedTurn).toHaveBeenCalledWith({
      text: '/unknown command',
      images: [],
    });
  });
});
