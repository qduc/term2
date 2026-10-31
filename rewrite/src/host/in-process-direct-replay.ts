/** Atomic tail-only reconnect using the Session-owned captureFrom contract.
 * The current captured state is internal context, NEVER an initial snapshot followed
 * by old facts. Existing client state receives (fromSeq, toSeq], then live updates.
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
  const capture = session.captureFrom(fromSeq, update);
  unsubscribe = () => capture.unsubscribe();
  try {
    after = capture.position;
    projection = new DirectProjection(capture.state, capture.seq);
    let previousSeq = fromSeq;
    for (const entry of capture.replay) {
      if (entry.seq <= previousSeq || entry.seq > capture.seq) throw new Error('Invalid accepted replay prefix');
      previousSeq = entry.seq;
      for (const event of projection.update({ type: 'fact', position: 0, seq: entry.seq, fact: entry.fact })) events.push(event);
    }
    // Tail projection must not add historical usage/drafts to current state a second time.
    projection = new DirectProjection(capture.state, capture.seq);
    for (const next of pending) update(next);
    return { snapshot: null, replay: { fromSeq, toSeq: capture.seq }, events } as const;
  } catch (error) { events.close(); throw error; }
}
