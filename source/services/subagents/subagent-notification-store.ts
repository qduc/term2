import type {
  BackgroundCheckInDueEvent,
  ConversationEvent,
  SubagentCommandMessageEvent,
  SubagentToolStartedEvent,
} from '../conversation/conversation-events.js';
import type { SubagentResult } from './types.js';
import { isTerminalSubagentResult } from './types.js';
import type { NormalizedUsage } from '../../utils/ai/token-usage.js';
import { formatToolCommand, parseToolArguments } from '../../utils/conversation/conversation-utils.js';
import { formatSubagentResult, truncatePreview } from './utils.js';
import type { RunBudgetEvent } from '../agent-runtime/run-budget.js';

/** A completed background run that still owes the main agent a notification. */
export interface BackgroundSubagentCompletionNotification {
  kind: 'completion';
  /** Stable per logical run, so replay cannot duplicate a completion. */
  messageId: string;
  runId: string;
  name?: string;
  role: string;
  status: 'completed' | 'failed' | 'cancelled' | 'interrupted';
  /** Compact one-line preview for the user-facing display. */
  preview: string;
  /** Full model-facing report, inlined so the main agent need not call get_subagent_result. */
  formattedResult: string;
  error?: string;
  completedAt: number;
}

/** A live execution segment's bounded request for its owning orchestrator. */
export interface BackgroundSubagentQuestionNotification {
  kind: 'question';
  messageId: string;
  runId: string;
  name?: string;
  role: string;
  question: string;
  askedAt: number;
}

/** Budget/stall evidence requiring the parent agent's judgement. */
export interface BackgroundSubagentBudgetNotification {
  kind: 'budget';
  messageId: string;
  runId: string;
  name?: string;
  role: string;
  event: RunBudgetEvent;
  recordedAt: number;
}

/** A message-id-keyed queue item for a background async subagent. */
export type BackgroundSubagentNotification =
  | BackgroundSubagentCompletionNotification
  | BackgroundSubagentQuestionNotification
  | BackgroundSubagentBudgetNotification;

/** A settled shell job that still owes the main agent a notification. */
export interface BackgroundShellCompletionNotification {
  kind: 'shell_completion';
  /** Stable per job: duplicate process settlement must never wake the agent twice. */
  messageId: string;
  jobId: string;
  command: string;
  status: 'completed' | 'failed' | 'timed_out' | 'cancelled';
  output: string;
  error?: string;
  completedAt: number;
}

/** One shell watch firing while its job may still be running. */
export interface BackgroundShellOutputNotification {
  kind: 'shell_output';
  /**
   * `shell_output:${jobId}:${watchId}:${seq}` — the seq suffix keeps a
   * repeating watch's firings distinct under the exactly-once dedupe.
   */
  messageId: string;
  jobId: string;
  command: string;
  watchId: string;
  /** Per-watch monotonic firing ordinal; also encoded in the messageId suffix. */
  seq: number;
  /** Bounded, complete-line match text carried by the firing. */
  matchedLines: string;
  /** Distinct complete lines coalesced into this firing (incl. byte-cap evictions). */
  coalescedCount?: number;
  /** Inclusive per-watch seq range this firing represents. */
  seqRange?: { first: number; last: number };
  /** Present only when the firing carried it. */
  droppedBytes?: number;
  recordedAt: number;
}

/** A still-running background task has reached its next proactive check-in interval. */
export interface BackgroundCheckInNotification {
  kind: 'check_in';
  /** `check_in:${target.kind}:${target.id}:${checkInIndex}` — repeat check-ins are distinct ids. */
  messageId: string;
  target: { kind: 'subagent'; id: string } | { kind: 'shell'; id: string };
  checkInIndex: number;
  elapsedMs: number;
  details: BackgroundCheckInDueEvent['details'];
  recordedAt: number;
}

/** A user action on background work that the main agent must plan around. */
export interface BackgroundUserControlNotification {
  kind: 'user_control';
  /** Stable per action and target, so repeated clicks do not repeat planning input. */
  messageId: string;
  action: 'stop' | 'background';
  target: { kind: 'subagent' | 'shell'; id: string };
  details:
    | { kind: 'subagent'; id: string; name?: string; role: string; task: string }
    | { kind: 'shell'; id: string; command: string };
  requestedAt: number;
}

/** Background work is delivered through one queue regardless of its executor. */
export type BackgroundNotification =
  | BackgroundSubagentNotification
  | BackgroundShellCompletionNotification
  | BackgroundShellOutputNotification
  | BackgroundUserControlNotification
  | BackgroundCheckInNotification;

export type BackgroundSubagentTaskStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

/** The single most recent tool call observed for a live background run. */
export interface BackgroundSubagentTaskTool {
  /** Display-ready command line, e.g. `grep "TODO" src/`. */
  label: string;
  state: 'running' | 'success' | 'failed';
}

/** Conversation-scoped projection of one background subagent lifecycle. */
export interface BackgroundSubagentTask {
  /** Omitted by legacy callers; any non-shell task is a subagent task. */
  kind?: 'subagent';
  runId: string;
  /** Optional user-provided alias for identifying the run in the UI. */
  name?: string;
  role: string;
  task: string;
  status: BackgroundSubagentTaskStatus;
  startedAt: number;
  completedAt?: number;
  /** Aggregate model usage, available after the subagent settles. */
  usage?: NormalizedUsage;
  /** Absent until the run calls its first tool; dropped once the run settles. */
  lastTool?: BackgroundSubagentTaskTool;
  /**
   * The newest tool calls of a live run, oldest first, capped at
   * {@link BACKGROUND_SUBAGENT_RECENT_TOOL_LIMIT}. Absent until the run calls
   * its first tool; dropped once the run settles.
   */
  recentTools?: BackgroundSubagentTaskTool[];
  /** Failure reason if the subagent failed. */
  error?: string;
}

export type BackgroundShellTaskStatus = 'running' | 'completed' | 'failed' | 'timed_out' | 'cancelled';

/** Conversation-scoped projection of one session-owned background shell job. */
export interface BackgroundShellTask {
  kind: 'shell';
  jobId: string;
  command: string;
  status: BackgroundShellTaskStatus;
  startedAt: number;
  completedAt?: number;
  error?: string;
}

/** The UI has one background-task surface with executor-specific details. */
export type BackgroundTask = BackgroundSubagentTask | BackgroundShellTask;

/**
 * The delivery half of {@link SubagentNotificationStore}, for callers that hand
 * pending notifications to the main agent but never produce them.
 */
export interface BackgroundSubagentNotificationPort {
  readonly pendingCount: number;
  drain(): BackgroundNotification[];
  retain(notifications: readonly BackgroundNotification[]): void;
  /** Queues one exact-once notification for a successful user control action. */
  enqueueUserControl(
    notification: Omit<BackgroundUserControlNotification, 'kind' | 'messageId' | 'requestedAt'>,
  ): boolean;
}

/** Read-only lifecycle projection used by the background-tasks UI. */
export interface BackgroundSubagentTaskPort {
  getSnapshot(): readonly BackgroundTask[];
  setObserver(observer: (() => void) | null): void;
}

export interface SubagentNotificationStoreDeps {
  /** Injectable clock so completion timestamps stay deterministic under test. */
  now?: () => number;
  /** How long terminal tasks remain visible in the background overview. */
  recentTaskRetentionMs?: number;
  /**
   * Upper bound on remembered notification ids. The async registry caps
   * sessions at 50 and TTLs terminal runs out after 30 minutes, so a few
   * hundred ids covers replay protection while staying O(1) in memory.
   */
  deliveredIdCap?: number;
}

const DEFAULT_DELIVERED_ID_CAP = 256;
export const BACKGROUND_TASK_RECENT_RETENTION_MS = 5_000;
/** How many of a live run's newest tool calls the task panel shows. */
export const BACKGROUND_SUBAGENT_RECENT_TOOL_LIMIT = 3;

/**
 * Pending notifications for background (async) subagent runs.
 *
 * Owns three invariants the callers must not have to re-derive:
 *  - Only async completions and async registry questions are notifiable.
 *    Foreground and nested activity has no async flag and never surfaces here.
 *  - A message is announced at most once, ever. Completion ids are stable per
 *    run while each question has its own id, allowing one live run to ask more
 *    than once over its lifetime without replaying either message.
 *  - Delivery is confirmed by the caller, not by reading. `drain()` hands over
 *    the pending batch and clears it; a caller whose delivery failed calls
 *    `retain()` to put the batch back at the front of the queue. Drain/retain
 *    was chosen over peek/commit because the common path (delivery succeeds) is
 *    then a single call, and because retained notifications are handed back as
 *    values rather than leaving the store holding provisional state. A message
 *    id stays deduped across both paths, so a retained notification is
 *    redelivered exactly once and a replayed event for it is still dropped.
 */
