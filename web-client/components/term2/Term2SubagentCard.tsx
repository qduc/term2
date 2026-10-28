'use client';
import type { Term2SubagentCard as Term2SubagentCardModel } from '../../lib/term2/types';
import { Term2Markdown } from './Term2Markdown';
import { Term2ToolGroup } from './Term2ToolGroup';

export function Term2SubagentCard({ card }: { card: Term2SubagentCardModel }) {
  return (
    <article
      className="rounded-lg border border-zinc-200 bg-white p-3 text-sm dark:border-zinc-700 dark:bg-zinc-800"
      aria-label={`Subagent ${card.role} ${card.status}`}
    >
      <div className="flex items-center justify-between">
        <strong>{card.name || card.role}</strong>
        <span className="text-xs text-zinc-500">
          {card.status}
          {card.async ? ' · async' : ''}
        </span>
      </div>
      {card.task && (
        <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-xs text-zinc-600 dark:text-zinc-300">{card.task}</p>
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
        <details className="mt-1 text-xs">
          <summary className="cursor-pointer text-zinc-500">Result</summary>
          <Term2Markdown text={card.finalText} className="mt-1 !text-xs !leading-5" />
        </details>
      )}
      {card.error && <p className="mt-1 text-xs text-red-700">{card.error}</p>}
    </article>
  );
}
