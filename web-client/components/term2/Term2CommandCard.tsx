'use client';
import { useState } from 'react';
import { Check, ChevronRight, CircleAlert, Loader2, Minus } from 'lucide-react';
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
    <pre className="max-h-72 overflow-auto rounded-md border border-zinc-200 bg-white py-1 font-mono text-xs dark:border-zinc-800 dark:bg-zinc-950">
      {lines.map((line, index) => (
        <div
          key={index}
          className={
            line.kind === '+'
              ? 'bg-emerald-50 px-3 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300'
              : line.kind === '-'
                ? 'bg-red-50 px-3 text-red-800 dark:bg-red-950/40 dark:text-red-300'
                : 'px-3 text-zinc-500'
          }
        >
          {line.kind === ' ' ? ' ' : line.kind} {line.text}
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
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-zinc-100 p-2 font-mono text-xs dark:bg-zinc-900">
        {clipped ? text.slice(0, OUTPUT_PREVIEW_CHARS) : text}
      </pre>
      {clipped && (
        <button
          type="button"
          className="mt-1 text-xs text-teal-700 hover:underline dark:text-teal-400"
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
        className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800/60"
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRight aria-hidden className={`h-3.5 w-3.5 shrink-0 text-zinc-400 transition-transform ${open ? 'rotate-90' : ''}`} />
        <StatusIcon status={command.status} />
        <span className="shrink-0 text-zinc-700 dark:text-zinc-300">{verb}</span>
        {target && <span className="min-w-0 truncate font-mono text-xs text-zinc-500">{target}</span>}
        {command.status === 'failed' && <span className="ml-auto shrink-0 text-xs text-red-600 dark:text-red-400">failed</span>}
        {(command.status === 'aborted' || command.status === 'unknown') && (
          <span className="ml-auto shrink-0 text-xs text-zinc-500">{command.status}</span>
        )}
      </button>
      {open && (
        <div className="ml-7 mt-1 mb-2 space-y-2">
          {diff}
          {command.argumentsText && (
            <details>
              <summary className="cursor-pointer text-xs text-zinc-500">Arguments</summary>
              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-zinc-100 p-2 font-mono text-xs dark:bg-zinc-900">
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
