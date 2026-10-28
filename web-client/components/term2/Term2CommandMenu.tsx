'use client';

import { useEffect, useRef, useState } from 'react';
import { Archive, Ellipsis, Loader2, RotateCcw, Wrench } from 'lucide-react';
import { TERM2_COMMAND_IDS, type Term2CommandId } from '../../lib/term2/types';

const COMMAND_LABELS: Record<Term2CommandId, string> = {
  compact: 'Compact context',
  'retry-tool': 'Retry last tool',
  'retry-turn': 'Retry failed turn',
};

const COMMAND_HINTS: Record<Term2CommandId, string> = {
  compact: 'Summarise history to free up context',
  'retry-tool': 'Run the last tool call again',
  'retry-turn': 'Start the failed turn over',
};

const COMMAND_ICONS: Record<Term2CommandId, typeof Archive> = {
  compact: Archive,
  'retry-tool': Wrench,
  'retry-turn': RotateCcw,
};

/** Session commands live behind one composer button so they don't crowd the input. */
export function Term2CommandMenu({
  disabled,
  pending,
  notice,
  onCommand,
}: {
  disabled: boolean;
  pending: boolean;
  notice: { tone: 'neutral' | 'error'; message: string } | null;
  onCommand: (commandId: Term2CommandId) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // A focused menu item unmounts with the menu, which would drop focus to <body>.
      // Move it to the trigger first, but only when focus is inside the menu: with focus
      // elsewhere (e.g. the composer) Escape must not steal it.
      if (rootRef.current?.contains(document.activeElement)) triggerRef.current?.focus();
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative flex min-w-0 items-center gap-2">
      <button
        ref={triggerRef}
        type="button"
        aria-label="Session commands"
        aria-haspopup="menu"
        aria-expanded={open && !disabled}
        title="Session commands"
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-black/[0.08] text-zinc-500 transition-colors hover:bg-black/[0.04] hover:text-zinc-900 disabled:cursor-not-allowed disabled:opacity-40 dark:border-white/10 dark:text-zinc-400 dark:hover:bg-white/[0.06] dark:hover:text-zinc-100 ${
          open ? 'bg-black/[0.04] text-zinc-900 dark:bg-white/[0.06] dark:text-zinc-100' : ''
        }`}
      >
        {pending ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <Ellipsis aria-hidden className="h-4 w-4" />}
      </button>
      {open && !disabled && (
        <div
          role="menu"
          className="t2-enter absolute bottom-full left-0 z-30 mb-2 w-64 rounded-xl border border-black/[0.08] bg-white p-1 shadow-[0_12px_32px_-8px_rgba(0,0,0,0.18)] dark:border-white/10 dark:bg-zinc-900 dark:shadow-[0_12px_32px_-8px_rgba(0,0,0,0.6)]"
        >
          {TERM2_COMMAND_IDS.map((commandId) => {
            const Icon = COMMAND_ICONS[commandId];
            return (
              <button
                key={commandId}
                type="button"
                role="menuitem"
                disabled={disabled}
                onClick={() => {
                  setOpen(false);
                  onCommand(commandId);
                }}
                className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-black/[0.04] disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-white/[0.06]"
              >
                <Icon aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500" strokeWidth={1.75} />
                <span className="min-w-0">
                  <span className="block text-sm text-zinc-900 dark:text-zinc-100">{COMMAND_LABELS[commandId]}</span>
                  <span className="block text-xs text-zinc-500">{COMMAND_HINTS[commandId]}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
      {pending && <span className="text-xs text-zinc-500">Running…</span>}
      {notice && (
        <p
          role="status"
          className={`truncate text-xs ${notice.tone === 'error' ? 'text-red-700 dark:text-red-400' : 'text-zinc-500'}`}
        >
          {notice.message}
        </p>
      )}
    </div>
  );
}
