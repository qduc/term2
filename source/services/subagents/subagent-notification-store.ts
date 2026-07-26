import type { ConversationEvent } from '../conversation/conversation-events.js';
import type { SubagentResult } from './types.js';
import { truncatePreview } from './utils.js';

/** A background subagent run that finished and still owes the main agent a notification. */
export interface BackgroundSubagentNotification {
  runId: string;
  role: string;
  status: 'completed' | 'failed' | 'cancelled';
  preview: string;
  error?: string;
  completedAt: number;
}

export type BackgroundSubagentTaskStatus = 'running' | 'completed' | 'failed' | 'cancelled';

/** Conversation-scoped projection of one background subagent lifecycle. */
export interface BackgroundSubagentTask {
  runId: string;
  role: string;
  task: string;
  status: BackgroundSubagentTaskStatus;
  startedAt: number;
  completedAt?: number;
}

/**
 * The delivery half of {@link SubagentNotificationStore}, for callers that hand
 * pending notifications to the main agent but never produce them.
 */
export interface BackgroundSubagentNotificationPort {
  readonly pendingCount: number;
  drain(): BackgroundSubagentNotification[];
  retain(notifications: readonly BackgroundSubagentNotification[]): void;
}

/** Read-only lifecycle projection used by the background-tasks UI. */
export interface BackgroundSubagentTaskPort {
  getSnapshot(): readonly BackgroundSubagentTask[];
  setObserver(observer: (() => void) | null): void;
}

export interface SubagentNotificationStoreDeps {
  /** Injectable clock so completion timestamps stay deterministic under test. */
  now?: () => number;
  /** How long terminal tasks remain visible in the background overview. */
  recentTaskRetentionMs?: number;
  /**
   * Upper bound on remembered run ids. The async registry caps sessions at 50
   * and TTLs terminal runs out after 30 minutes, so a few hundred ids covers
   * every run that could still be replayed while staying O(1) in memory.
   */
  deliveredIdCap?: number;
}

const DEFAULT_DELIVERED_ID_CAP = 256;
export const BACKGROUND_TASK_RECENT_RETENTION_MS = 5_000;

/**
 * Pending notifications for background (async) subagent runs.
 *
 * Owns three invariants the callers must not have to re-derive:
 *  - Only `subagent_completed` events flagged `async: true` are notifiable.
 *    Foreground and nested runs emit the same event type without the flag and
 *    must never surface a notification.
 *  - A run is announced at most once, ever. The registry already guards against
 *    double-settling a run, so the duplicates guarded here come from buffered
 *    event flushes and conversation replay, which can re-present an event long
 *    after it was first seen — including after it was already delivered.
 *  - Delivery is confirmed by the caller, not by reading. `drain()` hands over
 *    the pending batch and clears it; a caller whose delivery failed calls
 *    `retain()` to put the batch back at the front of the queue. Drain/retain
 *    was chosen over peek/commit because the common path (delivery succeeds) is
 *    then a single call, and because retained notifications are handed back as
 *    values rather than leaving the store holding provisional state. A run id
 *    stays deduped across both paths, so a retained notification is redelivered
 *    exactly once and a replayed event for it is still dropped.
 */
export class SubagentNotificationStore implements BackgroundSubagentNotificationPort {
  #pending = new Map<string, BackgroundSubagentNotification>();
  #seen = new Set<string>();
  #tasks = new Map<string, BackgroundSubagentTask>();
  #settledTaskIds = new Set<string>();
  #now: () => number;
  #deliveredIdCap: number;
  #recentTaskRetentionMs: number;

  constructor(deps: SubagentNotificationStoreDeps = {}) {
    this.#now = deps.now ?? Date.now;
    this.#deliveredIdCap = Math.max(1, deps.deliveredIdCap ?? DEFAULT_DELIVERED_ID_CAP);
    this.#recentTaskRetentionMs = Math.max(0, deps.recentTaskRetentionMs ?? BACKGROUND_TASK_RECENT_RETENTION_MS);
  }

