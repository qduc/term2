import { resolveOutputAllocation } from '../agent-runtime/model-context-policy.js';
import { getCatalogModel } from '../../providers/model-catalog/catalog.js';
import { CONTEXT_COMPACTION_INSTRUCTIONS } from '../../prompts/context-compaction.js';
import { projectConversationMessage } from '../conversation/conversation-message-projection.js';
import { LocalContextCompactor, } from '../agent-runtime/context-compaction/local-context-compactor.js';
import { estimateContext } from '../agent-runtime/context-compaction/index.js';
import { ConversationRecord } from '../conversation/conversation-record.js';
import { createCheckpointSourceDigest, resolveCheckpointSourceRefs, } from '../conversation/conversation-checkpoint-provenance.js';
import { readConversationLogEnvelopes, generateId } from '../conversation/conversation-persistence.js';
import { ApprovalState } from '../approval/approval-state.js';
import { TurnItemAccumulator } from './turn-item-accumulator.js';
import { getMethod, getToolInfoFromInterruption } from '../interruption-info.js';
import { DelegatingShellAutoApprovalResolver, } from '../approval/shell-auto-approval-resolver.js';
import { ApprovalFlowCoordinator } from '../approval/approval-flow-coordinator.js';
import { SessionToolTracker } from './session-tool-tracker.js';
import { ConversationLogger } from '../logging/conversation-logger.js';
import { SessionInputPlanner } from './session-input-planner.js';
import { SessionLifecycle } from './session-lifecycle.js';
import { ProviderContinuity } from '../provider-continuity.js';
import { TurnCoordinator } from './turn-coordinator.js';
import { BackgroundCheckInScheduler } from './background-check-in-scheduler.js';
import { SessionStreamProcessor } from './session-stream-processor.js';
import { SessionRuntimeController } from './session-runtime-controller.js';
import { ContinuationPlanApplier } from './continuation-plan-applier.js';
import { ContinuationRecoveryHandler } from './continuation-recovery-handler.js';
import { DefaultConversationRecoveryPolicy } from '../retry/recovery-policy.js';
import { DefaultRecoveryExecutor } from '../retry/recovery-executor.js';
import { GenerationGuard } from '../generation-guard.js';
import { DefaultRetryClassifier } from '../retry/retry-classifier.js';
import { RetryEventPresenter } from '../retry/retry-event-presenter.js';
import { SessionTurnAdapter } from './session-turn-adapter.js';
import { SessionTurnDomain } from './session-turn-domain.js';
import { AutomaticMemoryFinalizer } from './automatic-memory-finalizer.js';
import { TurnStatusMachine } from './turn-status-machine.js';
import { TurnAttemptFactory } from './turn-attempt-factory.js';
import { InitialInputPreparer } from './initial-input-preparer.js';
import { InitialTurnRecoveryHandler } from './initial-turn-recovery-handler.js';
import { SessionContinuityReset } from './session-continuity-reset.js';
import { SessionIdentity } from './session-identity.js';
import { SubagentNotificationStore, } from '../subagents/subagent-notification-store.js';
import { BackgroundTaskControl, } from './background-task-control.js';
import { ToolApprovalPolicyRegistry } from '../approval/tool-approval-policy-registry.js';
import { PostExecutePendingRegistry, } from './post-execute-pending-registry.js';
import { HookEventFactory } from '../hooks/hook-event-factory.js';
import { PendingInteractionState } from './pending-interaction-state.js';
import { BackgroundSubagentApprovalController } from '../approval/background-subagent-approval-controller.js';
import { ToolCallMarkerStore } from '../../utils/streaming/extract-command-messages.js';
import { registerSessionRuntime } from '../workspace/active-workspace-root.js';
import { NestedApprovalOwner } from '../approval/nested-approval-owner.js';
import { resolveActiveEnforcement } from '../profiles/index.js';
const asAskUserAnswerSink = (value) => value && typeof value.setAskUserAnswer === 'function' ? value : null;
const asSubagentEventSinkHost = (value) => value && typeof value.setSubagentEventSink === 'function'
    ? value
    : null;
const asBackgroundShellEventSinkHost = (value) => value && typeof value.setBackgroundShellEventSink === 'function'
    ? value
    : null;
/**
 * Projects session-owned work into the coarse public lifecycle state.
 * Waiting interactions take precedence over unrelated active work: a caller
 * must never observe `working` while an approval is waiting for input.
 * Subagents are isolated from public hook status (docs/plans/agent-runtime/public-hooks-system.md);
 * only root foreground work and background shell jobs drive public status.
 */
