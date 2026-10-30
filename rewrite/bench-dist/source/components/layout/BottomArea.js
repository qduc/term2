import React, { useEffect, useRef, useState } from 'react';
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
import BackgroundTasksPanel from './BackgroundTasksPanel.js';
import BackgroundTaskManager from './BackgroundTaskManager.js';
import { mergeLiveTaskRows } from './live-task-rows.js';
import { deriveInputOwner } from '../../lib/input-owner.js';
import { useInputActions, useInputState } from '../../context/InputContext.js';
import FirstRunSetupPrompt from '../input/FirstRunSetupPrompt.js';
import { useTheme } from '../theme.js';
import { truncateTerminalText } from './terminal-text-budget.js';
import { useTerminalColumns } from '../../hooks/use-terminal-columns.js';
const BottomArea = ({ pendingApproval, waitingForApproval, waitingForRejectionReason, waitingForAskUserAnswer = false, currentAskUserQuestionIndex = 0, isProcessing, interruptConfirmVisible = false, thinkingStartedAt = null, retryCountdown = null, toolCallStreamingInfo = null, liveStreamingSpeed = null, isShellMode = false, activeShellCommand, onShellModeEnter, onShellModeExit, onSubmit, onRejectionReasonInputReady, slashCommands, settingsService, loggingService, historyService, onApprove, onReject, onCancel, onTypeAnswer, onNavigateQuestion, sshInfo, lastUsage, lastCodexRateLimit, runBudgetNotice, grokCreditUsage, openCodeGoUsage, openRouterUpstream, upstreamProvider, onSettingChange, onSystemMessage, handoffState, onHandoffConfirm, onHandoffDecline, onHandoffCancel, onStandardModeConfirm, onStandardModeDecline, pendingModeSwitch, onModeSwitchConfirm, onModeSwitchDecline, largeUncachedWarning, pendingLargeUncachedTurn, pendingLargeUncachedTokens = 0, onLargeUncachedApprove, onLargeUncachedDecline, pendingSurgeTurn, pendingSurgeReason = '', onSurgeApprove, onSurgeDecline, skillsService, staticCommitBlocker = null, queuePaused = false, queueLength = 0, costSummary, queuePauseReason, onResumeQueue, onDiscardQueue, pendingQueuedMessages = [], onRetractQueuedMessage, onEditQueuedMessage, backgroundSubagentTasks = [], backgroundSubagentTasksNow = Date.now(), backgroundTaskDetails, backgroundTaskDetailsNow = backgroundSubagentTasksNow, listBackgroundTaskDetails, getBackgroundTaskDetails, stopBackgroundTask, getForegroundTaskTransferCandidate, listForegroundTaskTransferCandidates, moveForegroundTaskToBackground, backgroundTaskManagerOpen, onBackgroundTaskManagerOpenChange, backgroundApprovalPendingCount = 0, firstRunSetup, onProviderSelected, onUnavailableModelSelected, onSkillSelected, onCopySelection, listConversations, resumeConversation, mcpManager, mcpConfigController, }) => {
    const theme = useTheme();
    const { WorkingIndicator, LiveDivider, ShellActivity } = useSkin();
    const { controller, input } = useInputState();
    const { replaceInput } = useInputActions();
    const terminalColumns = useTerminalColumns();
    const [dotCount, setDotCount] = useState(1);
    const [workingElapsedSeconds, setWorkingElapsedSeconds] = useState(0);
    const workStartedAtRef = useRef(null);
    const [thinkingElapsedSeconds, setThinkingElapsedSeconds] = useState(() => thinkingStartedAt == null ? 0 : Math.max(0, Math.floor((Date.now() - thinkingStartedAt) / 1000)));
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
    const retrySecondsLeft = (until) => Math.max(0, Math.ceil((until - Date.now()) / 1000));
    const [retryRemainingSeconds, setRetryRemainingSeconds] = useState(() => retryCountdown == null ? 0 : retrySecondsLeft(retryCountdown.until));
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
    const workingPhase = retryCountdown != null && retryRemainingSeconds > 0
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
    const workingStepKey = workingPhase === 'tool_call' ? `tool_call:${toolCallStreamingInfo?.toolName ?? ''}` : workingPhase;
    useEffect(() => {
        if (!isProcessing) {
            workStartedAtRef.current = null;
            // eslint-disable-next-line react-hooks/set-state-in-effect -- clear elapsed time when the run ends
            setWorkingElapsedSeconds(0);
            return;
        }
        workStartedAtRef.current = Date.now();
        const updateElapsed = () => setWorkingElapsedSeconds(Math.max(0, Math.floor((Date.now() - (workStartedAtRef.current ?? Date.now())) / 1000)));
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
    const showApprovalPrompt = inputOwner.kind === 'approval' || (waitingForAskUserAnswer && pendingApproval?.toolName === 'ask_user');
    const showQueuePausedPrompt = inputOwner.kind === 'queue-paused';
    const showBackgroundTaskManager = inputOwner.kind === 'background-tasks';
    const foregroundTransferCandidate = getForegroundTaskTransferCandidate?.() ?? null;
    // A higher-priority prompt replaces this branch and unmounts the manager.
    // Close the lifted owner state with it so reopening the branch cannot leave
    // an empty manager with its previous local task snapshot gone.
    useEffect(() => {
        if (backgroundTaskManagerOpen &&
            (showHandoffConfirm ||
                showStandardModeConfirm ||
                showModeSwitchConfirm ||
                showSurgePrompt ||
                showLargeUncachedPrompt)) {
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
    const hasBlockingPrompt = showHandoffConfirm ||
        showStandardModeConfirm ||
        (showModeSwitchConfirm && pendingModeSwitch != null) ||
        showSurgePrompt ||
        showLargeUncachedPrompt;
    const hasLiveTasks = (listForegroundTaskTransferCandidates?.()?.length ?? (foregroundTransferCandidate ? 1 : 0)) > 0 ||
        (backgroundTaskDetails?.length ?? backgroundSubagentTasks?.length ?? 0) > 0;
    const hasTopContent = (showApprovalPrompt && pendingApproval != null) || interruptConfirmVisible || hasLiveTasks || showQueuePausedPrompt;
    return (React.createElement(Box, { flexDirection: "column", width: "100%" },
        React.createElement(Box, { flexDirection: "column", marginTop: 1 },
            !hasBlockingPrompt && (React.createElement(React.Fragment, null, isProcessing && (React.createElement(WorkingIndicator, { phase: workingPhase, elapsedSeconds: workingPhase === 'retrying'
                    ? retryRemainingSeconds
                    : workingPhase === 'thinking'
                        ? thinkingElapsedSeconds
                        : workingElapsedSeconds, tokensPerSecond: workingPhase === 'retrying' ? undefined : liveStreamingSpeed?.tps, toolName: workingPhase === 'tool_call' ? toolCallStreamingInfo?.toolName : undefined, argumentChars: workingPhase === 'tool_call' ? toolCallStreamingInfo?.argumentCharCount : undefined, retry: workingPhase === 'retrying' && retryCountdown
                    ? { attempt: retryCountdown.attempt, maxRetries: retryCountdown.maxRetries }
                    : undefined, dotCount: dotCount })))),
            React.createElement(LiveDivider, null),
            firstRunSetup?.active && firstRunSetup.phase && (React.createElement(FirstRunSetupPrompt, { phase: firstRunSetup.phase, provider: firstRunSetup.provider })),
            showHandoffConfirm ? (React.createElement(HandoffConfirmationPrompt, { onConfirm: onHandoffConfirm || (() => { }), onDecline: onHandoffDecline || (() => { }), onCancel: onHandoffCancel || (() => { }) })) : showStandardModeConfirm ? (React.createElement(StandardModeConfirmationPrompt, { onConfirm: onStandardModeConfirm || (() => { }), onDecline: onStandardModeDecline || (() => { }), onCancel: onHandoffCancel || (() => { }) })) : showModeSwitchConfirm && pendingModeSwitch ? (React.createElement(ModeSwitchConfirmationPrompt, { modeLabel: pendingModeSwitch.modeLabel, targetValue: pendingModeSwitch.targetValue ?? true, onConfirm: onModeSwitchConfirm || (() => { }), onDecline: onModeSwitchDecline || (() => { }), onCancel: onModeSwitchDecline || (() => { }) })) : showSurgePrompt ? (React.createElement(InputSurgeConfirmationPrompt, { reason: pendingSurgeReason, onConfirm: onSurgeApprove || (() => { }), onDecline: onSurgeDecline || (() => { }) })) : showLargeUncachedPrompt ? (React.createElement(LargeUncachedConfirmationPrompt, { usage: lastUsage, onConfirm: onLargeUncachedApprove || (() => { }), onDecline: onLargeUncachedDecline || (() => { }) })) : (React.createElement(Box, { flexDirection: "column", marginBottom: hasTopContent ? 1 : 0 },
                showApprovalPrompt && pendingApproval && (React.createElement(Box, { flexDirection: "column" },
                    backgroundApprovalPendingCount > 1 && (React.createElement(Text, { color: theme.warning },
                        "Background approval \u00B7 ",
                        backgroundApprovalPendingCount - 1,
                        " queued")),
                    React.createElement(ApprovalPrompt, { approval: pendingApproval, onApprove: onApprove, onReject: onReject, onCancel: onCancel, onTypeAnswer: onTypeAnswer, onNavigateQuestion: onNavigateQuestion, currentQuestionIndex: currentAskUserQuestionIndex, waitingForAskUserAnswer: waitingForAskUserAnswer }))),
                activeShellCommand && (React.createElement(ShellActivity, { command: truncateTerminalText(activeShellCommand, Math.max(1, terminalColumns - 24)) })),
                interruptConfirmVisible && React.createElement(Text, { color: theme.warning }, "Press Esc again to interrupt"),
                React.createElement(BackgroundTasksPanel, { tasks: mergeLiveTaskRows({
                        foreground: listForegroundTaskTransferCandidates?.() ??
                            (foregroundTransferCandidate ? [foregroundTransferCandidate] : []),
                        background: backgroundTaskDetails ?? backgroundSubagentTasks,
                    }), now: backgroundTaskDetails ? backgroundTaskDetailsNow : backgroundSubagentTasksNow }),
                listBackgroundTaskDetails && getBackgroundTaskDetails && stopBackgroundTask && (React.createElement(BackgroundTaskManager, { enabled: inputOwner.kind === 'input' || showBackgroundTaskManager, open: backgroundTaskManagerOpen, listDetails: listBackgroundTaskDetails, getDetails: getBackgroundTaskDetails, requestStop: stopBackgroundTask, getForegroundTransferCandidate: getForegroundTaskTransferCandidate, listForegroundTransferCandidates: listForegroundTaskTransferCandidates, moveForegroundToBackground: moveForegroundTaskToBackground, onOpenChange: onBackgroundTaskManagerOpenChange })),
                showQueuePausedPrompt && (React.createElement(QueuePausedPrompt, { queueLength: queueLength, pauseReason: queuePauseReason, onResume: onResumeQueue || (() => { }), onDiscard: onDiscardQueue || (() => { }), onCommand: replaceInput })))),
            React.createElement(ApplicationInputSurface, { enabled: inputOwner.kind === 'input' || inputOwner.kind === 'menu', onSubmit: onSubmit, onRejectionReasonInputReady: onRejectionReasonInputReady, slashCommands: slashCommands, waitingForRejectionReason: waitingForRejectionReason, isShellMode: isShellMode, onShellModeEnter: onShellModeEnter, onShellModeExit: onShellModeExit, settingsService: settingsService, loggingService: loggingService, historyService: historyService, onSettingChange: onSettingChange, onSystemMessage: onSystemMessage, skillsService: skillsService, turnInFlight: isProcessing, pendingQueuedMessages: pendingQueuedMessages, onRetractQueuedMessage: onRetractQueuedMessage, onEditQueuedMessage: onEditQueuedMessage, onProviderSelected: onProviderSelected, onUnavailableModelSelected: onUnavailableModelSelected, onSkillSelected: onSkillSelected, onCopySelection: onCopySelection, listConversations: listConversations, resumeConversation: resumeConversation, mcpManager: mcpManager, mcpConfigController: mcpConfigController, promptLabel: waitingForAskUserAnswer
                    ? 'Answer: '
                    : handoffState?.stage === 'entering_message'
                        ? 'Handoff message (enter to use default message): '
                        : handoffState?.stage === 'selecting_model'
                            ? 'Select model for handoff: '
                            : handoffState?.stage === 'selecting_effort'
                                ? 'Select reasoning effort level: '
                                : undefined, allowEmptySubmit: handoffState?.stage === 'entering_message' || waitingForAskUserAnswer })),
        React.createElement(StatusBar, { settingsService: settingsService, sshInfo: sshInfo, lastUsage: lastUsage, liveStreamingSpeed: liveStreamingSpeed, lastCodexRateLimit: lastCodexRateLimit, runBudgetNotice: runBudgetNotice, grokCreditUsage: grokCreditUsage, openCodeGoUsage: openCodeGoUsage, openRouterUpstream: openRouterUpstream, upstreamProvider: upstreamProvider, largeUncachedWarning: largeUncachedWarning, hasPendingConfirmation: (pendingLargeUncachedTurn !== null && pendingLargeUncachedTokens > 0) || pendingSurgeTurn !== null, pendingLargeUncachedTokens: pendingLargeUncachedTokens, staticCommitBlocker: staticCommitBlocker, queueLength: queueLength, costSummary: costSummary })));
};
export default BottomArea;
//# sourceMappingURL=BottomArea.js.map