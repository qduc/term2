'use client';
import type { Term2ConnectionStatus } from '../../lib/term2/types';

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
  return (
    <div
      role="status"
      className={`flex items-center justify-between gap-3 border-b px-4 py-2 text-sm ${
        attention ? 'border-red-200 bg-red-50 text-red-800' : 'border-zinc-200 bg-zinc-50 text-zinc-600'
      }`}
    >
      <span>{label}</span>
      {onRetry && (attention || status === 'reconnecting') && (
        <button type="button" className="rounded border px-2 py-1 text-xs" onClick={onRetry}>
          Reload
        </button>
      )}
    </div>
  );
}