export function computePublicStatus({ foregroundStatus, foregroundApprovalKind, backgroundDetails, }) {
    if (foregroundStatus === 'awaiting_approval') {
        return foregroundApprovalKind === 'ask_user' ? 'waiting_for_user' : 'waiting_for_approval';
    }
    let backgroundWorkPending = false;
    for (const detail of backgroundDetails) {
        if (detail.kind === 'shell') {
            if (detail.status === 'running' || detail.status === 'cancelling') {
                backgroundWorkPending = true;
            }
        }
    }
    if (foregroundStatus !== 'idle') {
        return 'working';
    }
    if (backgroundWorkPending) {
        return 'working';
    }
    return 'idle';
}
// ── Composition factory ───────────────────────────────────────────
export function createSessionRuntimeInternals(options) {
    const { sessionId: initialSessionId, sessionIdentity: suppliedIdentity, sessionStartedAt, agentClient, providerContinuity: suppliedProviderContinuity, providerRegistry, openAIRootCheckpointLifecycleObserver, toolOwnership, approvalPolicyRegistry: suppliedApprovalPolicyRegistry, postExecutePending: suppliedPostExecutePending, postExecutePauseCapability, sessionAccess, automaticMemory, askUserAnswerSink, subagentEventSinkHost, deps, retryOptions, turnAccumulator, hookLifecycle, hookEvents: suppliedHookEvents, toolCallMarkers: suppliedToolCallMarkers, enableNestedApproval = false, } = options;
    const startedAt = sessionStartedAt ?? new Date().toISOString();
    const identity = suppliedIdentity ?? new SessionIdentity(initialSessionId, startedAt);
    const id = identity.current;
    const { logger, settingsService, sessionContextService } = deps;
    const resolvedTurnAccumulator = turnAccumulator ?? new TurnItemAccumulator();
    const toolCallMarkers = suppliedToolCallMarkers ?? new ToolCallMarkerStore();
    const resolvedAskUserAnswerSink = askUserAnswerSink ?? asAskUserAnswerSink(agentClient);
    const resolvedSubagentEventSinkHost = subagentEventSinkHost ?? asSubagentEventSinkHost(agentClient);
    const resolvedBackgroundShellEventSinkHost = asBackgroundShellEventSinkHost(agentClient);
    // Graph-owned registry resolution. Root AgentClient instances expose the
    // registry their graph registered into; transient (subagent) clients expose
    // the subagent graph's registry supplied at creation. Either way this
    // instance IS the production authority for the session composed here — an
    // empty registry fails closed (every evaluation is `unknown`) but drifts
    // outcomes toward prompts/advisories, so both fallbacks warn loudly.
    // Resolve from the client only when the caller did not supply a registry,
    // preserving the composition seam's tolerance for null test clients.
    const clientRegistry = suppliedApprovalPolicyRegistry ? undefined : agentClient?.getApprovalPolicyRegistry?.();
    if (!suppliedApprovalPolicyRegistry && !clientRegistry) {
        logger.warn('Session composed without a graph-owned approval policy registry; using an isolated empty registry.', {
            eventType: 'session.approval_registry_fallback',
            category: 'approval',
            sessionId: id,
        });
    }
    const approvalPolicyRegistry = suppliedApprovalPolicyRegistry ?? clientRegistry ?? new ToolApprovalPolicyRegistry();
    if (approvalPolicyRegistry.size === 0) {
        logger.warn('Session approval policy registry holds zero policies; every evaluation resolves `unknown`.', {
            eventType: 'session.approval_registry_empty',
            category: 'approval',
            sessionId: id,
        });
    }
    // Background (async) subagent runs settle whenever they settle, including
    // while the conversation is idle and no per-turn sink is attached.
    let disposed = false;
    let syncPublicStatus = () => { };
    const notificationStore = new SubagentNotificationStore();
    let notificationObserver = null;
    let taskObserver = null;
    let backgroundSubagentEventObserver = null;
    const backgroundSubagentNotifications = {
        get pendingCount() {
            return notificationStore.pendingCount;
        },
        drain: () => notificationStore.drain(),
        retain: (notifications) => notificationStore.retain(notifications),
        enqueueUserControl: (notification) => notificationStore.enqueueUserControl(notification),
        setObserver: (observer) => {
            notificationObserver = observer;
        },
    };
    const backgroundSubagentTasks = {
        getSnapshot: () => notificationStore.getTaskSnapshot(),
        setObserver: (observer) => {
            taskObserver = observer;
        },
    };
    const backgroundTaskControl = new BackgroundTaskControl({
        client: agentClient,
        notifications: notificationStore,
        onNotification: () => {
            try {
                notificationObserver?.();
            }
            catch (error) {
                logger.warn('Background task control notification observer threw', {
                    eventType: 'subagent.control_notification_observer_failed',
                    category: 'subagent',
                    sessionId: id,
                    errorMessage: error instanceof Error ? error.message : String(error),
                });
            }
        },
        onTaskChange: () => {
            syncPublicStatus();
            try {
                taskObserver?.();
            }
            catch (error) {
                logger.warn('Background task control task observer threw', {
                    eventType: 'subagent.control_task_observer_failed',
                    category: 'subagent',
                    sessionId: id,
                    errorMessage: error instanceof Error ? error.message : String(error),
                });
            }
        },
    });
    // This controller owns background-child approval policy and FIFO ordering.
    // It intentionally does not touch ApprovalState, which owns the root turn.
    const backgroundSubagentApprovals = new BackgroundSubagentApprovalController({
        logger,
        sessionId: identity,
        toolOwnership,
        nestedCompatibility: getMethod(agentClient, 'getNestedToolCompatibilityState')?.call(agentClient),
    });
    const generationGuard = new GenerationGuard();
    // Factory-owned handles supply this same registry to the root tool policy.
    // Compatibility callers receive a fresh explicit token, never a wall-clock epoch.
    const postExecutePending = suppliedPostExecutePending ?? new PostExecutePendingRegistry({ sessionId: identity, epoch: crypto.randomUUID() });
    const providerContinuity = suppliedProviderContinuity ?? new ProviderContinuity();
    const record = new ConversationRecord({
        logger,
        providerContext: providerContinuity,
        checkpointObserver: openAIRootCheckpointLifecycleObserver,
    });
    const approvalState = new ApprovalState();
    const pendingInteraction = new PendingInteractionState();
    const nestedApprovalOwner = new NestedApprovalOwner(identity);
    if (enableNestedApproval)
        agentClient?.setNestedApprovalOwner?.(nestedApprovalOwner);
    const toolTracker = new SessionToolTracker();
    const shellAutoApproval = new DelegatingShellAutoApprovalResolver({
        record,
        agentClient,
        logger,
        settingsService,
        sessionContextService,
        sessionAccess,
    });
    const appState = { statusMachine: new TurnStatusMachine() };
    const hookEvents = suppliedHookEvents ?? (hookLifecycle ? new HookEventFactory({ sessionId: identity }) : undefined);
    const inputPlanner = new SessionInputPlanner({
        record,
        settingsService,
        agentClient,
        providerContinuity,
        providerRegistry,
        getProviderHistorySnapshot: () => record.getProviderHistorySnapshot(),
        getHistoryIdentity: () => record.getProviderHistoryIdentity().identity,
    });
    const conversationLogger = new ConversationLogger({
        turnAccumulator: resolvedTurnAccumulator,
        logger,
        getAssistantTurnState: () => {
            const fn = getMethod(agentClient, 'getProvider');
            const provider = fn ? fn.call(agentClient) : settingsService?.get('agent.modelSelection').provider;
            const model = settingsService?.get('agent.modelSelection').model;
            return {
                previousResponseId: providerContinuity.previousResponseId,
                ...(model ? { model } : {}),
                ...(provider ? { provider } : {}),
            };
        },
        getCurrentTurnId: () => record.getCurrentTurnId(),
        getToolLedger: () => record.exportToolEvidence(),
    });
    const appendLocalCheckpoint = (input) => {
        const envelopes = readConversationLogEnvelopes(identity.current);
        const sourceRefs = envelopes
            ? resolveCheckpointSourceRefs({ envelopes, history: input.history, hotTail: input.hotTail })
            : null;
        if (!sourceRefs) {
            logger.warn('Local context compaction committed without a provenance event; source refs were unavailable', {
                eventType: 'context_compaction.provenance_unavailable',
                sessionId: identity.current,
            });
            return;
        }
        const sourceDigest = createCheckpointSourceDigest(sourceRefs, envelopes ?? []);
        if (!sourceDigest) {
            logger.warn('Local context compaction committed without a provenance event; source payloads were unavailable', {
                eventType: 'context_compaction.provenance_unavailable',
                sessionId: identity.current,
            });
            return;
        }
        conversationLogger.log({
            type: 'context_checkpoint_created',
            version: 1,
            artifactId: generateId(),
            sourceRefs,
            sourceDigest,
            item: input.checkpoint,
        });
    };
    getMethod(agentClient, 'setLocalCheckpointSink')?.call(agentClient, appendLocalCheckpoint);
    openAIRootCheckpointLifecycleObserver?.setEvidenceRecorder?.((evidence) => {
        try {
            conversationLogger.log(evidence);
        }
        catch {
            // Checkpoint lifecycle diagnostics must never affect the stream path.
        }
    });
    // Background lifecycle belongs to the conversation-scoped sink, not the
    // active turn's UI sink. Both async subagents and root shell jobs use the
    // same projection and delivery queue, while their concrete registries retain
    // process/run ownership.
    const recordBackgroundEvent = (event) => {
        if (event.type === 'subagent_completed' && event.async === true) {
            backgroundSubagentApprovals.removeRun(event.result.agentId);
        }
        conversationLogger.dispatchEventToLog(event);
        if (notificationStore.recordLifecycle(event)) {
            try {
                taskObserver?.();
            }
            catch (error) {
                logger.warn('Background subagent task observer threw', {
                    eventType: 'subagent.task_observer_failed',
                    category: 'subagent',
                    sessionId: id,
                    errorMessage: error instanceof Error ? error.message : String(error),
                });
            }
        }
        if (event.type.startsWith('background_shell_')) {
            syncPublicStatus();
        }
        // The host observer sees all subagent events, including starts and duplicate
        // completions. Root shell events share this owner but use a separate channel.
        if (event.type.startsWith('subagent_')) {
            try {
                backgroundSubagentEventObserver?.(event);
            }
            catch (error) {
                logger.warn('Background subagent event observer threw', {
                    eventType: 'subagent.event_observer_failed',
                    category: 'subagent',
                    sessionId: id,
                    errorMessage: error instanceof Error ? error.message : String(error),
                });
            }
        }
        if (!notificationStore.enqueue(event))
            return;
        try {
            notificationObserver?.();
        }
        catch (error) {
            logger.warn('Background subagent notification observer threw', {
                eventType: 'subagent.notification_observer_failed',
                category: 'subagent',
                sessionId: id,
                errorMessage: error instanceof Error ? error.message : String(error),
            });
        }
    };
    resolvedSubagentEventSinkHost?.setBackgroundSubagentEventSink?.(recordBackgroundEvent);
    resolvedSubagentEventSinkHost?.setBackgroundSubagentApprovalPauseSink?.(backgroundSubagentApprovals.publish);
    resolvedBackgroundShellEventSinkHost?.setBackgroundShellEventSink?.(recordBackgroundEvent);
    // Wakes the launching agent to check on a still-running background shell
    // job or subagent while the session is otherwise idle. See
    // docs/plans/background-work/background-work-control/agent-checkin.md. Settings are read
    // fresh on every tick so a runtime change takes effect without restarting
    // the timer.
    const backgroundCheckInScheduler = new BackgroundCheckInScheduler({
        getRunningTasks: () => notificationStore.getTaskSnapshot(),
        emit: recordBackgroundEvent,
        getSubagentStatus: (runId) => agentClient.getBackgroundSubagentStatus?.(runId),
        getShellJob: (jobId) => agentClient.getBackgroundShellJob?.(jobId),
        getShellOutputTail: (jobId, maxBytes) => agentClient.getBackgroundShellOutputTail?.(jobId, maxBytes),
        getSettings: () => ({
            enabled: settingsService?.get('agent.backgroundCheckIn.enabled') ?? true,
            intervalMs: settingsService?.get('agent.backgroundCheckIn.intervalMs') ?? 300_000,
        }),
    });
    getMethod(agentClient, 'setBackgroundCheckInScheduler')?.call(agentClient, backgroundCheckInScheduler);
    const approvalFlow = new ApprovalFlowCoordinator({
        record,
        agentClient,
        approvalState,
        logger,
        sessionId: identity,
        generationGuard,
        toolOwnership,
        sessionAccess,
        hookLifecycle,
        hookEvents,
        toolCallMarkers,
    });
    const continuityReset = new SessionContinuityReset({
        providerContinuity,
        approvalFlow,
        toolTracker,
        shellAutoApproval,
        inputPlanner,
        turnAccumulator: resolvedTurnAccumulator,
        agentClient,
    });
    // eslint-disable-next-line prefer-const
    let terminateActiveTurn;
    const state = new SessionLifecycle({
        conversationLogger,
        agentClient,
        settingsService,
        inputPlanner,
        record,
        logger,
        sessionId: identity,
        appState,
        providerContinuity,
        generationGuard,
        continuityReset,
        sessionAccess,
        pendingInteraction,
        terminateActiveTurn: () => terminateActiveTurn?.(),
    });
    let publicStatus = 'idle';
    const getPublicStatus = () => {
        const pending = approvalFlow.getPending();
        const pendingTool = pending ? getToolInfoFromInterruption(pending.interruption).toolName : undefined;
        return computePublicStatus({
            foregroundStatus: appState.statusMachine.current,
            foregroundApprovalKind: appState.statusMachine.current === 'awaiting_approval'
                ? pendingTool === 'ask_user'
                    ? 'ask_user'
                    : 'approval'
                : undefined,
            backgroundApprovalPending: false,
            backgroundDetails: backgroundTaskControl.listDetails(),
        });
    };
    syncPublicStatus = () => {
        if (disposed || !hookLifecycle || !hookEvents)
            return;
        const next = getPublicStatus();
        if (next === publicStatus)
            return;
        const previous = publicStatus;
        publicStatus = next;
        void hookLifecycle.emit(hookEvents.create('status.change', {
            previous,
            current: next,
            reason: previous === 'waiting_for_approval' && next === 'working'
                ? 'approval_resolved'
                : next === 'waiting_for_user'
                    ? 'ask_user'
                    : next === 'waiting_for_approval'
                        ? 'approval_requested'
                        : next === 'idle'
                            ? 'turn_finished'
                            : 'turn_started',
        }));
    };
    appState.statusMachine.setObserver(() => {
        syncPublicStatus();
    });
    const streamProcessor = new SessionStreamProcessor({
        logger,
        sessionId: identity,
        toolTracker,
        generationGuard,
        abortStream: () => agentClient.abort(),
        toolCallMarkers,
    });
    const breakChaining = (reason) => {
        // A rejected provider checkpoint is request-local recovery, not a new
        // conversation: clear only provider continuity and retain session identity/history.
        providerContinuity.breakChaining();
        const configuredTransport = settingsService?.get('agent.transport');
        logger.warn('Provider continuity invalidated; rebuilding from full history', {
            eventType: 'conversation.chaining_broken',
            category: 'provider',
            phase: 'retry',
            sessionId: identity.current,
            reason,
            ...(configuredTransport ? { configuredTransport } : {}),
        });
    };
    const recoveryPolicy = new DefaultConversationRecoveryPolicy();
    const recoveryExecutor = new DefaultRecoveryExecutor({
        record,
        providerContinuity,
    });
    const retryClassifier = new DefaultRetryClassifier(agentClient);
    const retryEventPresenter = new RetryEventPresenter();
    const resolveRetryLimit = () => {
        const configured = settingsService?.get('agent.retryAttempts');
        if (typeof configured === 'number' && Number.isInteger(configured) && configured >= 0) {
            return configured;
        }
        return 2;
    };
    const attemptFactory = new TurnAttemptFactory({
        agentClient,
        record,
        generationGuard,
        state,
        resolveRetryLimit,
    });
    const inputPreparer = new InitialInputPreparer({
        record,
        generationGuard,
        inputPlanner,
        logger,
        sessionId: identity,
        state,
    });
    const recoveryHandler = new InitialTurnRecoveryHandler({
        breakChaining,
        record,
        freshStartRetriesAllowed: retryOptions?.allowFreshStartRetries ?? true,
        generationGuard,
        inputPlanner,
        logger,
        recoveryExecutor,
        recoveryPolicy,
        retryClassifier,
        retryEventPresenter,
        sessionId: identity,
        provider: agentClient?.getProvider?.(),
    });
    const planApplier = new ContinuationPlanApplier({
        record,
        approvalFlow,
        toolTracker,
    });
    const continuationRecoveryHandler = new ContinuationRecoveryHandler({
        record,
        breakChaining,
        logger,
        sessionId: identity,
        generationGuard,
        retryClassifier,
        recoveryPolicy,
        recoveryExecutor,
        retryEventPresenter,
        resolveRetryLimit,
        provider: agentClient?.getProvider?.(),
    });
    const turnDomainDeps = {
        agentClient,
        logger,
        sessionId: identity,
        turnAccumulator: resolvedTurnAccumulator,
        toolTracker,
        shellAutoApproval,
        generationGuard,
        attemptFactory,
        inputPreparer,
        streamProcessor,
        recoveryHandler,
        inputPlanner,
        record,
        approvalFlow,
        planApplier,
        continuationRecoveryHandler,
        providerContinuity,
        sessionAccess,
        approvalPolicyRegistry,
        postExecutePending,
        setActivePostExecuteRunId: postExecutePauseCapability?.setActiveRunId.bind(postExecutePauseCapability),
        toolCallMarkers,
        hookLifecycle,
        hookEvents,
    };
    const createTurnDomain = () => new SessionTurnDomain(turnDomainDeps);
    const automaticMemoryFinalizer = new AutomaticMemoryFinalizer({
        sessionId: identity,
        automaticMemory,
        automaticMemoryAllowed: () => !!settingsService?.get('memory.enabled') &&
            sessionAccess?.isReadOnly !== true &&
            !resolveActiveEnforcement(settingsService).denials.has('filesystem-mutation'),
    });
    let compatibilityAdapter;
    let compatibilityCoordinator;
    const getTurnAdapter = () => (compatibilityAdapter ??= new SessionTurnAdapter(turnDomainDeps));
    const getTurnCoordinator = () => (compatibilityCoordinator ??= new TurnCoordinator({
        statusMachine: appState.statusMachine,
        turnAdapter: getTurnAdapter(),
        approvalFlow,
        providerContinuity,
        shellAutoApproval,
        sessionId: identity,
        automaticMemoryFinalizer,
        hookLifecycle,
        hookEvents,
    }));
    terminateActiveTurn = () => compatibilityCoordinator?.terminate();
    const stateFacade = state;
    const runtimeController = new SessionRuntimeController({
        agentClient,
        state,
    });
    let backgroundShellSettlement;
    let backgroundSubagentSettlement;
    let ownsBackgroundSinks = true;
    const relinquishBackgroundSinkOwnership = () => {
        ownsBackgroundSinks = false;
    };
    const prepareRollover = (newSessionId, newStartedAt = new Date().toISOString()) => {
        if (disposed)
            throw new Error('Session runtime is already disposed.');
        if (!newSessionId)
            throw new Error('Session rollover requires a session ID.');
        if (!appState.statusMachine.is('idle')) {
            throw new Error('Session rollover is blocked while the foreground turn is active.');
        }
        if (approvalFlow.getPending() || postExecutePending.snapshot().entries.length > 0) {
            throw new Error('Session rollover is blocked while a foreground approval is pending.');
        }
        if (nestedApprovalOwner.getSnapshot()) {
            throw new Error('Session rollover is blocked while a nested approval is pending.');
        }
        return () => {
            // This is intentionally the same root-state reset used by clear, but it
            // does not dispose the graph. The retained client owns live background
            // work, permissions, and approval registries; only transcript and
            // provider/turn continuity are freshened. The current persisted
            // conversation id advances; SessionIdentity.publicId remains process-stable.
            state.resetSession({ clearConversations: false, rollover: true });
            identity.replace(newSessionId, newStartedAt);
            agentClient.resetMemoryContextForNewSession?.();
        };
    };
    const rollover = (newSessionId, newStartedAt = new Date().toISOString()) => {
        prepareRollover(newSessionId, newStartedAt)();
    };
    const dispose = () => {
        if (disposed)
            return;
        disposed = true;
        backgroundCheckInScheduler.dispose();
        getMethod(agentClient, 'setBackgroundCheckInScheduler')?.call(agentClient, undefined);
        compatibilityAdapter?.abortLiveRun();
        postExecutePending.close();
        generationGuard.invalidate();
        // Abort any active SDK work only if a turn is currently running.
        if (!appState.statusMachine.is('idle')) {
            approvalFlow.abort();
            appState.statusMachine.abort();
        }
        // Background subagent runs are bound to the conversation, not to a turn,
        // so they must be cancelled even when no turn is in flight.
        getMethod(agentClient, 'cancelBackgroundRuns')?.call(agentClient);
        getMethod(agentClient, 'cancelBackgroundShellJobs')?.call(agentClient);
        getMethod(agentClient, 'disposeShellChildren')?.call(agentClient);
        notificationObserver = null;
        taskObserver = null;
        const subagentDisposal = getMethod(agentClient, 'disposeBackgroundSubagents')?.call(agentClient);
        const detachSubagentSinks = () => {
            // Persistence observers need terminal events through asynchronous shutdown.
            backgroundSubagentEventObserver = null;
            backgroundSubagentApprovals.close();
            if (ownsBackgroundSinks) {
                resolvedSubagentEventSinkHost?.setBackgroundSubagentApprovalPauseSink?.(null);
                resolvedSubagentEventSinkHost?.setBackgroundSubagentEventSink?.(null);
            }
        };
        if (subagentDisposal) {
            backgroundSubagentSettlement = Promise.resolve(subagentDisposal).finally(detachSubagentSinks);
        }
        else {
            // Without a disposal promise there is no settlement left to await. A
            // deferred detach could erase a replacement session's reused client sinks.
            detachSubagentSinks();
            backgroundSubagentSettlement = Promise.resolve();
        }
        const shellDisposal = getMethod(agentClient, 'disposeBackgroundShellJobs')?.call(agentClient);
        const detachShellSink = () => {
            if (ownsBackgroundSinks) {
                resolvedBackgroundShellEventSinkHost?.setBackgroundShellEventSink?.(null);
            }
        };
        if (shellDisposal) {
            backgroundShellSettlement = Promise.resolve(shellDisposal).finally(detachShellSink);
        }
        else {
            detachShellSink();
            backgroundShellSettlement = Promise.resolve();
        }
        providerContinuity.clear();
        pendingInteraction.clear();
        nestedApprovalOwner.close();
    };
    let shutdownPromise;
    const shutdown = () => {
        shutdownPromise ??= (async () => {
            dispose();
            await backgroundShellSettlement;
            await backgroundSubagentSettlement;
            await hookLifecycle?.shutdown();
        })();
        return shutdownPromise;
    };
    const compactContext = async (options) => {
        if (!appState.statusMachine.is('idle'))
            return { kind: 'busy' };
        const snapshot = record.getProviderHistorySnapshot();
        const provider = getMethod(agentClient, 'getProvider')?.call(agentClient) ??
            settingsService?.get('agent.modelSelection').provider ??
            'openai';
        const model = settingsService?.get('agent.modelSelection').model ?? 'gpt-5';
        const reasoningEffort = settingsService?.get('agent.reasoningEffort');
        const catalog = getCatalogModel(provider, model);
        const compactThreshold = settingsService?.get('agent.contextCompaction.compactThreshold') ?? 0.8;
        const configuredMaxOutput = settingsService?.get('agent.maxOutputTokens');
        const requestOutput = resolveOutputAllocation(catalog, configuredMaxOutput, settingsService?.getSource?.('agent.maxOutputTokens') === 'default');
        const abortError = () => {
            const error = new Error('Context compaction cancelled.');
            error.name = 'AbortError';
            return error;
        };
        const compactCodex = getMethod(agentClient, 'compactCodexSessionHistory');
        if (provider === 'codex' && compactCodex) {
            const before = estimateContext({
                history: snapshot.history,
                contextWindow: catalog?.contextWindow,
                maxOutputTokens: requestOutput,
            });
            // Commit point for the codex branch: everything after this (the native
            // call, history replacement) is a started compaction whose outcome must
            // be reported with a terminal frame by the caller.
            await options?.onStarted?.();
            const remote = await compactCodex.call(agentClient, snapshot.history, options?.signal);
            if (remote.kind !== 'compacted') {
                return remote.kind === 'failed'
                    ? // A native codex failure is not a local size outcome. Report it under
                        // its own typed reason; result_still_too_large stays reserved for the
                        // local planner's genuine post-estimate check.
                        { kind: 'failed', reason: 'native_failed', estimate: before, provider: remote.provider }
                    : { kind: 'not_needed', estimate: before };
            }
            if (!record.replaceHistoryAtRevision(snapshot.revision, remote.history)) {
                return { kind: 'stale' };
            }
            providerContinuity.clear();
            const after = estimateContext({
                history: remote.history,
                contextWindow: catalog?.contextWindow,
                maxOutputTokens: requestOutput,
            });
            return {
                kind: 'compacted',
                checkpoint: {
                    type: 'message',
                    role: 'system',
                    content: '',
                    contextSummary: {
                        version: 1,
                        strategy: 'local',
                        estimatedTokensBefore: before.renderedInputTokens,
                        estimatedTokensAfter: after.renderedInputTokens,
                    },
                },
                hotTail: [],
                estimate: after,
                rearmAtTokens: after.renderedInputTokens,
                usage: { inputTokens: 0, outputTokens: 0 },
                costRecords: [],
                droppedOpaqueItems: 0,
            };
        }
        const liveGenerator = getMethod(agentClient, 'createContextSummaryGenerator')?.call(agentClient, identity.current, identity.promptCacheKey);
        const compactor = new LocalContextCompactor(liveGenerator ?? {
            generate: async ({ renderedInput, maxOutputTokens, signal }) => {
                if (signal?.aborted)
                    throw abortError();
                const chatOptions = {
                    provider,
                    model,
                    reasoningEffort,
                    instructions: CONTEXT_COMPACTION_INSTRUCTIONS,
                    maxTokens: maxOutputTokens,
                    signal,
                };
                const aborted = new Promise((_, reject) => {
                    signal?.addEventListener('abort', () => {
                        getMethod(agentClient, 'abort')?.call(agentClient);
                        reject(abortError());
                    }, { once: true });
                });
                const generate = async () => {
                    if (agentClient.chatDetailed) {
                        const result = await agentClient.chatDetailed(renderedInput, chatOptions);
                        return {
                            text: result.text,
                            usage: result.usage
                                ? {
                                    inputTokens: result.usage.prompt_tokens,
                                    outputTokens: result.usage.completion_tokens,
                                }
                                : undefined,
                            costRecords: result.costRecords,
                        };
                    }
                    return { text: await agentClient.chat(renderedInput, chatOptions) };
                };
                return signal ? Promise.race([generate(), aborted]) : generate();
            },
        });
        const outcome = await compactor.compactAtBoundary({
            history: snapshot.history,
            provider,
            model,
            sourceRevision: snapshot.revision,
            contextWindow: catalog?.contextWindow,
            maxOutputTokens: requestOutput,
            compactThreshold,
            compactThresholdTokens: null,
            maxRequestInputTokens: settingsService?.get('agent.maxRequestInputTokens'),
            manual: true,
            signal: options?.signal,
            onStarted: options?.onStarted,
        });
        if (outcome.kind !== 'compacted')
            return outcome;
        const genuineUsers = snapshot.history.filter((item) => {
            const message = projectConversationMessage(item);
            return message?.role === 'user' && !message.isSynthetic;
        });
        const hotUsers = outcome.hotTail.filter((item) => {
            const message = projectConversationMessage(item);
            return message?.role === 'user' && !message.isSynthetic;
        }).length;
        const preservedUsers = hotUsers === 0 ? genuineUsers : genuineUsers.slice(0, -hotUsers);
        if (!record.replaceHistoryAtRevision(snapshot.revision, [...preservedUsers, outcome.checkpoint, ...outcome.hotTail])) {
            return { kind: 'stale' };
        }
        appendLocalCheckpoint({ history: snapshot.history, hotTail: outcome.hotTail, checkpoint: outcome.checkpoint });
        providerContinuity.clear();
        return outcome;
    };
    return {
        sessionId: id,
        identity,
        get sessionStartedAt() {
            return identity.startedAt;
        },
        getUnsettledToolExecutions: () => {
            const unsettled = new Set(record.unsettledToolCallIdsForCurrentTurn());
            return record
                .exportToolEvidence()
                .filter((entry) => unsettled.has(entry.callId))
                .map(({ callId, toolName, status }) => ({ callId, toolName, status }));
        },
        logger,
        record,
        approvalState,
        toolTracker,
        toolCallMarkers,
        shellAutoApproval,
        approvalFlow,
        inputPlanner,
        state,
        conversationLogger,
        streamProcessor,
        appState,
        get turnCoordinator() {
            return getTurnCoordinator();
        },
        stateFacade,
        runtimeController,
        dispose,
        relinquishBackgroundSinkOwnership,
        shutdown,
        rollover,
        prepareRollover,
        generationGuard,
        providerContinuity,
        breakChaining,
        compactContext,
        recoveryPolicy,
        recoveryExecutor,
        retryClassifier,
        retryEventPresenter,
        turnAccumulator: resolvedTurnAccumulator,
        get turnAdapter() {
            return getTurnAdapter();
        },
        createTurnDomain,
        automaticMemoryFinalizer,
        freshStartRetriesAllowed: retryOptions?.allowFreshStartRetries ?? true,
        resolvedAskUserAnswerSink,
        resolvedSubagentEventSinkHost: resolvedSubagentEventSinkHost
            ? {
                setSubagentEventSink: resolvedSubagentEventSinkHost.setSubagentEventSink.bind(resolvedSubagentEventSinkHost),
                setBackgroundSubagentEventSink: (sink) => {
                    if (!disposed)
                        backgroundSubagentEventObserver = sink;
                },
                setBackgroundShellEventSink: resolvedSubagentEventSinkHost.setBackgroundShellEventSink?.bind(resolvedSubagentEventSinkHost),
                setBackgroundSubagentApprovalPauseSink: resolvedSubagentEventSinkHost.setBackgroundSubagentApprovalPauseSink?.bind(resolvedSubagentEventSinkHost),
                answerBackgroundSubagentQuestion: resolvedSubagentEventSinkHost.answerBackgroundSubagentQuestion?.bind(resolvedSubagentEventSinkHost),
                cancelSubagentRuns: resolvedSubagentEventSinkHost.cancelSubagentRuns?.bind(resolvedSubagentEventSinkHost),
            }
            : null,
        resolvedBackgroundShellEventSinkHost,
        backgroundSubagentNotifications,
        backgroundSubagentTasks,
        backgroundSubagentApprovals,
        backgroundTaskControl,
        postExecutePending,
        pendingInteraction,
        nestedApprovalOwner,
    };
}
/** @internal Alias that keeps the narrow {@link ConversationSessionBundle} return type. */
export const createConversationSession = createSessionRuntimeInternals;
// ── Session Runtime Factory ───────────────────────────────────────
/** @internal Wraps a shared internals instance into the closed runtime. */
export function buildSessionRuntime(internals) {
    const { turnCoordinator, stateFacade, runtimeController, conversationLogger, record, dispose, approvalFlow, resolvedAskUserAnswerSink, resolvedSubagentEventSinkHost, backgroundSubagentNotifications, backgroundSubagentTasks, backgroundSubagentApprovals, backgroundTaskControl, postExecutePending, pendingInteraction, nestedApprovalOwner, } = internals;
    return {
        get sessionId() {
            return internals.identity.current;
        },
        get sessionStartedAt() {
            return internals.identity.startedAt;
        },
        get publicSessionId() {
            return internals.identity.publicId;
        },
        get publicSessionStartedAt() {
            return internals.identity.publicStartedAt;
        },
        getUnsettledToolExecutions: internals.getUnsettledToolExecutions,
        turns: {
            start: turnCoordinator.start.bind(turnCoordinator),
            continueAfterApproval: turnCoordinator.continueAfterApproval.bind(turnCoordinator),
            continueAfterPostExecuteApproval: turnCoordinator.continueAfterPostExecuteApproval.bind(turnCoordinator),
            abort: turnCoordinator.abort.bind(turnCoordinator),
            steer: turnCoordinator.steer.bind(turnCoordinator),
            retractSteer: turnCoordinator.retractSteer.bind(turnCoordinator),
            editSteer: turnCoordinator.editSteer.bind(turnCoordinator),
        },
        state: stateFacade,
        settings: runtimeController,
        compactContext: internals.compactContext,
        logs: {
            setLogSink: (sink) => {
                conversationLogger.setLogSink(sink);
                record.setJournalSink(sink);
            },
            dispatchEventToLog: conversationLogger.dispatchEventToLog.bind(conversationLogger),
            log: conversationLogger.log.bind(conversationLogger),
        },
        approval: {
            getPending: approvalFlow.getPending.bind(approvalFlow),
            getPendingInterruption: approvalFlow.getPendingInterruption.bind(approvalFlow),
            getPostExecutePending: postExecutePending.snapshot.bind(postExecutePending),
            decidePostExecutePending: postExecutePending.decide.bind(postExecutePending),
        },
        pendingInteraction,
        nestedApproval: {
            getSnapshot: nestedApprovalOwner.getSnapshot.bind(nestedApprovalOwner),
            subscribe: nestedApprovalOwner.subscribe.bind(nestedApprovalOwner),
            decide: nestedApprovalOwner.decide.bind(nestedApprovalOwner),
            close: nestedApprovalOwner.close.bind(nestedApprovalOwner),
        },
        sinks: {
            askUserAnswer: resolvedAskUserAnswerSink,
            subagentEvents: resolvedSubagentEventSinkHost,
        },
        backgroundSubagentNotifications,
        backgroundSubagentTasks,
        backgroundSubagentApprovals,
        backgroundTaskControl,
        dispose,
        relinquishBackgroundSinkOwnership: internals.relinquishBackgroundSinkOwnership,
        shutdown: internals.shutdown,
        rollover: internals.rollover,
        prepareRollover: internals.prepareRollover,
    };
}
/**
 * Creates a session runtime with a clean public API, without constructing
 * the conversation-layer adapter. Internal composition details remain private.
 */
export function createSessionRuntime(options) {
    const releaseRuntime = registerSessionRuntime();
    try {
        const runtime = buildSessionRuntime(createSessionRuntimeInternals({
            ...options,
            turnAccumulator: undefined,
        }));
        let released = false;
        const releaseOnce = () => {
            if (released)
                return;
            released = true;
            releaseRuntime();
        };
        const dispose = runtime.dispose;
        runtime.dispose = () => {
            try {
                dispose();
            }
            finally {
                releaseOnce();
            }
        };
        const shutdown = runtime.shutdown;
        runtime.shutdown = async () => {
            try {
                await shutdown();
            }
            finally {
                releaseOnce();
            }
        };
        return runtime;
    }
    catch (error) {
        releaseRuntime();
        throw error;
    }
}
//# sourceMappingURL=session-composition.js.map