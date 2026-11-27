'use client';

import { useEffect, useRef, useState } from 'react';
import { Bot, ChevronRight, Terminal, X } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { TaskControlAction, Term2SessionView, Term2TurnView } from '../../lib/term2/types';
import { describeCommand } from './Term2CommandCard';
import { Term2TurnTimeline } from './Term2TurnTimeline';

type Fields = Readonly<Record<string, unknown>>;
type Observation = { kind?: string; at?: number; toolName?: string; attempt?: number; maxRetries?: number };

const LIVE = new Set(['running', 'awaiting_interaction', 'cancelling']);
/** Same as the TUI tasks panel: a finished task stays this long, then leaves. */
const GRACE_MS = 5_000;
/**
 * Foreground shell commands that finish quickly (ls, git status, single-file checks)
 * already show on their inline tool row; wait before surfacing them in the header pill
 * and running-tasks panel so everyday commands don't flicker chrome.
 */
export const SHELL_SHOW_DELAY_MS = 1_500;

export type RunningTask = {
  id: string;
  task: Fields;
  live: boolean;
  needsYou: boolean;
};

const str = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);
const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

/**
 * The tasks to show: every live task (after a short grace delay for foreground shell
 * commands so sub-second runs don't flicker the header pill or panel), plus shown ones
 * that finished in the last few seconds so a card doesn't vanish the instant it settles.
 * Schedules only a single one-shot timeout for the next show/expiry boundary so live
 * tasks never force root shell re-renders every second.
 */
