// @ts-expect-error IS_REACT_ACT_ENVIRONMENT is not in globalThis types
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import React from 'react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createNode } from '../node_modules/ink/build/dom.js';
import reconciler from '../node_modules/ink/build/reconciler.js';
import App from './app.js';
import { renderInAct, rerenderInAct } from './test-helpers/ink-testing.js';

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
  admissionConfirmation: null as any,
  submitTurnForAdmission: vi.fn(() => ({ kind: 'submitted' as const, completion: Promise.resolve() })),
  resolveAdmissionConfirmation: vi.fn<any>(),
  setWaitingForRejectionReason: vi.fn(),
  setWaitingForAskUserAnswer: vi.fn(),
  stopProcessing: vi.fn(),
  addSystemMessage: vi.fn(),
  sendUserMessage: vi.fn(),
  sendSessionRolloverBrief: vi.fn(),
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
  enterShellMode: vi.fn(),
  exitShellMode: vi.fn(),
  handleShellSubmit: vi.fn(),
  cycleAppModes: vi.fn(),
  clearConversation: vi.fn(),
  handoff: {
    handoffState: null as any,
    startHandoff: vi.fn(),
    confirmHandoff: vi.fn(async () => {}),
    declineHandoff: vi.fn(async () => {}),
    cancelHandoff: vi.fn(),
    submitHandoffInput: vi.fn(async () => false),
    handleModelSubmitPrompt: vi.fn(() => false),
    completeHandoffWithEffort: vi.fn(async () => {}),
    confirmStandardMode: vi.fn(async () => {}),
    declineStandardMode: vi.fn(async () => {}),
  },
  slashCommands: [] as any[],
  slashActionReturnValue: undefined as boolean | void | undefined,
  clearConversationCallback: null as null | (() => Promise<void>),
  sessionRolloverCallback: null as null | ((request: any) => void | Promise<void>),
  requestModeSwitchConfirmCallback: null as null | ((pending: any) => void),
  messageListMounts: 0,
  inputValue: '',
  stdoutWrite: vi.fn(),
  selectedSkill: null as any,
  sandboxNetworkHandler: null as null | ((request: { host: string; port?: number }) => Promise<unknown>),
  registerSandboxNetworkApprovalHandler: vi.fn(),
  menuController: {
    open: vi.fn(),
    setIntentHost: vi.fn(),
  },
  conversationState: {
    pendingApproval: null as { toolName?: string; checkIn?: string } | null,
    waitingForApproval: false,
    waitingForRejectionReason: false,
    waitingForAskUserAnswer: false,
    isProcessing: false,
    backgroundTaskDetails: [] as any[],
  },
  setTerminalTitle: vi.fn(),
}));

vi.mock('./utils/output/terminal-title.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./utils/output/terminal-title.js')>();
  return {
    ...actual,
    setTerminalTitle: mocks.setTerminalTitle,
  };
});

// Ink's public test renderer uses a legacy, non-strict root. Build the same
// Ink host root in concurrent strict mode so React actually replays effects.
const CONCURRENT_REACT_ROOT = 1;

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
    input: mocks.inputValue,
    mode: 'text',
    cursorOffset: 0,
    triggerIndex: null,
    images: [],
    controller: mocks.menuController,
  }),
}));

