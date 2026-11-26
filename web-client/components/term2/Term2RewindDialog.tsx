'use client';

import { useState } from 'react';
import { useLoadOnOpen } from '../../hooks/useLoadOnOpen';
import { History, Loader2, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { RewindTargetSummary } from '../../lib/term2/types';
import { useServerData } from './shell/ShellContext';

/** The checkpoint selected when the dialog opens: the one named, else the latest. */
function defaultTargetId(targets: readonly RewindTargetSummary[], initialTurnId: string | null | undefined): string | null {
  const match = initialTurnId
    ? targets.find((t) => t.turnId === initialTurnId || t.targetId === initialTurnId)
    : targets[targets.length - 1];
  return match?.targetId ?? targets[0]?.targetId ?? null;
}

const NO_TARGETS: RewindTargetSummary[] = [];

export function Term2RewindDialog({
  sessionId,
  initialTurnId,
  expectedRevision,
  onRewind,
  onClose,
}: {
  sessionId: string;
  initialTurnId?: string | null;
  expectedRevision?: string;
  onRewind: (target: RewindTargetSummary, restoreText: boolean) => Promise<void>;
  onClose: () => void;
}) {
  // Read each time the dialog opens: a turn or a rewind changes the list.
  const opened = useLoadOnOpen(useServerData().rewindTargets, sessionId);
  const targets = opened.status === 'ready' ? opened.data : NO_TARGETS;
  const loading = opened.status === 'loading';
  // A failed rewind; a failed load is shown from the resource.
  const [rewindError, setError] = useState<string | null>(null);
  const error =
    rewindError ?? (opened.status === 'failed' ? opened.error || 'Could not load rewind points.' : null);
  // Null until the user picks: the default checkpoint then.
  const [pickedId, setSelectedId] = useState<string | null>(null);
  const selectedId = pickedId ?? defaultTargetId(targets, initialTurnId);
  const [busy, setBusy] = useState(false);

  const selected = targets.find((t) => t.targetId === selectedId) ?? null;
  const files = selected?.editedFiles ?? selected?.affectedFiles ?? [];

  const confirm = async (restoreText: boolean) => {
    if (!selected || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onRewind(selected, restoreText);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Rewind failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4 text-sm">
      <p className="text-zinc-600 dark:text-zinc-400">
        Choose a previous message to rewind to. Later turns in this conversation will be discarded, and you can edit and
        resend your prompt.
      </p>

      {loading && (
        <div className="flex items-center gap-2 py-6 text-zinc-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading conversation checkpoints…
        </div>
      )}

      {error && (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      )}

      {!loading && targets.length === 0 && !error && (
        <p className="rounded-xl bg-zinc-100 px-3.5 py-3 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
          No earlier checkpoints are available to rewind to yet.
        </p>
      )}

      {!loading && targets.length > 0 && (
        <ul className="max-h-60 space-y-1.5 overflow-y-auto pr-1 scrollbar-thin" role="radiogroup" aria-label="Rewind checkpoints">
          {targets.map((target, index) => {
            const active = target.targetId === selectedId;
            return (
              <li key={target.targetId}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setSelectedId(target.targetId)}
                  className={`flex w-full items-start gap-2.5 rounded-xl border p-3 text-left transition-colors ${
                    active
                      ? 'border-teal-500/60 bg-teal-500/10 dark:border-teal-400/50 dark:bg-teal-500/15'
                      : 'border-black/[0.08] hover:bg-zinc-50 dark:border-white/10 dark:hover:bg-white/[0.04]'
                  }`}
                >
                  <History className="mt-0.5 h-4 w-4 shrink-0 text-zinc-400" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-zinc-900 dark:text-zinc-100">
                      #{index + 1} · {target.text.trim().split('\n')[0] || '(empty prompt)'}
                    </span>
                    <span className="mt-0.5 block text-xs text-zinc-500 dark:text-zinc-400">
                      Discards {target.discardedTurns} turn{target.discardedTurns === 1 ? '' : 's'}
                      {(target.editedFiles?.length ?? target.affectedFiles?.length ?? 0) > 0
                        ? ` · ${(target.editedFiles ?? target.affectedFiles ?? []).length} file(s) touched after this point`
                        : ''}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {selected && files.length > 0 && (
        <div className="rounded-xl border border-amber-300/70 bg-amber-50/70 p-3 text-xs text-amber-950 dark:border-amber-700/60 dark:bg-amber-950/30 dark:text-amber-100">
          <p className="font-medium">Files changed after this message:</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 font-mono text-xs">
            {files.slice(0, 8).map((file) => (
              <li key={file}>{file}</li>
            ))}
            {files.length > 8 && <li>and {files.length - 8} more…</li>}
          </ul>
          <p className="mt-1.5 text-xs opacity-80">
            Rewinding removes the conversation turns; verify file changes on disk if needed.
          </p>
        </div>
      )}

      <div className="flex flex-wrap justify-end gap-2 border-t border-black/[0.06] pt-3 dark:border-white/[0.08]">
        <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button type="button" disabled={!selected || busy} onClick={() => void confirm(true)}>
          {busy ? <Loader2 className="animate-spin" /> : <RotateCcw />}
          Rewind &amp; edit prompt
        </Button>
      </div>
      {expectedRevision ? <span className="sr-only">{expectedRevision}</span> : null}
    </div>
  );
}
