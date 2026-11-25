'use client';

import { useState } from 'react';
import {
  Bot,
  Check,
  ChevronRight,
  CircleAlert,
  FilePen,
  FilePlus,
  FileText,
  FolderSearch,
  Globe,
  ListTree,
  Minus,
  Search,
  SquareTerminal,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import type { Term2Command } from '../../lib/term2/types';
import {
  extractCleanToolError,
  parseToolArgs,
  summarizeCommandMeta,
  ToolInputPreview,
  ToolOutputPreview,
} from './Term2ToolContent';

const VERBS: Record<string, [running: string, done: string]> = {
  read_file: ['Reading', 'Read'],
  view_file: ['Reading', 'Read'],
  grep: ['Searching', 'Searched'],
  glob: ['Listing', 'Listed'],
  find_files: ['Listing', 'Listed'],
  shell: ['Running', 'Ran'],
  run_code: ['Running code', 'Ran code'],
  search_replace: ['Editing', 'Edited'],
  apply_patch: ['Patching', 'Patched'],
  create_file: ['Creating', 'Created'],
  web_search: ['Searching the web for', 'Searched the web for'],
  web_fetch: ['Fetching', 'Fetched'],
  run_subagent: ['Delegating', 'Delegated'],
  code_context_search: ['Searching code for', 'Searched code for'],
  read_code_outline: ['Outlining', 'Outlined'],
};

const ICONS: Record<string, LucideIcon> = {
  read_file: FileText,
  view_file: FileText,
  grep: Search,
  glob: FolderSearch,
  find_files: FolderSearch,
  shell: SquareTerminal,
  run_code: SquareTerminal,
  search_replace: FilePen,
  apply_patch: FilePen,
  create_file: FilePlus,
  web_search: Globe,
  web_fetch: Globe,
  run_subagent: Bot,
  code_context_search: Search,
  read_code_outline: ListTree,
};

/** The one argument a reader recognises the call by: a path, pattern or command. */
function targetOf(args: Record<string, unknown> | null): string {
  if (!args) return '';
  for (const key of ['path', 'file_path', 'pattern', 'command', 'query', 'url', 'task']) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value.trim().split('\n')[0].slice(0, 120);
  }
  return '';
}

/** The short label the model gave the call (shell, run_code, …), which the TUI shows instead of the raw command. */
function labelOf(args: Record<string, unknown> | null): string {
  const value = args?.description;
  return typeof value === 'string' ? value.trim().split('\n')[0].slice(0, 120) : '';
}

/**
 * How a call reads in one line. A call the model labelled reads as that label alone, as in the TUI's
 * concise display; `detail` keeps the raw target for a row that has room to show it quietly.
 */
export function describeCommand(command: Term2Command): { verb: string; target: string; detail?: string } {
  const verbs = VERBS[command.toolName];
  const active = command.status === 'running';
  const args = parseToolArgs(command.argumentsText);
  const target = targetOf(args);
  const label = labelOf(args);
  if (label && command.status !== 'pending') return { verb: label, target: '', detail: target };
  return {
    verb:
      command.status === 'pending'
        ? `Waiting to run ${command.toolName}`
        : verbs
          ? active
            ? verbs[0]
            : verbs[1]
          : command.toolName,
    target,
  };
}

export function StatusIcon({ status }: { status: Term2Command['status'] }) {
  if (status === 'running') {
    return (
      <span aria-hidden className="inline-flex h-3.5 w-3.5 items-center justify-center">
        <span className="t2-heartbeat h-2 w-2 rounded-full bg-teal-500 ring-2 ring-teal-500/25" />
      </span>
    );
  }
  if (status === 'completed') return <Check aria-hidden className="h-3.5 w-3.5 text-teal-600 dark:text-teal-400" />;
  if (status === 'failed') return <CircleAlert aria-hidden className="h-3.5 w-3.5 text-red-600 dark:text-red-400" />;
  return <Minus aria-hidden className="h-3.5 w-3.5 text-zinc-400" />;
}

/** The tool's own icon, replaced by a spinner or warning while that state is the news. */
function ToolIcon({ command }: { command: Term2Command }) {
  if (command.status === 'running' || command.status === 'pending' || command.status === 'failed')
    return <StatusIcon status={command.status} />;
  const Icon = ICONS[command.toolName] ?? Wrench;
  return <Icon aria-hidden className="h-3.5 w-3.5 text-zinc-400 dark:text-zinc-500" strokeWidth={1.75} />;
}

export function Term2CommandCard({ command }: { command: Term2Command }) {
  // Closed until the reader opens it; a failure's reason is already on the row.
  const [open, setOpen] = useState(false);
  const { verb, target, detail } = describeCommand(command);
  const meta = summarizeCommandMeta(command);
  const cleanError = extractCleanToolError(command.error);
  const errorLine = cleanError?.replace(/^Error:\s*/i, '').split('\n').find((line) => line.trim())?.trim();

  return (
    <article aria-label={`Tool ${command.toolName} ${command.status}`} className="text-sm">
      <button
        type="button"
        aria-expanded={open}
        className="group/row flex w-full min-w-0 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-black/[0.035] dark:hover:bg-white/[0.04]"
        onClick={() => setOpen(!open)}
      >
        <span className="flex h-4 w-4 shrink-0 items-center justify-center">
          <ToolIcon command={command} />
        </span>
        <span className={`font-medium text-zinc-700 dark:text-zinc-300 ${detail ? 'min-w-0 shrink truncate' : 'shrink-0'}`}>
          {verb}
        </span>
        {detail && !(command.status === 'failed' && errorLine && !open) && (
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-400 dark:text-zinc-500" title={detail}>
            {detail}
          </span>
        )}
        {target && (
          <span
            className={`min-w-0 truncate font-mono text-xs text-zinc-500 dark:text-zinc-400 ${
              command.status === 'failed' && errorLine ? 'max-w-[40%] shrink-0' : ''
            }`}
          >
            {target}
          </span>
        )}
        {command.status === 'failed' && errorLine && !open && (
          <span className="min-w-0 truncate text-xs text-red-600/90 dark:text-red-400/90" title={errorLine}>
            {errorLine}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {meta && command.status === 'completed' && (
            <span className="rounded bg-black/[0.045] px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-zinc-500 dark:bg-white/[0.06] dark:text-zinc-400">
              {meta}
            </span>
          )}
          {command.status === 'failed' && !errorLine && (
            <span className="rounded-full bg-red-500/10 px-1.5 py-0.5 text-xs font-medium text-red-600 dark:text-red-400">
              failed
            </span>
          )}
          {(command.status === 'aborted' || command.status === 'unknown') && (
            <span className="text-xs text-zinc-500">{command.status}</span>
          )}
          <ChevronRight
            aria-hidden
            className={`h-3.5 w-3.5 shrink-0 text-zinc-400 opacity-50 transition-all group-hover/row:opacity-100 ${
              open ? 'rotate-90 opacity-100' : ''
            }`}
          />
        </span>
      </button>
      {open && (
        <div className="t2-enter mb-2 ml-6 mr-2 mt-1.5 space-y-2.5">
          {command.argumentsText && (
            <ToolInputPreview toolName={command.toolName} argumentsText={command.argumentsText} compact />
          )}
          {command.output && <ToolOutputPreview toolName={command.toolName} output={command.output} />}
          {cleanError && (
            <div className="rounded-xl border border-red-200 bg-red-50/70 px-3 py-2 text-xs leading-5 text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300">
              {cleanError}
            </div>
          )}
        </div>
      )}
    </article>
  );
}
