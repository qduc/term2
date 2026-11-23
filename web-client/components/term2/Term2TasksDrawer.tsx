'use client';

import { useState } from 'react';
import { ArrowDownToLine, Bot, ChevronDown, ChevronRight, Loader2, Square, Terminal, X } from 'lucide-react';
import type { TaskControlAction, Term2SessionView } from '../../lib/term2/types';
import { Term2Markdown } from './Term2Markdown';
import { Term2ToolGroup } from './Term2ToolGroup';

const ACTIVE_STATUSES = new Set(['running', 'queued', 'pending', 'waiting', 'cancelling', 'awaiting_interaction']);

export function Term2TasksDrawer({
  view,
  onControlTask,
}: {
  view: Term2SessionView;
  onControlTask: (action: TaskControlAction) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);

  const tasks = view.nativeState?.tasks ?? [];
  const branches = Object.values(view.branches ?? {});
  const activeCount = tasks.filter((t) => ACTIVE_STATUSES.has(String(t.status))).length;

  if (tasks.length === 0 && branches.length === 0) return null;

  const act = async (taskId: string, action: 'cancel' | 'background' | 'foreground' | 'check_in') => {
    setBusyTaskId(taskId);
    try {
      await onControlTask({ taskId, action });
    } finally {
      setBusyTaskId(null);
    }
  };

  return (
    <section
      aria-label="Tasks and subagents"
      className="rounded-2xl border border-black/[0.08] bg-zinc-50/70 dark:border-white/[0.08] dark:bg-white/[0.02]"
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left text-xs font-medium text-zinc-700 transition-colors hover:text-zinc-950 dark:text-zinc-300 dark:hover:text-zinc-50"
      >
        {activeCount > 0 ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-teal-600 dark:text-teal-400" />
        ) : (
          <Bot className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
        )}
        <span>
          {activeCount > 0
            ? `${activeCount} active task${activeCount === 1 ? '' : 's'}`
            : `${tasks.length || branches.length} task${(tasks.length || branches.length) === 1 ? '' : 's'} & subagents`}
        </span>
        {tasks.length > activeCount && activeCount > 0 && (
          <span className="text-zinc-400">· {tasks.length} total</span>
        )}
        <ChevronDown className={`ml-auto h-3.5 w-3.5 text-zinc-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="space-y-2 border-t border-black/[0.06] px-3.5 py-3 text-xs dark:border-white/[0.06]">
          {tasks.map((task) => {
            const id = String(task.id ?? '');
            const status = String(task.status ?? 'unknown');
            const label = String(task.label ?? task.name ?? task.role ?? id);
            const isActive = ACTIVE_STATUSES.has(status);
            const isShell = task.kind === 'shell';
            const branch = branches.find((b) => b.identity.taskId === id);
            return (
              <article
                key={id}
                className="rounded-xl border border-black/[0.07] bg-white p-3 dark:border-white/[0.07] dark:bg-zinc-900/80"
              >
                <div className="flex flex-wrap items-center gap-2">
                  {isShell ? (
                    <Terminal className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
                  ) : (
                    <Bot className="h-3.5 w-3.5 shrink-0 text-teal-600 dark:text-teal-400" />
                  )}
                  <span className="font-medium text-zinc-900 dark:text-zinc-100">{label}</span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10.5px] font-medium ${
                      status === 'running'
                        ? 'bg-teal-500/15 text-teal-700 dark:text-teal-300'
                        : status === 'failed'
                          ? 'bg-red-500/15 text-red-700 dark:text-red-300'
                          : 'bg-black/[0.05] text-zinc-600 dark:bg-white/[0.07] dark:text-zinc-300'
                    }`}
                  >
                    {status}
                  </span>
                  {isActive && (
                    <div className="ml-auto flex items-center gap-1.5">
                      <button
                        type="button"
                        disabled={busyTaskId === id}
                        onClick={() => void act(id, 'background')}
                        title="Move task to background"
                        className="inline-flex items-center gap-1 rounded-md border border-black/[0.1] px-2 py-0.5 text-[11px] text-zinc-600 hover:bg-zinc-50 disabled:opacity-40 dark:border-white/10 dark:text-zinc-300 dark:hover:bg-white/[0.06]"
                      >
                        <ArrowDownToLine className="h-3 w-3" />
                        Background
                      </button>
                      <button
                        type="button"
                        disabled={busyTaskId === id}
                        onClick={() => void act(id, 'cancel')}
                        title="Stop task"
                        className="inline-flex items-center gap-1 rounded-md border border-red-200 px-2 py-0.5 text-[11px] text-red-600 hover:bg-red-50 disabled:opacity-40 dark:border-red-900/60 dark:text-red-400 dark:hover:bg-red-950/40"
                      >
                        <Square className="h-2.5 w-2.5 fill-current" />
                        Stop
                      </button>
                    </div>
                  )}
                </div>
                {branch && branch.view.turns.length > 0 && (
                  <details className="group/branch mt-2">
                    <summary className="flex cursor-pointer list-none items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 [&::-webkit-details-marker]:hidden">
                      <ChevronRight className="h-3 w-3 transition-transform group-open/branch:rotate-90" />
                      View subagent activity ({branch.view.turns.length} turn{branch.view.turns.length === 1 ? '' : 's'})
                    </summary>
                    <div className="mt-2 space-y-2 border-l-2 border-zinc-200 pl-3 dark:border-zinc-700">
                      {branch.view.turns.map((turn) => (
                        <div key={turn.turnId} className="space-y-1.5">
                          {turn.commands.length > 0 && <Term2ToolGroup commands={turn.commands} />}
                          {turn.text && <Term2Markdown text={turn.text} className="!text-xs !leading-5" />}
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </article>
            );
          })}
          {tasks.length === 0 &&
            branches.map(({ identity, view: branch }) => (
              <article
                key={identity.branchId}
                className="rounded-xl border border-black/[0.07] bg-white p-3 dark:border-white/[0.07] dark:bg-zinc-900/80"
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium text-zinc-900 dark:text-zinc-100">Subagent · {identity.taskId}</span>
                  <button
                    type="button"
                    aria-label="Close tasks panel"
                    onClick={() => setOpen(false)}
                    className="rounded p-0.5 text-zinc-400 hover:text-zinc-700"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="mt-2 space-y-2">
                  {branch.turns.map((turn) => (
                    <div key={turn.turnId} className="space-y-1.5">
                      {turn.commands.length > 0 && <Term2ToolGroup commands={turn.commands} />}
                      {turn.text && <Term2Markdown text={turn.text} className="!text-xs !leading-5" />}
                    </div>
                  ))}
                </div>
              </article>
            ))}
        </div>
      )}
    </section>
  );
}
