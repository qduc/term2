// @ts-ignore
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import React from 'react';
import { it, expect, vi, beforeEach } from 'vitest';
import App from './app.js';
import { renderInAct } from './test-helpers/ink-testing.js';

const mocks = vi.hoisted(() => ({
  bottomAreaProps: null as any,
  goToPreviousQuestion: vi.fn(),
  goToNextQuestion: vi.fn(),
  setInput: vi.fn(),
  setMode: vi.fn(),
  setTriggerIndex: vi.fn(),
  setImages: vi.fn(),
  toggleShellMode: vi.fn(),
  handleShellSubmit: vi.fn(),
  cycleAppModes: vi.fn(),
  applyRuntimeSetting: vi.fn(),
  sendUserMessage: vi.fn(),
  handleApprovalDecision: vi.fn(),
  onTypeAnswer: vi.fn(),
  clearConversation: vi.fn(),
  stopProcessing: vi.fn(),
  undoLastUserMessage: vi.fn(),
  getUserMessages: vi.fn(() => []),
  undoToUserMessage: vi.fn(),
  setModel: vi.fn(),
  setReasoningEffort: vi.fn(),
  setTemperature: vi.fn(),
  addSystemMessage: vi.fn(),
  addShellMessage: vi.fn(),
  getSubagentUsage: vi.fn(),
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
    waitingForApproval: false,
    waitingForRejectionReason: false,
    waitingForAskUserAnswer: false,
    currentAskUserQuestionIndex: 0,
    setWaitingForRejectionReason: vi.fn(),
    setWaitingForAskUserAnswer: vi.fn(),
    isProcessing: false,
    thinkingStartedAt: null,
    toolCallStreamingInfo: null,
    sendUserMessage: mocks.sendUserMessage,
    handleApprovalDecision: mocks.handleApprovalDecision,
    onTypeAnswer: mocks.onTypeAnswer,
    clearConversation: mocks.clearConversation,
    stopProcessing: mocks.stopProcessing,
    undoLastUserMessage: mocks.undoLastUserMessage,
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
    flushShellHistory: vi.fn(),
  }),
}));

vi.mock('./hooks/use-app-commands.js', () => ({
  useAppCommands: () => ({
    slashCommands: [],
    cycleAppModes: mocks.cycleAppModes,
    togglePlanMode: vi.fn(),
  }),
}));

vi.mock('./services/notification-service.js', () => ({
  sendNotification: vi.fn(),
}));

vi.mock('./utils/ai/model-provider-arg.js', () => ({
  parseModelProviderArg: vi.fn(() => ({})),
}));

beforeEach(() => {
  mocks.bottomAreaProps = null;
  mocks.goToPreviousQuestion.mockReset();
  mocks.goToNextQuestion.mockReset();
});

it.sequential('App wires ask_user navigation into BottomArea', async () => {
  const conversationService = {
    sessionId: 'session-1',
    previewLargeUncachedInput: vi.fn(() => ({ action: 'allow' })),
    previewInputSurge: vi.fn(() => ({ action: 'allow' })),
    setRetryCallback: vi.fn(),
    abort: vi.fn(),
    undoNUserTurns: vi.fn(),
    resetWithNewId: vi.fn(),
    queueModeNotice: vi.fn(),
    addShellContext: vi.fn(),
  } as any;

  const settingsService = {
    get: vi.fn(() => false),
    set: vi.fn(),
    onChange: vi.fn(() => () => {}),
  } as any;

  const historyService = {
    getMessages: vi.fn(() => []),
    getTurns: vi.fn(() => []),
    addMessage: vi.fn(),
    clear: vi.fn(),
  } as any;

  const loggingService = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    security: vi.fn(),
    setCorrelationId: vi.fn(),
    getCorrelationId: vi.fn(() => undefined),
    clearCorrelationId: vi.fn(),
  } as any;

  await renderInAct(
    <App
      conversationService={conversationService}
      settingsService={settingsService}
      historyService={historyService}
      loggingService={loggingService}
      sessionId="session-1"
      generateId={() => 'session-2'}
    />,
  );

  expect(mocks.bottomAreaProps?.onNavigateQuestion).toBeTypeOf('function');

  mocks.bottomAreaProps.onNavigateQuestion('prev');
  expect(mocks.goToPreviousQuestion).toHaveBeenCalledTimes(1);
  expect(mocks.goToNextQuestion).not.toHaveBeenCalled();

  mocks.bottomAreaProps.onNavigateQuestion('next');
  expect(mocks.goToNextQuestion).toHaveBeenCalledTimes(1);
});
