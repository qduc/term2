import type { Term2SessionView } from './types';

export interface QueueEntry {
  messageId: string;
  text: string;
  delivery: string;
}

/** The Session's queue, as the snapshot holds it. */
export function readQueueEntries(view: Term2SessionView): QueueEntry[] {
  return (view.session?.queue ?? []).map((entry) => ({
    messageId: entry.messageId,
    text: typeof entry.text === 'string' ? entry.text : '',
    delivery: typeof entry.delivery === 'string' ? entry.delivery : 'follow_up',
  }));
}

/**
 * Background notices the Session has recorded but not yet handed to a turn. The Session only
 * delivers them when an attached client asks it to drain, as the TUI does; nothing else wakes
 * the agent for a task that finishes while the chat is idle.
 */
export function undeliveredBackgroundNoticeIds(view: Term2SessionView): string[] {
  const notifications = view.session?.notifications;
  const delivered = new Set((notifications?.deliveries ?? []).flatMap((item) => item.notificationIds));
  return (notifications?.notices ?? []).map((item) => item.id).filter((id) => !delivered.has(id));
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
  const state = view.session?.queueState;
  return (
    LIVE_STATUSES.has(view.status) &&
    !rootInteraction &&
    !view.turns.some((turn) => turn.status === 'streaming' || turn.status === 'pending') &&
    (state === undefined || state === 'idle') &&
    readQueueEntries(view).length === 0
  );
}
