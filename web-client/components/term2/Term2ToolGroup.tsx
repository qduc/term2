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
function summarizeCompletedTools(commands: Term2Command[]): string {
  const counts = new Map<string, number>();
  for (const cmd of commands) {
    counts.set(cmd.toolName, (counts.get(cmd.toolName) ?? 0) + 1);
  }
  const parts: string[] = [];
  for (const [name, count] of counts) {
    switch (name) {
      case 'read_file':
      case 'view_file':
        parts.push(`Read ${count} ${count === 1 ? 'file' : 'files'}`);
        break;
      case 'grep':
      case 'code_context_search':
        parts.push(`Searched ${count} ${count === 1 ? 'time' : 'times'}`);
        break;
      case 'glob':
      case 'find_files':
        parts.push(`Listed files${count > 1 ? ` ×${count}` : ''}`);
        break;
      case 'shell':
        parts.push(`Ran ${count} ${count === 1 ? 'command' : 'commands'}`);
        break;
      case 'search_replace':
      case 'apply_patch':
        parts.push(`Edited ${count} ${count === 1 ? 'file' : 'files'}`);
        break;
      case 'create_file':
        parts.push(`Created ${count} ${count === 1 ? 'file' : 'files'}`);
        break;
      case 'web_search':
        parts.push(`Searched the web${count > 1 ? ` ×${count}` : ''}`);
        break;
      case 'web_fetch':
        parts.push(`Fetched ${count} ${count === 1 ? 'page' : 'pages'}`);
        break;
      default:
        parts.push(`Used ${name}${count > 1 ? ` ×${count}` : ''}`);
        break;
    }
  }
  if (parts.length === 0) return `${commands.length} tool ${commands.length === 1 ? 'action' : 'actions'}`;
  if (parts.length <= 3) return parts.join(', ');
  return `${parts.slice(0, 2).join(', ')} and ${parts.length - 2} more`;
}

export function Term2ToolGroup({
  commands,
  defaultExpanded = false,
}: {
  commands: Term2Command[];
  defaultExpanded?: boolean;
}) {
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  if (commands.length === 0) return null;
  const running = commands.filter((c) => c.status === 'running').length;
  const pending = commands.filter((c) => c.status === 'pending').length;
  const failed = commands.filter((c) => c.status === 'failed').length;
  // A failed run stays open: the summary only says that it failed, and the reason is on the card.
  const open = userOpen ?? (defaultExpanded || running > 0 || pending > 0 || failed > 0);
  const summary =
    running > 0
      ? `Running ${running} ${running === 1 ? 'action' : 'actions'}${pending > 0 ? ` · ${pending} waiting` : ''}`
      : pending > 0
        ? `${pending} ${pending === 1 ? 'action' : 'actions'} waiting to start`
        : summarizeCompletedTools(commands);
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
          {commands.map((command, index) => (
            <Term2CommandCard key={command.messageId ?? index} command={command} />
          ))}
        </div>
      )}
    </section>
  );
}
