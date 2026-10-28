'use client';
import { useState } from 'react';
import { ChevronRight, CircleAlert, Layers, Loader2 } from 'lucide-react';
import type { Term2Command } from '../../lib/term2/types';
import { Term2CommandCard } from './Term2CommandCard';

/**
 * One collapsible row summarising a run of tool calls. Open while anything is
 * still running so progress is visible, then folds to a single line unless the
 * reader has opened or closed it themselves.
 */
export function Term2ToolGroup({ commands }: { commands: Term2Command[] }) {
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  if (commands.length === 0) return null;
  const running = commands.filter((c) => c.status === 'running' || c.status === 'pending').length;
  const failed = commands.filter((c) => c.status === 'failed').length;
  const open = userOpen ?? running > 0;
  const summary =
    running > 0
      ? `Working · ${commands.length - running} of ${commands.length} tool calls done`
      : `Used ${commands.length} ${commands.length === 1 ? 'tool' : 'tools'}`;
  return (
    <section aria-label="Tool calls" className="text-sm">
      <button
        type="button"
        aria-expanded={open}
        className="group/tg -ml-2 inline-flex max-w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-zinc-500 transition-colors hover:bg-black/[0.035] hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-white/[0.04] dark:hover:text-zinc-100"
        onClick={() => setUserOpen(!open)}
      >
        {running > 0 ? (
          <Loader2 aria-hidden className="h-4 w-4 shrink-0 animate-spin text-teal-600 dark:text-teal-400" />
        ) : failed > 0 ? (
          <CircleAlert aria-hidden className="h-4 w-4 shrink-0 text-red-600 dark:text-red-400" />
        ) : (
          <Layers aria-hidden className="h-4 w-4 shrink-0" strokeWidth={1.75} />
        )}
        <span className="truncate">{summary}</span>
        {failed > 0 && <span className="shrink-0 text-xs text-red-600 dark:text-red-400">· {failed} failed</span>}
        <ChevronRight
          aria-hidden
          className={`h-3.5 w-3.5 shrink-0 transition-transform duration-200 ${open ? 'rotate-90' : ''}`}
        />
      </button>
      {open && (
        <div className="t2-enter mt-1 space-y-px rounded-xl border border-black/[0.06] bg-zinc-50/60 p-1 dark:border-white/[0.06] dark:bg-white/[0.02]">
          {commands.map((command) => (
            <Term2CommandCard key={command.callId} command={command} />
          ))}
        </div>
      )}
    </section>
  );
}
