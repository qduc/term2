'use client';
import { useState } from 'react';
import { ChevronRight, CircleAlert, Loader2, Wrench } from 'lucide-react';
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
      ? `${commands.length - running}/${commands.length} tool calls`
      : `${commands.length} tool ${commands.length === 1 ? 'call' : 'calls'}`;
  return (
    <section
      aria-label="Tool calls"
      className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900/40"
    >
      <button
        type="button"
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
        onClick={() => setUserOpen(!open)}
      >
        <ChevronRight aria-hidden className={`h-4 w-4 text-zinc-400 transition-transform ${open ? 'rotate-90' : ''}`} />
        {running > 0 ? (
          <Loader2 aria-hidden className="h-4 w-4 animate-spin text-teal-600 dark:text-teal-400" />
        ) : failed > 0 ? (
          <CircleAlert aria-hidden className="h-4 w-4 text-red-600 dark:text-red-400" />
        ) : (
          <Wrench aria-hidden className="h-4 w-4 text-zinc-500" />
        )}
        <span className="font-medium">{summary}</span>
        {failed > 0 && <span className="text-xs text-red-600 dark:text-red-400">{failed} failed</span>}
      </button>
      {open && (
        <div className="space-y-0.5 border-t border-zinc-200 px-1 py-1 dark:border-zinc-800">
          {commands.map((command) => (
            <Term2CommandCard key={command.callId} command={command} />
          ))}
        </div>
      )}
    </section>
  );
}
