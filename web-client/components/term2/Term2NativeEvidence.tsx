'use client';

import type { Term2SessionView } from '../../lib/term2/types';

type Frame = { kind?: string; seq?: number | null; events?: readonly { type?: string }[] };

/**
 * Diagnostics: where this page's copy of the session stands, and the last frames the session stream sent
 * (kept only while diagnostics are on). Nothing reads state from these frames; the transcript comes from the
 * folded snapshot alone.
 */
export function Term2NativeEvidence({ view, frames }: { view: Term2SessionView; frames: readonly unknown[] | null }) {
  const session = view.session;
  return (
    <div className="space-y-3 text-xs text-muted-foreground" aria-label="Session diagnostics">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt>Accepted through</dt>
        <dd>seq {view.lastAppliedSequence}</dd>
        <dt>Replay</dt>
        <dd>{view.replayMode ?? 'not connected'}</dd>
        <dt>Queue</dt>
        <dd>
          {session ? `${session.queueState}, ${session.queue.length} waiting` : 'unknown'}
        </dd>
        <dt>Tasks</dt>
        <dd>{session ? session.tasks.length : 'unknown'}</dd>
        {session?.lastError && (
          <>
            <dt>Last error</dt>
            <dd>
              {session.lastError.kind}: {session.lastError.message}
            </dd>
          </>
        )}
      </dl>
      {frames && frames.length > 0 ? (
        <ol className="max-h-64 space-y-0.5 overflow-auto font-mono" aria-label="Recent session frames">
          {[...frames].reverse().map((value, index) => {
            const frame = value as Frame;
            const types = (frame.events ?? []).map((event) => event.type ?? '?').join(', ') || '(no events)';
            return (
              <li key={frames.length - index}>
                {frame.kind}
                {typeof frame.seq === 'number' ? ` ${frame.seq}` : ''}: {types}
              </li>
            );
          })}
        </ol>
      ) : (
        <p>Recent frames are kept from the next page load while diagnostics are on.</p>
      )}
    </div>
  );
}
