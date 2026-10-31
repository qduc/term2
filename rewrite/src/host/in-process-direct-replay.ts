/** Atomic tail-only reconnect using the Session-owned captureFrom contract.
 * A current captured state is NEVER an initial snapshot followed by old facts. Existing client state receives (fromSeq, toSeq], then an authoritative
 * cut-state synchronization for non-durable interruption/error state, then live updates.
 */
import type { DirectSession, DirectSessionUpdate } from '../session/facade-types.js';
import { DirectProjection } from '../protocol/direct-projection.js';
import { DirectProtocolError } from '../protocol/direct-errors.js';
import { DirectEventQueue } from './in-process-direct-queue.js';

export function directReplayView(session: DirectSession, fromSeq: number) {
  const pending: DirectSessionUpdate[] = [];
  let projection: DirectProjection | null = null;
  let after = 0;
  let unsubscribe = (): void => undefined;
  const events = new DirectEventQueue(() => unsubscribe());
  const update = (next: DirectSessionUpdate): void => {
    if (!projection) { pending.push(next); return; }
    if (events.closed) return;
    try {
      if (next.position <= after) throw new Error('Session replay/live positions overlap');
      after = next.position;
      for (const event of projection.update(next)) events.push(event);
    } catch { events.fail(new DirectProtocolError('internal_error', 'Session replay projection failed.')); }
  };
  // Reconstruct projection context from the real accepted prefix. A queue edit or
  // steer tail cannot be interpreted from a current snapshot or an empty queue.
  // Session still owns the only reader/writer and the atomic live cut.
  const capture = session.captureFrom(0, update);
  unsubscribe = () => capture.unsubscribe();
  try {
    if (fromSeq > capture.seq) throw new DirectProtocolError('replay_unavailable', 'Replay cursor is ahead of the accepted log.');
    after = capture.position;
    projection = DirectProjection.forReplay(capture.state);
    let previousSeq = 0;
    for (const entry of capture.replay) {
      if (entry.seq <= previousSeq || entry.seq > capture.seq) throw new Error('Invalid accepted replay prefix');
      previousSeq = entry.seq;
      for (const event of projection.update(entry)) {
        if (entry.seq > fromSeq) events.push(event);
      }
    }
    // The accepted log cannot contain reopen interruption or a poisoned-writer fault.
    // Synchronize AFTER the tail, never before it, so retained clients reach the real
    // atomic cut without applying historical deltas on top of a current snapshot.
    for (const event of projection.synchronize(capture.state)) events.push(event);
    for (const next of pending) update(next);
    return { snapshot: null, replay: { fromSeq, toSeq: capture.seq }, events } as const;
  } catch (error) { events.close(); throw error; }
}
