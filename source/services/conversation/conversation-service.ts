import type { ILoggingService, ISettingsService, ISessionContextService } from '../service-interfaces.js';
import type { ConversationTerminal, ReasoningEffortSetting } from '../../contracts/conversation.js';
import type { PendingApproval } from '../../contracts/conversation.js';
import type { SavedToolExecution } from '../tool-execution-ledger.js';
import type { RewindTarget, RewindTargetId } from './conversation-store.js';
import type { LogEvent, StateSnapshot } from '../logging/conversation-log-events.js';
import type { UserTurn } from '../../types/user-turn.js';
import type { ConversationAgentClient } from '../conversation-agent-client.js';
import type { SkillsService } from '../skills/skills-service.js';
import {
  createCallerOwnedSessionClientFactory,
  type SessionClientFactory,
  type SessionClientHandle,
} from '../session/session-client-factory.js';
import type {
  SendMessageOptions,
  HandleApprovalDecisionOptions,
  ConversationAdapter,
  ConversationEventSink,
  QueuedTurnStartObserver,
  SubmissionMutation,
} from './conversation-adapter.js';
import type { LargeUncachedInputDecision } from '../large-uncached-input-guard.js';
import type { InputSurgeDecision } from '../input-surge-guard.js';
import type { SessionRuntime } from '../session/session-composition.js';
import type { BackgroundTaskControlPort } from '../session/background-task-control.js';
import type {
  BackgroundSubagentNotificationPort,
  BackgroundSubagentTaskPort,
} from '../subagents/subagent-notification-store.js';
import type { BackgroundSubagentApprovalChannel } from '../session/session-composition.js';
import type { QueueStateKind, QueueStateObserver } from './conversation-adapter.js';
import type { ProviderInputItem } from '../../contracts/provider-input.js';
import { createConversationRuntime } from './conversation-runtime-factory.js';
import { ToolOwnershipRegistry } from '../approval/tool-ownership-registry.js';
import type { HookEventFactory } from '../hooks/hook-event-factory.js';
import type {
  PendingInteractionResolution,
  PendingInteractionSnapshot,
  ResolvePendingInteractionRequest,
} from '../session/pending-interaction-state.js';

export type { ConversationTerminal, ApprovalDescriptor, PendingApproval } from '../../contracts/conversation.js';
export type { CommandMessage } from '../../tools/types.js';

/**
 * Backward-compatible facade for the CLI.
 *
 * Phase 3: the session owns the conversation state; the service is a thin wrapper.
 */
