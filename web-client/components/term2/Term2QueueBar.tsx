'use client';

import { useState } from 'react';
import { PauseCircle, Pencil, Play, Trash2, X } from 'lucide-react';
import type { QueueManageAction, Term2SessionView } from '../../lib/term2/types';
import { readQueueEntries } from '../../lib/term2/queue';

export function Term2QueueBar({
  view,
  onManageQueue,
}: {
  view: Term2SessionView;
  onManageQueue: (action: QueueManageAction) => Promise<boolean>;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const entries = readQueueEntries(view);
  const queueState = view.hydration?.snapshot.queueState;
  const paused = queueState === 'paused';

  if (entries.length === 0 && !paused) return null;

  const runAction = async (action: QueueManageAction) => {
    setBusy(true);
    try {
      const ok = await onManageQueue(action);
      if (ok && action.action === 'edit') {
        setEditingId(null);
        setEditDraft('');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pointer-events-auto mx-auto mb-2 max-w-[46rem] space-y-1.5">
      {paused && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-amber-300/80 bg-amber-50/90 px-3.5 py-2 text-xs text-amber-950 dark:border-amber-700/60 dark:bg-amber-950/60 dark:text-amber-100"
        >
          <span className="flex items-center gap-2 font-medium">
            <PauseCircle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
            Message queue is paused ({entries.length} waiting)
          </span>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={busy}
              onClick={() => void runAction({ action: 'resume' })}
              className="inline-flex items-center gap-1 rounded-lg bg-amber-700 px-2.5 py-1 font-medium text-white hover:bg-amber-800 disabled:opacity-50"
            >
              <Play className="h-3 w-3" />
              Resume
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void runAction({ action: 'discard' })}
              className="inline-flex items-center gap-1 rounded-lg border border-amber-400/70 px-2.5 py-1 font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-50 dark:border-amber-700 dark:text-amber-100 dark:hover:bg-amber-900/40"
            >
              <Trash2 className="h-3 w-3" />
              Discard all
            </button>
          </div>
        </div>
      )}

      {entries.length > 0 && (
        <div
          aria-label="Queued messages"
          className="rounded-2xl border border-black/[0.08] bg-zinc-50/95 px-3 py-2 text-xs shadow-sm dark:border-white/10 dark:bg-zinc-900/95"
        >
          <div className="mb-1 flex items-center justify-between text-[11px] font-medium text-zinc-500 dark:text-zinc-400">
            <span>Queued messages ({entries.length})</span>
            <span>Runs automatically when ready</span>
          </div>
          <ul className="space-y-1">
            {entries.map((entry) => (
              <li
                key={entry.messageId}
                className="flex items-center gap-2 rounded-lg bg-white px-2.5 py-1.5 dark:bg-zinc-800/70"
              >
                <span
                  className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                    entry.delivery === 'steering'
                      ? 'bg-teal-500/15 text-teal-700 dark:text-teal-300'
                      : 'bg-zinc-200/80 text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300'
                  }`}
                >
                  {entry.delivery === 'steering' ? 'Steer' : 'Next'}
                </span>
                {editingId === entry.messageId ? (
                  <form
                    className="flex min-w-0 flex-1 items-center gap-1.5"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (editDraft.trim()) {
                        void runAction({ action: 'edit', messageId: entry.messageId, text: editDraft.trim() });
                      }
                    }}
                  >
                    <input
                      value={editDraft}
                      onChange={(event) => setEditDraft(event.target.value)}
                      disabled={busy}
                      aria-label="Edit queued message"
                      className="min-w-0 flex-1 rounded border border-teal-500/50 bg-transparent px-2 py-0.5 text-xs outline-none"
                    />
                    <button
                      type="submit"
                      disabled={busy || !editDraft.trim()}
                      className="rounded bg-teal-600 px-2 py-0.5 text-[11px] font-medium text-white disabled:opacity-40"
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingId(null)}
                      className="rounded p-0.5 text-zinc-400 hover:text-zinc-700"
                      aria-label="Cancel edit"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </form>
                ) : (
                  <>
                    <span className="min-w-0 flex-1 truncate text-zinc-800 dark:text-zinc-200">{entry.text}</span>
                    <button
                      type="button"
                      disabled={busy}
                      aria-label="Edit queued message"
                      onClick={() => {
                        setEditingId(entry.messageId);
                        setEditDraft(entry.text);
                      }}
                      className="rounded p-1 text-zinc-400 hover:bg-black/[0.05] hover:text-zinc-700 dark:hover:bg-white/[0.07] dark:hover:text-zinc-200"
                    >
                      <Pencil className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      aria-label="Remove queued message"
                      onClick={() => void runAction({ action: 'retract', messageId: entry.messageId })}
                      className="rounded p-1 text-zinc-400 hover:bg-red-500/10 hover:text-red-600 dark:hover:text-red-400"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
