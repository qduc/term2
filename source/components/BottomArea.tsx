import React, { FC, useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import ApprovalPrompt from './ApprovalPrompt.js';
import InputBox from './InputBox.js';
import StatusBar from './StatusBar.js';
import HandoffConfirmationPrompt from './HandoffConfirmationPrompt.js';
import LargeUncachedConfirmationPrompt from './LargeUncachedConfirmationPrompt.js';
import type { HandoffState } from '../app.js';
import type { SlashCommand } from '../slash-commands.js';
import type { SettingsService } from '../services/settings-service.js';
import type { LoggingService } from '../services/logging-service.js';
import type { HistoryService } from '../services/history-service.js';
import type { SSHInfo } from '../hooks/use-shell-mode.js';
import type { NormalizedUsage } from '../utils/token-usage.js';
import type { CodexRateLimitInfo } from '../services/conversation-events.js';
import type { PendingApproval } from '../contracts/conversation.js';
import type { UserTurn } from '../types/user-turn.js';
import type { UndoItem } from '../hooks/use-undo-selection.js';

export type BottomAreaProps = {
  pendingApproval: PendingApproval | null;
  waitingForApproval: boolean;
  waitingForRejectionReason: boolean;
  waitingForAskUserAnswer?: boolean;
  isProcessing: boolean;
  thinkingStartedAt?: number | null;
  toolCallStreamingInfo?: { toolName?: string; argumentCharCount: number } | null;
  isShellMode?: boolean;
  lastUsage?: NormalizedUsage | null;
  lastCodexRateLimit?: CodexRateLimitInfo | null;
  onSubmit: (value: UserTurn) => Promise<void>;
  slashCommands: SlashCommand[];
  settingsService: SettingsService;
  loggingService: LoggingService;
  historyService: HistoryService;
  onApprove: (answer?: string) => void;
  onReject: () => void;
  onTypeAnswer?: () => void;
  sshInfo?: SSHInfo;
  undoMenuRef?: React.MutableRefObject<{ open: (items: UndoItem[]) => void } | null>;
  onUndoSelect?: (item: UndoItem) => void;
  providersMenuRef?: React.MutableRefObject<{ open: () => void } | null>;
  onSettingChange?: (key: string, value: any) => void;
  onSystemMessage?: (text: string) => void;
  handoffState?: HandoffState | null;
  onHandoffConfirm?: () => void;
  onHandoffDecline?: () => void;
  onHandoffCancel?: () => void;
  largeUncachedWarning?: import('../services/large-uncached-input-guard.js').LargeUncachedInputDecision | null;
  pendingLargeUncachedTurn?: UserTurn | null;
  pendingLargeUncachedTokens?: number;
  onLargeUncachedApprove?: () => void;
  onLargeUncachedDecline?: () => void;
  onSlashTabComplete?: (command: SlashCommand) => boolean;
};

const BottomArea: FC<BottomAreaProps> = ({
  pendingApproval,
  waitingForApproval,
  waitingForRejectionReason,
  waitingForAskUserAnswer = false,
  isProcessing,
  thinkingStartedAt = null,
  toolCallStreamingInfo = null,
  isShellMode = false,
  onSubmit,
  slashCommands,
  settingsService,
  loggingService,
  historyService,
  onApprove,
  onReject,
  onTypeAnswer,
  sshInfo,
  lastUsage,
  lastCodexRateLimit,
  undoMenuRef,
  onUndoSelect,
  providersMenuRef,
  onSettingChange,
  onSystemMessage,
  handoffState,
  onHandoffConfirm,
  onHandoffDecline,
  onHandoffCancel,
  largeUncachedWarning,
  pendingLargeUncachedTurn,
  pendingLargeUncachedTokens = 0,
  onLargeUncachedApprove,
  onLargeUncachedDecline,
  onSlashTabComplete,
}) => {
  const [dotCount, setDotCount] = useState(1);
  const [thinkingElapsedSeconds, setThinkingElapsedSeconds] = useState(() =>
    thinkingStartedAt == null ? 0 : Math.max(0, Math.floor((Date.now() - thinkingStartedAt) / 1000)),
  );

  useEffect(() => {
    if (!isProcessing) {
      setDotCount(1);
      return;
    }

    const interval = setInterval(() => {
      setDotCount((prev) => (prev === 3 ? 1 : prev + 1));
    }, 800);

    return () => clearInterval(interval);
  }, [isProcessing]);

  useEffect(() => {
    if (thinkingStartedAt == null) {
      setThinkingElapsedSeconds(0);
      return;
    }

    const updateElapsed = () => {
      setThinkingElapsedSeconds(Math.max(0, Math.floor((Date.now() - thinkingStartedAt) / 1000)));
    };

    updateElapsed();
    const interval = setInterval(updateElapsed, 1000);
    return () => clearInterval(interval);
  }, [thinkingStartedAt]);

  const showHandoffConfirm = handoffState?.stage === 'confirm_model';
  const showLargeUncachedPrompt = Boolean(pendingLargeUncachedTurn);
  const showApprovalPrompt =
    !showHandoffConfirm &&
    !showLargeUncachedPrompt &&
    waitingForApproval &&
    !isProcessing &&
    !waitingForRejectionReason &&
    pendingApproval &&
    !waitingForAskUserAnswer;
  const showInput =
    !showHandoffConfirm &&
    !showLargeUncachedPrompt &&
    ((!isProcessing && !waitingForApproval) || waitingForRejectionReason || waitingForAskUserAnswer);

  return (
    <Box flexDirection="column" width="100%">
      <Box flexDirection="column" marginTop={1}>
        {showHandoffConfirm ? (
          <HandoffConfirmationPrompt
            onConfirm={onHandoffConfirm || (() => {})}
            onDecline={onHandoffDecline || (() => {})}
            onCancel={onHandoffCancel || (() => {})}
          />
        ) : showLargeUncachedPrompt ? (
          <LargeUncachedConfirmationPrompt
            usage={lastUsage}
            onConfirm={onLargeUncachedApprove || (() => {})}
            onDecline={onLargeUncachedDecline || (() => {})}
          />
        ) : showApprovalPrompt ? (
          <ApprovalPrompt
            approval={pendingApproval}
            onApprove={onApprove}
            onReject={onReject}
            onTypeAnswer={onTypeAnswer}
          />
        ) : isProcessing && thinkingStartedAt != null ? (
          <Text color="#64748b">Thinking... {thinkingElapsedSeconds}s</Text>
        ) : isProcessing && toolCallStreamingInfo ? (
          <Text color="#64748b">
            Calling {toolCallStreamingInfo.toolName ? <Text bold>{toolCallStreamingInfo.toolName}</Text> : 'tool'} (
            {toolCallStreamingInfo.argumentCharCount} chars){'.'.repeat(dotCount)}
          </Text>
        ) : isProcessing ? (
          <Text color="#64748b">processing{'.'.repeat(dotCount)}</Text>
        ) : showInput ? (
          <InputBox
            onSubmit={onSubmit}
            slashCommands={slashCommands}
            waitingForRejectionReason={waitingForRejectionReason}
            isShellMode={isShellMode}
            settingsService={settingsService}
            loggingService={loggingService}
            historyService={historyService}
            undoMenuRef={undoMenuRef}
            onUndoSelect={onUndoSelect}
            providersMenuRef={providersMenuRef}
            onSettingChange={onSettingChange}
            onSystemMessage={onSystemMessage}
            onSlashTabComplete={onSlashTabComplete}
            promptLabel={
              waitingForAskUserAnswer
                ? 'Answer: '
                : handoffState?.stage === 'entering_message'
                ? 'Handoff message (enter to use default message): '
                : undefined
            }
            allowEmptySubmit={handoffState?.stage === 'entering_message' || waitingForAskUserAnswer}
          />
        ) : null}
      </Box>

      <StatusBar
        settingsService={settingsService}
        isShellMode={isShellMode}
        sshInfo={sshInfo}
        lastUsage={lastUsage}
        lastCodexRateLimit={lastCodexRateLimit}
        largeUncachedWarning={largeUncachedWarning}
        hasPendingConfirmation={pendingLargeUncachedTurn !== null && pendingLargeUncachedTokens > 0}
        pendingLargeUncachedTokens={pendingLargeUncachedTokens}
      />
    </Box>
  );
};

export default BottomArea;