vi.mock('./hooks/use-conversation.js', () => ({
  useConversation: (options: any) => {
    mocks.sessionRolloverCallback = options.onSessionRollover ?? null;
    return {
      messages: [],
      lastUsage: null,
      lastCodexRateLimit: null,
      pendingApproval: mocks.conversationState.pendingApproval,
      waitingForApproval: mocks.conversationState.waitingForApproval,
      waitingForRejectionReason: mocks.conversationState.waitingForRejectionReason,
      waitingForAskUserAnswer: mocks.conversationState.waitingForAskUserAnswer,
      currentAskUserQuestionIndex: 0,
      setWaitingForRejectionReason: mocks.setWaitingForRejectionReason,
      setWaitingForAskUserAnswer: mocks.setWaitingForAskUserAnswer,
      isProcessing: mocks.conversationState.isProcessing,
      backgroundTaskDetails: mocks.conversationState.backgroundTaskDetails ?? [],
      thinkingStartedAt: null,
      toolCallStreamingInfo: null,
      sendUserMessage: mocks.sendUserMessage,
      sendSessionRolloverBrief: mocks.sendSessionRolloverBrief,
      admissionConfirmation: mocks.admissionConfirmation,
      submitTurnForAdmission: mocks.submitTurnForAdmission,
      resolveAdmissionConfirmation: mocks.resolveAdmissionConfirmation,
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
      getCostSummary: vi.fn(() => null),
      goToPreviousQuestion: mocks.goToPreviousQuestion,
      goToNextQuestion: mocks.goToNextQuestion,
      queueActive: false,
      queuePaused: false,
      queueLength: 0,
      queuePauseReason: undefined,
      pendingQueuedMessages: [],
      resumeQueue: vi.fn(),
      discardQueue: vi.fn(),
    };
  },
}));

vi.mock('./hooks/use-setting.js', () => ({
  useSetting: () => false,
}));

vi.mock('./utils/shell/sandbox/sandbox-network-approval.js', () => ({
  registerSandboxNetworkApprovalHandler: mocks.registerSandboxNetworkApprovalHandler,
}));

mocks.registerSandboxNetworkApprovalHandler.mockImplementation((handler) => {
  mocks.sandboxNetworkHandler = handler;
  return () => {
    if (mocks.sandboxNetworkHandler === handler) mocks.sandboxNetworkHandler = null;
  };
});

vi.mock('./hooks/use-runtime-settings.js', () => ({
  useRuntimeSettings: () => mocks.applyRuntimeSetting,
}));

vi.mock('./hooks/use-shell-mode.js', () => ({
  useShellMode: () => ({
    isShellMode: false,
    enterShellMode: mocks.enterShellMode,
    exitShellMode: mocks.exitShellMode,
    handleShellSubmit: mocks.handleShellSubmit,
  }),
}));

