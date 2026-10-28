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
  Loader2,
  Minus,
  Search,
  SquareTerminal,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import type { Term2Command } from '../../lib/term2/types';

const VERBS: Record<string, [running: string, done: string]> = {
  read_file: ['Reading', 'Read'],
  grep: ['Searching', 'Searched'],
  glob: ['Listing', 'Listed'],
  find_files: ['Listing', 'Listed'],
  shell: ['Running', 'Ran'],
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
  grep: Search,
  glob: FolderSearch,
  find_files: FolderSearch,
  shell: SquareTerminal,
  search_replace: FilePen,
  apply_patch: FilePen,
  create_file: FilePlus,
  web_search: Globe,
  web_fetch: Globe,
  run_subagent: Bot,
  code_context_search: Search,
  read_code_outline: ListTree,
};

function parseArgs(argumentsText?: string): Record<string, unknown> | null {
  if (!argumentsText) return null;
  try {
    const parsed: unknown = JSON.parse(argumentsText);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The one argument a reader recognises the call by: a path, pattern or command. */
function targetOf(args: Record<string, unknown> | null): string {
  if (!args) return '';
  for (const key of ['path', 'file_path', 'pattern', 'command', 'query', 'url', 'task']) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value.trim().split('\n')[0].slice(0, 120);
  }
  return '';
}

export function describeCommand(command: Term2Command): { verb: string; target: string } {
  const verbs = VERBS[command.toolName];
  const active = command.status === 'running' || command.status === 'pending';
  const target = targetOf(parseArgs(command.argumentsText));
  return { verb: verbs ? (active ? verbs[0] : verbs[1]) : command.toolName, target };
}

export function StatusIcon({ status }: { status: Term2Command['status'] }) {
  if (status === 'running' || status === 'pending') {
    return <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin text-teal-600 dark:text-teal-400" />;
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

/** Inline diff for edit tools; null when the arguments are not a recognised edit. */
function EditDiff({ command }: { command: Term2Command }) {
  const args = parseArgs(command.argumentsText);
  if (!args) return null;
  let lines: Array<{ kind: '+' | '-' | ' '; text: string }> = [];
  if (command.toolName === 'apply_patch' && typeof args.patch === 'string') {
    lines = args.patch.split('\n').map((text) => {
      if (text.startsWith('+')) return { kind: '+', text: text.slice(1) };
      if (text.startsWith('-')) return { kind: '-', text: text.slice(1) };
      return { kind: ' ', text };
    });
  } else if (typeof args.search_content === 'string' && typeof args.replace_content === 'string') {
    lines = [
      ...args.search_content.split('\n').map((text) => ({ kind: '-' as const, text })),
      ...args.replace_content.split('\n').map((text) => ({ kind: '+' as const, text })),
    ];
  } else {
    return null;
  }
  return (
    <pre className="max-h-72 overflow-auto rounded-xl border border-black/[0.06] bg-white py-1.5 font-mono text-[12px] leading-5 dark:border-white/[0.07] dark:bg-zinc-950/60">
      {lines.map((line, index) => (
        <div
          key={index}
          className={`flex ${
            line.kind === '+'
              ? 'bg-emerald-500/[0.08] text-emerald-800 dark:bg-emerald-400/[0.08] dark:text-emerald-300'
              : line.kind === '-'
                ? 'bg-red-500/[0.07] text-red-800 dark:bg-red-400/[0.08] dark:text-red-300'
                : 'text-zinc-500'
          }`}
        >
          <span aria-hidden className="w-7 shrink-0 select-none text-center opacity-60">
            {line.kind === ' ' ? '' : line.kind}
          </span>
          <span className="whitespace-pre pr-3">{line.text}</span>
        </div>
      ))}
    </pre>
  );
}

const OUTPUT_PREVIEW_CHARS = 4000;

function Output({ text }: { text: string }) {
  const [all, setAll] = useState(false);
  const clipped = !all && text.length > OUTPUT_PREVIEW_CHARS;
  return (
    <div>
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-zinc-100/80 px-3 py-2.5 font-mono text-[12px] leading-5 text-zinc-700 dark:bg-white/[0.04] dark:text-zinc-300">
        {clipped ? text.slice(0, OUTPUT_PREVIEW_CHARS) : text}
      </pre>
      {clipped && (
        <button
          type="button"
          className="mt-1.5 text-xs font-medium text-teal-700 hover:underline dark:text-teal-400"
          onClick={() => setAll(true)}
        >
          Show all {text.length.toLocaleString()} characters
        </button>
      )}
    </div>
  );
}

export function Term2CommandCard({ command }: { command: Term2Command }) {
  const [open, setOpen] = useState(false);
  const { verb, target } = describeCommand(command);
  const diff = <EditDiff command={command} />;
  return (
    <article aria-label={`Tool ${command.toolName} ${command.status}`} className="text-sm">
      <button
        type="button"
        aria-expanded={open}
        className="group/row flex w-full min-w-0 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-black/[0.035] dark:hover:bg-white/[0.04]"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="flex h-4 w-4 shrink-0 items-center justify-center">
          <ToolIcon command={command} />
        </span>
        <span className="shrink-0 text-zinc-700 dark:text-zinc-300">{verb}</span>
        {target && (
          <span className="min-w-0 truncate font-mono text-[12.5px] text-zinc-500 dark:text-zinc-400">{target}</span>
        )}
        {command.status === 'failed' && <span className="ml-auto shrink-0 text-xs text-red-600 dark:text-red-400">failed</span>}
        {(command.status === 'aborted' || command.status === 'unknown') && (
          <span className="ml-auto shrink-0 text-xs text-zinc-500">{command.status}</span>
        )}
        <ChevronRight
          aria-hidden
          className={`h-3.5 w-3.5 shrink-0 text-zinc-400 opacity-0 transition-all group-hover/row:opacity-100 ${
            command.status === 'failed' || command.status === 'aborted' || command.status === 'unknown' ? '' : 'ml-auto'
          } ${open ? 'rotate-90 opacity-100' : ''}`}
        />
      </button>
      {open && (
        <div className="t2-enter mb-2 ml-8 mt-1 space-y-2">
          {diff}
          {command.argumentsText && (
            <details className="group/args">
              <summary className="flex cursor-pointer list-none items-center gap-1 text-xs text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 [&::-webkit-details-marker]:hidden">
                <ChevronRight aria-hidden className="h-3 w-3 transition-transform group-open/args:rotate-90" />
                Arguments
              </summary>
              <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-zinc-100/80 px-3 py-2.5 font-mono text-[12px] leading-5 text-zinc-700 dark:bg-white/[0.04] dark:text-zinc-300">
                {command.argumentsText}
              </pre>
            </details>
          )}
          {command.output && <Output text={command.output} />}
          {command.error && <p className="text-xs text-red-600 dark:text-red-400">{command.error}</p>}
        </div>
      )}
    </article>
  );
}
