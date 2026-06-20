import React, { FC, useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import ApprovalPrompt from '../prompt/ApprovalPrompt.js';
import InputBox from '../InputBox.js';
import StatusBar from './StatusBar.js';
import HandoffConfirmationPrompt from '../prompt/HandoffConfirmationPrompt.js';
import StandardModeConfirmationPrompt from '../prompt/StandardModeConfirmationPrompt.js';
import LargeUncachedConfirmationPrompt from '../prompt/LargeUncachedConfirmationPrompt.js';
import InputSurgeConfirmationPrompt from '../prompt/InputSurgeConfirmationPrompt.js';
import type { HandoffState } from '../../hooks/use-handoff-flow.js';
import type { SlashCommand } from '../../slash-commands.js';
import type { SettingsService } from '../../services/settings/settings-service.js';
import type { LoggingService } from '../../services/logging/logging-service.js';
import type { HistoryService } from '../../services/history-service.js';
import type { SSHInfo } from '../../hooks/use-shell-mode.js';
import type { NormalizedUsage } from '../../utils/ai/token-usage.js';
import type { CodexRateLimitInfo } from '../../services/conversation/conversation-events.js';
import type { PendingApproval } from '../../contracts/conversation.js';
import type { UserTurn } from '../../types/user-turn.js';
import type { UndoItem } from '../../hooks/use-undo-selection.js';
import type { SkillsService } from '../../services/skills/skills-service.js';

export type BottomAreaProps = {
  pendingApproval: PendingApproval | null;
  waitingForApproval: boolean;
  waitingForRejectionReason: boolean;
  waitingForAskUserAnswer?: boolean;
  currentAskUserQuestionIndex?: number;
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
  onNavigateQuestion?: (direction: 'prev' | 'next') => void;
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
  onStandardModeConfirm?: () => void;
  onStandardModeDecline?: () => void;
  largeUncachedWarning?: import('../../services/large-uncached-input-guard.js').LargeUncachedInputDecision | null;
  pendingLargeUncachedTurn?: UserTurn | null;
  pendingLargeUncachedTokens?: number;
  onLargeUncachedApprove?: () => void;
  onLargeUncachedDecline?: () => void;
  pendingSurgeTurn?: UserTurn | null;
  pendingSurgeReason?: string;
  onSurgeApprove?: () => void;
  onSurgeDecline?: () => void;
  onSlashTabComplete?: (command: SlashCommand) => boolean;
  skillsService?: SkillsService;
};

const BottomArea: FC<BottomAreaProps> = ({
  pendingApproval,
  waitingForApproval,
  waitingForRejectionReason,
  waitingForAskUserAnswer = false,
  currentAskUserQuestionIndex = 0,
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
  onNavigateQuestion,
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
  onStandardModeConfirm,
  onStandardModeDecline,
  largeUncachedWarning,
  pendingLargeUncachedTurn,
  pendingLargeUncachedTokens = 0,
  onLargeUncachedApprove,
  onLargeUncachedDecline,
  pendingSurgeTurn,
  pendingSurgeReason = '',
  onSurgeApprove,
  onSurgeDecline,
  onSlashTabComplete,
  skillsService,
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
  const showStandardModeConfirm = handoffState?.stage === 'confirm_standard_mode';
  const showSurgePrompt = Boolean(pendingSurgeTurn);
  const showLargeUncachedPrompt = Boolean(pendingLargeUncachedTurn);
  const showApprovalPrompt =
    !showHandoffConfirm &&
    !showStandardModeConfirm &&
    !showLargeUncachedPrompt &&
    !showSurgePrompt &&
    waitingForApproval &&
    !isProcessing &&
    !waitingForRejectionReason &&
    pendingApproval;
  const showInput =
    !showHandoffConfirm &&
    !showStandardModeConfirm &&
    !showLargeUncachedPrompt &&
    !showSurgePrompt &&
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
        ) : showStandardModeConfirm ? (
          <StandardModeConfirmationPrompt
            onConfirm={onStandardModeConfirm || (() => {})}
            onDecline={onStandardModeDecline || (() => {})}
            onCancel={onHandoffCancel || (() => {})}
          />
        ) : showSurgePrompt ? (
          <InputSurgeConfirmationPrompt
            reason={pendingSurgeReason}
            onConfirm={onSurgeApprove || (() => {})}
            onDecline={onSurgeDecline || (() => {})}
          />
        ) : showLargeUncachedPrompt ? (
          <LargeUncachedConfirmationPrompt
            usage={lastUsage}
            onConfirm={onLargeUncachedApprove || (() => {})}
            onDecline={onLargeUncachedDecline || (() => {})}
          />
        ) : (
          <Box flexDirection="column">
            {showApprovalPrompt && (
              <ApprovalPrompt
                approval={pendingApproval}
                onApprove={onApprove}
                onReject={onReject}
                onTypeAnswer={onTypeAnswer}
                onNavigateQuestion={onNavigateQuestion}
                currentQuestionIndex={currentAskUserQuestionIndex}
                waitingForAskUserAnswer={waitingForAskUserAnswer}
              />
            )}
            {isProcessing && toolCallStreamingInfo && (
              <Text color="#64748b">
                Calling {toolCallStreamingInfo.toolName ? <Text bold>{toolCallStreamingInfo.toolName}</Text> : 'tool'} (
                {toolCallStreamingInfo.argumentCharCount} chars){'.'.repeat(dotCount)}
              </Text>
            )}
            {isProcessing && !toolCallStreamingInfo && thinkingStartedAt != null && (
              <Text color="#64748b">Thinking... {thinkingElapsedSeconds}s</Text>
            )}
            {isProcessing && !toolCallStreamingInfo && thinkingStartedAt == null && (
              <Text color="#64748b">processing{'.'.repeat(dotCount)}</Text>
            )}
            {showInput && (
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
                skillsService={skillsService}
                promptLabel={
                  waitingForAskUserAnswer
                    ? 'Answer: '
                    : handoffState?.stage === 'entering_message'
                    ? 'Handoff message (enter to use default message): '
                    : undefined
                }
                allowEmptySubmit={handoffState?.stage === 'entering_message' || waitingForAskUserAnswer}
              />
            )}
          </Box>
        )}
      </Box>

      <StatusBar
        settingsService={settingsService}
        isShellMode={isShellMode}
        sshInfo={sshInfo}
        lastUsage={lastUsage}
        lastCodexRateLimit={lastCodexRateLimit}
        largeUncachedWarning={largeUncachedWarning}
        hasPendingConfirmation={
          (pendingLargeUncachedTurn !== null && pendingLargeUncachedTokens > 0) || pendingSurgeTurn !== null
        }
        pendingLargeUncachedTokens={pendingLargeUncachedTokens}
      />
    </Box>
  );
};

export default BottomArea;