  /**
   * Updates the read-only task projection for async starts and completions.
   * Internal tool events intentionally do not enter this state.
   */
  recordLifecycle(event: ConversationEvent): boolean {
    if (event.type === 'subagent_started' && event.async === true) {
      if (this.#settledTaskIds.has(event.agentId)) return false;
      const existing = this.#tasks.get(event.agentId);
      if (existing && existing.status !== 'running') return false;
      if (existing?.status === 'running' && existing.role === event.role && existing.task === event.task) {
        return false;
      }

      this.#tasks.set(event.agentId, {
        runId: event.agentId,
        role: event.role,
        task: event.task,
        status: 'running',
        startedAt: existing?.startedAt ?? this.#now(),
      });
      return true;
    }

    if (event.type !== 'subagent_completed' || event.async !== true) return false;
    const result = event.result;
    if (!result?.agentId) return false;
    if (this.#settledTaskIds.has(result.agentId)) return false;

    const existing = this.#tasks.get(result.agentId);
    if (existing && existing.status !== 'running') return false;

    const completedAt = this.#now();
    this.#tasks.set(result.agentId, {
      runId: result.agentId,
      role: existing?.role ?? result.role,
      task: existing?.task ?? '',
      status: result.status,
      startedAt: existing?.startedAt ?? completedAt,
      completedAt,
    });
    this.#settledTaskIds.add(result.agentId);
    while (this.#settledTaskIds.size > this.#deliveredIdCap) {
      const oldest = this.#settledTaskIds.values().next().value;
      if (oldest === undefined) break;
      this.#settledTaskIds.delete(oldest);
    }
    return true;
  }

  getTaskSnapshot(): readonly BackgroundSubagentTask[] {
    const now = this.#now();
    for (const [runId, task] of this.#tasks) {
      if (task.completedAt !== undefined && now - task.completedAt >= this.#recentTaskRetentionMs) {
        this.#tasks.delete(runId);
      }
    }
    return [...this.#tasks.values()];
  }

  /**
   * Records a completion event when it belongs to a background run that has not
   * been seen before. Returns whether the notification was novel, so a caller
   * can act (wake a turn) only on first sight.
   */
  enqueue(event: ConversationEvent): boolean {
    if (event?.type !== 'subagent_completed' || event.async !== true) return false;
    const result = (event as { result?: SubagentResult }).result;
    const runId = result?.agentId;
    if (!result || !runId) return false;
    if (this.#seen.has(runId)) return false;

    this.#pending.set(runId, {
      runId,
      role: result.role,
      status: result.status,
      preview: truncatePreview(result.finalText || result.error),
      ...(result.error ? { error: result.error } : {}),
      completedAt: this.#now(),
    });
    this.#seen.add(runId);
    this.#evictOldestSeen();
    return true;
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  /** Hands over every pending notification in completion order and clears them. */
  drain(): BackgroundSubagentNotification[] {
    const drained = [...this.#pending.values()];
    this.#pending.clear();
    // Handing the batch over is the point at which old ids become evictable:
    // nothing is owed a notification any more, only replay protection.
    this.#evictOldestSeen();
    return drained;
  }

  /** Returns undelivered notifications to the queue, ahead of anything newer. */
  retain(notifications: readonly BackgroundSubagentNotification[]): void {
    if (notifications.length === 0) return;
    const newer = [...this.#pending.values()];
    this.#pending.clear();
    for (const notification of notifications) {
      this.#pending.set(notification.runId, notification);
      this.#seen.add(notification.runId);
    }
    for (const notification of newer) this.#pending.set(notification.runId, notification);
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
    for (const runId of this.#seen) {
      if (this.#seen.size <= this.#deliveredIdCap) return;
      if (this.#pending.has(runId)) continue;
      this.#seen.delete(runId);
    }
  }
}
