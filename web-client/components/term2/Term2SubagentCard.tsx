'use client';
import { Bot, ChevronRight, Loader2 } from 'lucide-react';
import type { Term2SubagentCard as Term2SubagentCardModel } from '../../lib/term2/types';
import { Term2Markdown } from './Term2Markdown';
import { Term2ToolGroup } from './Term2ToolGroup';

export function Term2SubagentCard({ card }: { card: Term2SubagentCardModel }) {
  return (
    <article
      className="rounded-xl border border-black/[0.07] bg-white p-3 text-sm shadow-[0_1px_2px_rgba(0,0,0,0.03)] dark:border-white/[0.07] dark:bg-white/[0.02]"
      aria-label={`Subagent ${card.role} ${card.status}`}
    >
      <div className="flex items-center gap-2">
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-teal-500/10 text-teal-700 dark:text-teal-400">
          {card.status === 'running' ? (
            <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Bot aria-hidden className="h-3.5 w-3.5" />
          )}
        </span>
        <strong className="min-w-0 flex-1 truncate font-medium">{card.name || card.role}</strong>
        <span className="shrink-0 rounded-full bg-black/[0.04] px-2 py-0.5 text-[11px] text-zinc-500 dark:bg-white/[0.06] dark:text-zinc-400">
          {card.status}
          {card.async ? ' · async' : ''}
        </span>
      </div>
      {card.task && (
        <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-[13px] text-zinc-600 dark:text-zinc-400">{card.task}</p>
      )}
      {card.progressText && card.status === 'running' && (
        <p className="mt-1 whitespace-pre-wrap text-xs text-zinc-500">{card.progressText}</p>
      )}
      {card.commands.length > 0 && (
        <div className="mt-2">
          <Term2ToolGroup commands={card.commands} />
        </div>
      )}
      {card.toolsUsed && card.toolsUsed.length > 0 && (
        <p className="mt-1 text-xs text-zinc-500">
          {card.toolsUsed.map((tool) => `${tool.toolName} ×${tool.count}`).join(', ')}
        </p>
      )}
      {card.finalText && (
        <details className="group/result mt-2 text-xs">
          <summary className="flex cursor-pointer list-none items-center gap-1 text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 [&::-webkit-details-marker]:hidden">
            <ChevronRight aria-hidden className="h-3 w-3 transition-transform group-open/result:rotate-90" />
            Result
          </summary>
          <Term2Markdown text={card.finalText} className="mt-1 !text-xs !leading-5" />
        </details>
      )}
      {card.error && <p className="mt-1 text-xs text-red-700 dark:text-red-400">{card.error}</p>}
    </article>
  );
}