vi.mock('./hooks/use-app-commands.js', () => ({
  useAppCommands: ({
    clearConversation,
    onSkillSelected,
    requestModeSwitchConfirm,
  }: {
    clearConversation: () => Promise<void>;
    onSkillSelected: (skill: any) => void;
    requestModeSwitchConfirm?: (pending: any) => void;
  }) => {
    mocks.clearConversationCallback = clearConversation;
    mocks.requestModeSwitchConfirmCallback = requestModeSwitchConfirm ?? null;
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
  useAppKeyboardShortcuts: vi.fn(() => ({ interruptConfirmVisible: false })),
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
    listRewindTargets: vi.fn(() => []),
    rewindToTarget: vi.fn(),
    undoNUserTurns: vi.fn(),
    resetWithNewId: vi.fn(),
    queueModeNotice: vi.fn(),
    addShellContext: vi.fn(),
    listUserTurns: vi.fn(() => []),
    logSessionRollover: vi.fn(),
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
  mocks.sendSessionRolloverBrief.mockReset();
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
  mocks.enterShellMode.mockReset();
  mocks.exitShellMode.mockReset();
  mocks.handleShellSubmit.mockReset();
  mocks.cycleAppModes.mockReset();
  mocks.clearConversation.mockReset();
  mocks.clearConversationCallback = null;
  mocks.sessionRolloverCallback = null;
  mocks.messageListMounts = 0;
  mocks.inputValue = '';
  mocks.stdoutWrite.mockReset();
  mocks.admissionConfirmation = null;
  mocks.submitTurnForAdmission.mockReset();
  mocks.submitTurnForAdmission.mockReturnValue({ kind: 'submitted', completion: Promise.resolve() });
  mocks.resolveAdmissionConfirmation.mockReset();
  mocks.resolveAdmissionConfirmation.mockReturnValue({ kind: 'stale' });
  mocks.handoff.handoffState = null;
  mocks.handoff.startHandoff.mockReset();
  mocks.handoff.confirmHandoff.mockReset();
  mocks.handoff.declineHandoff.mockReset();
  mocks.handoff.cancelHandoff.mockReset();
  mocks.handoff.submitHandoffInput.mockReset();
  mocks.handoff.submitHandoffInput.mockResolvedValue(false);
  mocks.handoff.handleModelSubmitPrompt.mockReset();
  mocks.handoff.handleModelSubmitPrompt.mockReturnValue(false);
  mocks.handoff.completeHandoffWithEffort.mockReset();
  mocks.handoff.confirmStandardMode.mockReset();
  mocks.handoff.declineStandardMode.mockReset();
  mocks.slashCommands = [];
  mocks.slashActionReturnValue = undefined;
  mocks.selectedSkill = null;
  mocks.sandboxNetworkHandler = null;
  mocks.registerSandboxNetworkApprovalHandler.mockClear();
  mocks.menuController.open.mockReset();
  mocks.menuController.setIntentHost.mockReset();
  mocks.conversationState.pendingApproval = null;
  mocks.conversationState.waitingForApproval = false;
  mocks.conversationState.waitingForRejectionReason = false;
  mocks.conversationState.waitingForAskUserAnswer = false;
  mocks.conversationState.isProcessing = false;
});

describe('App orchestration', () => {
  it.sequential('rotates a requested rollover and sends a marked protocol briefing into the new session', async () => {
    const services = createServices();

    await renderInAct(
      <App {...services} sessionId="session-1" terminalTitleBase="term2" generateId={() => 'session-2'} />,
    );

    await act(async () => {
      await mocks.sessionRolloverCallback?.({
        brief: 'Done: implementation. Open: validation.',
        reason: 'task_boundary',
      });
    });

    expect(services.conversationService.logSessionRollover).toHaveBeenCalledWith({
      brief: 'Done: implementation. Open: validation.',
      reason: 'task_boundary',
    });
    expect(mocks.clearConversation).toHaveBeenCalledTimes(1);
    expect(mocks.sendSessionRolloverBrief).toHaveBeenCalledWith(
      expect.stringContaining('Previous session: `session-1`'),
    );
    expect(mocks.sendSessionRolloverBrief).toHaveBeenCalledWith(
      expect.stringContaining('Done: implementation. Open: validation.'),
    );
    expect(mocks.sendUserMessage).not.toHaveBeenCalled();
  });

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
    expect(mocks.submitTurnForAdmission).not.toHaveBeenCalled();
    expect(mocks.handleApprovalDecision).not.toHaveBeenCalled();
  });

  it.sequential('keeps sandbox network approval live after StrictMode replays effects', async () => {
    const services = createServices();
    const root = createNode('ink-root');
    const container = reconciler.createContainer(
      root,
      CONCURRENT_REACT_ROOT,
      null,
      true,
      null,
      'strict-app-test',
      () => {},
      () => {},
      () => {},
      () => {},
    );

    await act(async () => {
      reconciler.updateContainer(
        <React.StrictMode>
          <App {...services} sessionId="session-1" terminalTitleBase="term2" generateId={() => 'session-2'} />
        </React.StrictMode>,
        container,
        null,
        () => {},
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
    });

    expect(mocks.registerSandboxNetworkApprovalHandler).toHaveBeenCalledTimes(2);
    expect(mocks.sandboxNetworkHandler).toEqual(expect.any(Function));
    let request: Promise<unknown> | undefined;
    await act(async () => {
      request = mocks.sandboxNetworkHandler?.({ host: 'api.example.com', port: 443 });
      await Promise.resolve();
    });

    expect(mocks.bottomAreaProps.pendingApproval).toMatchObject({
      toolName: 'sandbox_network_access',
      argumentsText: 'Allow network access to api.example.com:443?',
    });

    await act(async () => {
      await mocks.bottomAreaProps.onApprove('allow-once');
    });
    await expect(request).resolves.toBe('allow-once');

    let pendingOnUnmount: Promise<unknown> | undefined;
    await act(async () => {
      pendingOnUnmount = mocks.sandboxNetworkHandler?.({ host: 'shutdown.example.com' });
      await Promise.resolve();
    });
    expect(mocks.bottomAreaProps.pendingApproval).toMatchObject({
      argumentsText: 'Allow network access to shutdown.example.com?',
    });

    await act(async () => {
      reconciler.updateContainer(null, container, null, () => {});
      await Promise.resolve();
    });
    await expect(pendingOnUnmount).resolves.toBe('deny');
    expect(mocks.sandboxNetworkHandler).toBeNull();
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

  it.sequential('stops a run-budget check-in without asking for a rejection reason', async () => {
    // The check-in borrows the approval transport but has no tool to deny, and
    // the reason composer refuses an empty submit — prompting "Why?" here left
    // Stop unreachable without typing text nothing reads.
    mocks.conversationState.pendingApproval = { checkIn: 'run_budget' };
    mocks.conversationState.waitingForApproval = true;
    const services = createServices();

    await renderInAct(
      <App {...services} sessionId="session-1" terminalTitleBase="term2" generateId={() => 'session-2'} />,
    );

    await act(async () => {
      mocks.bottomAreaProps.onReject();
      await Promise.resolve();
    });

    expect(mocks.handleApprovalDecision).toHaveBeenCalledWith('n', undefined);
    expect(mocks.setWaitingForRejectionReason).not.toHaveBeenCalled();
  });

  it.sequential('still asks for a rejection reason when denying a real tool call', async () => {
    mocks.conversationState.pendingApproval = { toolName: 'shell' };
    mocks.conversationState.waitingForApproval = true;
    const services = createServices();

    await renderInAct(
      <App {...services} sessionId="session-1" terminalTitleBase="term2" generateId={() => 'session-2'} />,
    );

    await act(async () => {
      mocks.bottomAreaProps.onReject();
      await Promise.resolve();
    });

    expect(mocks.setWaitingForRejectionReason).toHaveBeenCalledWith(true);
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
    expect(mocks.submitTurnForAdmission).not.toHaveBeenCalled();
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
    expect(mocks.submitTurnForAdmission).not.toHaveBeenCalled();
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

    expect(mocks.submitTurnForAdmission).toHaveBeenCalledWith({
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

    expect(mocks.submitTurnForAdmission).toHaveBeenCalledWith({
      text: '/unknown command',
      images: [],
    });
  });

  it.sequential('routes a controller submit-prompt intent through admission', async () => {
    const services = createServices();
    await renderInAct(
      <App {...services} sessionId="session-1" terminalTitleBase="term2" generateId={() => 'session-2'} />,
    );
    const intentHost = mocks.menuController.setIntentHost.mock.calls
      .map(([value]) => value)
      .find((value) => typeof value === 'function');
    if (typeof intentHost !== 'function') throw new Error('Expected menu intent host');

    await act(async () => {
      intentHost({ intentRequest: { intent: { type: 'submit-prompt', text: 'From menu' } } });
      await Promise.resolve();
    });

    expect(mocks.submitTurnForAdmission).toHaveBeenCalledWith({ text: 'From menu' });
    expect(mocks.sendUserMessage).not.toHaveBeenCalled();
    expect(mocks.replaceInput).toHaveBeenCalledWith('');
  });

  it.sequential('restores declined confirmation text on a microtask without clearing attachments', async () => {
    mocks.admissionConfirmation = {
      id: 'confirm-a',
      kind: 'large_uncached',
      turn: { text: 'Keep this prompt', images: [] },
      estimatedTokens: 72_000,
      options: {},
    };
    mocks.resolveAdmissionConfirmation.mockReturnValue({
      kind: 'declined',
      turn: { text: 'Keep this prompt', images: [] },
    });
    const services = createServices();

    await renderInAct(
      <App {...services} sessionId="session-1" terminalTitleBase="term2" generateId={() => 'session-2'} />,
    );

    await act(async () => {
      await mocks.bottomAreaProps.onLargeUncachedDecline();
      await Promise.resolve();
    });

    expect(mocks.resolveAdmissionConfirmation).toHaveBeenCalledWith('confirm-a', 'decline');
    expect(mocks.replaceInput).toHaveBeenCalledWith('Keep this prompt');
    expect(mocks.setImages).not.toHaveBeenCalled();
  });

  it.sequential('leaves composer state alone when an admission decision is stale', async () => {
    mocks.admissionConfirmation = {
      id: 'confirm-a',
      kind: 'surge',
      turn: { text: 'Old prompt', images: [] },
      reason: 'Input surge detected',
      options: {},
    };
    mocks.resolveAdmissionConfirmation.mockReturnValue({ kind: 'stale' });
    const services = createServices();

    await renderInAct(
      <App {...services} sessionId="session-1" terminalTitleBase="term2" generateId={() => 'session-2'} />,
    );

    await act(async () => {
      await mocks.bottomAreaProps.onSurgeApprove();
    });

    expect(mocks.resolveAdmissionConfirmation).toHaveBeenCalledWith('confirm-a', 'approve');
    expect(mocks.replaceInput).not.toHaveBeenCalled();
    expect(mocks.setImages).not.toHaveBeenCalled();
  });

  it.sequential('clears submitted composer text before a slow admission completes', async () => {
    let complete: (() => void) | undefined;
    mocks.submitTurnForAdmission.mockReturnValue({
      kind: 'submitted',
      completion: new Promise<void>((resolve) => {
        complete = resolve;
      }),
    });
    const services = createServices();

    await renderInAct(
      <App {...services} sessionId="session-1" terminalTitleBase="term2" generateId={() => 'session-2'} />,
    );
    const submission = mocks.bottomAreaProps.onSubmit({ text: 'Send this', images: [] });
    let settled = false;
    void submission.then(() => {
      settled = true;
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(mocks.replaceInput).toHaveBeenCalledWith('');
    expect(settled).toBe(false);
    complete?.();
    await submission;
  });

  it.sequential('clears matched approval composer state before a slow admission completes', async () => {
    let complete: (() => void) | undefined;
    mocks.admissionConfirmation = {
      id: 'confirm-a',
      kind: 'surge',
      turn: { text: 'Approved prompt', images: [] },
      reason: 'Input surge detected',
      options: {},
    };
    mocks.resolveAdmissionConfirmation.mockReturnValue({
      kind: 'submitted',
      completion: new Promise<void>((resolve) => {
        complete = resolve;
      }),
    });
    const services = createServices();

    await renderInAct(
      <App {...services} sessionId="session-1" terminalTitleBase="term2" generateId={() => 'session-2'} />,
    );
    const approval = mocks.bottomAreaProps.onSurgeApprove();
    await act(async () => {
      await Promise.resolve();
    });

    expect(mocks.replaceInput).toHaveBeenCalledWith('');
    expect(mocks.setImages).toHaveBeenCalledWith([]);
    complete?.();
    await approval;
  });

  it.sequential('preserves an admission completion rejection for the submit caller', async () => {
    const failure = new Error('send failed');
    let rejectCompletion: ((error: Error) => void) | undefined;
    mocks.submitTurnForAdmission.mockReturnValue({
      kind: 'submitted',
      completion: new Promise<void>((_resolve, reject) => {
        rejectCompletion = reject;
      }),
    });
    const services = createServices();

    await renderInAct(
      <App {...services} sessionId="session-1" terminalTitleBase="term2" generateId={() => 'session-2'} />,
    );
    const submission = mocks.bottomAreaProps.onSubmit({ text: 'Send this', images: [] });
    rejectCompletion?.(failure);
    await expect(submission).rejects.toThrow('send failed');
    expect(mocks.replaceInput).toHaveBeenCalledWith('');
  });

  // previewLargeUncachedInput builds and serializes the entire outgoing
  // history, so its cost grows with the conversation. It used to run once per
  // keystroke, synchronously during render, which blocked the event loop
  // between the key press and the repaint and read as typing lag in long
  // sessions.
  describe('large-uncached composer advisory', () => {
    const renderApp = async (services: ReturnType<typeof createServices>) =>
      renderInAct(<App {...services} sessionId="session-1" terminalTitleBase="term2" generateId={() => 'session-2'} />);

    const type = async (view: Awaited<ReturnType<typeof renderApp>>, services: any, text: string) => {
      for (let i = 1; i <= text.length; i++) {
        mocks.inputValue = text.slice(0, i);
        await rerenderInAct(
          view,
          <App {...services} sessionId="session-1" terminalTitleBase="term2" generateId={() => 'session-2'} />,
        );
      }
    };

    it.sequential('does not re-run the preview once per keystroke', async () => {
      vi.useFakeTimers();
      try {
        const services = createServices();
        const view = await renderApp(services);
        services.conversationService.previewLargeUncachedInput.mockClear();

        await type(view, services, 'refactor the planner');

        expect(services.conversationService.previewLargeUncachedInput).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it.sequential('runs the preview once after typing settles', async () => {
      vi.useFakeTimers();
      try {
        const services = createServices();
        const view = await renderApp(services);
        services.conversationService.previewLargeUncachedInput.mockClear();

        await type(view, services, 'refactor the planner');
        await act(async () => {
          await vi.advanceTimersByTimeAsync(500);
        });

        expect(services.conversationService.previewLargeUncachedInput).toHaveBeenCalledTimes(1);
        expect(services.conversationService.previewLargeUncachedInput).toHaveBeenCalledWith(
          { text: 'refactor the planner' },
          expect.any(Number),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it.sequential('clears a shown warning immediately when the composer is emptied', async () => {
      vi.useFakeTimers();
      try {
        const services = createServices();
        services.conversationService.previewLargeUncachedInput.mockReturnValue({
          action: 'warn',
          warningKey: 'k',
          reasons: ['idle_timeout'],
          estimatedTokens: 90_000,
          estimatedBytes: 360_000,
        });
        const view = await renderApp(services);

        await type(view, services, 'hi');
        await act(async () => {
          await vi.advanceTimersByTimeAsync(500);
        });
        expect(mocks.bottomAreaProps.largeUncachedWarning).not.toBeNull();

        // Submitting clears the composer; the advisory must not outlive the
        // text it described, so an empty composer bypasses the debounce.
        mocks.inputValue = '';
        await rerenderInAct(
          view,
          <App {...services} sessionId="session-1" terminalTitleBase="term2" generateId={() => 'session-2'} />,
        );

        expect(mocks.bottomAreaProps.largeUncachedWarning).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it.sequential('does not show or run preview when user types while agent is processing', async () => {
      vi.useFakeTimers();
      try {
        const services = createServices();
        services.conversationService.previewLargeUncachedInput.mockReturnValue({
          action: 'warn',
          warningKey: 'k',
          reasons: ['idle_timeout'],
          estimatedTokens: 90_000,
          estimatedBytes: 360_000,
        });
        mocks.conversationState.isProcessing = true;
        const view = await renderApp(services);
        services.conversationService.previewLargeUncachedInput.mockClear();

        await type(view, services, 'hello agent');
        await act(async () => {
          await vi.advanceTimersByTimeAsync(500);
        });

        expect(services.conversationService.previewLargeUncachedInput).not.toHaveBeenCalled();
        expect(mocks.bottomAreaProps.largeUncachedWarning).toBeNull();
      } finally {
        vi.useRealTimers();
        mocks.conversationState.isProcessing = false;
      }
    });

    it.sequential('clears warning immediately when agent starts processing', async () => {
      vi.useFakeTimers();
      try {
        const services = createServices();
        services.conversationService.previewLargeUncachedInput.mockReturnValue({
          action: 'warn',
          warningKey: 'k',
          reasons: ['idle_timeout'],
          estimatedTokens: 90_000,
          estimatedBytes: 360_000,
        });
        mocks.conversationState.isProcessing = false;
        const view = await renderApp(services);

        await type(view, services, 'hi');
        await act(async () => {
          await vi.advanceTimersByTimeAsync(500);
        });
        expect(mocks.bottomAreaProps.largeUncachedWarning).not.toBeNull();

        mocks.conversationState.isProcessing = true;
        await rerenderInAct(
          view,
          <App {...services} sessionId="session-1" terminalTitleBase="term2" generateId={() => 'session-2'} />,
        );

        expect(mocks.bottomAreaProps.largeUncachedWarning).toBeNull();
      } finally {
        vi.useRealTimers();
        mocks.conversationState.isProcessing = false;
      }
    });
  });

  describe('Mode switch confirmation flow', () => {
    it.sequential('handles mode switch confirmation by clearing conversation and enabling mode', async () => {
      const services = createServices();
      services.settingsService.get = vi.fn((key: string) => (key === 'app.planMode' ? true : false));
      services.settingsService.set = vi.fn();

      await renderInAct(
        <App {...services} sessionId="session-1" terminalTitleBase="term2" generateId={() => 'session-2'} />,
      );

      expect(mocks.requestModeSwitchConfirmCallback).not.toBeNull();

      // Trigger mode switch confirm request
      await act(async () => {
        mocks.requestModeSwitchConfirmCallback!({
          targetProfileId: 'builtin:lite',
          modeLabel: 'Lite',
          targetValue: true,
          enabledDetail: ' - using minimal prompt',
        });
      });

      expect(mocks.bottomAreaProps.pendingModeSwitch).toEqual({
        targetProfileId: 'builtin:lite',
        modeLabel: 'Lite',
        targetValue: true,
        enabledDetail: ' - using minimal prompt',
      });

      // Confirm
      await act(async () => {
        await mocks.bottomAreaProps.onModeSwitchConfirm();
      });

      expect(mocks.clearConversation).toHaveBeenCalled();
      expect(services.settingsService.set).toHaveBeenCalledWith('app.activeProfileId', 'builtin:lite');
      expect(mocks.addSystemMessage).toHaveBeenCalledWith('Welcome to term²! Type a message to start chatting.');
      expect(mocks.addSystemMessage).toHaveBeenCalledWith('Lite mode enabled - using minimal prompt');
      expect(mocks.bottomAreaProps.pendingModeSwitch).toBeNull();
    });

    it.sequential('handles mode switch decline without clearing conversation or changing settings', async () => {
      const services = createServices();
      services.settingsService.get = vi.fn(() => false);
      services.settingsService.set = vi.fn();

      await renderInAct(
        <App {...services} sessionId="session-1" terminalTitleBase="term2" generateId={() => 'session-2'} />,
      );

      // Trigger mode switch confirm request
      await act(async () => {
        mocks.requestModeSwitchConfirmCallback!({
          targetProfileId: 'builtin:orchestrator',
          modeLabel: 'Orchestrator',
          targetValue: true,
          enabledDetail: ' - tool-backed work must use subagents',
        });
      });

      expect(mocks.bottomAreaProps.pendingModeSwitch).not.toBeNull();

      // Decline
      await act(async () => {
        mocks.bottomAreaProps.onModeSwitchDecline();
      });

      expect(mocks.clearConversation).not.toHaveBeenCalled();
      expect(services.settingsService.set).not.toHaveBeenCalled();
      expect(mocks.bottomAreaProps.pendingModeSwitch).toBeNull();
    });

    it.sequential('sets terminal title with [...] prefix when background tasks are running', async () => {
      const services = createServices();
      mocks.setTerminalTitle.mockClear();
      mocks.conversationState.isProcessing = false;
      mocks.conversationState.backgroundTaskDetails = [{ kind: 'subagent', status: 'running', runId: 'sub-1' }];

      await renderInAct(
        <App {...services} sessionId="session-1" terminalTitleBase="term2" generateId={() => 'session-2'} />,
      );

      expect(mocks.setTerminalTitle).toHaveBeenCalledWith('[...] term2');
    });
  });
});
