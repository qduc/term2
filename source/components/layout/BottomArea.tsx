import React, { FC, useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import ApprovalPrompt from '../prompt/ApprovalPrompt.js';
import ApplicationInputSurface from '../input/ApplicationInputSurface.js';
import StatusBar from './StatusBar.js';
import HandoffConfirmationPrompt from '../prompt/HandoffConfirmationPrompt.js';
import StandardModeConfirmationPrompt from '../prompt/StandardModeConfirmationPrompt.js';
import ModeSwitchConfirmationPrompt from '../prompt/ModeSwitchConfirmationPrompt.js';
import LargeUncachedConfirmationPrompt from '../prompt/LargeUncachedConfirmationPrompt.js';
import InputSurgeConfirmationPrompt from '../prompt/InputSurgeConfirmationPrompt.js';
import QueuePausedPrompt from '../prompt/QueuePausedPrompt.js';
import type { PendingModeSwitch } from '../../commands/mode-commands.js';
import type { HandoffState } from '../../hooks/use-handoff-flow.js';
import type { SlashCommand } from '../../slash-commands.js';
import type { SettingsService } from '../../services/settings/settings-service.js';
import type { LoggingService } from '../../services/logging/logging-service.js';
import type { HistoryService } from '../../services/history-service.js';
import type { SSHInfo } from '../../services/shell/shell-interaction-session.js';
import type { NormalizedUsage } from '../../utils/ai/token-usage.js';
import type { RunBudgetEvent } from '../../services/agent-runtime/run-budget.js';
import type { CodexRateLimitInfo } from '../../services/conversation/conversation-events.js';
import type { GrokCreditUsage } from '../../providers/grok-credit-usage.js';
import type { PendingApproval } from '../../contracts/conversation.js';
import type { UserTurn } from '../../types/user-turn.js';
import type { SkillInfo, SkillsService } from '../../services/skills/skills-service.js';
import type { StaticCommitBlocker } from '../message/MessageList.js';
import type { QueuePauseReason } from '../../services/queue/queue-controller.js';
import type { BackgroundTask } from '../../services/subagents/subagent-notification-store.js';
import BackgroundTasksPanel from './BackgroundTasksPanel.js';
import BackgroundTaskManager from './BackgroundTaskManager.js';
import { mergeLiveTaskRows } from './live-task-rows.js';
import { deriveInputOwner } from '../../lib/input-owner.js';
import type { SubmissionMutation } from '../../services/conversation/conversation-adapter.js';
import type { SessionCostSummary } from '../../services/cost/model-cost.js';
import type { BackgroundTaskControlPort } from '../../services/session/background-task-control.js';
import type { BackgroundTaskControlDetails } from '../../services/session/background-task-control.js';
import type { CopySelection } from '../../utils/copy-selections.js';
import type { PendingQueueMessage } from '../input/PendingQueueList.js';
import { useInputState } from '../../context/InputContext.js';
import FirstRunSetupPrompt, { type FirstRunSetupPhase } from '../input/FirstRunSetupPrompt.js';
import { COLOR_TEXT_SUBTLE, COLOR_WARNING } from '../theme.js';

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
  runBudgetNotice?: RunBudgetEvent | null;
  grokCreditUsage?: GrokCreditUsage | null;
  onSubmit: (value: UserTurn, options?: { busyMode?: 'steer' | 'follow_up' }) => Promise<void>;
  onRejectionReasonInputReady?: () => void;
  slashCommands: SlashCommand[];
  settingsService: SettingsService;
  loggingService: LoggingService;
  historyService: HistoryService;
  onApprove: (answer?: string) => void;
  onReject: () => void;
  onCancel?: () => void;
  onTypeAnswer?: (initialAnswer?: string) => void;
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
  pendingModeSwitch?: PendingModeSwitch | null;
  onModeSwitchConfirm?: () => void;
  onModeSwitchDecline?: () => void;
  largeUncachedWarning?: import('../../services/large-uncached-input-guard.js').LargeUncachedInputDecision | null;
  pendingLargeUncachedTurn?: UserTurn | null;
  pendingLargeUncachedTokens?: number;
  onLargeUncachedApprove?: () => void;
  onLargeUncachedDecline?: () => void;
  pendingSurgeTurn?: UserTurn | null;
  pendingSurgeReason?: string;
  onSurgeApprove?: () => void;
  onSurgeDecline?: () => void;
  skillsService?: SkillsService;
  staticCommitBlocker?: StaticCommitBlocker | null;
  // Queue state
  queuePaused?: boolean;
  queueLength?: number;
  costSummary?: SessionCostSummary | null;
  queuePauseReason?: QueuePauseReason;
  onResumeQueue?: () => void;
  onDiscardQueue?: () => void;
  pendingQueuedMessages?: ReadonlyArray<PendingQueueMessage>;
  onRetractQueuedMessage?: (id: string) => Promise<SubmissionMutation>;
  onEditQueuedMessage?: (id: string, turn: UserTurn) => Promise<SubmissionMutation>;
  backgroundSubagentTasks?: readonly BackgroundTask[];
  backgroundSubagentTasksNow?: number;
  backgroundTaskDetails?: readonly BackgroundTaskControlDetails[];
  backgroundTaskDetailsNow?: number;
  listBackgroundTaskDetails?: BackgroundTaskControlPort['listDetails'];
  getBackgroundTaskDetails?: BackgroundTaskControlPort['getDetails'];
  stopBackgroundTask?: BackgroundTaskControlPort['requestStop'];
  getForegroundTaskTransferCandidate?: BackgroundTaskControlPort['getForegroundTransferCandidate'];
  listForegroundTaskTransferCandidates?: BackgroundTaskControlPort['listForegroundTransferCandidates'];
  moveForegroundTaskToBackground?: BackgroundTaskControlPort['moveForegroundToBackground'];
  backgroundTaskManagerOpen: boolean;
  onBackgroundTaskManagerOpenChange: (open: boolean) => void;
  backgroundApprovalPendingCount?: number;
  firstRunSetup?: { active: boolean; phase: FirstRunSetupPhase | null; provider: string };
  onProviderSelected?: (provider: string) => void;
  onUnavailableModelSelected?: (provider: string) => void;
  onSkillSelected?: (skill: SkillInfo) => void;
  onCopySelection?: (selection: CopySelection) => void;
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
  onRejectionReasonInputReady,
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
  runBudgetNotice,
  grokCreditUsage,
  onSettingChange,
  onSystemMessage,
  handoffState,
  onHandoffConfirm,
  onHandoffDecline,
  onHandoffCancel,
  onStandardModeConfirm,
  onStandardModeDecline,
  pendingModeSwitch,
  onModeSwitchConfirm,
  onModeSwitchDecline,
  largeUncachedWarning,
  pendingLargeUncachedTurn,
  pendingLargeUncachedTokens = 0,
  onLargeUncachedApprove,
  onLargeUncachedDecline,
  pendingSurgeTurn,
  pendingSurgeReason = '',
  onSurgeApprove,
  onSurgeDecline,
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
  backgroundTaskDetails,
  backgroundTaskDetailsNow = backgroundSubagentTasksNow,
  listBackgroundTaskDetails,
  getBackgroundTaskDetails,
  stopBackgroundTask,
  getForegroundTaskTransferCandidate,
  listForegroundTaskTransferCandidates,
  moveForegroundTaskToBackground,
  backgroundTaskManagerOpen,
  onBackgroundTaskManagerOpenChange,
  backgroundApprovalPendingCount = 0,
  firstRunSetup,
  onProviderSelected,
  onUnavailableModelSelected,
  onSkillSelected,
  onCopySelection,
}) => {
  const { controller } = useInputState();
  const [dotCount, setDotCount] = useState(1);
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
  // input. Most prompt rendering follows it, but the ask_user prompt remains
  // visible as context while its custom-answer composer owns input. See
  // source/lib/input-owner.ts.
  const inputOwner = deriveInputOwner({
    handoffStage: handoffState?.stage ?? null,
    pendingModeSwitch,
    pendingSurgeTurn,
    pendingLargeUncachedTurn,
    waitingForApproval,
    waitingForRejectionReason,
    waitingForAskUserAnswer,
    pendingApproval,
    queuePaused,
    isProcessing,
    backgroundTaskManagerOpen,
    firstRunSetupActive: firstRunSetup?.active,
    menuOpen: controller.getSnapshot().stack.length > 0,
  });
  const showHandoffConfirm = inputOwner.kind === 'handoff-confirm';
  const showStandardModeConfirm = inputOwner.kind === 'standard-mode-confirm';
  const showModeSwitchConfirm = inputOwner.kind === 'mode-switch-confirm';
  const showSurgePrompt = inputOwner.kind === 'input-surge';
  const showLargeUncachedPrompt = inputOwner.kind === 'large-uncached';
  // Ask-user answers are typed in the composer, so inputOwner intentionally
  // becomes `input`; keep the question rendered as context while that happens.
  const showApprovalPrompt =
    inputOwner.kind === 'approval' || (waitingForAskUserAnswer && pendingApproval?.toolName === 'ask_user');
  const showQueuePausedPrompt = inputOwner.kind === 'queue-paused';
  const showBackgroundTaskManager = inputOwner.kind === 'background-tasks';
  const foregroundTransferCandidate = getForegroundTaskTransferCandidate?.() ?? null;

  // A higher-priority prompt replaces this branch and unmounts the manager.
  // Close the lifted owner state with it so reopening the branch cannot leave
  // an empty manager with its previous local task snapshot gone.
  useEffect(() => {
    if (
      backgroundTaskManagerOpen &&
      (showHandoffConfirm ||
        showStandardModeConfirm ||
        showModeSwitchConfirm ||
        showSurgePrompt ||
        showLargeUncachedPrompt)
    ) {
      onBackgroundTaskManagerOpenChange(false);
    }
  }, [
    backgroundTaskManagerOpen,
    onBackgroundTaskManagerOpenChange,
    showHandoffConfirm,
    showLargeUncachedPrompt,
    showModeSwitchConfirm,
    showStandardModeConfirm,
    showSurgePrompt,
  ]);

  const hasLiveTasks =
    (listForegroundTaskTransferCandidates?.()?.length ?? (foregroundTransferCandidate ? 1 : 0)) > 0 ||
    (backgroundTaskDetails?.length ?? backgroundSubagentTasks?.length ?? 0) > 0;
  const hasTopContent =
    (showApprovalPrompt && pendingApproval != null) ||
    isProcessing ||
    interruptConfirmVisible ||
    hasLiveTasks ||
    showQueuePausedPrompt;

  return (
    <Box flexDirection="column" width="100%">
      <Box flexDirection="column" marginTop={1}>
        {firstRunSetup?.active && firstRunSetup.phase && (
          <FirstRunSetupPrompt phase={firstRunSetup.phase} provider={firstRunSetup.provider} />
        )}
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
        ) : showModeSwitchConfirm && pendingModeSwitch ? (
          <ModeSwitchConfirmationPrompt
            modeLabel={pendingModeSwitch.modeLabel}
            targetValue={pendingModeSwitch.targetValue ?? true}
            onConfirm={onModeSwitchConfirm || (() => {})}
            onDecline={onModeSwitchDecline || (() => {})}
            onCancel={onModeSwitchDecline || (() => {})}
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
          <Box flexDirection="column" marginBottom={hasTopContent ? 1 : 0}>
            {showApprovalPrompt && pendingApproval && (
              <Box flexDirection="column">
                {backgroundApprovalPendingCount > 1 && (
                  <Text color={COLOR_WARNING}>Background approval · {backgroundApprovalPendingCount - 1} queued</Text>
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
              <Text color={COLOR_TEXT_SUBTLE}>
                Calling {toolCallStreamingInfo.toolName ? <Text bold>{toolCallStreamingInfo.toolName}</Text> : 'tool'} (
                {toolCallStreamingInfo.argumentCharCount} chars){'.'.repeat(dotCount)}
              </Text>
            )}
            {isProcessing && !toolCallStreamingInfo && thinkingStartedAt != null && (
              <Text color={COLOR_TEXT_SUBTLE}>Thinking... {thinkingElapsedSeconds}s</Text>
            )}
            {isProcessing && !toolCallStreamingInfo && thinkingStartedAt == null && (
              <Text color={COLOR_TEXT_SUBTLE}>processing{'.'.repeat(dotCount)}</Text>
            )}
            {interruptConfirmVisible && <Text color={COLOR_WARNING}>Press ESC again to interrupt</Text>}
            <BackgroundTasksPanel
              tasks={mergeLiveTaskRows({
                foreground:
                  listForegroundTaskTransferCandidates?.() ??
                  (foregroundTransferCandidate ? [foregroundTransferCandidate] : []),
                background: backgroundTaskDetails ?? backgroundSubagentTasks,
              })}
              now={backgroundTaskDetails ? backgroundTaskDetailsNow : backgroundSubagentTasksNow}
            />
            {listBackgroundTaskDetails && getBackgroundTaskDetails && stopBackgroundTask && (
              <BackgroundTaskManager
                enabled={inputOwner.kind === 'input' || showBackgroundTaskManager}
                open={backgroundTaskManagerOpen}
                listDetails={listBackgroundTaskDetails}
                getDetails={getBackgroundTaskDetails}
                requestStop={stopBackgroundTask}
                getForegroundTransferCandidate={getForegroundTaskTransferCandidate}
                listForegroundTransferCandidates={listForegroundTaskTransferCandidates}
                moveForegroundToBackground={moveForegroundTaskToBackground}
                onOpenChange={onBackgroundTaskManagerOpenChange}
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
          </Box>
        )}
        <ApplicationInputSurface
          enabled={inputOwner.kind === 'input' || inputOwner.kind === 'menu'}
          onSubmit={onSubmit}
          onRejectionReasonInputReady={onRejectionReasonInputReady}
          slashCommands={slashCommands}
          waitingForRejectionReason={waitingForRejectionReason}
          isShellMode={isShellMode}
          settingsService={settingsService}
          loggingService={loggingService}
          historyService={historyService}
          onSettingChange={onSettingChange}
          onSystemMessage={onSystemMessage}
          skillsService={skillsService}
          turnInFlight={isProcessing}
          pendingQueuedMessages={pendingQueuedMessages}
          onRetractQueuedMessage={onRetractQueuedMessage}
          onEditQueuedMessage={onEditQueuedMessage}
          onProviderSelected={onProviderSelected}
          onUnavailableModelSelected={onUnavailableModelSelected}
          onSkillSelected={onSkillSelected}
          onCopySelection={onCopySelection}
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
      </Box>

      <StatusBar
        settingsService={settingsService}
        isShellMode={isShellMode}
        sshInfo={sshInfo}
        lastUsage={lastUsage}
        lastCodexRateLimit={lastCodexRateLimit}
        runBudgetNotice={runBudgetNotice}
        grokCreditUsage={grokCreditUsage}
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
