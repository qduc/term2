'use client';
import { useState } from 'react';
import { ChevronRight, CircleAlert, Layers } from 'lucide-react';
import type { Term2Command } from '../../lib/term2/types';
import { describeCommand, Term2CommandCard } from './Term2CommandCard';
import type { Term2DisplayMode } from './Term2TurnTimeline';

/**
 * A run of tool calls. In concise mode it is one summary line, plus the latest call while the run is live (opened only by the
 * reader); in standard mode it is one compact row per call.
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

const MAX_NAMED_FAILURES = 3;

/** "2 failed: git tag, package.json": the quiet line under a run with failures, as in the TUI. */
function describeFailures(commands: Term2Command[]): string | null {
  const failed = commands.filter((c) => c.status === 'failed');
  if (failed.length === 0) return null;
  const names = failed.slice(0, MAX_NAMED_FAILURES).map((command) => {
    const { verb, target } = describeCommand(command);
    if (!target) return verb;
    const short = /[\\/]/.test(target) && !/\s/.test(target) ? target.split(/[\\/]/).filter(Boolean).pop() : target;
    return short && short.length > 40 ? `${short.slice(0, 40)}…` : short;
  });
  const more = failed.length - names.length;
  return `${failed.length} failed: ${names.join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
}

/** Lower-case every clause after the first so the line reads as one sentence. */
function asSentence(summary: string): string {
  return summary
    .split(', ')
    .map((part, index) => (index === 0 ? part : part.charAt(0).toLowerCase() + part.slice(1)))
    .join(', ');
}

export function Term2ToolGroup({
  commands,
  displayMode = 'concise',
  live = false,
}: {
  commands: Term2Command[];
  displayMode?: Term2DisplayMode;
  /** The run can still grow: show the latest call on its own line. */
  live?: boolean;
}) {
  const [userOpen, setUserOpen] = useState(false);
  if (commands.length === 0) return null;

  // Standard: one compact row per call, nothing opened for the reader.
  if (displayMode === 'standard') {
    return (
      <section aria-label="Tool calls" className="-ml-2 space-y-px text-sm">
        {commands.map((command, index) => (
          <Term2CommandCard key={command.messageId ?? command.callId ?? index} command={command} />
        ))}
      </section>
    );
  }

  // Concise: line 1 tallies every call in the run, counted when it is issued, so it changes only
  // when a new call arrives. While the run is live, line 2 names the latest call and stays after
  // that call settles, until the next call replaces it or the run ends: a fast call never makes a
  // line appear and vanish, and the row's height changes once, when other content follows it.
  const active = commands.filter((c) => c.status === 'running' || c.status === 'pending');
  const failed = commands.filter((c) => c.status === 'failed').length;
  const allFailed = failed === commands.length;
  const summary = asSentence(summarizeCompletedTools(commands));
  // A call that was issued but hasn't started yet reads as running, so line 2 doesn't cycle through
  // "waiting" -> "running" -> "done" on every call.
  const latest = active[0] ? { ...active[0], status: 'running' as const } : commands[commands.length - 1]!;
  const current = describeCommand(latest);
  const currentText = `${current.verb}${current.target ? ` ${current.target}` : ''}${
    active.length > 1 ? ` and ${active.length - 1} more` : ''
  }${active.length > 0 ? '…' : ''}`;
  // Keep any failure summary steady once a call in the run has failed so it doesn't
  // toggle the row height on and off as subsequent tools in the same run start and finish.
  const failures = describeFailures(commands);
  const open = userOpen;

  return (
    <section aria-label="Tool calls" className="text-sm">
      <button
        type="button"
        aria-expanded={open}
        className="group/tg -ml-2 flex min-h-7 max-w-full items-start gap-2 rounded-lg px-2 py-1 text-left text-muted-foreground transition-colors hover:bg-black/[0.035] hover:text-foreground dark:hover:bg-white/[0.04]"
        onClick={() => setUserOpen(!open)}
      >
        <span className="flex h-5 shrink-0 items-center">
          {active.length > 0 ? (
            <span aria-hidden className="flex h-4 w-4 items-center justify-center">
              <span className="t2-heartbeat h-2 w-2 rounded-full bg-teal-500 ring-2 ring-teal-500/25" />
            </span>
          ) : allFailed ? (
            <CircleAlert aria-hidden className="h-4 w-4 text-red-600 dark:text-red-400" />
          ) : (
            <Layers aria-hidden className="h-4 w-4" strokeWidth={1.75} />
          )}
        </span>
        <span className="min-w-0">
          <span className="flex items-center gap-1.5 leading-5">
            <span className="truncate">{summary}</span>
            <ChevronRight
              aria-hidden
              className={`h-3.5 w-3.5 shrink-0 transition-transform duration-200 ${open ? 'rotate-90' : ''}`}
            />
          </span>
          {failures && (
            <span
              className={`block truncate text-xs leading-4 ${allFailed ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground'}`}
            >
              {failures}
            </span>
          )}
        </span>
      </button>
      {live && !open && (
        <p
          className={`truncate pl-6 text-xs leading-5 ${
            latest.status === 'failed'
              ? 'text-red-600 dark:text-red-400'
              : active.length > 0
                ? 't2-shimmer text-muted-foreground'
                : 'text-muted-foreground'
          }`}
        >
          {currentText}
        </p>
      )}
      {open && (
        <div className="t2-enter mt-1 space-y-px rounded-xl border border-black/[0.06] bg-zinc-50/60 p-1 dark:border-white/[0.06] dark:bg-white/[0.02]">
          {commands.map((command, index) => (
            <Term2CommandCard key={command.messageId ?? command.callId ?? index} command={command} />
          ))}
        </div>
      )}
    </section>
  );
}
