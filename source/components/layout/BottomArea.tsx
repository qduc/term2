import React, { FC, useEffect, useRef, useState } from 'react';
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
import { useSkin } from '../../skins/SkinContext.js';
import type { WorkingIndicatorView } from '../../skins/types.js';
import type { RetryCountdown } from '../../hooks/conversation-ui-reducer.js';
import type { PendingModeSwitch } from '../../commands/mode-commands.js';
import type { HandoffState } from '../../hooks/use-handoff-flow.js';
import type { SlashCommand } from '../../slash-commands.js';
import type { McpConnectionManager } from '../../services/mcp/mcp-connection-manager.js';
import type { McpConfigController } from '../../services/mcp/mcp-config-controller.js';
import type { SettingsService } from '../../services/settings/settings-service.js';
import type { LoggingService } from '../../services/logging/logging-service.js';
import type { HistoryService } from '../../services/history-service.js';
import type { SSHInfo } from '../../services/shell/shell-interaction-session.js';
import type { NormalizedUsage } from '../../utils/ai/token-usage.js';
import type { RunBudgetEvent } from '../../services/agent-runtime/run-budget.js';
import type { CodexRateLimitInfo } from '../../services/conversation/conversation-events.js';
import type { GrokCreditUsage } from '../../providers/grok-credit-usage.js';
import type { OpenCodeGoUsage } from '../../providers/opencode-go-usage.js';
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
import { useInputActions, useInputState } from '../../context/InputContext.js';
import FirstRunSetupPrompt, { type FirstRunSetupPhase } from '../input/FirstRunSetupPrompt.js';
import { useTheme } from '../theme.js';
import { truncateTerminalText } from './terminal-text-budget.js';
import { useTerminalColumns } from '../../hooks/use-terminal-columns.js';

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
  retryCountdown?: RetryCountdown | null;
  toolCallStreamingInfo?: { toolName?: string; argumentCharCount?: number } | null;
  liveStreamingSpeed?: { tps: number; ttftMs?: number } | null;
  isShellMode?: boolean;
  activeShellCommand?: string;
  onShellModeEnter?: () => void;
  onShellModeExit?: () => void;
  lastUsage?: NormalizedUsage | null;
  lastCodexRateLimit?: CodexRateLimitInfo | null;
  runBudgetNotice?: RunBudgetEvent | null;
  grokCreditUsage?: GrokCreditUsage | null;
  openCodeGoUsage?: OpenCodeGoUsage | null;
  openRouterUpstream?: string | null;
  upstreamProvider?: string | null;
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
  listConversations?: () => Promise<
    import('../../services/conversation/conversation-persistence.js').ConversationListEntry[]
  >;
  resumeConversation?: (target?: string) => void | Promise<void>;
  mcpManager?: McpConnectionManager;
  mcpConfigController?: McpConfigController;
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
  retryCountdown = null,
  toolCallStreamingInfo = null,
  liveStreamingSpeed = null,
  isShellMode = false,
  activeShellCommand,
  onShellModeEnter,
  onShellModeExit,
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
  openCodeGoUsage,
  openRouterUpstream,
  upstreamProvider,
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
  listConversations,
  resumeConversation,
  mcpManager,
  mcpConfigController,
}) => {
  const theme = useTheme();
  const { WorkingIndicator, LiveDivider, ShellActivity } = useSkin();
  const { controller, input } = useInputState();
  const { replaceInput } = useInputActions();
  const terminalColumns = useTerminalColumns();
  const [dotCount, setDotCount] = useState(1);
  const [workingElapsedSeconds, setWorkingElapsedSeconds] = useState(0);
  const workStartedAtRef = useRef<number | null>(null);
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

  const retrySecondsLeft = (until: number) => Math.max(0, Math.ceil((until - Date.now()) / 1000));
  const [retryRemainingSeconds, setRetryRemainingSeconds] = useState(() =>
    retryCountdown == null ? 0 : retrySecondsLeft(retryCountdown.until),
  );
  useEffect(() => {
    if (retryCountdown == null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- no backoff in progress
      setRetryRemainingSeconds(0);
      return;
    }
    const update = () => setRetryRemainingSeconds(retrySecondsLeft(retryCountdown.until));
    update();
    const interval = setInterval(update, 250);
    return () => clearInterval(interval);
  }, [retryCountdown]);

  // Once the backoff ends the retry request is in flight, which is the plain
  // waiting-for-model state until its output arrives.
  const workingPhase: WorkingIndicatorView['phase'] =
    retryCountdown != null && retryRemainingSeconds > 0
      ? 'retrying'
      : toolCallStreamingInfo
      ? 'tool_call'
      : thinkingStartedAt != null
      ? 'thinking'
      : liveStreamingSpeed?.tps != null && liveStreamingSpeed.tps > 0
      ? 'generating'
      : 'processing';
  // The clock times the current step, not the turn: a turn-long count under
  // "Calling tool X" or "Processing" blames the slow part on the wrong step.
  const workingStepKey =
    workingPhase === 'tool_call' ? `tool_call:${toolCallStreamingInfo?.toolName ?? ''}` : workingPhase;

  useEffect(() => {
    if (!isProcessing) {
      workStartedAtRef.current = null;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clear elapsed time when the run ends
      setWorkingElapsedSeconds(0);
      return;
    }

    workStartedAtRef.current = Date.now();
    const updateElapsed = () =>
      setWorkingElapsedSeconds(Math.max(0, Math.floor((Date.now() - (workStartedAtRef.current ?? Date.now())) / 1000)));
    updateElapsed();
    const interval = setInterval(updateElapsed, 1000);
    return () => clearInterval(interval);
  }, [isProcessing, workingStepKey]);

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
    inputValue: input,
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

  const hasBlockingPrompt =
    showHandoffConfirm ||
    showStandardModeConfirm ||
    (showModeSwitchConfirm && pendingModeSwitch != null) ||
    showSurgePrompt ||
    showLargeUncachedPrompt;
  const hasLiveTasks =
    (listForegroundTaskTransferCandidates?.()?.length ?? (foregroundTransferCandidate ? 1 : 0)) > 0 ||
    (backgroundTaskDetails?.length ?? backgroundSubagentTasks?.length ?? 0) > 0;
  const hasTopContent =
    (showApprovalPrompt && pendingApproval != null) || interruptConfirmVisible || hasLiveTasks || showQueuePausedPrompt;

  return (
    <Box flexDirection="column" width="100%">
      <Box flexDirection="column" marginTop={1}>
        {/* Working status sits above the divider so it is not boxed in with the task panel. */}
        {!hasBlockingPrompt && (
          <>
            {isProcessing && (
              <WorkingIndicator
                phase={workingPhase}
                elapsedSeconds={
                  workingPhase === 'retrying'
                    ? retryRemainingSeconds
                    : workingPhase === 'thinking'
                    ? thinkingElapsedSeconds
                    : workingElapsedSeconds
                }
                tokensPerSecond={workingPhase === 'retrying' ? undefined : liveStreamingSpeed?.tps}
                toolName={workingPhase === 'tool_call' ? toolCallStreamingInfo?.toolName : undefined}
                argumentChars={workingPhase === 'tool_call' ? toolCallStreamingInfo?.argumentCharCount : undefined}
                retry={
                  workingPhase === 'retrying' && retryCountdown
                    ? { attempt: retryCountdown.attempt, maxRetries: retryCountdown.maxRetries }
                    : undefined
                }
                dotCount={dotCount}
              />
            )}
          </>
        )}
        {/* The one structural split on screen: printed history above, live controls below. */}
        <LiveDivider />
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
                  <Text color={theme.warning}>Background approval · {backgroundApprovalPendingCount - 1} queued</Text>
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
            {activeShellCommand && (
              <ShellActivity command={truncateTerminalText(activeShellCommand, Math.max(1, terminalColumns - 24))} />
            )}
            {interruptConfirmVisible && <Text color={theme.warning}>Press Esc again to interrupt</Text>}
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
                onCommand={replaceInput}
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
          onShellModeEnter={onShellModeEnter}
          onShellModeExit={onShellModeExit}
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
          listConversations={listConversations}
          resumeConversation={resumeConversation}
          mcpManager={mcpManager}
          mcpConfigController={mcpConfigController}
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
        sshInfo={sshInfo}
        lastUsage={lastUsage}
        liveStreamingSpeed={liveStreamingSpeed}
        lastCodexRateLimit={lastCodexRateLimit}
        runBudgetNotice={runBudgetNotice}
        grokCreditUsage={grokCreditUsage}
        openCodeGoUsage={openCodeGoUsage}
        openRouterUpstream={openRouterUpstream}
        upstreamProvider={upstreamProvider}
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
