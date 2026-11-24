'use client';

import { Brain, ChevronRight } from 'lucide-react';
import type { Term2Command, Term2TurnItem, Term2TurnView } from '../../lib/term2/types';
import { Term2Markdown } from './Term2Markdown';
import { Term2ToolGroup } from './Term2ToolGroup';

type RenderSegment =
  | { kind: 'reasoning'; id: string; text: string; streaming?: boolean }
  | { kind: 'text'; id: string; text: string }
  | { kind: 'tools'; key: string; commands: Term2Command[] };

/**
 * Keep thinking, text, and each tool call in chronological order. A tool call
 * is its own row, including when one reply starts several at once.
 */
function buildSegments(turn: Term2TurnView): RenderSegment[] {
  const commandById = new Map(turn.commands.map((cmd) => [cmd.callId, cmd]));
  const usedTools = new Set<string>();

  if (turn.items && turn.items.length > 0) {
    const segments: RenderSegment[] = [];
    for (const entry of turn.items) {
      if (entry.kind === 'tool') {
        const cmd = commandById.get(entry.executionId);
        if (!cmd || usedTools.has(cmd.callId)) continue;
        usedTools.add(cmd.callId);
        // One row per call. A parallel reply must not collapse into a single "Read N files" line.
        segments.push({ kind: 'tools', key: `tools:${cmd.callId}`, commands: [cmd] });
      } else if (entry.kind === 'reasoning') {
        if (!entry.text.trim()) continue;
        segments.push({ kind: 'reasoning', id: entry.id, text: entry.text, streaming: entry.streaming });
      } else if (entry.kind === 'text') {
        if (!entry.text) continue;
        segments.push({ kind: 'text', id: entry.id, text: entry.text });
      }
    }
    const remainingTools = turn.commands.filter((cmd) => !usedTools.has(cmd.callId));
    for (const cmd of remainingTools) {
      segments.push({ kind: 'tools', key: `tools:extra:${cmd.callId}`, commands: [cmd] });
    }
    return segments;
  }

  // Fallback for legacy turns without chronological item metadata.
  const fallback: RenderSegment[] = [];
  if (turn.reasoning && turn.reasoning.trim()) {
    fallback.push({
      kind: 'reasoning',
      id: `${turn.turnId}:reasoning`,
      text: turn.reasoning,
      streaming: turn.status === 'streaming' && !turn.text && turn.commands.length === 0,
    });
  }
  for (const cmd of turn.commands) {
    fallback.push({ kind: 'tools', key: `${turn.turnId}:tools:${cmd.callId}`, commands: [cmd] });
  }
  if (turn.text) {
    fallback.push({ kind: 'text', id: `${turn.turnId}:text`, text: turn.text });
  }
  return fallback;
}

export function Term2TurnTimeline({
  turn,
  displayMode,
}: {
  turn: Term2TurnView;
  displayMode: 'concise' | 'detailed';
}) {
  const segments = buildSegments(turn);
  if (segments.length === 0) return null;

  return (
    <>
      {segments.map((segment, index) => {
        if (segment.kind === 'reasoning') {
          const isStreamingNow = Boolean(segment.streaming && turn.status === 'streaming');
          return (
            <details
              key={`reason:${segment.id}:${index}`}
              className="group/reason text-sm"
              open={displayMode === 'detailed' || isStreamingNow || undefined}
            >
              <summary className="-ml-2 inline-flex cursor-pointer list-none select-none items-center gap-2 rounded-lg px-2 py-1 text-zinc-500 transition-colors hover:bg-black/[0.035] hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-white/[0.04] dark:hover:text-zinc-100 [&::-webkit-details-marker]:hidden">
                <Brain aria-hidden className="h-4 w-4 shrink-0" strokeWidth={1.75} />
                <span className={isStreamingNow ? 't2-shimmer' : undefined}>
                  {isStreamingNow ? 'Thinking…' : 'Thought process'}
                </span>
                <ChevronRight
                  aria-hidden
                  className="h-3.5 w-3.5 transition-transform group-open/reason:rotate-90"
                />
              </summary>
              <div className="ml-[7px] mt-1.5 border-l-2 border-zinc-200 pl-4 dark:border-zinc-800">
                <Term2Markdown
                  text={segment.text}
                  className="md-compact !text-[13px] !leading-6 !text-zinc-500 dark:!text-zinc-400"
                />
              </div>
            </details>
          );
        }

        if (segment.kind === 'tools') {
          return (
            <Term2ToolGroup
              key={segment.key}
              commands={segment.commands}
              defaultExpanded={displayMode === 'detailed'}
            />
          );
        }

        return <Term2Markdown key={`text:${segment.id}:${index}`} text={segment.text} />;
      })}
    </>
  );
}

export type { Term2TurnItem };