export class SubagentNotificationStore implements BackgroundSubagentNotificationPort {
  #pending = new Map<string, BackgroundNotification>();
  #seen = new Set<string>();
  /** Stop requests are session-scoped and their target count is registry-bounded. */
  #userControlMessageIds = new Set<string>();
  #tasks = new Map<string, BackgroundTask>();
  #settledTaskIds = new Set<string>();
  #lifecycleEpochs = new Map<string, number>();
  #now: () => number;
  #deliveredIdCap: number;
  #recentTaskRetentionMs: number;

  constructor(deps: SubagentNotificationStoreDeps = {}) {
    this.#now = deps.now ?? Date.now;
    this.#deliveredIdCap = Math.max(1, deps.deliveredIdCap ?? DEFAULT_DELIVERED_ID_CAP);
    this.#recentTaskRetentionMs = Math.max(0, deps.recentTaskRetentionMs ?? BACKGROUND_TASK_RECENT_RETENTION_MS);
  }

  /**
   * Updates the read-only task projection for async starts, tool activity, and
   * completions. Only the newest tool calls of a live run are kept: the overview
   * answers "what is it doing now", not its full history.
   */
  recordLifecycle(event: ConversationEvent): boolean {
    if (event.type === 'background_shell_started') {
      this.#purgeExpiredTasks();
      const existing = this.#tasks.get(event.jobId);
      if (existing?.kind === 'shell' && existing.status !== 'running') return false;
      if (existing?.kind === 'shell' && existing.status === 'running' && existing.command === event.command)
        return false;
      this.#tasks.set(event.jobId, {
        kind: 'shell',
        jobId: event.jobId,
        command: event.command,
        status: 'running',
        startedAt: existing?.startedAt ?? this.#now(),
      });
      return true;
    }

    if (event.type === 'background_shell_completed') {
      const existing = this.#tasks.get(event.jobId);
      if (existing?.kind === 'shell' && existing.status !== 'running') return false;
      const completedAt = this.#now();
      this.#tasks.set(event.jobId, {
        kind: 'shell',
        jobId: event.jobId,
        command: event.command,
        status: event.status,
        startedAt: existing?.kind === 'shell' ? existing.startedAt : completedAt,
        completedAt,
        ...(event.error ? { error: event.error } : {}),
      });
      return true;
    }

    if (event.type === 'subagent_tool_started' || event.type === 'subagent_command_message') {
      return this.#recordToolActivity(event);
    }

    if (event.type === 'usage_update') {
      if (!event.agentId) return false;
      const task = this.#tasks.get(event.agentId);
      if (!task || task.kind !== 'subagent' || task.status !== 'running') return false;
      this.#tasks.set(event.agentId, { ...task, usage: event.usage });
      return true;
    }

    if (event.type === 'subagent_started' && event.async === true) {
      // Retention is what separates replay from continuation here, so it has to
      // be current whether or not the UI has read a snapshot since.
      this.#purgeExpiredTasks();
      const existing = this.#tasks.get(event.agentId);
      // A terminal task still inside its retention window means this start is a
      // replay of the run that just finished, not a continuation of it.
      if (existing && existing.status !== 'running') return false;
      if (
        existing?.kind !== 'shell' &&
        existing?.status === 'running' &&
        existing.role === event.role &&
        existing.task === event.task
      ) {
        return false;
      }
      // `continue_run_id` reuses a settled run id, so a start for one opens a
      // fresh lifecycle rather than replaying the old one.
      if (this.#settledTaskIds.delete(event.agentId)) {
        this.#bumpLifecycleEpoch(event.agentId);
      }

      this.#tasks.set(event.agentId, {
        kind: 'subagent',
        runId: event.agentId,
        ...(event.name !== undefined ? { name: event.name } : {}),
        role: event.role,
        task: event.task,
        status: 'running',
        startedAt: existing?.startedAt ?? this.#now(),
      });
      return true;
    }

    if (event.type !== 'subagent_completed' || event.async !== true) return false;
    const result = event.result;
    if (!result?.agentId || !isTerminalSubagentResult(result)) return false;
    if (this.#settledTaskIds.has(result.agentId)) return false;

    const existing = this.#tasks.get(result.agentId);
    if (existing && existing.status !== 'running') return false;

    const completedAt = this.#now();
    this.#tasks.set(result.agentId, {
      kind: 'subagent',
      runId: result.agentId,
      ...(existing?.kind !== 'shell' && existing?.name !== undefined
        ? { name: existing.name }
        : result.name !== undefined
        ? { name: result.name }
        : {}),
      role: existing && existing.kind !== 'shell' ? existing.role : result.role,
      task: existing && existing.kind !== 'shell' ? existing.task : '',
      status: result.status,
      startedAt: existing && existing.kind !== 'shell' ? existing.startedAt : completedAt,
      completedAt,
      ...(result.usage !== undefined ? { usage: result.usage } : {}),
      ...(result.error ? { error: result.error } : {}),
    });
    this.#settledTaskIds.add(result.agentId);
    while (this.#settledTaskIds.size > this.#deliveredIdCap) {
      const oldest = this.#settledTaskIds.values().next().value;
      if (oldest === undefined) break;
      this.#settledTaskIds.delete(oldest);
    }
    return true;
  }

  /**
   * Projects the newest tool calls of a live run. Tool events carry no `async`
   * flag, so membership in the running task map is what scopes this to
   * background runs — foreground and nested activity never registers a task.
   */
  #recordToolActivity(event: SubagentToolStartedEvent | SubagentCommandMessageEvent): boolean {
    const task = this.#tasks.get(event.agentId);
    if (!task || task.kind !== 'subagent' || task.status !== 'running') return false;

    const lastTool: BackgroundSubagentTaskTool =
      event.type === 'subagent_tool_started'
        ? {
            label: formatToolCommand(event.toolName, parseToolArguments(event.arguments) as Record<string, unknown>),
            state: 'running',
          }
        : {
            label: event.message?.command ?? '',
            state: event.message?.success === false ? 'failed' : 'success',
          };

    if (!lastTool.label) return false;
    const previous = task.recentTools ?? (task.lastTool ? [task.lastTool] : []);
    const newest = previous[previous.length - 1];
    if (newest?.label === lastTool.label && newest.state === lastTool.state) return false;

    const recentTools = [...previous, lastTool].slice(-BACKGROUND_SUBAGENT_RECENT_TOOL_LIMIT);
    this.#tasks.set(event.agentId, { ...task, lastTool, recentTools });
    return true;
  }

  getTaskSnapshot(): readonly BackgroundTask[] {
    this.#purgeExpiredTasks();
    return [...this.#tasks.values()];
  }

  #purgeExpiredTasks(): void {
    const now = this.#now();
    for (const [runId, task] of this.#tasks) {
      if (task.completedAt !== undefined && now - task.completedAt >= this.#recentTaskRetentionMs) {
        this.#tasks.delete(runId);
      }
    }
  }

  /** Records one novel async completion or question, returning whether it woke the queue. */
  enqueue(event: ConversationEvent): boolean {
    const notification = this.#notificationFor(event);
    if (!notification || this.#seen.has(notification.messageId)) return false;

    this.#pending.set(notification.messageId, notification);
    this.#seen.add(notification.messageId);
    this.#evictOldestSeen();
    return true;
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  /** Hands over every pending notification in completion order and clears them. */
  drain(): BackgroundNotification[] {
    const drained = [...this.#pending.values()];
    this.#pending.clear();
    // Handing the batch over is the point at which old ids become evictable:
    // nothing is owed a notification any more, only replay protection.
    this.#evictOldestSeen();
    return drained;
  }

  /** Returns undelivered notifications to the queue, ahead of anything newer. */
  retain(notifications: readonly BackgroundNotification[]): void {
    if (notifications.length === 0) return;
    const newer = [...this.#pending.values()];
    this.#pending.clear();
    for (const notification of notifications) {
      this.#pending.set(notification.messageId, notification);
      this.#seen.add(notification.messageId);
    }
    for (const notification of newer) this.#pending.set(notification.messageId, notification);
  }

  enqueueUserControl(
    notification: Omit<BackgroundUserControlNotification, 'kind' | 'messageId' | 'requestedAt'>,
  ): boolean {
    const lifecycleSuffix =
      notification.target.kind === 'subagent' ? `:${this.#lifecycleEpochs.get(notification.target.id) ?? 1}` : '';
    const messageId = `user_control:${notification.action}:${notification.target.kind}:${notification.target.id}${lifecycleSuffix}`;
    if (this.#userControlMessageIds.has(messageId)) return false;
    this.#pending.set(messageId, { kind: 'user_control', ...notification, messageId, requestedAt: this.#now() });
    this.#userControlMessageIds.add(messageId);
    this.#seen.add(messageId);
    this.#evictOldestSeen();
    return true;
  }

  /**
   * Drops the oldest remembered ids once the cap is exceeded, skipping runs that
   * still owe a notification: correctness of an undelivered notification wins
   * over the memory bound, and the pending queue is itself bounded by the number
   * of runs the registry will retain. Forgetting an id only costs replay
   * protection for a run that was delivered long ago.
   */
  #evictOldestSeen(): void {
    if (this.#seen.size <= this.#deliveredIdCap) return;
    for (const messageId of this.#seen) {
      if (this.#seen.size <= this.#deliveredIdCap) return;
      if (this.#pending.has(messageId)) continue;
      this.#seen.delete(messageId);
    }
  }

  /**
   * Completion ids are stable per lifecycle, not per run id. A run id that is
   * continued completes once per continuation, and each of those completions
   * owes the main agent its own notification; only a replay within one
   * lifecycle is a duplicate.
   */
  #completionMessageId(runId: string): string {
    const epoch = this.#lifecycleEpochs.get(runId) ?? 1;
    return epoch > 1 ? `completion:${runId}#${epoch}` : `completion:${runId}`;
  }

  #bumpLifecycleEpoch(runId: string): void {
    this.#lifecycleEpochs.set(runId, (this.#lifecycleEpochs.get(runId) ?? 1) + 1);
    while (this.#lifecycleEpochs.size > this.#deliveredIdCap) {
      const oldest = this.#lifecycleEpochs.keys().next().value;
      if (oldest === undefined || oldest === runId) break;
      this.#lifecycleEpochs.delete(oldest);
    }
  }

  #notificationFor(event: ConversationEvent): BackgroundNotification | undefined {
    if (event.type === 'background_shell_completed') {
      return {
        kind: 'shell_completion',
        messageId: `shell_completion:${event.jobId}`,
        jobId: event.jobId,
        command: event.command,
        status: event.status,
        output: event.output,
        ...(event.error ? { error: event.error } : {}),
        completedAt: this.#now(),
      };
    }
    if (event.type === 'background_shell_output') {
      return {
        kind: 'shell_output',
        messageId: `shell_output:${event.jobId}:${event.watchId}:${event.seq}`,
        jobId: event.jobId,
        command: event.command,
        watchId: event.watchId,
        seq: event.seq,
        matchedLines: event.matchedLines,
        ...(event.coalescedCount !== undefined ? { coalescedCount: event.coalescedCount } : {}),
        ...(event.seqRange !== undefined ? { seqRange: event.seqRange } : {}),
        ...(event.droppedBytes !== undefined ? { droppedBytes: event.droppedBytes } : {}),
        recordedAt: this.#now(),
      };
    }
    if (event.type === 'background_check_in_due') {
      return {
        kind: 'check_in',
        messageId: `check_in:${event.target.kind}:${event.target.id}:${event.checkInIndex}`,
        target: event.target,
        checkInIndex: event.checkInIndex,
        elapsedMs: event.elapsedMs,
        details: event.details,
        recordedAt: this.#now(),
      };
    }
    if (event.type === 'subagent_completed' && event.async === true) {
      const result = (event as { result?: SubagentResult }).result;
      const runId = result?.agentId;
      if (!result || !runId || !isTerminalSubagentResult(result)) return undefined;
      const task = this.#tasks.get(runId);
      return {
        kind: 'completion',
        messageId: this.#completionMessageId(runId),
        runId,
        ...(task?.kind !== 'shell' && task?.name !== undefined
          ? { name: task.name }
          : result.name !== undefined
          ? { name: result.name }
          : {}),
        role: result.role,
        status: result.status,
        preview: truncatePreview(result.finalText || result.error),
        formattedResult: formatSubagentResult(result),
        ...(result.error ? { error: result.error } : {}),
        completedAt: this.#now(),
      };
    }
    if (event.type === 'subagent_question' && event.async === true && event.messageId && event.runId) {
      return {
        kind: 'question',
        messageId: event.messageId,
        runId: event.runId,
        ...(event.name !== undefined ? { name: event.name } : {}),
        role: event.role,
        question: event.question,
        askedAt: this.#now(),
      };
    }
    if (event.type === 'subagent_run_budget') {
      // Soft is a wrap-up nudge for the child itself, delivered through its own
      // tool output. Escalating it would ask the parent to judge a run that has
      // not yet reached anything abnormal.
      if (event.event.type === 'budget_stage' && event.event.stage === 'soft') return undefined;
      const task = this.#tasks.get(event.agentId);
      const eventKey =
        event.event.type === 'budget_stage'
          ? `${event.event.type}:${event.event.stage}:${event.event.evidence.dimension}`
          : `${event.event.type}:${event.event.toolName}:${event.event.argumentsText}`;
      return {
        kind: 'budget',
        messageId: `budget:${event.agentId}:${eventKey}`,
        runId: event.agentId,
        ...(task?.kind !== 'shell' && task?.name !== undefined ? { name: task.name } : {}),
        role: event.role,
        event: event.event,
        recordedAt: this.#now(),
      };
    }
    return undefined;
  }
}
