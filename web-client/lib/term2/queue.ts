import type { Term2SessionView } from './types';

export interface QueueEntry {
  messageId: string;
  text: string;
  delivery: string;
}

/** The latest native queue projection, falling back to the hydration cut. */
export function readQueueEntries(view: Term2SessionView): QueueEntry[] {
  const fromChanges = [...(view.nativeChanges ?? [])].reverse().find((c) => c.type === 'queue_changed');
  const rawList =
    fromChanges && Array.isArray(fromChanges.payload.entries)
      ? fromChanges.payload.entries
      : Array.isArray(view.hydration?.snapshot.queue)
        ? (view.hydration?.snapshot.queue as unknown[])
        : [];
  const entries: QueueEntry[] = [];
  for (const item of rawList) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    if (typeof record.messageId !== 'string') continue;
    entries.push({
      messageId: record.messageId,
      text: typeof record.text === 'string' ? record.text : '',
      delivery: typeof record.delivery === 'string' ? record.delivery : 'follow_up',
    });
  }
  return entries;
}

/**
 * Background notices the Session has recorded but not yet handed to a turn. The Session only
 * delivers them when an attached client asks it to drain, as the TUI does; nothing else wakes
 * the agent for a task that finishes while the chat is idle.
 */
export function undeliveredBackgroundNoticeIds(view: Term2SessionView): string[] {
  const notifications = view.nativeState?.notifications;
  const delivered = new Set(
    (notifications?.deliveries ?? []).flatMap((item) =>
      Array.isArray(item.notificationIds) ? (item.notificationIds as string[]) : [],
    ),
  );
  return (notifications?.notices ?? [])
    .map((item) => item.id)
    .filter((id): id is string => typeof id === 'string' && !delivered.has(id));
}

/** The Session's queue state: the latest live queue projection, else the hydration cut. */
function queueState(view: Term2SessionView): unknown {
  const latest = [...(view.nativeChanges ?? [])].reverse().find((c) => c.type === 'queue_changed');
  if (latest && latest.payload.state !== undefined) return latest.payload.state;
  return view.hydration?.snapshot.queueState ?? view.rootEvidence?.queueState;
}

const LIVE_STATUSES = new Set<Term2SessionView['status']>(['connected', 'running', 'awaiting_interaction']);

/**
 * Whether this view shows an idle chat a silent notice turn may start in, mirroring the TUI: the
 * stream is live, no root turn is running, no approval of the root turn is open (a background
 * task's own approval does not hold other tasks' notices back), and the user queue is idle and
 * empty (a drain must never resume a paused queue). It reads turns rather than `status`, which a
 * resolved task approval can leave at `running` with no root turn. The Session still decides.
 */
export function readyForBackgroundDrain(view: Term2SessionView): boolean {
  const interaction = view.pendingInteraction;
  const rootInteraction = interaction !== null && !(interaction.state === 'pending' && interaction.subagent);
  const state = queueState(view);
  return (
    LIVE_STATUSES.has(view.status) &&
    !rootInteraction &&
    !view.turns.some((turn) => turn.status === 'streaming' || turn.status === 'pending') &&
    (state === undefined || state === 'idle') &&
    readQueueEntries(view).length === 0
  );
}
