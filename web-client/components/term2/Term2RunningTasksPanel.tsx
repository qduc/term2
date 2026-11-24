'use client';

import { useEffect, useRef, useState } from 'react';
import { Bot, ChevronRight, Loader2, Terminal, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { TaskControlAction, Term2SessionView } from '../../lib/term2/types';
import { describeCommand } from './Term2CommandCard';
import { Term2TurnTimeline } from './Term2TurnTimeline';

type Fields = Readonly<Record<string, unknown>>;
type Observation = { kind?: string; at?: number; toolName?: string; attempt?: number; maxRetries?: number };

const LIVE = new Set(['running', 'awaiting_interaction', 'cancelling']);
/** Same as the TUI tasks panel: a finished task stays this long, then leaves. */
const GRACE_MS = 5_000;

export type RunningTask = {
  id: string;
  task: Fields;
  live: boolean;
  needsYou: boolean;
};

const str = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);
const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

/**
 * The tasks to show: every live task, plus ones that finished in the last few seconds so a
 * card doesn't vanish the instant it settles. Re-renders each second while any are shown.
 */
export function useRunningTasks(view: Term2SessionView) {
  const settledAt = useRef(new Map<string, number>());
  const [now, setNow] = useState(() => Date.now());
  const tasks = (view.nativeState?.tasks ?? []) as readonly Fields[];
  // A foreground shell command that reaches the network waits on the chat's network prompt; its
  // task status stays running, so mark it here as waiting on you.
  const pending = view.pendingInteraction?.state === 'pending' ? view.pendingInteraction : undefined;
  const networkPrompt = Boolean(
    pending && !pending.subagent && pending.interaction.descriptor.toolName === 'sandbox_network_access',
  );

  const shown: RunningTask[] = [];
  for (const task of tasks) {
    const id = str(task.id);
    if (!id) continue;
    const status = String(task.status ?? '');
    const live = LIVE.has(status);
    if (live) settledAt.current.delete(id);
    else {
      if (!settledAt.current.has(id)) settledAt.current.set(id, num(task.completedAt) ?? now);
      if (now - settledAt.current.get(id)! >= GRACE_MS) continue;
    }
    const blockedOnNetwork = live && networkPrompt && task.kind === 'shell' && task.mode !== 'background';
    shown.push({
      id,
      task: blockedOnNetwork ? { ...task, status: 'awaiting_interaction' } : task,
      live,
      needsYou: status === 'awaiting_interaction' || blockedOnNetwork,
    });
  }

  const anyShown = shown.length > 0;
  useEffect(() => {
    if (!anyShown) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [anyShown]);

  return {
    shown,
    runningCount: shown.filter((entry) => entry.live).length,
    needsYouCount: shown.filter((entry) => entry.needsYou).length,
  };
}

function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * A subagent's current step from its own events, the way the TUI's nested reducer finds it:
 * the tool it is running, else whether the model is writing or still thinking.
 */
function branchActivity(branch: Term2SessionView | undefined): string | undefined {
  const turn = branch?.turns.at(-1);
  if (!turn || turn.status !== 'streaming') return undefined;
  const running = [...turn.commands].reverse().find((command) => command.status === 'running');
  if (running) {
    const { verb, target } = describeCommand(running);
    return target ? `${verb} ${target}` : verb;
  }
  const last = turn.items?.at(-1);
  return last?.kind === 'text' ? 'Writing' : 'Waiting for the model';
}

/** What the task is doing right now, in plain words (the TUI task manager's activity, reworded). */
function activity(task: Fields, now: number, branch?: Term2SessionView): string {
  const status = String(task.status ?? '');
  if (status === 'cancelling') return 'Stopping…';
  if (status === 'awaiting_interaction')
    return task.pendingQuestion ? 'Waiting for your answer' : 'Waiting for your approval';
  if (!LIVE.has(status))
    return status === 'completed' ? 'Finished' : status === 'failed' ? 'Failed' : status === 'cancelled' ? 'Stopped' : 'Ended';
  const fromBranch = branchActivity(branch);
  if (fromBranch) return fromBranch;
  const observation = task.lastObservation as Observation | undefined;
  const lastTool = task.lastTool as { label?: string; state?: string } | undefined;
  // The tool call's own label ("Inspect folder contents") reads better than its tool name.
  if (observation?.kind === 'tool_started' && lastTool?.state === 'running' && lastTool.label)
    return `Running ${lastTool.label}`;
  const ago = (at?: number) => (at ? `${elapsed(now - at)} ago` : 'just now');
  switch (observation?.kind) {
    case 'request_dispatched':
    case 'tool_completed':
      return 'Waiting for the model';
    case 'response_started':
    case 'text_received':
      return 'Writing';
    case 'tool_input_received':
      return `Preparing ${observation.toolName ?? 'a tool call'}`;
    case 'tool_started':
      return `Running ${observation.toolName ?? 'a tool'}`;
    case 'retrying':
      return `Retrying ${observation.attempt ?? '?'} of ${observation.maxRetries ?? '?'}`;
    case 'approval_requested':
      return 'Waiting for your approval';
    case 'question_asked':
      return 'Waiting for your answer';
    case 'shell_started':
      return 'Started, no output yet';
    case 'shell_output_received':
      return `Output ${ago(observation.at ?? num(task.lastActivityAt))}`;
    case 'stop_requested':
      return 'Stopping…';
    default:
      return task.kind === 'shell' ? 'Running' : 'Working';
  }
}

const titleCase = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

/** Running tasks and subagents, with what each is doing and what you can do about it. */
export function Term2RunningTasksPanel({
  view,
  shown,
  onControlTask,
  onClose,
  onGoToQuestion,
}: {
  view: Term2SessionView;
  shown: RunningTask[];
  onControlTask: (action: TaskControlAction) => Promise<boolean>;
  onClose: () => void;
  onGoToQuestion: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState<string | null>(null);
  const [openActivity, setOpenActivity] = useState<string | null>(null);
  const now = Date.now();
  const branches = Object.values(view.branches ?? {});
  const runningCount = shown.filter((entry) => entry.live).length;

  const act = async (id: string, action: 'cancel' | 'background' | 'check_in') => {
    setBusy(id);
    setConfirmStop(null);
    try {
      await onControlTask({ taskId: id, action });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-12 shrink-0 items-center gap-1.5 px-3.5">
        <h2 className="text-sm font-medium text-foreground">Running</h2>
        <span className="text-xs text-muted-foreground">{runningCount}</span>
        <span className="flex-1" />
        <Button type="button" variant="ghost" size="icon-xs" aria-label="Close running tasks" onClick={onClose}>
          <X />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {shown.length === 0 && <p className="px-3.5 py-3 text-sm text-muted-foreground">Nothing is running.</p>}
        {shown.map(({ id, task, live, needsYou }) => {
          const shell = task.kind === 'shell';
          const background = task.mode === 'background';
          const role = str(task.name) ?? str(task.role);
          const name = shell ? 'Shell' : titleCase(role ?? 'Subagent');
          const model = (task.model as { model?: string } | undefined)?.model;
          const text = shell ? (str(task.label) ?? str(task.input)) : (str(task.input) ?? str(task.label));
          const startedAt = num(task.startedAt);
          const branch = branches.find((entry) => entry.identity.taskId === id);
          const steps = branch?.view.turns.length ?? 0;
          const status = String(task.status ?? '');
          return (
            <article
              key={id}
              className={cn(
                'border-t px-3.5 py-3 transition-opacity',
                needsYou && 'bg-amber-50 dark:bg-amber-950/30',
                !live && 'opacity-60',
              )}
            >
              <div className="flex items-center gap-1.5 text-sm">
                {shell ? (
                  <Terminal className="size-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <Bot className={cn('size-3.5 shrink-0', needsYou ? 'text-amber-600' : 'text-primary')} />
                )}
                <span className="font-medium text-foreground">{name}</span>
                <span className="min-w-0 truncate text-xs text-muted-foreground">
                  {[!shell && model, background && 'background'].filter(Boolean).join(' · ')}
                </span>
                <span className="flex-1" />
                {startedAt && live && <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{elapsed(now - startedAt)}</span>}
              </div>
              {text && (
                <p
                  title={text}
                  className={cn('mt-1.5 line-clamp-2 break-words text-sm text-foreground', shell && 'font-mono text-xs')}
                >
                  {text}
                </p>
              )}
              <p
                className={cn(
                  'mt-1 flex items-center gap-1.5 text-sm',
                  needsYou ? 'text-amber-800 dark:text-amber-200' : 'text-muted-foreground',
                )}
              >
                {live && !needsYou && status !== 'cancelling' && (
                  <span aria-hidden className="size-1.5 shrink-0 animate-pulse rounded-full bg-primary" />
                )}
                <span className="min-w-0 truncate">{activity(task, now, branch?.view)}</span>
              </p>
              {needsYou && (
                <button
                  type="button"
                  onClick={onGoToQuestion}
                  className="mt-1 text-xs text-amber-800 underline underline-offset-4 dark:text-amber-200"
                >
                  Go to it in the chat
                </button>
              )}
              {live && status !== 'cancelling' && (
                <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                  {!background && (
                    <Button type="button" variant="outline" size="xs" disabled={busy === id} onClick={() => void act(id, 'background')}>
                      Move to background
                    </Button>
                  )}
                  {background && (
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      disabled={busy === id}
                      title="Ask the agent to look at this task now"
                      onClick={() => void act(id, 'check_in')}
                    >
                      Check in
                    </Button>
                  )}
                  {confirmStop === id ? (
                    <>
                      <Button type="button" variant="destructive" size="xs" disabled={busy === id} onClick={() => void act(id, 'cancel')}>
                        Stop it
                      </Button>
                      <Button type="button" variant="ghost" size="xs" onClick={() => setConfirmStop(null)}>
                        Keep running
                      </Button>
                    </>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      size="xs"
                      disabled={busy === id}
                      className="text-destructive"
                      onClick={() => setConfirmStop(id)}
                    >
                      Stop
                    </Button>
                  )}
                  {busy === id && <Loader2 aria-label="Working" className="size-3.5 animate-spin text-muted-foreground" />}
                </div>
              )}
              {steps > 0 && (
                <div className="mt-2">
                  <button
                    type="button"
                    aria-expanded={openActivity === id}
                    onClick={() => setOpenActivity(openActivity === id ? null : id)}
                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                  >
                    <ChevronRight className={cn('size-3 transition-transform', openActivity === id && 'rotate-90')} />
                    {openActivity === id ? 'Hide activity' : 'Show activity'}
                  </button>
                  {openActivity === id && (
                    <div className="mt-2 space-y-2 border-l-2 pl-2.5">
                      {branch!.view.turns.map((turn) => (
                        <Term2TurnTimeline key={turn.turnId} turn={turn} displayMode="concise" />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}
