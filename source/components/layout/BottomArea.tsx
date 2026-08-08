import React, { FC, useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import ApprovalPrompt from '../prompt/ApprovalPrompt.js';
import InputBox from '../InputBox.js';
import StatusBar from './StatusBar.js';
import HandoffConfirmationPrompt from '../prompt/HandoffConfirmationPrompt.js';
import StandardModeConfirmationPrompt from '../prompt/StandardModeConfirmationPrompt.js';
import LargeUncachedConfirmationPrompt from '../prompt/LargeUncachedConfirmationPrompt.js';
import InputSurgeConfirmationPrompt from '../prompt/InputSurgeConfirmationPrompt.js';
import QueuePausedPrompt from '../prompt/QueuePausedPrompt.js';
import type { HandoffState } from '../../hooks/use-handoff-flow.js';
import type { SlashCommand } from '../../slash-commands.js';
import type { SettingsService } from '../../services/settings/settings-service.js';
import type { LoggingService } from '../../services/logging/logging-service.js';
import type { HistoryService } from '../../services/history-service.js';
import type { SSHInfo } from '../../services/shell/shell-interaction-session.js';
import type { NormalizedUsage } from '../../utils/ai/token-usage.js';
import type { CodexRateLimitInfo } from '../../services/conversation/conversation-events.js';
import type { PendingApproval } from '../../contracts/conversation.js';
import type { UserTurn } from '../../types/user-turn.js';
import type { SkillsService } from '../../services/skills/skills-service.js';
import type { StaticCommitBlocker } from '../message/MessageList.js';
import type { QueuePauseReason } from '../../services/queue/queue-controller.js';
import type { BackgroundTask } from '../../services/subagents/subagent-notification-store.js';
import BackgroundTasksPanel from './BackgroundTasksPanel.js';
import BackgroundTaskManager from './BackgroundTaskManager.js';
import { deriveInputOwner } from '../../lib/input-owner.js';
import type { SubmissionMutation } from '../../services/conversation/conversation-adapter.js';
import type { SessionCostSummary } from '../../services/cost/model-cost.js';
import type { BackgroundTaskControlPort } from '../../services/session/background-task-control.js';

export type BottomAreaProps = {
  pendingApproval: PendingApproval | null;
  waitingForApproval: boolean;
  waitingForRejectionReason: boolean;
  waitingForAskUserAnswer?: boolean;
  currentAskUserQuestionIndex?: number;
  isProcessing: boolean;
  /** True while a second Escape would interrupt the in-flight turn. */
  interruptConfirmVisible?: boolean;
  thinkingStartedAt?: number | null;
  toolCallStreamingInfo?: { toolName?: string; argumentCharCount: number } | null;
  isShellMode?: boolean;
  lastUsage?: NormalizedUsage | null;
  lastCodexRateLimit?: CodexRateLimitInfo | null;
  onSubmit: (value: UserTurn, options?: { busyMode?: 'steer' | 'follow_up' }) => Promise<void>;
  slashCommands: SlashCommand[];
  settingsService: SettingsService;
  loggingService: LoggingService;
  historyService: HistoryService;
  onApprove: (answer?: string) => void;
  onReject: () => void;
  onCancel?: () => void;
  onTypeAnswer?: () => void;
  onNavigateQuestion?: (direction: 'prev' | 'next') => void;
  sshInfo?: SSHInfo;
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
  staticCommitBlocker?: StaticCommitBlocker | null;
  // Queue state
  queuePaused?: boolean;
  queueLength?: number;
  costSummary?: SessionCostSummary | null;
  queuePauseReason?: QueuePauseReason;
  onResumeQueue?: () => void;
  onDiscardQueue?: () => void;
  pendingQueuedMessages?: ReadonlyArray<{ id: string; text: string; queuedAt: number }>;
  onRetractQueuedMessage?: (id: string) => Promise<SubmissionMutation>;
  onEditQueuedMessage?: (id: string, turn: UserTurn) => Promise<SubmissionMutation>;
  backgroundSubagentTasks?: readonly BackgroundTask[];
  backgroundSubagentTasksNow?: number;
  listBackgroundTaskDetails?: BackgroundTaskControlPort['listDetails'];
  getBackgroundTaskDetails?: BackgroundTaskControlPort['getDetails'];
  stopBackgroundTask?: BackgroundTaskControlPort['requestStop'];
  getForegroundTaskTransferCandidate?: BackgroundTaskControlPort['getForegroundTransferCandidate'];
  listForegroundTaskTransferCandidates?: BackgroundTaskControlPort['listForegroundTransferCandidates'];
  moveForegroundTaskToBackground?: BackgroundTaskControlPort['moveForegroundToBackground'];
  backgroundApprovalPendingCount?: number;
};

const BottomArea: FC<BottomAreaProps> = ({
  pendingApproval,
  waitingForApproval,
  waitingForRejectionReason,
  waitingForAskUserAnswer = false,
  currentAskUserQuestionIndex = 0,
  isProcessing,
  interruptConfirmVisible = false,
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
  onCancel,
  onTypeAnswer,
  onNavigateQuestion,
  sshInfo,
  lastUsage,
  lastCodexRateLimit,
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
  staticCommitBlocker = null,
  queuePaused = false,
  queueLength = 0,
  costSummary,
  queuePauseReason,
  onResumeQueue,
  onDiscardQueue,
  pendingQueuedMessages = [],
  onRetractQueuedMessage,
  onEditQueuedMessage,
  backgroundSubagentTasks = [],
  backgroundSubagentTasksNow = Date.now(),
  listBackgroundTaskDetails,
  getBackgroundTaskDetails,
  stopBackgroundTask,
  getForegroundTaskTransferCandidate,
  listForegroundTaskTransferCandidates,
  moveForegroundTaskToBackground,
  backgroundApprovalPendingCount = 0,
}) => {
  const [dotCount, setDotCount] = useState(1);
  const [backgroundTaskManagerOpen, setBackgroundTaskManagerOpen] = useState(false);
  const [thinkingElapsedSeconds, setThinkingElapsedSeconds] = useState(() =>
    thinkingStartedAt == null ? 0 : Math.max(0, Math.floor((Date.now() - thinkingStartedAt) / 1000)),
  );

  useEffect(() => {
    if (!isProcessing) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset dot count when not processing
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
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset elapsed seconds when no thinking started
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

  // `inputOwner` is the single source of truth for which surface owns keyboard
  // input, derived from the same state that drives rendering. It mirrors the
  // mutual-exclusivity chain below so "what is rendered" and "who owns input"
  // stay in sync. See source/lib/input-owner.ts.
  const inputOwner = deriveInputOwner({
    handoffStage: handoffState?.stage ?? null,
    pendingSurgeTurn,
    pendingLargeUncachedTurn,
    waitingForApproval,
    waitingForRejectionReason,
    waitingForAskUserAnswer,
    pendingApproval,
    queuePaused,
    isProcessing,
    backgroundTaskManagerOpen,
  });
  const showHandoffConfirm = inputOwner.kind === 'handoff-confirm';
  const showStandardModeConfirm = inputOwner.kind === 'standard-mode-confirm';
  const showSurgePrompt = inputOwner.kind === 'input-surge';
  const showLargeUncachedPrompt = inputOwner.kind === 'large-uncached';
  const showApprovalPrompt = inputOwner.kind === 'approval';
  const showQueuePausedPrompt = inputOwner.kind === 'queue-paused';
  const showBackgroundTaskManager = inputOwner.kind === 'background-tasks';
  const foregroundTransferCandidate = getForegroundTaskTransferCandidate?.() ?? null;
  // InputBox owns input only when no modal prompt owns it and either no approval
  // is pending or the user is entering a rejection reason / ask-user answer.
  const showInput =
    inputOwner.kind === 'input' &&
    !queuePaused &&
    (!waitingForApproval || waitingForRejectionReason || waitingForAskUserAnswer);

  useEffect(() => {
    if (
      backgroundTaskManagerOpen &&
      (showHandoffConfirm || showStandardModeConfirm || showSurgePrompt || showLargeUncachedPrompt)
    ) {
      setBackgroundTaskManagerOpen(false);
    }
  }, [
    backgroundTaskManagerOpen,
    showHandoffConfirm,
    showLargeUncachedPrompt,
    showStandardModeConfirm,
    showSurgePrompt,
  ]);

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
            {showApprovalPrompt && pendingApproval && (
              <Box flexDirection="column">
                {backgroundApprovalPendingCount > 1 && (
                  <Text color="#f59e0b">Background approval · {backgroundApprovalPendingCount - 1} queued</Text>
                )}
                <ApprovalPrompt
                  approval={pendingApproval}
                  onApprove={onApprove}
                  onReject={onReject}
                  onCancel={onCancel}
                  onTypeAnswer={onTypeAnswer}
                  onNavigateQuestion={onNavigateQuestion}
                  currentQuestionIndex={currentAskUserQuestionIndex}
                  waitingForAskUserAnswer={waitingForAskUserAnswer}
                />
              </Box>
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
            {foregroundTransferCandidate && <Text color="#64748b">Foreground shell running · Ctrl+B manage</Text>}
            {interruptConfirmVisible && <Text color="#f59e0b">Press ESC again to interrupt</Text>}
            <BackgroundTasksPanel tasks={backgroundSubagentTasks} now={backgroundSubagentTasksNow} />
            {listBackgroundTaskDetails && getBackgroundTaskDetails && stopBackgroundTask && (
              <BackgroundTaskManager
                enabled={inputOwner.kind === 'input' || showBackgroundTaskManager}
                listDetails={listBackgroundTaskDetails}
                getDetails={getBackgroundTaskDetails}
                requestStop={stopBackgroundTask}
                getForegroundTransferCandidate={getForegroundTaskTransferCandidate}
                listForegroundTransferCandidates={listForegroundTaskTransferCandidates}
                moveForegroundToBackground={moveForegroundTaskToBackground}
                onOpenChange={setBackgroundTaskManagerOpen}
              />
            )}
            {showQueuePausedPrompt && (
              <QueuePausedPrompt
                queueLength={queueLength}
                pauseReason={queuePauseReason}
                onResume={onResumeQueue || (() => {})}
                onDiscard={onDiscardQueue || (() => {})}
              />
            )}
            {!showQueuePausedPrompt && !showBackgroundTaskManager && showInput && (
              <InputBox
                onSubmit={onSubmit}
                slashCommands={slashCommands}
                waitingForRejectionReason={waitingForRejectionReason}
                isShellMode={isShellMode}
                settingsService={settingsService}
                loggingService={loggingService}
                historyService={historyService}
                onSettingChange={onSettingChange}
                onSystemMessage={onSystemMessage}
                onSlashTabComplete={onSlashTabComplete}
                skillsService={skillsService}
                turnInFlight={isProcessing}
                pendingQueuedMessages={pendingQueuedMessages}
                onRetractQueuedMessage={onRetractQueuedMessage}
                onEditQueuedMessage={onEditQueuedMessage}
                promptLabel={
                  waitingForAskUserAnswer
                    ? 'Answer: '
                    : handoffState?.stage === 'entering_message'
                    ? 'Handoff message (enter to use default message): '
                    : handoffState?.stage === 'selecting_model'
                    ? 'Select model for handoff: '
                    : handoffState?.stage === 'selecting_effort'
                    ? 'Select reasoning effort level: '
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
        staticCommitBlocker={staticCommitBlocker}
        queueLength={queueLength}
        costSummary={costSummary}
      />
    </Box>
  );
};

export default BottomArea;