export function useRunningTasks(view: Term2SessionView) {
  const settledAt = useRef(new Map<string, number>());
  const firstSeenAt = useRef(new Map<string, number>());
  const everShown = useRef(new Set<string>());
  const [tick, setTick] = useState(0);
  const now = Date.now();
  const tasks = (view.session?.tasks ?? []) as unknown as readonly Fields[];
  // A foreground shell command that reaches the network waits on the chat's network prompt; its
  // task status stays running, so mark it here as waiting on you.
  const pending = view.pendingInteraction?.state === 'pending' ? view.pendingInteraction : undefined;
  const networkPrompt = Boolean(
    pending && !pending.subagent && pending.interaction.descriptor.toolName === 'sandbox_network_access',
  );

  const activeIds = new Set<string>();
  const shown: RunningTask[] = [];
  let nextWakeup: number | null = null;
  const scheduleWakeup = (at: number) => {
    if (nextWakeup === null || at < nextWakeup) nextWakeup = at;
  };

  for (const task of tasks) {
    const id = str(task.id);
    if (!id) continue;
    activeIds.add(id);
    const status = String(task.status ?? '');
    const live = LIVE.has(status);
    const blockedOnNetwork = live && networkPrompt && task.kind === 'shell' && task.mode !== 'background';
    const needsYou = status === 'awaiting_interaction' || blockedOnNetwork;
    const foregroundShell = task.kind === 'shell' && task.mode !== 'background';

    if (live) {
      settledAt.current.delete(id);
      if (foregroundShell && !needsYou && !everShown.current.has(id)) {
        let seen = firstSeenAt.current.get(id);
        if (seen === undefined) {
          seen = now;
          firstSeenAt.current.set(id, seen);
        }
        const started = num(task.startedAt);
        const anchor = started !== undefined ? Math.min(started, seen) : seen;
        const showAt = anchor + SHELL_SHOW_DELAY_MS;
        if (now < showAt) {
          scheduleWakeup(showAt);
          continue;
        }
      }
      everShown.current.add(id);
    } else {
      // A fast foreground shell command that finished before ever being shown shouldn't
      // pop into the panel as a dimmed "Finished" card for the grace window.
      if (foregroundShell && !everShown.current.has(id)) continue;
      if (!settledAt.current.has(id)) settledAt.current.set(id, num(task.completedAt) ?? now);
      const expiry = settledAt.current.get(id)! + GRACE_MS;
      if (now >= expiry) continue;
      scheduleWakeup(expiry);
    }
    shown.push({
      id,
      task: blockedOnNetwork ? { ...task, status: 'awaiting_interaction' } : task,
      live,
      needsYou,
    });
  }

  for (const id of firstSeenAt.current.keys()) {
    if (!activeIds.has(id)) firstSeenAt.current.delete(id);
  }
  for (const id of everShown.current) {
    if (!activeIds.has(id)) everShown.current.delete(id);
  }
  for (const id of settledAt.current.keys()) {
    if (!activeIds.has(id)) settledAt.current.delete(id);
  }

  useEffect(() => {
    if (nextWakeup === null) return;
    const delay = Math.max(50, nextWakeup - Date.now());
    const timer = window.setTimeout(() => setTick((t) => t + 1), delay);
    return () => window.clearTimeout(timer);
  }, [nextWakeup, tick]);

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
function branchActivity(turns: readonly Term2TurnView[] | undefined): string | undefined {
  const turn = turns?.at(-1);
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
function activity(task: Fields, now: number, branch?: readonly Term2TurnView[]): string {
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
  allowedActions,
  onControlTask,
  onClose,
  onGoToQuestion,
}: {
  view: Term2SessionView;
  shown: RunningTask[];
  allowedActions?: readonly ('cancel' | 'background' | 'check_in' | 'foreground')[];
  onControlTask: (action: TaskControlAction) => Promise<boolean>;
  onClose: () => void;
  onGoToQuestion: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmStop, setConfirmStop] = useState<string | null>(null);
  const [openActivity, setOpenActivity] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const runningCount = shown.filter((entry) => entry.live).length;
  const actions = new Set(allowedActions ?? ['cancel', 'background']);
  const canBackground = actions.has('background');
  const canCheckIn = actions.has('check_in');
  const canCancel = actions.has('cancel');

  useEffect(() => {
    if (runningCount === 0) return;
    let timer: number | null = null;
    const start = () => {
      if (timer !== null || document.hidden) return;
      timer = window.setInterval(() => setNow(Date.now()), 1_000);
    };
    const stop = () => {
      if (timer === null) return;
      window.clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => {
      if (document.hidden) stop();
      else {
        setNow(Date.now());
        start();
      }
    };
    start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [runningCount]);

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
          const branchTurns = view.session?.tasks.find((entry) => entry.id === id)?.branchTurns ?? [];
          const steps = branchTurns.length;
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
                  <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-primary" />
                )}
                <span className="min-w-0 truncate">{activity(task, now, branchTurns)}</span>
                {live && !needsYou && status !== 'cancelling' && (() => {
                  const lastAt = num((task.lastObservation as Observation | undefined)?.at) ?? num(task.lastActivityAt) ?? startedAt;
                  const quietMs = lastAt !== undefined ? now - lastAt : 0;
                  return quietMs >= 30_000 ? (
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground/80">
                      (quiet {elapsed(quietMs)})
                    </span>
                  ) : null;
                })()}
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
                  {!background && canBackground && (
                    <Button type="button" variant="outline" size="xs" disabled={busy === id} onClick={() => void act(id, 'background')}>
                      Move to background
                    </Button>
                  )}
                  {background && canCheckIn && (
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
                  {canCancel && (confirmStop === id ? (
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
                  ))}
                  {busy === id && <Spinner aria-label="Working" className="size-3.5 text-muted-foreground" />}
                </div>
              )}
              {shell && (() => {
                const shellOutput = str(task.text) ?? str(task.error);
                if (!shellOutput) return null;
                return (
                  <div className="mt-2">
                    <button
                      type="button"
                      aria-expanded={openActivity === id}
                      onClick={() => setOpenActivity(openActivity === id ? null : id)}
                      className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                    >
                      <ChevronRight className={cn('size-3 transition-transform', openActivity === id && 'rotate-90')} />
                      {openActivity === id ? 'Hide output' : 'Show output'}
                    </button>
                    {openActivity === id && (
                      <pre className="mt-2 max-h-48 overflow-auto rounded-md border bg-background p-2 font-mono text-[11px] leading-relaxed text-foreground whitespace-pre-wrap break-words">
                        {shellOutput.length > 4_000 ? shellOutput.slice(-4_000) : shellOutput}
                      </pre>
                    )}
                  </div>
                );
              })()}
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
                      {branchTurns.map((turn) => (
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
