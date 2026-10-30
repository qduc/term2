import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useInputActions, useInputState } from './context/InputContext.js';
import { clearTerminalForRedraw, clearVisibleForResize, messagesHaveNonSystemContent } from './app-helpers.js';
import { Box, useApp, useStdout } from 'ink';
import { useConversation } from './hooks/use-conversation.js';
import MessageList, { detectStaticCommitBlocker, EMPTY_RESTORED_STATIC_MESSAGE_IDS, MESSAGE_HORIZONTAL_PADDING, } from './components/message/MessageList.js';
import BottomArea from './components/layout/BottomArea.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { useGrokCreditUsage } from './hooks/use-grok-credit-usage.js';
import { useOpenCodeGoUsage } from './hooks/use-opencode-go-usage.js';
import { useSetting } from './hooks/use-setting.js';
import { useDebouncedValue } from './hooks/use-debounced-value.js';
import { parseInput } from './utils/input-parser.js';
import { ConversationConfigurationService } from './services/runtime-setting-router.js';
import { useShellMode } from './hooks/use-shell-mode.js';
import { ShellInteractionSession } from './services/shell/shell-interaction-session.js';
import { useAppCommands } from './hooks/use-app-commands.js';
import { clearInputBeforeReset } from './utils/clear-input-before-reset.js';
import { ProfileTransitionService } from './services/profiles/profile-transition.js';
import { useHandoffFlow } from './hooks/use-handoff-flow.js';
import { useTerminalFocusNotifier } from './hooks/use-terminal-focus-notifier.js';
import { useAppKeyboardShortcuts } from './hooks/use-app-keyboard-shortcuts.js';
import { hasUserTurnContent } from './types/user-turn.js';
import { createUsageAccumulator, formatSessionUsageBreakdown } from './utils/ai/token-usage.js';
import { createSessionCostAccumulator, formatModelUsageBreakdown, formatUsdMicros, } from './services/cost/model-cost.js';
import { buildRewindItems } from './utils/conversation/rewind-items.js';
import { tryExecuteSlashCommand } from './utils/slash-command-dispatch.js';
import { useMcpNotices } from './hooks/use-mcp-notices.js';
import { buildTerminalTitleLabel, setTerminalTitle } from './utils/output/terminal-title.js';
import { deriveInputOwner } from './lib/input-owner.js';
import { publishHarnessInputState } from './lib/harness-input-idle.js';
import { handleSettingsIntent } from './components/input/settings-intent-host.js';
import { handleMcpIntent } from './components/input/mcp-intent-host.js';
import { registerSandboxNetworkApprovalHandler, } from './utils/shell/sandbox/sandbox-network-approval.js';
import { SandboxNetworkApprovalCoordinator } from './utils/shell/sandbox/sandbox-network-approval-coordinator.js';
import { useFirstRunSetupGate } from './hooks/use-first-run-setup.js';
import { TOOL_NAME_ASK_USER } from './tools/tool-names.js';
import { copyToClipboard } from './utils/clipboard.js';
import { isConversationLocked, getConversationLockPath, loadConversationForProject, loadLastConversation, } from './services/conversation/conversation-persistence.js';
import { listRecentConversations } from './services/conversation/recent-conversations.js';
import { profileIdFromLegacyMode } from './services/profiles/legacy-adapter.js';
import { composeSessionRolloverBrief } from './services/session-rollover/session-rollover-brief.js';
import { formatGoalClosedByCheck } from './services/conversation/durable-goal.js';
function projectNestedApproval(nestedApproval) {
    if (!nestedApproval)
        return null;
    // The prepared call is the source of truth for what the approval prompt
    // must show. A descriptor can cross the observer boundary with placeholder
    // arguments, especially for nested calls assembled outside the run loop.
    if (nestedApproval.preparedArguments === undefined)
        return nestedApproval.approval;
    try {
        return {
            ...nestedApproval.approval,
            argumentsText: JSON.stringify(nestedApproval.preparedArguments),
        };
    }
    catch {
        return nestedApproval.approval;
    }
}
/**
 * How long the composer must be quiet before the large-uncached-input advisory
 * is recomputed. Long enough that a burst of typing costs one pass instead of
 * one per character, short enough that the notice appears while the user is
 * still looking at the text that triggered it.
 */
