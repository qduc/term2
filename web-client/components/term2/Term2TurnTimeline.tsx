'use client';

import { memo, useState } from 'react';
import { Brain, ChevronRight } from 'lucide-react';
import type { Term2Command, Term2TurnItem, Term2TurnView } from '../../lib/term2/types';
import { Term2Markdown } from './Term2Markdown';
import { Term2ToolGroup } from './Term2ToolGroup';
import { Term2UserContent } from './Term2UserContent';
import { useSmoothText } from './useSmoothText';

/**
 * How tool activity reads, matching the TUI's `ui.displayMode`: `standard` shows one
 * row per tool call and collapsed-by-default reasoning disclosures; `concise` folds each
 * run of tool calls into one summary line and hides reasoning (live thinking shows in the
 * reserved status line). Neither opens a call's output or a thinking block by itself.
 */
export type Term2DisplayMode = 'concise' | 'standard';

type RenderSegment =
  | { kind: 'user'; id: string; text: string; content?: readonly unknown[] }
  | { kind: 'reasoning'; id: string; text: string; streaming?: boolean }
  | { kind: 'text'; id: string; text: string }
  | { kind: 'tools'; key: string; commands: Term2Command[] };

/**
 * In concise mode, fold each run of consecutive tool calls into one segment. Reasoning is
 * hidden there (matching the TUI's concise mode), so live thinking neither splits tool runs
 * nor expands and collapses the transcript between steps.
 */
function foldToolRuns(segments: RenderSegment[]): RenderSegment[] {
  const folded: RenderSegment[] = [];
  let run: Extract<RenderSegment, { kind: 'tools' }> | null = null;
  for (const segment of segments) {
    if (segment.kind === 'reasoning') continue;
    if (segment.kind === 'tools') {
      if (run) run.commands.push(...segment.commands);
      else {
        run = { kind: 'tools', key: segment.key, commands: [...segment.commands] };
        folded.push(run);
      }
      continue;
    }
    run = null;
    folded.push(segment);
  }
  return folded;
}

/**
 * Keep thinking, text, and each tool call in chronological order. A tool call
 * is its own segment, including when one reply starts several at once.
 */
function buildSegments(turn: Term2TurnView, displayMode: Term2DisplayMode): RenderSegment[] {
  const segments = buildChronologicalSegments(turn);
  return displayMode === 'concise' ? foldToolRuns(segments) : segments;
}

function buildChronologicalSegments(turn: Term2TurnView): RenderSegment[] {
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
      } else if (entry.kind === 'user') {
        if (!entry.text) continue;
        segments.push({ kind: 'user', id: entry.id, text: entry.text, content: entry.content });
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

/**
 * Collapsed by default so streaming reasoning never expands hundreds of pixels and then snaps
 * shut when a tool call or reply starts. User-opened state survives live -> accepted transitions
 * because the parent keys by reasoning ordinal within the turn, and expanded output scrolls in a
 * bounded box.
 */
function ReasoningBlock({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="group/reason text-sm"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="-ml-2 inline-flex min-h-7 cursor-pointer list-none select-none items-center gap-2 rounded-lg px-2 py-1 leading-5 text-zinc-500 transition-colors hover:bg-black/[0.035] hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-white/[0.04] dark:hover:text-zinc-100 [&::-webkit-details-marker]:hidden">
        <Brain aria-hidden className="h-4 w-4 shrink-0" strokeWidth={1.75} />
        <span className={streaming ? 't2-shimmer' : undefined}>
          {streaming ? 'Thinking…' : 'Thought process'}
        </span>
        <ChevronRight
          aria-hidden
          className="h-3.5 w-3.5 transition-transform group-open/reason:rotate-90"
        />
      </summary>
      {open && (
        <div className="ml-[7px] mt-1.5 max-h-72 overflow-y-auto border-l-2 border-zinc-200 pl-4 scrollbar-thin dark:border-zinc-800">
          <Term2Markdown
            text={text}
            className="md-compact !text-[13px] !leading-6 !text-zinc-500 dark:!text-zinc-400"
          />
        </div>
      )}
    </details>
  );
}

/** Reply text: paced and faded in while it streams, plain markdown otherwise. */
function ReplyText({ text, streaming, replyStart }: { text: string; streaming: boolean; replyStart: boolean }) {
  const smooth = useSmoothText(text, streaming);
  return <Term2Markdown text={smooth.text} fade={smooth.fade} replyStart={replyStart} />;
}

export const Term2TurnTimeline = memo(function Term2TurnTimeline({
  turn,
  displayMode,
}: {
  turn: Term2TurnView;
  displayMode: Term2DisplayMode;
}) {
  const segments = buildSegments(turn, displayMode);
  if (segments.length === 0) return null;

  let reasoningOrdinal = 0;
  let textOrdinal = 0;

  return (
    <>
      {segments.map((segment, index) => {
        if (segment.kind === 'reasoning') {
          const isStreamingNow = Boolean(segment.streaming && turn.status === 'streaming');
          const key = `reason:${reasoningOrdinal++}`;
          return <ReasoningBlock key={key} text={segment.text} streaming={isStreamingNow} />;
        }

        if (segment.kind === 'user') {
          return (
            <div key={`user:${segment.id}`} className="flex flex-col items-end gap-1">
              <div className="max-w-[85%] rounded-3xl bg-zinc-100 px-4 py-2.5 dark:bg-white/[0.07]">
                <Term2UserContent text={segment.text} content={segment.content} />
              </div>
            </div>
          );
        }

        if (segment.kind === 'tools') {
          return (
            <Term2ToolGroup
              key={segment.key}
              commands={segment.commands}
              displayMode={displayMode}
              // The run is still open while it is the turn's newest segment and the turn is streaming.
              live={turn.status === 'streaming' && index === segments.length - 1}
            />
          );
        }

        const ordinal = textOrdinal++;
        return (
          <ReplyText
            key={`text:${ordinal}`}
            text={segment.text}
            replyStart={ordinal === 0}
            // Only the turn's newest segment can still grow.
            streaming={turn.status === 'streaming' && index === segments.length - 1}
          />
        );
      })}
    </>
  );
});

export type { Term2TurnItem };
