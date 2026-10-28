'use client';
import { CircleAlert, Loader2, RotateCw } from 'lucide-react';
import type { Term2ConnectionStatus } from '../../lib/term2/types';

/** Healthy states stay announced to assistive tech but are not drawn. */
const QUIET: ReadonlySet<Term2ConnectionStatus> = new Set(['idle', 'connected', 'running', 'awaiting_interaction', 'closed']);
const BUSY: ReadonlySet<Term2ConnectionStatus> = new Set(['hydrating', 'connecting', 'reconnecting', 'aborting']);

export function Term2StatusBanner({
  status,
  error,
  onRetry,
}: {
  status: Term2ConnectionStatus;
  error: string | null;
  onRetry?: () => void;
}) {
  const label =
    error ||
    ({
      idle: 'Choose a workspace and session',
      hydrating: 'Loading session…',
      connecting: 'Connecting…',
      connected: 'Connected',
      running: 'Running',
      awaiting_interaction: 'Waiting for your response',
      aborting: 'Stopping turn…',
      interrupted: 'Session interrupted',
      closed: 'Session closed',
      reconnecting: 'Reconnecting…',
      error: 'Unable to load session',
    }[status] ??
      'Ready');
  const attention = ['error', 'interrupted'].includes(status) || !!error;
  const quiet = !attention && QUIET.has(status);
  const showRetry = onRetry && (attention || status === 'reconnecting');
  return (
    <div className="pointer-events-none absolute inset-x-0 top-2 z-30 flex justify-center px-3">
      <div
        role="status"
        className={
          quiet
            ? 'sr-only'
            : `t2-enter pointer-events-auto ${attention ? '' : '[animation-delay:700ms]'} flex max-w-full items-center gap-2 rounded-full border py-1 pl-3 text-[13px] shadow-sm backdrop-blur-md ${
                showRetry ? 'pr-1' : 'pr-3'
              } ${
                attention
                  ? 'border-red-200 bg-red-50/90 text-red-700 dark:border-red-900/60 dark:bg-red-950/70 dark:text-red-300'
                  : 'border-black/[0.06] bg-white/85 text-zinc-600 dark:border-white/[0.08] dark:bg-zinc-900/85 dark:text-zinc-300'
              }`
        }
      >
        {!quiet &&
          (attention ? (
            <CircleAlert aria-hidden className="h-3.5 w-3.5 shrink-0" />
          ) : BUSY.has(status) ? (
            <Loader2 aria-hidden className="h-3.5 w-3.5 shrink-0 animate-spin" />
          ) : null)}
        <span className="truncate">{label}</span>
        {showRetry && (
          <button
            type="button"
            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-black/[0.06] px-2.5 py-0.5 text-xs font-medium hover:bg-black/[0.1] dark:bg-white/10 dark:hover:bg-white/15"
            onClick={onRetry}
          >
            <RotateCw aria-hidden className="h-3 w-3" />
            Reload
          </button>
        )}
      </div>
    </div>
  );
}