export class ConversationService {
  #runtime: SessionRuntime;
  #adapter: ConversationAdapter;
  #clientHandle: SessionClientHandle;
  readonly #clientFactory: SessionClientFactory;
  #eventSink: ConversationEventSink | null = null;
  #pendingInteractionObserver: ((snapshot: PendingInteractionSnapshot | null) => void) | null = null;
  readonly #deps: {
    logger: ILoggingService;
    settingsService?: ISettingsService;
    sessionContextService: ISessionContextService;
    skillsService?: SkillsService;
  };

  constructor({
    agentClient,
    sessionClientFactory,
    deps,
    sessionId = 'default',
    sessionStartedAt,
    toolOwnership,
  }: {
    /** Compatibility seam: caller retains ownership of a prebuilt client. */
    agentClient?: ConversationAgentClient;
    /** Production seam: each session receives a newly owned client. */
    sessionClientFactory?: SessionClientFactory;
    deps: {
      logger: ILoggingService;
      settingsService?: ISettingsService;
      sessionContextService: ISessionContextService;
      skillsService?: SkillsService;
    };
    sessionId?: string;
    sessionStartedAt?: string;
    /** Required with a caller-owned client to preserve approval/nested identity. */
    toolOwnership?: ToolOwnershipRegistry;
  }) {
    if (!sessionClientFactory && !agentClient) {
      throw new Error('ConversationService requires an agentClient or sessionClientFactory');
    }
    if (!sessionClientFactory && !toolOwnership) {
      throw new Error('ConversationService requires toolOwnership with an agentClient');
    }
    this.#clientFactory = sessionClientFactory ?? createCallerOwnedSessionClientFactory(agentClient!, toolOwnership!);
    this.#clientHandle = this.#clientFactory.create(sessionId ?? 'default');
    this.#deps = deps;
    const { runtime, adapter } = createConversationRuntime({
      agentClient: this.#clientHandle.agentClient,
      providerContinuity: this.#clientHandle.providerContinuity,
      openAIRootFreshTurnSelectorParityObserver: this.#clientHandle.openAIRootFreshTurnSelectorParityObserver,
      openAIRootCheckpointLifecycleObserver: this.#clientHandle.openAIRootCheckpointLifecycleObserver,
      toolOwnership: this.#clientHandle.toolOwnership,
      postExecutePending: this.#clientHandle.postExecutePending,
      postExecutePauseCapability: this.#clientHandle.postExecutePauseCapability,
      ...(this.#clientHandle.access ? { sessionAccess: this.#clientHandle.access } : {}),
      ...(this.#clientHandle.hookLifecycle ? { hookLifecycle: this.#clientHandle.hookLifecycle } : {}),
      ...(this.#clientHandle.hookEvents ? { hookEvents: this.#clientHandle.hookEvents } : {}),
      deps,
      queueForeground: true,
      sessionId: sessionId ?? 'default',
      sessionStartedAt,
    });
    this.#runtime = runtime;
    this.#adapter = adapter;
  }

  setEventSink(sink: ConversationEventSink | null): void {
    this.#eventSink = sink;
    this.#adapter.setEventSink(sink);
  }

  #backgroundSubagentNotificationObserver: (() => void) | null = null;
  #backgroundSubagentTaskObserver: (() => void) | null = null;

  /**
   * Observe background (async) subagent runs settling. The observer fires once
   * per newly queued completion; the queued notifications themselves are read
   * through {@link backgroundSubagentNotifications}.
   */
  setBackgroundSubagentNotificationObserver(observer: (() => void) | null): void {
    this.#backgroundSubagentNotificationObserver = observer;
    this.#runtime.backgroundSubagentNotifications.setObserver(observer);
  }

  /** Completions of background subagent runs still owed to the main agent. */
  get backgroundSubagentNotifications(): BackgroundSubagentNotificationPort {
    return this.#runtime.backgroundSubagentNotifications;
  }

  setBackgroundSubagentTaskObserver(observer: (() => void) | null): void {
    this.#backgroundSubagentTaskObserver = observer;
    this.#runtime.backgroundSubagentTasks.setObserver(observer);
  }

  /** Current running and briefly retained terminal background tasks. */
  get backgroundSubagentTasks(): BackgroundSubagentTaskPort {
    return this.#runtime.backgroundSubagentTasks;
  }

  /** Details and stop requests for conversation-owned background work. */
  get backgroundTaskControl(): BackgroundTaskControlPort {
    return this.#runtime.backgroundTaskControl;
  }

  get backgroundSubagentApprovals(): BackgroundSubagentApprovalChannel {
    return this.#runtime.backgroundSubagentApprovals;
  }

  get sessionId(): string {
    return this.#runtime.sessionId;
  }

  get hookEvents(): HookEventFactory | undefined {
    return this.#clientHandle.hookEvents;
  }

  async shutdown(): Promise<void> {
    await this.#runtime.shutdown();
    this.#clientHandle.dispose();
  }

  resetWithNewId(newId: string): void {
    const previousLogSink = this.#logSink;
    const previousEventSink = this.#eventSink;
    this.#runtime.state.reset();
    this.#runtime.dispose();
    this.#clientHandle.dispose();
    this.#deps.skillsService?.discoverSkills();
    this.#clientHandle = this.#clientFactory.create(newId);
    const { runtime, adapter } = createConversationRuntime({
      agentClient: this.#clientHandle.agentClient,
      providerContinuity: this.#clientHandle.providerContinuity,
      openAIRootFreshTurnSelectorParityObserver: this.#clientHandle.openAIRootFreshTurnSelectorParityObserver,
      openAIRootCheckpointLifecycleObserver: this.#clientHandle.openAIRootCheckpointLifecycleObserver,
      toolOwnership: this.#clientHandle.toolOwnership,
      postExecutePending: this.#clientHandle.postExecutePending,
      postExecutePauseCapability: this.#clientHandle.postExecutePauseCapability,
      ...(this.#clientHandle.access ? { sessionAccess: this.#clientHandle.access } : {}),
      ...(this.#clientHandle.hookLifecycle ? { hookLifecycle: this.#clientHandle.hookLifecycle } : {}),
      ...(this.#clientHandle.hookEvents ? { hookEvents: this.#clientHandle.hookEvents } : {}),
      deps: this.#deps,
      queueForeground: true,
      sessionId: newId,
    });
    this.#runtime = runtime;
    this.#adapter = adapter;
    if (previousLogSink) {
      this.#runtime.logs.setLogSink(previousLogSink);
    }
    if (previousEventSink) {
      this.#adapter.setEventSink(previousEventSink);
    }
    // The previous runtime's notification queue died with it; re-attach the
    // observers so the new conversation still wakes and updates its overview.
    this.#runtime.backgroundSubagentNotifications.setObserver(this.#backgroundSubagentNotificationObserver);
    this.#runtime.backgroundSubagentTasks.setObserver(this.#backgroundSubagentTaskObserver);
    this.#runtime.pendingInteraction.setObserver(this.#pendingInteractionObserver);
  }

  #logSink: ((event: LogEvent) => void) | null = null;

  setLogSink(sink: ((event: LogEvent) => void) | null): void {
    this.#logSink = sink;
    this.#runtime.logs.setLogSink(sink);
  }

  getCurrentSnapshot(): StateSnapshot {
    return this.#runtime.state.getCurrentSnapshot();
  }

  undoLastUserTurn(): { text: string; images?: UserTurn['images'] } | null {
    return this.#runtime.state.undoLastUserTurn();
  }

  listUserTurns(): { index: number; text: string; imageCount: number }[] {
    return this.#runtime.state.listUserTurns();
  }

  /**
   * Every turn the conversation can be rewound to, annotated with what
   * rewinding there would discard. Drives the `/rewind` picker's cost preview.
   */
  listRewindTargets(): RewindTarget[] {
    return this.#runtime.state.listRewindTargets();
  }

  rewindToTarget(targetId: RewindTargetId): { text: string; images?: UserTurn['images'] } | null {
    return this.#runtime.state.rewindToTarget(targetId);
  }

  undoNUserTurns(n: number): { text: string; images?: UserTurn['images'] } | null {
    return this.#runtime.state.undoNUserTurns(n);
  }

  peekLastToolOutput(): {
    index: number;
    callId?: string;
    toolName?: string;
    output?: unknown;
    itemType: string;
  } | null {
    return this.#runtime.state.peekLastToolOutput();
  }

  setModel(model: string): void {
    this.#runtime.settings.setModel(model);
  }

  setReasoningEffort(effort: ReasoningEffortSetting): void {
    this.#runtime.settings.setReasoningEffort(effort);
  }

  setTemperature(temperature?: number): void {
    this.#runtime.settings.setTemperature(temperature);
  }

  setProvider(provider: string): void {
    this.#runtime.settings.setProvider(provider);
  }

  switchProvider(provider: string): void {
    this.#runtime.settings.switchProvider(provider);
  }

  setRetryCallback(callback: () => void): void {
    this.#runtime.settings.setRetryCallback(callback);
  }

  /**
   * Record what the user did in shell mode so the agent can see it.
   *
   * While a turn is running the store is the wrong destination: the turn holds
   * its own transcript and overwrites the store when it commits, which drops
   * anything appended underneath it. Hand it to the turn instead, and fall
   * back to the store only when no turn will take it.
   */
  addShellContext(historyText: string): void {
    if (!historyText.trim()) return;
    void this.#adapter
      .injectIntoActiveTurn([{ type: 'message', role: 'user', content: historyText }])
      .catch(() => false)
      .then((injected) => {
        if (!injected) this.#runtime.state.addShellContext(historyText);
      });
  }

  queueModeNotice(text: string): void {
    this.#runtime.state.queueModeNotice(text);
  }

  /**
   * Abort the in-flight turn. Background (async) subagent runs are
   * conversation-bound and survive this; they are only stopped by
   * {@link interruptFromUser}, disposal, or shutdown.
   */
  abort(): void {
    this.#adapter.abort();
  }

  /**
   * Abort the in-flight turn *and* cancel conversation-bound background
   * subagent runs, because the user explicitly asked everything to stop.
   */
  interruptFromUser(): void {
    this.#adapter.abort();
    this.#clientHandle.agentClient.cancelBackgroundRuns?.();
    this.#clientHandle.agentClient.cancelBackgroundShellJobs?.();
  }

  /** Release the current runtime and, when factory-owned, its session client. */
  dispose(): void {
    this.#runtime.dispose();
    this.#clientHandle.dispose();
  }

  sendMessage(input: string | UserTurn, options?: SendMessageOptions): Promise<ConversationTerminal> {
    return this.#adapter.sendMessage(input, options);
  }

  async compactContext(): Promise<string> {
    const startedAt = Date.now();
    this.#eventSink?.({
      type: 'context_compaction_started',
      provider: this.#deps.settingsService?.get('agent.provider') ?? 'openai',
      sessionId: this.sessionId,
      strategy: 'local',
    });
    try {
      const outcome = await this.#runtime.compactContext();
      if (outcome.kind === 'busy') {
        this.#eventSink?.({
          type: 'context_compaction_failed',
          provider: this.#deps.settingsService?.get('agent.provider') ?? 'openai',
          sessionId: this.sessionId,
          errorCategory: 'validation',
          durationMs: Date.now() - startedAt,
          strategy: 'local',
        });
        return 'Context compaction is available only while the conversation is idle.';
      }
      if (outcome.kind === 'stale') throw new Error('Conversation changed while context compaction was running');
      if (outcome.kind === 'blocked') {
        const message =
          outcome.reason === 'no_complete_cold_turn'
            ? 'Nothing to compact: at least one complete cold turn is required.'
            : `Context compaction was blocked: ${outcome.reason}.`;
        this.#eventSink?.({
          type: 'context_compaction_failed',
          provider: this.#deps.settingsService?.get('agent.provider') ?? 'openai',
          sessionId: this.sessionId,
          errorCategory: 'validation',
          durationMs: Date.now() - startedAt,
          strategy: 'local',
        });
        return message;
      }
      if (outcome.kind !== 'compacted') return 'Nothing to compact.';
      this.#eventSink?.({
        type: 'context_compaction_completed',
        provider: this.#deps.settingsService?.get('agent.provider') ?? 'openai',
        sessionId: this.sessionId,
        inputTokensBefore: outcome.checkpoint.contextSummary.estimatedTokensBefore,
        inputTokensAfter: outcome.checkpoint.contextSummary.estimatedTokensAfter,
        durationMs: Date.now() - startedAt,
        strategy: 'local',
      });
      return `Context compacted locally (${outcome.checkpoint.contextSummary.estimatedTokensBefore ?? '?'} → ${
        outcome.checkpoint.contextSummary.estimatedTokensAfter ?? '?'
      } estimated tokens).`;
    } catch (error) {
      this.#eventSink?.({
        type: 'context_compaction_failed',
        provider: this.#deps.settingsService?.get('agent.provider') ?? 'openai',
        sessionId: this.sessionId,
        errorCategory: 'request',
        durationMs: Date.now() - startedAt,
        strategy: 'local',
      });
      throw error;
    }
  }

  /** Resume foreground messages retained after an execution failure or abort. */
  resumeQueue(): Promise<void> {
    return this.#adapter.resumeQueue();
  }

  /** Discard all queued foreground messages without executing them. */
  discardQueue(): Promise<void> {
    return this.#adapter.discardQueue();
  }

  retractSubmission(id: string): Promise<SubmissionMutation> {
    return this.#adapter.retractSubmission(id);
  }

  editSubmission(id: string, turn: UserTurn): Promise<SubmissionMutation> {
    return this.#adapter.editSubmission(id, turn);
  }

  getPendingInteractionSnapshot(): PendingInteractionSnapshot | null {
    return this.#runtime.pendingInteraction.getSnapshot();
  }

  setPendingInteractionObserver(observer: ((snapshot: PendingInteractionSnapshot | null) => void) | null): void {
    this.#pendingInteractionObserver = observer;
    this.#runtime.pendingInteraction.setObserver(observer);
  }

  resolvePendingInteraction(request: ResolvePendingInteractionRequest): PendingInteractionResolution {
    return this.#runtime.pendingInteraction.resolve(request);
  }

  presentPendingInteraction(approval: PendingApproval): PendingInteractionSnapshot {
    return this.#runtime.pendingInteraction.present(approval);
  }

  clearPendingInteraction(): void {
    this.#runtime.pendingInteraction.clear();
  }

  goToPreviousPendingInteractionQuestion(): void {
    this.#runtime.pendingInteraction.goToPreviousQuestion();
  }

  goToNextPendingInteractionQuestion(): void {
    this.#runtime.pendingInteraction.goToNextQuestion();
  }

  /**
   * Deliver a user message into the turn already running, so the model reads it
   * mid-turn — after the tool results of the round in flight — instead of after
   * the whole turn ends. Nothing is cancelled.
   *
   * Resolves false when the running turn offers no further request boundary
   * (it is finishing, or parked on an approval); the caller then sends the
   * message as its own turn.
   */
  steerActiveTurn(input: string | UserTurn, options?: { id?: string }): Promise<boolean> {
    return this.#adapter.steerActiveTurn(input, options);
  }

  /** Deliver pre-built items into the running turn. See the adapter for terms. */
  injectIntoActiveTurn(items: readonly ProviderInputItem[]): Promise<boolean> {
    return this.#adapter.injectIntoActiveTurn(items);
  }

  /**
   * Returns true if a foreground turn is currently active (running,
   * completing, awaiting an approval, etc.). The orchestrator uses this to
   * decide whether to immediately append a user message to the message list
   * (when no turn is active) or display it as queued until the queue pops it.
   */
  isQueueActive(): boolean {
    return this.#adapter.isQueueActive();
  }

  /** True while a foreground queue owns the display lifecycle of new submits. */
  isQueueOwningSubmissions(): boolean {
    return this.#adapter.isQueueOwningSubmissions();
  }

  /** The queue's current state kind. Diagnostics only — do not branch on it. */
  queueStateKind(): QueueStateKind | 'none' {
    return this.#adapter.queueStateKind();
  }

  /** Set an observer for queue state changes. The observer fires immediately with current state. */
  setQueueStateObserver(observer: QueueStateObserver | null): void {
    this.#adapter.setQueueStateObserver(observer);
  }

  /**
   * Set an observer that fires each time the queue has actually started
   * executing a queued message (after the in-flight turn finished). The
   * observer receives the internal request id and the original turn so the
   * caller can render the message in the UI at the correct timeline.
   */
  setQueuedTurnStartObserver(observer: QueuedTurnStartObserver | null): void {
    this.#adapter.setQueuedTurnStartObserver(observer);
  }

  retryLastToolOutput(options?: SendMessageOptions): Promise<ConversationTerminal | null> {
    this.abort();
    const removed = this.#runtime.state.retryLastToolOutput();
    if (removed === null) {
      return Promise.resolve(null);
    }

    return this.#adapter.sendMessage('', {
      ...options,
      replayFromHistory: true,
    });
  }

  previewLargeUncachedInput(input: string | UserTurn, now?: number): LargeUncachedInputDecision {
    return this.#runtime.state.previewLargeUncachedInput(input, now);
  }

  previewInputSurge(input: string | UserTurn): InputSurgeDecision {
    return this.#runtime.state.previewInputSurge(input);
  }

  handleApprovalDecision(
    answer: string,
    rejectionReason?: string,
    options?: HandleApprovalDecisionOptions,
  ): Promise<ConversationTerminal | null> {
    return this.#adapter.handleApprovalDecision(answer, rejectionReason, options);
  }

  exportState(): {
    history: unknown[];
    previousResponseId: string | null;
    toolLedger: SavedToolExecution[];
  } {
    return this.#runtime.state.exportState();
  }

  importState(state: {
    history: unknown[];
    previousResponseId: string | null;
    toolLedger?: SavedToolExecution[];
    updatedAt?: string;
  }): void {
    this.#runtime.state.importState(state);
  }
}