const LARGE_UNCACHED_PREVIEW_DEBOUNCE_MS = 250;
/** How long after the last resize event the terminal must stay quiet before a redraw fires. */
const RESIZE_SETTLED_MS = 300;
const App = ({ conversationService, settingsService, historyService, loggingService, sshInfo, sshService, usageAccumulator, subagentUsageAccumulator, costAccumulator, onPrintUsage, onRestart, onExitUsage, sessionId: initialSessionId, initialMessages = [], restoredStaticMessageIds = EMPTY_RESTORED_STATIC_MESSAGE_IDS, logWriter, onRotateWriter, generateId, onSessionIdChange, onHasConversationContent, skillsService, terminalTitleBase, mcpManager = null, mcpOAuthStore = null, mcpStartupNotices, mcpUserConfigPath, mcpConfigController, controlSocket: initialControlSocket, controlSocketIsStartup = false, connectControlSocket, disconnectControlSocket, controlStartupNotice, controlSessionMetadata, initialGoal, appendGoal, onGoalRestore, goalAchievedSlot, }) => {
    const [goal, setGoalState] = useState(initialGoal);
    const [controlSocket, setControlSocket] = useState(initialControlSocket);
    const setGoal = useCallback((nextGoal, source) => {
        appendGoal?.(nextGoal, source);
        setGoalState(nextGoal);
    }, [appendGoal]);
    const { exit, waitUntilRenderFlush } = useApp();
    const restartPreparing = useRef(false);
    const [isRestartPreparing, setRestartPreparing] = useState(false);
    const { stdout } = useStdout();
    const { setInput, replaceInput, setImages } = useInputActions();
    const { input, mode, images: _images, controller } = useInputState();
    const menuOpen = typeof controller.getSnapshot === 'function'
        ? (controller.getSnapshot().stack?.length ?? 0) > 0
        : mode !== 'text';
    const [messageListEpoch, setMessageListEpoch] = useState(0);
    const [startupBannerIds, setStartupBannerIds] = useState(['startup-banner-0']);
    const [bannerStartsNewSession, setBannerStartsNewSession] = useState(false);
    const [activeRestoredStaticMessageIds, setActiveRestoredStaticMessageIds] = useState(restoredStaticMessageIds);
    const displayMode = useSetting(settingsService, 'ui.displayMode') ?? 'concise';
    const sessionUsage = useMemo(() => usageAccumulator ?? createUsageAccumulator(), [usageAccumulator]);
    const subagentUsage = useMemo(() => subagentUsageAccumulator ?? createUsageAccumulator(), [subagentUsageAccumulator]);
    const sessionCost = useMemo(() => costAccumulator ?? createSessionCostAccumulator(), [costAccumulator]);
    const [sessionId, setSessionId] = useState(initialSessionId);
    const [backgroundTaskManagerOpen, setBackgroundTaskManagerOpen] = useState(false);
    const handleClearConversationRef = useRef(null);
    const sessionRolloverHandlerRef = useRef(null);
    const latestRotatedSessionIdRef = useRef(undefined);
    const pendingRolloverSuccessorIdRef = useRef(undefined);
    const pendingSkillRef = useRef(null);
    const sandboxApprovalCoordinatorRef = useRef(null);
    const [sandboxPromptRequest, setSandboxPromptRequest] = useState(null);
    const notifier = useTerminalFocusNotifier({ stdout, settingsService, loggingService });
    useEffect(() => {
        const coordinator = new SandboxNetworkApprovalCoordinator();
        sandboxApprovalCoordinatorRef.current = coordinator;
        const unsubscribe = coordinator.subscribe(() => {
            setSandboxPromptRequest(coordinator.getSnapshot().activeRequest);
        });
        const unregister = registerSandboxNetworkApprovalHandler(async (request) => {
            return await coordinator.request(request);
        });
        return () => {
            unregister();
            unsubscribe();
            if (sandboxApprovalCoordinatorRef.current === coordinator) {
                sandboxApprovalCoordinatorRef.current = null;
            }
            coordinator.dispose();
        };
    }, []);
    const { messages, lastUsage, costSummary, lastCodexRateLimit, runBudgetNotice, pendingApproval, nestedApproval, resolveNestedApproval, waitingForApproval, waitingForRejectionReason, setWaitingForRejectionReason, waitingForAskUserAnswer, setWaitingForAskUserAnswer, currentAskUserQuestionIndex, isProcessing, thinkingStartedAt, retryCountdown, toolCallStreamingInfo, liveStreamingSpeed, backgroundSubagentTasks, backgroundSubagentTasksNow, backgroundTaskDetails, backgroundTaskDetailsNow, listBackgroundTaskDetails, getBackgroundTaskDetails, stopBackgroundTask, getForegroundTaskTransferCandidate, moveForegroundTaskToBackground, listForegroundTaskTransferCandidates, backgroundSubagentApproval, resolveBackgroundSubagentApproval, sendUserMessage, sendSessionRolloverBrief, admissionConfirmation, submitTurnForAdmission, resolveAdmissionConfirmation, submitConversationTurn, submitApprovalDecision, handleApprovalDecision, onTypeAnswer, clearConversation, resetConversationPresentation, restoreConversation, stopProcessing, stopProcessingWithNotice, cancelAskUser, rewindToTarget, retryLastToolOutput, retryLastFailedTurn, compactContext, getUserMessages, setModelSelection, setReasoningEffort, addSystemMessage, addDividerMessage, setTemperature, addShellMessage, getSubagentUsage, goToPreviousQuestion, goToNextQuestion, queueActive: _queueActive, queuePaused, queueLength, queuePauseReason, pendingQueuedMessages, resumeQueue, discardQueue, retractPendingSubmission, editPendingSubmission, getCostSummary, } = useConversation({
        conversationService,
        loggingService,
        usageAccumulator: sessionUsage,
        subagentUsageAccumulator: subagentUsage,
        costAccumulator: sessionCost,
        initialMessages,
        sessionId,
        onClear: useCallback(async () => {
            if (handleClearConversationRef.current) {
                await handleClearConversationRef.current();
            }
        }, []),
        onSessionRollover: (request) => sessionRolloverHandlerRef.current?.(request),
        settingsService,
        historyService,
        replaceInput,
        onRestoreInput: setInput,
        logWriter,
        notifier,
        controlSocket,
        controlSessionMetadata,
    });
    useEffect(() => {
        if (controlStartupNotice)
            addSystemMessage(controlStartupNotice);
    }, [controlStartupNotice, addSystemMessage]);
    // A recorded achieved goal_check closes the goal at the root stop seam, while
    // the turn is still running. Persist it through the /goal achieved path now,
    // so prompt state and /clear carry the achieved goal, and show the notice once
    // the turn ends, after the model's final summary.
    const turnActiveForGoalNoticeRef = useRef(isProcessing);
    turnActiveForGoalNoticeRef.current = isProcessing;
    const pendingGoalNoticeRef = useRef(null);
    useEffect(() => {
        if (!goalAchievedSlot)
            return;
        const handler = (achieved) => {
            try {
                setGoal(achieved, 'goal_check');
            }
            catch (error) {
                addSystemMessage(`Goal update failed: ${error instanceof Error ? error.message : String(error)}`);
                throw error;
            }
            const notice = formatGoalClosedByCheck(achieved);
            if (turnActiveForGoalNoticeRef.current)
                pendingGoalNoticeRef.current = notice;
            else
                addSystemMessage(notice);
        };
        goalAchievedSlot.handler = handler;
        return () => {
            if (goalAchievedSlot.handler === handler)
                goalAchievedSlot.handler = undefined;
        };
    }, [goalAchievedSlot, setGoal, addSystemMessage]);
    useEffect(() => {
        if (isProcessing || !pendingGoalNoticeRef.current)
            return;
        addSystemMessage(pendingGoalNoticeRef.current);
        pendingGoalNoticeRef.current = null;
    }, [isProcessing, addSystemMessage]);
    // Keep older test/integration harnesses compatible while the session facade
    // rolls out the adopted-subagent approval channel.
    const backgroundApprovalState = backgroundSubagentApproval ?? { revision: 0, current: null, pendingCount: 0, closed: false };
    const backgroundApprovalEntry = backgroundApprovalState.current;
    const rolloverSourceSessionIdRef = useRef(undefined);
    // Notify cli.tsx when the conversation has content so it can decide whether
    // to show the "To resume this conversation" message.
    useEffect(() => {
        onHasConversationContent?.(messagesHaveNonSystemContent(messages));
    }, [messages, onHasConversationContent]);
    const handleClearConversation = useCallback(async () => {
        const newId = pendingRolloverSuccessorIdRef.current ?? generateId();
        pendingRolloverSuccessorIdRef.current = undefined;
        latestRotatedSessionIdRef.current = newId;
        const newCreatedAt = new Date().toISOString();
        const rolloverFrom = rolloverSourceSessionIdRef.current;
        rolloverSourceSessionIdRef.current = undefined;
        if (onRotateWriter) {
            onRotateWriter(newId, newCreatedAt, rolloverFrom);
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
    const configurationService = useMemo(() => new ConversationConfigurationService({
        setModelSelection,
        setReasoningEffort,
        setTemperature,
        conversationService,
        settingsService,
    }), [setModelSelection, setReasoningEffort, setTemperature, conversationService, settingsService]);
    const queueModeNotice = useCallback((text) => conversationService.queueModeNotice(text), [conversationService]);
    const profileTransitionService = useMemo(() => new ProfileTransitionService({
        settingsService,
        rebuildAgent: () => setModelSelection(settingsService.get('agent.modelSelection')),
        queueModeNotice,
    }), [setModelSelection, queueModeNotice, settingsService]);
    const applyRuntimeSetting = useCallback((key, value) => configurationService.applyRuntimeSetting(key, value), [configurationService]);
    const firstRunSetup = useFirstRunSetupGate({
        settingsService,
        controller,
    });
    const shellInteractionSession = useMemo(() => new ShellInteractionSession({
        settingsService,
        conversationSink: conversationService,
        sshInfo,
        sshService,
    }), [conversationService, settingsService, sshInfo, sshService]);
    const { isShellMode, activeCommand, enterShellMode, exitShellMode, handleShellSubmit } = useShellMode({
        session: shellInteractionSession,
        addShellMessage,
        replaceInput,
    });
    const clearConversationAndRefreshBanner = useCallback(async () => {
        onPrintUsage?.();
        const isRollover = rolloverSourceSessionIdRef.current !== undefined;
        await clearConversation();
        if (goal && !isRollover)
            appendGoal?.(goal);
        setStartupBannerIds(['startup-banner-0']);
        setBannerStartsNewSession(true);
        setActiveRestoredStaticMessageIds([]);
        setMessageListEpoch((epoch) => epoch + 1);
    }, [appendGoal, clearConversation, goal, onPrintUsage]);
    sessionRolloverHandlerRef.current = async (request) => {
        const sourceSessionId = sessionId;
        const taskInventory = (conversationService.backgroundTaskControl?.listDetails?.() ?? []).map((task) => ({
            kind: task.kind,
            id: task.id,
            status: task.status,
        }));
        conversationService.logSessionRollover({
            type: 'session_rollover',
            phase: 'requested',
            rolloverId: request.rolloverId,
            sourceSessionId,
            ...(request.reason ? { reason: request.reason } : {}),
            briefSize: request.brief.length,
            ...(request.providerInputTokens !== undefined ? { providerInputTokens: request.providerInputTokens } : {}),
        });
        const plannedSuccessorId = generateId();
        const successorCreatedAt = new Date().toISOString();
        const canRolloverInPlace = typeof conversationService.prepareRolloverWithNewId === 'function';
        // Admission must happen before rotating persistence. The returned callback
        // is the commit seam: after the writer runs, runtime rollover is a checked,
        // synchronous mutation and has no remaining admission point that can reject.
        const commitRollover = canRolloverInPlace
            ? conversationService.prepareRolloverWithNewId(plannedSuccessorId, successorCreatedAt)
            : undefined;
        pendingRolloverSuccessorIdRef.current = plannedSuccessorId;
        latestRotatedSessionIdRef.current = plannedSuccessorId;
        rolloverSourceSessionIdRef.current = sessionId;
        try {
            onPrintUsage?.();
            if (canRolloverInPlace) {
                if (onRotateWriter) {
                    onRotateWriter(plannedSuccessorId, successorCreatedAt, sourceSessionId, goal);
                }
                commitRollover?.();
            }
            else {
                // Compatibility harnesses predating the in-place seam retain the old
                // clear path; production ConversationService always has the method.
                await clearConversationAndRefreshBanner();
            }
        }
        catch (error) {
            pendingRolloverSuccessorIdRef.current = undefined;
            latestRotatedSessionIdRef.current = undefined;
            rolloverSourceSessionIdRef.current = undefined;
            throw error;
        }
        pendingRolloverSuccessorIdRef.current = undefined;
        rolloverSourceSessionIdRef.current = undefined;
        if (canRolloverInPlace) {
            setSessionId(plannedSuccessorId);
            resetConversationPresentation();
            onSessionIdChange?.(plannedSuccessorId, successorCreatedAt);
            setStartupBannerIds(['startup-banner-0']);
            setBannerStartsNewSession(true);
            setActiveRestoredStaticMessageIds([]);
            setMessageListEpoch((epoch) => epoch + 1);
        }
        const successorSessionId = latestRotatedSessionIdRef.current;
        if (!successorSessionId)
            throw new Error('Session rollover completed without a successor session ID.');
        const settlementLatencyMs = Math.max(0, Date.now() - request.requestedAt);
        conversationService.logSessionRollover({
            type: 'session_rollover',
            phase: 'completed',
            rolloverId: request.rolloverId,
            sourceSessionId,
            successorSessionId,
            ...(request.reason ? { reason: request.reason } : {}),
            briefSize: request.brief.length,
            ...(request.providerInputTokens !== undefined ? { providerInputTokens: request.providerInputTokens } : {}),
            settlementLatencyMs,
        });
        const briefing = composeSessionRolloverBrief({
            previousSessionId: sourceSessionId,
            request,
            taskInventory,
        });
        await sendSessionRolloverBrief(briefing);
    };
    const handoff = useHandoffFlow({
        clearConversationAndRefreshBanner,
        addSystemMessage,
        sendUserMessage,
        replaceInput,
        controller,
        settingsService,
        applyRuntimeSetting,
        queueModeNotice,
        setModelSelection,
        configurationService,
    });
    // The composer owns this live preview because it changes as the user types;
    // admitted turns and confirmation state belong to ConversationAdmissionWorkflow.
    //
    // The preview can cost a full outgoing-history build plus a serialization of
    // it (when a warning is actually possible), so it scales with conversation
    // length. Keep it off the keystroke path: debounce the composer text, then
    // evaluate in an effect so the work never sits inside a render. The
    // authoritative check still runs at submit time in ConversationAdmissionWorkflow.
    // An emptied composer flushes immediately so a stale warning never outlives
    // the text it described.
    const hasActiveBackgroundTasks = (backgroundTaskDetails ?? []).some((task) => task.status === 'running' ||
        task.status === 'cancelling' ||
        task.status === 'awaiting_approval' ||
        task.status === 'waiting_for_answer');
    const isOverallBusy = isProcessing || hasActiveBackgroundTasks;
    const grokCreditUsage = useGrokCreditUsage(settingsService, isOverallBusy);
    const openCodeGoUsage = useOpenCodeGoUsage(settingsService, isOverallBusy);
    const previewInput = useDebouncedValue(input, LARGE_UNCACHED_PREVIEW_DEBOUNCE_MS, (value) => value === '');
    const [largeUncachedPreview, setLargeUncachedPreview] = useState(null);
    useEffect(() => {
        if (!previewInput || mode !== 'text' || previewInput.startsWith('/') || isProcessing) {
            setLargeUncachedPreview(null);
            return;
        }
        const preview = conversationService.previewLargeUncachedInput({ text: previewInput }, Date.now());
        setLargeUncachedPreview(preview.action === 'warn' ? preview : null);
    }, [conversationService, previewInput, mode, isProcessing]);
    // Drop the advisory on the same render that empties the composer / leaves text
    // mode or starts processing; don't wait a frame for the effect to clear a stale warn.
    const largeUncachedWarning = !previewInput || mode !== 'text' || previewInput.startsWith('/') || isProcessing ? null : largeUncachedPreview;
    const pendingSurgeTurn = admissionConfirmation?.kind === 'surge' ? admissionConfirmation.turn : null;
    const pendingSurgeReason = admissionConfirmation?.kind === 'surge' ? admissionConfirmation.reason : '';
    const pendingLargeUncachedTurn = admissionConfirmation?.kind === 'large_uncached' ? admissionConfirmation.turn : null;
    const pendingLargeUncachedTokens = admissionConfirmation?.kind === 'large_uncached' ? admissionConfirmation.estimatedTokens : 0;
    const resolveAdmission = useCallback(async (decision) => {
        const confirmation = admissionConfirmation;
        if (!confirmation)
            return;
        const result = resolveAdmissionConfirmation(confirmation.id, decision);
        if (result.kind === 'stale')
            return;
        if (result.kind === 'declined') {
            queueMicrotask(() => replaceInput(result.turn.text || ''));
            return;
        }
        if (result.kind !== 'submitted')
            return;
        // Composer attachments are presentation state, and only a decision that
        // matched the displayed confirmation may clear them.
        replaceInput('');
        if (decision === 'approve')
            setImages([]);
        await result.completion;
    }, [admissionConfirmation, replaceInput, resolveAdmissionConfirmation, setImages]);
    const handleLargeUncachedApprove = useCallback(() => resolveAdmission('approve'), [resolveAdmission]);
    const handleLargeUncachedDecline = useCallback(() => resolveAdmission('decline'), [resolveAdmission]);
    const handleSurgeApprove = useCallback(() => resolveAdmission('approve'), [resolveAdmission]);
    const handleSurgeDecline = useCallback(() => resolveAdmission('decline'), [resolveAdmission]);
    const [pendingModeSwitch, setPendingModeSwitch] = useState(null);
    const handleModeSwitchConfirm = useCallback(async () => {
        if (!pendingModeSwitch)
            return;
        const { targetProfileId, modeLabel, targetValue, enabledDetail } = pendingModeSwitch;
        setPendingModeSwitch(null);
        await clearConversationAndRefreshBanner();
        profileTransitionService.activate(targetProfileId);
        addSystemMessage('Welcome to term²! Type a message to start chatting.');
        addSystemMessage(`${modeLabel} mode ${targetValue ? `enabled${enabledDetail ?? ''}` : 'disabled'}`);
    }, [pendingModeSwitch, clearConversationAndRefreshBanner, profileTransitionService, addSystemMessage]);
    const handleModeSwitchDecline = useCallback(() => {
        setPendingModeSwitch(null);
    }, []);
    const submitAdmittedTurn = useCallback(async (turn, options, submittedEditor = controller.getSnapshot().editor) => {
        const result = options ? submitTurnForAdmission(turn, options) : submitTurnForAdmission(turn);
        if (result.kind === 'submitted') {
            // A delayed queued-edit fallback may submit older text, and routing
            // may yield while another draft is typed. Clear only the submitted draft.
            if (submittedEditor.text === turn.text &&
                controller.getSnapshot().editor.revision === submittedEditor.revision) {
                replaceInput('');
            }
            await result.completion;
        }
    }, [controller, replaceInput, submitTurnForAdmission]);
    const redrawMessageList = useCallback(() => {
        clearTerminalForRedraw(stdout);
        setMessageListEpoch((epoch) => epoch + 1);
    }, [stdout]);
    const resumeProjectPath = sshInfo?.remoteDir ?? process.cwd();
    const resumeSshHost = sshInfo?.host;
    const listSavedConversations = useCallback(() => listRecentConversations(resumeProjectPath, resumeSshHost, 10), [resumeProjectPath, resumeSshHost]);
    const resumeConversation = useCallback(async (target) => {
        if (isProcessing) {
            addSystemMessage('Wait for the current turn to finish before resuming another conversation.');
            return;
        }
        let restored = null;
        if (target) {
            const result = loadConversationForProject(target, resumeProjectPath, resumeSshHost);
            if (result.status === 'project_mismatch') {
                addSystemMessage(`Conversation ${target} belongs to project ${result.conversation.projectPath ?? 'unknown'}. Resume it from that project directory with term2 --resume ${target}, or use --fork to branch it here.`);
                return;
            }
            if (result.status === 'ambiguous') {
                addSystemMessage(`Conversation reference ${target} is ambiguous. Candidates: ${result.candidates
                    .map((candidate) => `${candidate.shortRef} (${candidate.id})`)
                    .join(', ')}.`);
                return;
            }
            if (result.status === 'unreadable') {
                addSystemMessage(`Conversation ${target} could not be read.`);
                return;
            }
            restored = result.status === 'loaded' ? result.conversation : null;
        }
        else {
            restored = loadLastConversation(resumeProjectPath, resumeSshHost);
        }
        if (!restored) {
            addSystemMessage(`No conversation found to resume (${target ?? 'last'}).`);
            return;
        }
        if (restored.id !== sessionId) {
            const lock = isConversationLocked(restored.id);
            if (lock?.status === 'held') {
                addSystemMessage(`Conversation ${restored.id} is already open in another terminal (pid ${lock.pid}). Close it first or use the CLI --fork option.`);
                return;
            }
            if (lock?.status === 'corrupt') {
                addSystemMessage(`Conversation ${restored.id} has a corrupt lockfile at ${getConversationLockPath(restored.id)}. Remove that file only after confirming no other terminal is using the conversation, or use --fork to continue from a branch.`);
                return;
            }
        }
        try {
            if (restored.id !== sessionId) {
                onRotateWriter?.(restored.id, restored.createdAt);
            }
            conversationService.resetWithNewId(restored.id);
            const profileId = restored.activeProfileId ?? (restored.appMode ? profileIdFromLegacyMode(restored.appMode) : undefined);
            const currentSelection = settingsService.get('agent.modelSelection');
            const changes = [
                ...(restored.model || restored.provider
                    ? [
                        {
                            key: 'agent.modelSelection',
                            value: {
                                model: restored.model ?? currentSelection.model,
                                provider: restored.provider ?? currentSelection.provider,
                            },
                            persistence: 'runtime',
                        },
                    ]
                    : []),
                ...(restored.reasoningEffort &&
                    ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(restored.reasoningEffort)
                    ? [{ key: 'agent.reasoningEffort', value: restored.reasoningEffort, persistence: 'runtime' }]
                    : []),
                ...(profileId ? [{ key: 'app.activeProfileId', value: profileId, persistence: 'runtime' }] : []),
            ];
            configurationService.apply(changes);
            const savedProviderMatches = !restored.provider || restored.provider === settingsService.get('agent.modelSelection').provider;
            const savedModelMatches = !restored.model || restored.model === settingsService.get('agent.modelSelection').model;
            restoreConversation({
                ...restored,
                previousResponseId: savedProviderMatches && savedModelMatches ? restored.previousResponseId : null,
            });
            setSessionId(restored.id);
            onSessionIdChange?.(restored.id, restored.createdAt);
            setActiveRestoredStaticMessageIds(restored.messages.map((message) => message.id));
            redrawMessageList();
            for (const warning of restored.replayWarnings) {
                addSystemMessage(`Conversation replay: ${warning}`);
            }
            addSystemMessage(`Resumed conversation: ${restored.id}`);
            onGoalRestore?.(restored.goal);
            setGoalState(restored.goal);
        }
        catch (error) {
            addSystemMessage(`Failed to resume conversation: ${error instanceof Error ? error.message : String(error)}`);
        }
    }, [
        addSystemMessage,
        configurationService,
        conversationService,
        isProcessing,
        onRotateWriter,
        onGoalRestore,
        onSessionIdChange,
        redrawMessageList,
        restoreConversation,
        resumeProjectPath,
        resumeSshHost,
        sessionId,
        settingsService,
    ]);
    // Resize redraw: Ink's <Static> renders committed messages once and never
    // re-renders them, so old messages retain their old width after a terminal
    // resize. When the terminal resizes, clear the visible screen and remount
    // MessageList (via epoch bump) to re-render everything at the new width.
    //
    // Gate on !isProcessing to avoid clearing while Ink's log-update is
    // diff-updating the live region mid-stream, which causes visual artifacts.
    // A settled debounce (300ms of quiet after the last resize event) coalesces
    // resize storms from tmux pane drags or window snaps.
    const pendingResizeRedrawRef = useRef(false);
    const isProcessingRef = useRef(isProcessing);
    isProcessingRef.current = isProcessing;
    useEffect(() => {
        // Guard: test mocks may not provide EventEmitter methods on stdout.
        if (typeof stdout.on !== 'function' ||
            typeof stdout.off !== 'function')
            return;
        const emitter = stdout;
        let timer = null;
        const handleResize = () => {
            if (timer !== null)
                clearTimeout(timer);
            timer = setTimeout(() => {
                timer = null;
                if (isProcessingRef.current) {
                    pendingResizeRedrawRef.current = true;
                    return;
                }
                clearVisibleForResize(stdout);
                setMessageListEpoch((epoch) => epoch + 1);
            }, RESIZE_SETTLED_MS);
        };
        emitter.on('resize', handleResize);
        return () => {
            emitter.off('resize', handleResize);
            if (timer !== null)
                clearTimeout(timer);
        };
    }, [stdout]);
    // When processing ends and a resize redraw was deferred, apply it now.
    useEffect(() => {
        if (isProcessing || !pendingResizeRedrawRef.current)
            return;
        pendingResizeRedrawRef.current = false;
        clearVisibleForResize(stdout);
        setMessageListEpoch((epoch) => epoch + 1);
    }, [isProcessing, stdout]);
    const getSessionUsage = useCallback(() => {
        const tokenUsage = formatSessionUsageBreakdown(sessionUsage.get(), getSubagentUsage());
        const modelUsage = formatModelUsageBreakdown(sessionCost.getModelUsageBreakdown());
        const summary = getCostSummary();
        if (!summary || summary.state === 'unavailable') {
            return modelUsage ? `${tokenUsage}\n${modelUsage}` : tokenUsage;
        }
        const costLabel = summary.state === 'exact' ? 'Cost' : 'Estimated cost';
        const costAmount = `${formatUsdMicros(summary.knownUsdMicros)}${summary.state === 'partial' ? '+' : ''}`;
        const lowerBound = summary.state === 'partial' ? ' (lower bound)' : '';
        const costUsage = `${costLabel}: ${costAmount}${lowerBound} (${summary.pricedRequests} priced, ${summary.unpricedRequests} unpriced requests)`;
        return [tokenUsage, modelUsage, costUsage].filter(Boolean).join('\n');
    }, [getCostSummary, getSubagentUsage, sessionCost, sessionUsage]);
    const staticCommitBlocker = useMemo(() => detectStaticCommitBlocker(messages, { displayMode }), [messages, displayMode]);
    const exitWithUsage = useCallback(() => {
        exit();
        onExitUsage?.();
    }, [exit, onExitUsage]);
    const handleSkillSelected = useCallback((skill) => {
        pendingSkillRef.current = skill;
    }, []);
    /**
     * Put a rewound turn back where the user can edit it. Images ride along the
     * same way history recall restores them, so rewinding a multimodal turn does
     * not silently drop its attachments.
     */
    const restoreTurnToInput = useCallback((turn) => {
        replaceInput(turn.text);
        setImages(turn.images ?? []);
    }, [replaceInput, setImages]);
    /** Rewind candidates carry a domain target id plus a UI-only trim boundary. */
    const openRewindPickerItems = useCallback(() => buildRewindItems(getUserMessages(), conversationService.listRewindTargets()), [getUserMessages, conversationService]);
    const openRewindMenu = useCallback((disposition) => {
        const items = openRewindPickerItems();
        if (items.length === 0) {
            addSystemMessage('Nothing to rewind.');
            return;
        }
        // An external surface owns the interaction from this point; discard any
        // text-triggered frame that was used to invoke the command.
        controller.closeAll();
        controller.open({ kind: 'rewind', items, initialDisposition: disposition });
    }, [addSystemMessage, controller, openRewindPickerItems]);
    const openCopyMenu = useCallback((selections) => {
        controller.closeAll();
        controller.open({ kind: 'copy', items: selections }, { buffer: { type: 'clear' } });
    }, [controller]);
    const handleCopySelection = useCallback((selection) => {
        void copyToClipboard(selection.text)
            .then(() => {
            addSystemMessage(`Copied ${selection.label.toLowerCase()} to the clipboard.`);
        })
            .catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            addSystemMessage(`Failed to copy to clipboard: ${message}`);
        });
    }, [addSystemMessage]);
    // /clear, /quit and /resume reset the UI, so the typed command must leave the composer first.
    const clearConversationFromCommand = useMemo(() => clearInputBeforeReset({ replaceInput, waitUntilRenderFlush }, clearConversationAndRefreshBanner), [replaceInput, waitUntilRenderFlush, clearConversationAndRefreshBanner]);
    const resumeConversationFromUi = useMemo(() => clearInputBeforeReset({ replaceInput, waitUntilRenderFlush }, resumeConversation), [replaceInput, waitUntilRenderFlush, resumeConversation]);
    const exitFromCommand = useMemo(() => clearInputBeforeReset({ replaceInput, waitUntilRenderFlush }, exitWithUsage), [replaceInput, waitUntilRenderFlush, exitWithUsage]);
    const restartFromCommand = async (stopBackground) => {
        if (restartPreparing.current)
            throw new Error('Restart is already preparing.');
        if (activeCommand || pendingSurgeTurn || pendingLargeUncachedTurn) {
            throw new Error('Finish the foreground shell or pending input confirmation before restarting.');
        }
        if (!onRestart)
            throw new Error('Restart is unavailable in this host.');
        restartPreparing.current = true;
        setRestartPreparing(true);
        try {
            // Clear and paint before acquiring the final service handoff, never afterward.
            replaceInput('');
            await waitUntilRenderFlush();
            await onRestart(stopBackground, exit);
        }
        catch (error) {
            restartPreparing.current = false;
            setRestartPreparing(false);
            throw error;
        }
    };
    const { slashCommands, cycleAppModes } = useAppCommands({
        restart: restartFromCommand,
        settingsService,
        transitionService: profileTransitionService,
        addSystemMessage,
        addDividerMessage,
        applyRuntimeSetting,
        replaceInput,
        clearConversation: clearConversationFromCommand,
        getGoal: () => goal,
        setGoal,
        getSessionUsage,
        refreshProviderUsage: () => {
            grokCreditUsage.refresh();
            openCodeGoUsage.refresh();
        },
        exit: exitFromCommand,
        messages,
        setModelSelection,
        getRewindItems: openRewindPickerItems,
        rewindToTarget: (item) => rewindToTarget(item.targetId, item.uiIndex),
        restoreTurnToInput,
        retryLastToolOutput,
        retryLastFailedTurn,
        compactContext,
        onRewind: redrawMessageList,
        openRewindMenu,
        openProvidersMenu: () => {
            controller.closeAll();
            controller.open({ kind: 'providers' });
        },
        openMcpMenu: mcpManager && mcpConfigController
            ? () => {
                controller.closeAll();
                controller.open({ kind: 'mcp' });
            }
            : undefined,
        openCopyMenu,
        onHandoff: handoff.startHandoff,
        sendUserMessage,
        skillsService: skillsService ?? { getAvailableSkills: () => [] },
        onSkillSelected: handleSkillSelected,
        requestModeSwitchConfirm: setPendingModeSwitch,
        turnInFlight: isProcessing || isRestartPreparing,
        listConversations: listSavedConversations,
        resumeConversation: resumeConversationFromUi,
        mcpManager,
        mcpOAuthStore,
        mcpUserConfigPath,
        controlSocket,
        controlSocketIsStartup,
        getSessionId: () => sessionId,
        connectControlSocket: connectControlSocket
            ? async (name) => {
                const server = await connectControlSocket(name);
                setControlSocket(server);
                return server;
            }
            : undefined,
        disconnectControlSocket: disconnectControlSocket
            ? async (server) => {
                await disconnectControlSocket(server);
                setControlSocket(undefined);
            }
            : undefined,
    });
    useMcpNotices({
        manager: mcpManager,
        ...(mcpStartupNotices ? { startupNotices: mcpStartupNotices } : {}),
        addSystemMessage,
    });
    const handleRewindSelect = useCallback((item, disposition) => {
        const rewound = rewindToTarget(item.targetId, item.uiIndex);
        if (!rewound)
            return;
        redrawMessageList();
        if (disposition === 'resend') {
            replaceInput('');
            setImages([]);
            void sendUserMessage({ text: rewound.text, ...(rewound.images?.length ? { images: rewound.images } : {}) });
            return;
        }
        restoreTurnToInput(rewound);
    }, [rewindToTarget, redrawMessageList, replaceInput, restoreTurnToInput, sendUserMessage, setImages]);
    const handleTypeAnswer = useCallback((initialAnswer) => {
        if (initialAnswer !== undefined) {
            // Seed the composer with the selected answer and a separator so the
            // next characters become an appended note rather than joining words.
            setInput(`${initialAnswer} `);
        }
        onTypeAnswer();
    }, [onTypeAnswer, setInput]);
    const handleApprove = useCallback(async (answer) => {
        if (sandboxPromptRequest) {
            sandboxApprovalCoordinatorRef.current?.resolve(sandboxPromptRequest, answer ?? 'allow-once');
            return;
        }
        if (backgroundApprovalEntry) {
            resolveBackgroundSubagentApproval({
                revision: backgroundApprovalState.revision,
                entry: backgroundApprovalEntry,
                decision: { answer: answer ?? 'yes' },
            });
            return;
        }
        if (nestedApproval && !pendingApproval) {
            await resolveNestedApproval({ answer: answer ?? 'y' });
            return;
        }
        await submitApprovalDecision(answer);
    }, [
        backgroundApprovalEntry,
        backgroundApprovalState.revision,
        resolveBackgroundSubagentApproval,
        nestedApproval,
        pendingApproval,
        resolveNestedApproval,
        sandboxPromptRequest,
        submitApprovalDecision,
    ]);
    const handleReject = useCallback(() => {
        if (sandboxPromptRequest) {
            sandboxApprovalCoordinatorRef.current?.resolve(sandboxPromptRequest, 'deny');
            return;
        }
        if (backgroundApprovalEntry) {
            setWaitingForRejectionReason(true);
            return;
        }
        if (nestedApproval && !pendingApproval) {
            setWaitingForRejectionReason(true);
            return;
        }
        // A check-in has no tool to deny and its decision path discards any reason.
        // Asking "Why?" here strands the user: the composer refuses an empty
        // submit, so Stop could only be reached by typing text nothing reads.
        if (pendingApproval?.checkIn) {
            void handleApprovalDecision('n', undefined);
            return;
        }
        setWaitingForRejectionReason(true);
    }, [
        backgroundApprovalEntry,
        backgroundApprovalState.revision,
        handleApprovalDecision,
        pendingApproval,
        resolveBackgroundSubagentApproval,
        sandboxPromptRequest,
        setWaitingForRejectionReason,
        nestedApproval,
    ]);
    const handleCancelApproval = useCallback(() => {
        if (sandboxPromptRequest) {
            sandboxApprovalCoordinatorRef.current?.resolve(sandboxPromptRequest, 'deny');
            return;
        }
        if (backgroundApprovalEntry) {
            resolveBackgroundSubagentApproval({
                revision: backgroundApprovalState.revision,
                entry: backgroundApprovalEntry,
                decision: { answer: 'no', rejectionReason: undefined },
            });
            return;
        }
        if (nestedApproval && !pendingApproval) {
            stopProcessing();
            return;
        }
        if (pendingApproval?.toolName === 'ask_user') {
            // Graceful cancel: resolve the question with no answer while keeping the
            // turn's record (see use-conversation cancelAskUser).
            cancelAskUser();
            return;
        }
        // Escape in a regular approval prompt means “cancel/interrupt the turn”:
        // abort the run loop and drop the pending tool call.
        stopProcessing();
    }, [
        sandboxPromptRequest,
        backgroundApprovalEntry,
        backgroundApprovalState.revision,
        resolveBackgroundSubagentApproval,
        cancelAskUser,
        pendingApproval,
        nestedApproval,
        stopProcessing,
    ]);
    useEffect(() => {
        if (!controlSocket)
            return;
        const interrupt = () => {
            const hasInterruptibleSurface = Boolean(sandboxPromptRequest || backgroundApprovalEntry || nestedApproval || pendingApproval);
            if (hasInterruptibleSurface) {
                handleCancelApproval();
                return { accepted: true };
            }
            if (isProcessing || _queueActive || queueLength > 0) {
                stopProcessingWithNotice();
                return { accepted: true };
            }
            return { accepted: false, reason: 'idle' };
        };
        controlSocket.bindInterruptHandler(interrupt);
        return () => controlSocket.unbindInterruptHandler(interrupt);
    }, [
        _queueActive,
        backgroundApprovalEntry,
        controlSocket,
        handleCancelApproval,
        isProcessing,
        nestedApproval,
        pendingApproval,
        queueLength,
        sandboxPromptRequest,
        stopProcessingWithNotice,
    ]);
    const submitBridgedRejectionReason = useCallback(async (reason) => {
        if (backgroundApprovalEntry) {
            resolveBackgroundSubagentApproval({
                revision: backgroundApprovalState.revision,
                entry: backgroundApprovalEntry,
                decision: { answer: 'no', rejectionReason: reason },
            });
            setWaitingForRejectionReason(false);
            return;
        }
        if (nestedApproval && !pendingApproval) {
            await resolveNestedApproval({ answer: 'n', rejectionReason: reason });
            setWaitingForRejectionReason(false);
            return;
        }
        await handleApprovalDecision('n', reason);
    }, [
        backgroundApprovalEntry,
        backgroundApprovalState.revision,
        handleApprovalDecision,
        resolveBackgroundSubagentApproval,
        setWaitingForRejectionReason,
        nestedApproval,
        resolveNestedApproval,
        pendingApproval,
    ]);
    const backgroundPendingApproval = backgroundApprovalEntry
        ? {
            agentName: `${backgroundApprovalEntry.runId} (${backgroundApprovalEntry.toolName})`,
            toolName: backgroundApprovalEntry.toolName,
            argumentsText: backgroundApprovalEntry.argumentsText,
            rawInterruption: { runId: backgroundApprovalEntry.runId },
            callId: backgroundApprovalEntry.toolCallId,
        }
        : null;
    const effectivePendingApproval = sandboxPromptRequest === null
        ? backgroundPendingApproval ?? pendingApproval ?? projectNestedApproval(nestedApproval)
        : {
            agentName: 'Sandbox',
            toolName: 'sandbox_network_access',
            argumentsText: `Allow network access to ${sandboxPromptRequest.host}${sandboxPromptRequest.port == null ? '' : `:${sandboxPromptRequest.port}`}?`,
            rawInterruption: sandboxPromptRequest,
        };
    const effectiveWaitingForApproval = sandboxPromptRequest || backgroundPendingApproval || nestedApproval ? true : waitingForApproval;
    const effectiveWaitingForRejectionReason = sandboxPromptRequest ? false : waitingForRejectionReason;
    const effectiveWaitingForAskUserAnswer = sandboxPromptRequest ? false : waitingForAskUserAnswer;
    const effectiveIsProcessing = sandboxPromptRequest || backgroundPendingApproval || nestedApproval ? false : isProcessing;
    // Single source of truth for "which surface owns keyboard input right now."
    // Computed from the same effective state passed to BottomArea so the app
    // keyboard-shortcuts hook stays suppressed whenever a modal confirmation
    // prompt is rendered (Closing the Ink fan-out coupling — see input-owner.ts).
    const inputOwner = deriveInputOwner({
        handoffStage: handoff.handoffState?.stage ?? null,
        pendingModeSwitch,
        pendingSurgeTurn,
        pendingLargeUncachedTurn,
        waitingForApproval: effectiveWaitingForApproval,
        waitingForRejectionReason: effectiveWaitingForRejectionReason,
        waitingForAskUserAnswer: effectiveWaitingForAskUserAnswer,
        pendingApproval: effectivePendingApproval,
        queuePaused,
        inputValue: input,
        backgroundTaskManagerOpen,
        firstRunSetupActive: firstRunSetup.active,
        isProcessing: effectiveIsProcessing,
        menuOpen,
    });
    useEffect(() => {
        setTerminalTitle(buildTerminalTitleLabel(terminalTitleBase, isOverallBusy));
    }, [isOverallBusy, terminalTitleBase]);
    useEffect(() => {
        publishHarnessInputState({ owner: inputOwner.kind, processing: effectiveIsProcessing, inputValue: input });
    }, [effectiveIsProcessing, input, inputOwner.kind]);
    const handleNavigateQuestion = useCallback((direction) => {
        if (direction === 'prev') {
            goToPreviousQuestion();
        }
        else {
            goToNextQuestion();
        }
    }, [goToPreviousQuestion, goToNextQuestion]);
    const { interruptConfirmVisible, markRejectionReasonInputReady } = useAppKeyboardShortcuts({
        exitWithUsage,
        onCtrlCConfirmHint: (message) => addSystemMessage(message),
        pendingSkillRef,
        waitingForAskUserAnswer: effectiveWaitingForAskUserAnswer,
        setWaitingForAskUserAnswer,
        waitingForRejectionReason: effectiveWaitingForRejectionReason,
        setWaitingForRejectionReason,
        inputMode: mode,
        inputValue: input,
        isProcessing: effectiveIsProcessing,
        waitingForApproval: effectiveWaitingForApproval,
        stopProcessing,
        handoffState: handoff.handoffState,
        cancelHandoff: handoff.cancelHandoff,
        pendingLargeUncachedTurn,
        cycleAppModes,
        replaceInput,
        onSkillActivationCancelled: () => addSystemMessage('Skill activation cancelled.'),
        approvalShortcutsEnabled: effectivePendingApproval?.toolName !== TOOL_NAME_ASK_USER && !effectivePendingApproval?.dockerHostControl,
        // Use authoritative request identities, not the rebuilt display descriptor
        // or queue revision (which also changes when an unrelated item is queued).
        approvalShortcutIdentity: sandboxPromptRequest ??
            (backgroundApprovalEntry
                ? JSON.stringify([
                    'background',
                    backgroundApprovalEntry.runId,
                    backgroundApprovalEntry.generation,
                    backgroundApprovalEntry.toolCallId,
                    backgroundApprovalEntry.toolName,
                    backgroundApprovalEntry.argumentsText,
                ])
                : pendingApproval ?? nestedApproval?.requestId ?? null),
        approvalShortcutApproveAnswer: sandboxPromptRequest || effectivePendingApproval?.deniedRead ? 'allow-once' : undefined,
        onApprove: handleApprove,
        onReject: handleReject,
        submitRejectionReason: submitBridgedRejectionReason,
        inputOwner,
    });
    const handleSubmit = async (turn, options) => {
        if (restartPreparing.current) {
            addSystemMessage('Restart is preparing; new input is not admitted.');
            return;
        }
        const submittedEditor = controller.getSnapshot().editor;
        if (backgroundApprovalEntry && waitingForRejectionReason) {
            resolveBackgroundSubagentApproval({
                revision: backgroundApprovalState.revision,
                entry: backgroundApprovalEntry,
                decision: { answer: 'no', rejectionReason: turn.text },
            });
            setWaitingForRejectionReason(false);
            return;
        }
        if (nestedApproval && !pendingApproval && waitingForRejectionReason) {
            await resolveNestedApproval({ answer: 'n', rejectionReason: turn.text });
            setWaitingForRejectionReason(false);
            return;
        }
        const value = turn.text;
        const hasImages = Boolean(turn.images?.length);
        if (!hasUserTurnContent(turn) && handoff.handoffState?.stage !== 'entering_message')
            return;
        if (isShellMode && !hasImages) {
            await handleShellSubmit(value);
            return;
        }
        if (await submitConversationTurn(turn)) {
            return;
        }
        if (await handoff.submitHandoffInput(turn)) {
            return;
        }
        const parsed = parseInput(value);
        const attachPendingSkill = (baseTurn) => {
            const pendingSkill = pendingSkillRef.current;
            if (!pendingSkill) {
                return baseTurn;
            }
            pendingSkillRef.current = null;
            return {
                ...baseTurn,
                skill: {
                    name: pendingSkill.name,
                    description: pendingSkill.description,
                    body: pendingSkill.body,
                },
            };
        };
        switch (parsed.type) {
            case 'slash-command': {
                if (hasImages) {
                    break;
                }
                if (tryExecuteSlashCommand(value, slashCommands, replaceInput, addSystemMessage)) {
                    return;
                }
                // Non-command slash text (including paths) remains a normal message.
                break;
            }
            case 'message':
                return await submitAdmittedTurn(attachPendingSkill(turn), options, submittedEditor);
        }
        await submitAdmittedTurn(attachPendingSkill(turn), options, submittedEditor);
    };
    const handleSettingChange = useCallback((key, value) => {
        applyRuntimeSetting(key, value);
        if (handoff.handoffState?.stage === 'selecting_effort' && key === 'agent.reasoningEffort') {
            void handoff.completeHandoffWithEffort(String(value));
        }
    }, [applyRuntimeSetting, handoff]);
    const handleConfigurationSettingChange = useCallback((key, value) => {
        if (handoff.handoffState?.stage === 'selecting_effort' && key === 'agent.reasoningEffort') {
            void handoff.completeHandoffWithEffort(String(value));
        }
    }, [handoff]);
    // The application effect host: executes typed domain intents only after
    // the controller has committed the required input and stack transition.
    // Settings/model and MCP application use correlated IntentResults (success
    // or field error) delivered back to the originating frame; rewind remains
    // fire-and-forget.
    useEffect(() => {
        controller.setIntentHost(({ intentRequest }) => {
            if (intentRequest.intent.type === 'rewind') {
                handleRewindSelect(intentRequest.intent.item, intentRequest.intent.disposition);
                return;
            }
            if (intentRequest.intent.type === 'submit-prompt') {
                // A captured handoff intercepts its own model selection here rather
                // than through `handleSubmit`: the direct `/model ` trigger is
                // controller-owned, so an accepted selection never routes through a
                // submitted turn. See `useHandoffFlow`'s `handleModelSubmitPrompt`.
                if (handoff.handleModelSubmitPrompt(intentRequest.intent.text)) {
                    return;
                }
                // Text composed by a controller-owned menu (e.g. accepting a direct
                // `/model gpt-4` selection) is exactly what the user would have
                // typed and pressed Enter on, so it goes through the same slash-
                // command dispatch as handleSubmit before falling back to sending it
                // as ordinary content — otherwise a resolved command like `/model`
                // would be posted to the model as a literal chat message instead of
                // being executed.
                if (tryExecuteSlashCommand(intentRequest.intent.text, slashCommands, replaceInput, addSystemMessage)) {
                    return;
                }
                void submitAdmittedTurn({ text: intentRequest.intent.text });
                return;
            }
            if (intentRequest.intent.type.startsWith('mcp-') && mcpManager && mcpConfigController) {
                return handleMcpIntent(intentRequest, {
                    manager: mcpManager,
                    configController: mcpConfigController,
                    login: (name) => {
                        slashCommands.find((command) => command.name === 'mcp-login')?.action(name);
                    },
                });
            }
            const result = handleSettingsIntent(intentRequest, {
                settingsService,
                configurationService,
                onSettingChange: handleConfigurationSettingChange,
                onSystemMessage: addSystemMessage,
                applyRuntimeSetting,
            });
            if (result?.ok &&
                intentRequest.intent.type === 'apply-settings' &&
                intentRequest.intent.changes.some((change) => change.key === 'agent.modelSelection')) {
                firstRunSetup.completeModelSelection();
            }
            return result;
        });
        return () => controller.setIntentHost(undefined);
    }, [
        controller,
        handleRewindSelect,
        submitAdmittedTurn,
        settingsService,
        handleSettingChange,
        addSystemMessage,
        applyRuntimeSetting,
        handoff,
        slashCommands,
        replaceInput,
        firstRunSetup,
        mcpManager,
        mcpConfigController,
    ]);
    return (React.createElement(ErrorBoundary, { loggingService: loggingService },
        React.createElement(Box, { flexDirection: "column", flexGrow: 1 },
            React.createElement(Box, { flexDirection: "column", flexGrow: 1 },
                React.createElement(MessageList, { key: messageListEpoch, displayMode: displayMode, messages: messages, bannerItems: startupBannerIds, bannerStartsNewSession: bannerStartsNewSession, settingsService: settingsService, restoredStaticMessageIds: activeRestoredStaticMessageIds, turnPaused: effectiveWaitingForApproval })),
            React.createElement(Box, { paddingX: MESSAGE_HORIZONTAL_PADDING },
                React.createElement(BottomArea, { pendingApproval: effectivePendingApproval, waitingForApproval: effectiveWaitingForApproval, waitingForRejectionReason: effectiveWaitingForRejectionReason, waitingForAskUserAnswer: effectiveWaitingForAskUserAnswer, currentAskUserQuestionIndex: currentAskUserQuestionIndex, isProcessing: effectiveIsProcessing, interruptConfirmVisible: interruptConfirmVisible, thinkingStartedAt: thinkingStartedAt, retryCountdown: retryCountdown, toolCallStreamingInfo: toolCallStreamingInfo, liveStreamingSpeed: liveStreamingSpeed, isShellMode: isShellMode, activeShellCommand: activeCommand, onShellModeEnter: enterShellMode, onShellModeExit: exitShellMode, lastUsage: lastUsage, costSummary: costSummary, queuePaused: queuePaused, queueLength: queueLength, queuePauseReason: queuePauseReason, onResumeQueue: resumeQueue, onDiscardQueue: discardQueue, pendingQueuedMessages: pendingQueuedMessages, backgroundSubagentTasks: backgroundSubagentTasks, backgroundSubagentTasksNow: backgroundSubagentTasksNow, backgroundTaskDetails: backgroundTaskDetails, backgroundTaskDetailsNow: backgroundTaskDetailsNow, listBackgroundTaskDetails: listBackgroundTaskDetails, getBackgroundTaskDetails: getBackgroundTaskDetails, stopBackgroundTask: stopBackgroundTask, getForegroundTaskTransferCandidate: getForegroundTaskTransferCandidate, moveForegroundTaskToBackground: moveForegroundTaskToBackground, listForegroundTaskTransferCandidates: listForegroundTaskTransferCandidates, backgroundTaskManagerOpen: backgroundTaskManagerOpen, onBackgroundTaskManagerOpenChange: setBackgroundTaskManagerOpen, backgroundApprovalPendingCount: backgroundApprovalState.pendingCount, onRetractQueuedMessage: retractPendingSubmission, onEditQueuedMessage: editPendingSubmission, onSubmit: handleSubmit, onRejectionReasonInputReady: markRejectionReasonInputReady, slashCommands: slashCommands, skillsService: skillsService, settingsService: settingsService, loggingService: loggingService, historyService: historyService, onApprove: handleApprove, onReject: handleReject, onCancel: handleCancelApproval, onTypeAnswer: handleTypeAnswer, onNavigateQuestion: handleNavigateQuestion, sshInfo: sshInfo, lastCodexRateLimit: lastCodexRateLimit, runBudgetNotice: runBudgetNotice, grokCreditUsage: grokCreditUsage.usage, openCodeGoUsage: openCodeGoUsage.usage, staticCommitBlocker: staticCommitBlocker, firstRunSetup: firstRunSetup, onProviderSelected: firstRunSetup.active ? firstRunSetup.onProviderSelected : undefined, onUnavailableModelSelected: firstRunSetup.requestSetup, onSkillSelected: handleSkillSelected, onCopySelection: handleCopySelection, listConversations: listSavedConversations, resumeConversation: resumeConversationFromUi, mcpManager: mcpManager ?? undefined, mcpConfigController: mcpConfigController, onSettingChange: handleSettingChange, onSystemMessage: addSystemMessage, handoffState: handoff.handoffState, onHandoffConfirm: handoff.confirmHandoff, onHandoffDecline: handoff.declineHandoff, onHandoffCancel: handoff.cancelHandoff, onStandardModeConfirm: handoff.confirmStandardMode, onStandardModeDecline: handoff.declineStandardMode, pendingModeSwitch: pendingModeSwitch, onModeSwitchConfirm: handleModeSwitchConfirm, onModeSwitchDecline: handleModeSwitchDecline, largeUncachedWarning: largeUncachedWarning, pendingLargeUncachedTurn: pendingLargeUncachedTurn, pendingLargeUncachedTokens: pendingLargeUncachedTokens, onLargeUncachedApprove: handleLargeUncachedApprove, onLargeUncachedDecline: handleLargeUncachedDecline, pendingSurgeTurn: pendingSurgeTurn, pendingSurgeReason: pendingSurgeReason, onSurgeApprove: handleSurgeApprove, onSurgeDecline: handleSurgeDecline })))));
};
export default App;
//# sourceMappingURL=app.js.map