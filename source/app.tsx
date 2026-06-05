import React, { FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { sendNotification } from './services/notification-service.js';
import { useInputActions, useInputState } from './context/InputContext.js';
import { parseModelProviderArg } from './utils/model-provider-arg.js';

import { Box, useApp, useInput, useStdout } from 'ink';
import { useConversation } from './hooks/use-conversation.js';
import MessageList, {
  EMPTY_RESTORED_STATIC_MESSAGE_IDS,
  MESSAGE_HORIZONTAL_PADDING,
} from './components/MessageList.js';
import BottomArea from './components/BottomArea.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import type { ConversationService } from './services/conversation-service.js';
import type { SettingsService } from './services/settings-service.js';
import type { HistoryService } from './services/history-service.js';
import type { LoggingService } from './services/logging-service.js';
import { ISSHService } from './services/service-interfaces.js';
import { useSetting } from './hooks/use-setting.js';
import { parseInput } from './utils/input-parser.js';
import { useRuntimeSettings } from './hooks/use-runtime-settings.js';
import { useShellMode, SSHInfo } from './hooks/use-shell-mode.js';
import { useAppCommands } from './hooks/use-app-commands.js';
import { hasUserTurnContent, type UserTurn } from './types/user-turn.js';
import { createUsageAccumulator, formatSessionUsageBreakdown, type UsageAccumulator } from './utils/token-usage.js';
import type { Message } from './hooks/use-conversation.js';
import type { UndoItem } from './hooks/use-undo-selection.js';
import { resolveSlashCommand } from './slash-commands.js';
import { getSerializedInputBytes } from './services/large-uncached-input-guard.js';

const estimateLastTurnTokens = (turn: UserTurn): number => {
  const images = turn.images ?? [];
  let inputItem: unknown;
  if (images.length === 0) {
    inputItem = turn.text ?? '';
  } else {
    const content: any[] = [];
    if (turn.text) {
      content.push({ type: 'input_text', text: turn.text });
    }
    for (const image of images) {
      content.push({
        type: 'input_image',
        image: `data:${image.mimeType};base64,${image.data}`,
        detail: 'auto',
      });
    }
    inputItem = { role: 'user', type: 'message', content };
  }
  const bytes = getSerializedInputBytes(inputItem);
  return Math.ceil(bytes / 4);
};

interface AppProps {
  conversationService: ConversationService;
  settingsService: SettingsService;
  historyService: HistoryService;
  loggingService: LoggingService;
  sshInfo?: SSHInfo;
  sshService?: ISSHService;
  usageAccumulator?: UsageAccumulator;
  subagentUsageAccumulator?: UsageAccumulator;
  onPrintUsage?: () => void;
  onExitUsage?: () => void;
  sessionId: string;
  initialMessages?: Message[];
  restoredStaticMessageIds?: string[];
  logWriter?: { append: (event: any) => void };
  onRotateWriter?: (newSessionId: string) => void;
  generateId: () => string;
  onSessionIdChange?: (newId: string, createdAt: string) => void;
  onHasConversationContent?: (hasContent: boolean) => void;
}

export const appendStartupBannerId = (ids: string[]): string[] => [...ids, `startup-banner-${ids.length}`];

export const hasConversationContent = (messages: Message[]): boolean => messages.some((msg) => msg.sender !== 'system');

export const TERMINAL_REDRAW_CLEAR = '\u001B[2J\u001B[3J\u001B[H';

type TerminalWriter = {
  write: (value: string) => unknown;
};

export const clearTerminalForRedraw = (stdout: TerminalWriter): void => {
  stdout.write(TERMINAL_REDRAW_CLEAR);
};

type ScheduleCallback = (callback: () => void, delay: number) => unknown;

export const scheduleExitSideEffects = (
  _messages: Message[],
  onExitUsage?: () => void,
  schedule: ScheduleCallback = setTimeout,
): void => {
  schedule(() => {
    onExitUsage?.();
  }, 0);
};

export type HandoffStage = 'entering_message' | 'confirm_model' | 'selecting_model';
export interface HandoffState {
  capturedText: string;
  stage: HandoffStage;
  handoffMessage?: string;
}

const App: FC<AppProps> = ({
  conversationService,
  settingsService,
  historyService,
  loggingService,
  sshInfo,
  sshService,
  usageAccumulator,
  subagentUsageAccumulator,
  onPrintUsage,
  onExitUsage,
  sessionId: initialSessionId,
  initialMessages = [],
  restoredStaticMessageIds = EMPTY_RESTORED_STATIC_MESSAGE_IDS,
  logWriter,
  onRotateWriter,
  generateId,
  onSessionIdChange,
  onHasConversationContent,
}) => {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const { setInput, setMode, setTriggerIndex, setImages } = useInputActions();
  const { input, mode, images } = useInputState();
  const [handoffState, setHandoffState] = useState<HandoffState | null>(null);
  const [pendingLargeUncachedTurn, setPendingLargeUncachedTurn] = useState<UserTurn | null>(null);
  const [pendingLargeUncachedTokens, setPendingLargeUncachedTokens] = useState<number>(0);
  const undoMenuRef = useRef<{ open: (items: UndoItem[]) => void } | null>(null);
  const providersMenuRef = useRef<{ open: () => void } | null>(null);
  const [messageListEpoch, setMessageListEpoch] = useState(0);
  const [startupBannerIds, setStartupBannerIds] = useState(['startup-banner-0']);
  const liteMode = useSetting<boolean>(settingsService, 'app.liteMode') ?? false;
  const sessionUsage = useMemo(() => usageAccumulator ?? createUsageAccumulator(), [usageAccumulator]);
  const subagentUsage = useMemo(() => subagentUsageAccumulator ?? createUsageAccumulator(), [subagentUsageAccumulator]);
  const [sessionId, setSessionId] = useState(initialSessionId);
  const handleClearConversationRef = useRef<(() => Promise<void>) | null>(null);

  // ── Focus tracking ──────────────────────────────────────────────────────────
  // Default to "focused" so we stay silent when focus state is unknown.
  // DEC mode ?1004 focus-reporting sends ESC[I (focus in) / ESC[O (focus out).
  const focusedRef = useRef(true);

  // Enable terminal focus-reporting on mount; disable on unmount.
  useEffect(() => {
    stdout.write('\x1b[?1004h');
    return () => {
      stdout.write('\x1b[?1004l');
    };
  }, [stdout]);

  // Track focus state from CSI focus-in/out sequences delivered by Ink.
  useInput((rawInput: string) => {
    loggingService.debug('Received terminal raw input sequence', {
      rawInput: JSON.stringify(rawInput),
      length: rawInput.length,
    });

    if (rawInput === '\x1b[I' || rawInput === '[I') {
      loggingService.debug('Terminal focus changed to IN (focused)', {
        prevFocused: focusedRef.current,
      });
      focusedRef.current = true;
      return;
    }
    if (rawInput === '\x1b[O' || rawInput === '[O') {
      loggingService.debug('Terminal focus changed to OUT (unfocused)', {
        prevFocused: focusedRef.current,
      });
      focusedRef.current = false;
      return;
    }

    // Heuristic: If we receive any key input from the user while marked as unfocused,
    // they must have focused the window to type.
    if (!focusedRef.current) {
      loggingService.debug('Terminal focus restored via user input heuristic', {
        rawInput: JSON.stringify(rawInput),
      });
      focusedRef.current = true;
    }
  });

  // Notifier passed into useConversation to fire desktop notifications when
  // the terminal is unfocused.
  const notifier = useMemo(
    () => ({
      approvalNeeded() {
        loggingService.debug('notifier.approvalNeeded check', {
          focused: focusedRef.current,
          appNotifications: settingsService.get<boolean>('app.notifications'),
          appNotificationsOnApproval: settingsService.get<boolean>('app.notificationsOnApproval'),
        });
        if (focusedRef.current) return;
        if (!settingsService.get<boolean>('app.notifications')) return;
        if (!settingsService.get<boolean>('app.notificationsOnApproval')) return;
        sendNotification('Approval needed', 'Agent is waiting for your approval', { logger: loggingService });
      },
      turnComplete() {
        loggingService.debug('notifier.turnComplete check', {
          focused: focusedRef.current,
          appNotifications: settingsService.get<boolean>('app.notifications'),
          appNotificationsOnComplete: settingsService.get<boolean>('app.notificationsOnComplete'),
        });
        if (focusedRef.current) return;
        if (!settingsService.get<boolean>('app.notifications')) return;
        if (!settingsService.get<boolean>('app.notificationsOnComplete')) return;
        sendNotification('Response ready', 'Agent has finished responding', { logger: loggingService });
      },
    }),
    [settingsService, loggingService],
  );

  // Compute largeUncachedWarning in real-time as the user types
  const largeUncachedWarning = useMemo(() => {
    if (!input || mode !== 'text' || input.startsWith('/')) return null;
    const preview = conversationService.previewLargeUncachedInput({ text: input }, Date.now());
    if (preview.action === 'warn') {
      return {
        ...preview,
        estimatedTokens: estimateLastTurnTokens({ text: input, images }),
      };
    }
    return null;
  }, [input, mode, conversationService, images]);

  const {
    messages,
    lastUsage,
    lastCodexRateLimit,
    pendingApproval,
    waitingForApproval,
    waitingForRejectionReason,
    setWaitingForRejectionReason,
    waitingForAskUserAnswer,
    setWaitingForAskUserAnswer,
    isProcessing,
    thinkingStartedAt,
    toolCallStreamingInfo,
    sendUserMessage,
    handleApprovalDecision,
    onTypeAnswer,
    clearConversation,
    stopProcessing,
    undoLastUserMessage,
    getUserMessages,
    undoToUserMessage,
    setModel,
    setReasoningEffort,
    addSystemMessage,
    setTemperature,
    addShellMessage,
    getSubagentUsage,
  } = useConversation({
    conversationService,
    loggingService,
    usageAccumulator: sessionUsage,
    subagentUsageAccumulator: subagentUsage,
    initialMessages,
    sessionId,
    onClear: useCallback(async () => {
      if (handleClearConversationRef.current) {
        await handleClearConversationRef.current();
      }
    }, []),
    settingsService,
    onRestoreInput: setInput,
    logWriter,
    notifier,
  });

  // Notify cli.tsx when the conversation has content so it can decide whether
  // to show the "To resume this conversation" message.
  useEffect(() => {
    onHasConversationContent?.(hasConversationContent(messages));
  }, [messages, onHasConversationContent]);

  const handleClearConversation = useCallback(async () => {
    const newId = generateId();
    const newCreatedAt = new Date().toISOString();
    if (onRotateWriter) {
      onRotateWriter(newId);
    }
    conversationService.resetWithNewId(newId);
    setSessionId(newId);
    if (onSessionIdChange) {
      onSessionIdChange(newId, newCreatedAt);
    }
  }, [generateId, conversationService, onSessionIdChange, onRotateWriter]);

  useEffect(() => {
    handleClearConversationRef.current = handleClearConversation;
  }, [handleClearConversation]);

  useEffect(() => {
    conversationService.setRetryCallback(() => addSystemMessage('Retrying due to upstream error...'));
  }, [conversationService, addSystemMessage]);

  useEffect(() => {
    if (handoffState?.stage === 'selecting_model' && mode === 'text') {
      const handoffMsg = handoffState.handoffMessage || 'Implement this';
      const text = handoffState.capturedText;
      setHandoffState(null);
      setInput('');
      void sendUserMessage({ text: `${handoffMsg}:\n\n${text}` });
    }
  }, [mode, sendUserMessage, setInput, handoffState]);

  const applyRuntimeSetting = useRuntimeSettings({
    setModel,
    setReasoningEffort,
    setTemperature,
    conversationService,
    settingsService,
  });

  const { isShellMode, toggleShellMode, handleShellSubmit } = useShellMode({
    settingsService,
    conversationService,
    addShellMessage,
    setInput,
    liteMode,
    sshInfo,
    sshService,
  });

  const refreshStartupBanner = useCallback(() => {
    setStartupBannerIds(appendStartupBannerId);
  }, []);

  const clearConversationAndRefreshBanner = useCallback(async () => {
    onPrintUsage?.();
    await clearConversation();
    refreshStartupBanner();
  }, [clearConversation, onPrintUsage, refreshStartupBanner]);

  const redrawMessageList = useCallback(() => {
    clearTerminalForRedraw(stdout);
    setMessageListEpoch((epoch) => epoch + 1);
  }, [stdout]);

  const getSessionUsage = useCallback(
    () => formatSessionUsageBreakdown(sessionUsage.get(), getSubagentUsage()),
    [sessionUsage, getSubagentUsage],
  );

  const exitWithUsage = useCallback(() => {
    exit();
    onExitUsage?.();
  }, [exit, onExitUsage]);

  const handleHandoffConfirm = useCallback(async () => {
    await clearConversationAndRefreshBanner();
    setHandoffState((prev) => (prev ? { ...prev, stage: 'selecting_model' } : null));
    setInput('/model ');
    setMode('model_selection');
    setTriggerIndex('/model '.length);
  }, [clearConversationAndRefreshBanner, setInput, setMode, setTriggerIndex]);

  const handleHandoffDecline = useCallback(async () => {
    const text = handoffState?.capturedText;
    const handoffMsg = handoffState?.handoffMessage || 'Implement this';
    await clearConversationAndRefreshBanner();
    setHandoffState(null);
    setInput('');
    if (text) {
      await sendUserMessage({ text: `${handoffMsg}:\n\n${text}` });
    }
  }, [handoffState, clearConversationAndRefreshBanner, sendUserMessage, setInput]);

  const handleHandoffCancel = useCallback(() => {
    setHandoffState(null);
    setInput('');
    addSystemMessage('Handoff cancelled');
  }, [addSystemMessage, setInput]);

  const handleLargeUncachedApprove = useCallback(async () => {
    const turn = pendingLargeUncachedTurn;
    if (!turn) return;
    setPendingLargeUncachedTurn(null);
    setPendingLargeUncachedTokens(0);
    setImages([]);
    historyService.addMessage(turn);
    setInput('');
    await sendUserMessage(turn);
  }, [pendingLargeUncachedTurn, historyService, sendUserMessage, setImages, setInput]);

  const handleLargeUncachedDecline = useCallback(() => {
    const turn = pendingLargeUncachedTurn;
    if (!turn) return;
    setPendingLargeUncachedTurn(null);
    setPendingLargeUncachedTokens(0);
    // Restore the text to the input box
    queueMicrotask(() => setInput(turn.text || ''));
  }, [pendingLargeUncachedTurn, setInput]);

  const handleHandoff = useCallback((capturedText: string) => {
    setHandoffState({ capturedText, stage: 'entering_message' });
  }, []);

  const { slashCommands, cycleAppModes } = useAppCommands({
    settingsService,
    addSystemMessage,
    applyRuntimeSetting,
    setInput,
    clearConversation: clearConversationAndRefreshBanner,
    getSessionUsage,
    exit: exitWithUsage,
    messages,
    setModel,
    undoLastUserMessage,
    onUndo: redrawMessageList,
    openUndoMenu: () => {
      const userMessages = getUserMessages().map((m) => ({ uiIndex: m.uiIndex, text: m.text }));
      if (userMessages.length === 0) {
        addSystemMessage('Nothing to undo.');
        return;
      }
      if (undoMenuRef.current) {
        undoMenuRef.current.open(userMessages);
      }
    },
    openProvidersMenu: () => {
      if (providersMenuRef.current) {
        providersMenuRef.current.open();
      }
    },
    onHandoff: handleHandoff,
    sendUserMessage,
    listUserTurns: () => conversationService.listUserTurns(),
  });

  const handleUndoSelect = useCallback(
    (item: UndoItem) => {
      const text = undoToUserMessage(item.uiIndex);
      if (text !== null) {
        redrawMessageList();
        setInput(text);
      }
    },
    [undoToUserMessage, redrawMessageList, setInput],
  );

  // Handle Ctrl+C to exit immediately
  useInput((_input: string, key) => {
    if (key.ctrl && _input === 'c') {
      exitWithUsage();
    }
  });

  // Handle Esc to stop processing or cancel rejection reason or handoff
  useInput((_input: string, key) => {
    if (key.escape && waitingForAskUserAnswer) {
      setWaitingForAskUserAnswer(false);
      setInput('');
      return;
    }

    if (key.escape && waitingForRejectionReason) {
      // Cancel rejection reason input and return to approval prompt
      setWaitingForRejectionReason(false);
      setInput('');
      return;
    }

    if (key.escape && (isProcessing || waitingForApproval)) {
      stopProcessing();
      addSystemMessage('Stopped');
      setWaitingForRejectionReason(false);
      return;
    }

    if (key.escape && handoffState && handoffState.stage === 'entering_message') {
      handleHandoffCancel();
      return;
    }
  });

  const handleApprove = useCallback(
    async (answer?: string) => {
      await handleApprovalDecision('y', undefined, answer);
    },
    [handleApprovalDecision],
  );

  const handleReject = useCallback(() => {
    setWaitingForRejectionReason(true);
  }, [setWaitingForRejectionReason]);

  // Switch between Standard and Plan modes with Shift+Tab
  useInput((input: string, key) => {
    const isShiftTab = (key.shift && key.tab) || input === '\u001b[Z';
    if (!isShiftTab) return;

    if (pendingLargeUncachedTurn) {
      return;
    }

    if (liteMode) {
      toggleShellMode();
      return;
    }

    cycleAppModes();
  });

  const handleSubmit = async (turn: UserTurn): Promise<void> => {
    const value = turn.text;
    const hasImages = Boolean(turn.images?.length);
    if (waitingForAskUserAnswer) {
      setWaitingForAskUserAnswer(false);
      setInput('');
      await handleApprovalDecision('y', undefined, value);
      return;
    }
    if (!hasUserTurnContent(turn) && handoffState?.stage !== 'entering_message') return;

    // If waiting for rejection reason, handle it
    if (waitingForRejectionReason) {
      setWaitingForRejectionReason(false);
      setInput('');
      await handleApprovalDecision('n', value);
      return;
    }

    // If waiting for approval, ignore text input (handled by useInput)
    if (waitingForApproval) return;

    if (liteMode && isShellMode && !hasImages) {
      await handleShellSubmit(value);
      return;
    }

    // Handoff flow interception
    if (handoffState) {
      if (handoffState.stage === 'entering_message') {
        const handoffMessage = value.trim() || 'Implement this';
        setHandoffState({
          ...handoffState,
          handoffMessage,
          stage: 'confirm_model',
        });
        setInput('');
        return;
      }
      if (handoffState.stage === 'selecting_model') {
        // Model was selected from popup → model text submitted as message
        const parsedInput = parseInput(value);
        const modelArg = parsedInput.type === 'slash-command' ? parsedInput.args : value;
        const { modelId, provider } = parseModelProviderArg(modelArg);
        if (modelId) {
          settingsService.set('agent.model', modelId);
          if (provider) {
            settingsService.set('agent.provider', provider);
            applyRuntimeSetting('agent.provider', provider);
          }
          applyRuntimeSetting('agent.model', modelId);
          setModel(modelId);
        }
        const text = handoffState.capturedText;
        const handoffMsg = handoffState.handoffMessage || 'Implement this';
        setHandoffState(null);
        setInput('');
        await sendUserMessage({ text: `${handoffMsg}:\n\n${text}` });
        return;
      }
    }

    // Parse the input to determine what to do
    const parsed = parseInput(value);

    switch (parsed.type) {
      case 'slash-command': {
        if (hasImages) {
          break;
        }
        // Find matching command
        const command = resolveSlashCommand(slashCommands, parsed.commandName);
        if (command) {
          // Execute the command
          const shouldClearInput = command.action(parsed.args || undefined);

          // Clear input unless command returned false
          if (shouldClearInput !== false) {
            setInput('');
          }
          return;
        }
        // Command not found, fall through to send as message
        break;
      }

      case 'message':
        // Regular message, send to AI agent
        {
          const preview = conversationService.previewLargeUncachedInput(turn, Date.now());

          if (preview.action === 'warn') {
            setPendingLargeUncachedTurn(turn);
            setPendingLargeUncachedTokens(estimateLastTurnTokens(turn));
            loggingService.debug('Large uncached input warning shown', {
              eventType: 'large_uncached_input_warning_shown',
              category: 'provider',
              estimatedTokens: preview.estimatedTokens,
              estimatedBytes: preview.estimatedBytes,
              reasons: preview.reasons,
            });
            return;
          }
        }
        historyService.addMessage(turn);
        setInput('');
        await sendUserMessage(turn);
        return;
    }

    // Fallback: unknown slash command, send as message
    {
      const preview = conversationService.previewLargeUncachedInput(turn, Date.now());

      if (preview.action === 'warn') {
        setPendingLargeUncachedTurn(turn);
        setPendingLargeUncachedTokens(estimateLastTurnTokens(turn));
        loggingService.debug('Large uncached input warning shown', {
          eventType: 'large_uncached_input_warning_shown',
          category: 'provider',
          estimatedTokens: preview.estimatedTokens,
          estimatedBytes: preview.estimatedBytes,
          reasons: preview.reasons,
        });
        return;
      }
    }
    setInput('');
    await sendUserMessage(turn);
  };

  return (
    <ErrorBoundary loggingService={loggingService}>
      <Box flexDirection="column" flexGrow={1}>
        {/* Main content area grows to fill available vertical space */}
        <Box flexDirection="column" flexGrow={1}>
          <MessageList
            key={messageListEpoch}
            messages={messages}
            bannerItems={startupBannerIds}
            settingsService={settingsService}
            isShellMode={isShellMode}
            restoredStaticMessageIds={restoredStaticMessageIds}
          />
        </Box>

        {/* Fixed bottom area for input / status */}
        <Box paddingX={MESSAGE_HORIZONTAL_PADDING}>
          <BottomArea
            pendingApproval={pendingApproval}
            waitingForApproval={waitingForApproval}
            waitingForRejectionReason={waitingForRejectionReason}
            waitingForAskUserAnswer={waitingForAskUserAnswer}
            isProcessing={isProcessing}
            thinkingStartedAt={thinkingStartedAt}
            toolCallStreamingInfo={toolCallStreamingInfo}
            isShellMode={isShellMode}
            lastUsage={lastUsage}
            onSubmit={handleSubmit}
            slashCommands={slashCommands}
            settingsService={settingsService}
            loggingService={loggingService}
            historyService={historyService}
            onApprove={handleApprove}
            onReject={handleReject}
            onTypeAnswer={onTypeAnswer}
            sshInfo={sshInfo}
            lastCodexRateLimit={lastCodexRateLimit}
            undoMenuRef={undoMenuRef}
            onUndoSelect={handleUndoSelect}
            providersMenuRef={providersMenuRef}
            onSettingChange={applyRuntimeSetting}
            onSystemMessage={addSystemMessage}
            handoffState={handoffState}
            onHandoffConfirm={handleHandoffConfirm}
            onHandoffDecline={handleHandoffDecline}
            onHandoffCancel={handleHandoffCancel}
            largeUncachedWarning={largeUncachedWarning}
            pendingLargeUncachedTurn={pendingLargeUncachedTurn}
            pendingLargeUncachedTokens={pendingLargeUncachedTokens}
            onLargeUncachedApprove={handleLargeUncachedApprove}
            onLargeUncachedDecline={handleLargeUncachedDecline}
            onSlashTabComplete={(command) => {
              if (command.name === 'undo') {
                const userMessages = getUserMessages().map((m) => ({ uiIndex: m.uiIndex, text: m.text }));
                if (userMessages.length === 0) {
                  addSystemMessage('Nothing to undo.');
                  return true;
                }
                if (undoMenuRef.current) {
                  undoMenuRef.current.open(userMessages);
                }
                return true;
              }
              return false;
            }}
          />
        </Box>
      </Box>
    </ErrorBoundary>
  );
};

export default App;
