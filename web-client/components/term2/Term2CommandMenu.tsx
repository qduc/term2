'use client';

import { TERM2_COMMAND_IDS, type Term2CommandId } from '../../lib/term2/types';

const COMMAND_LABELS: Record<Term2CommandId, string> = {
  compact: 'Compact context',
  'retry-tool': 'Retry last tool',
  'retry-turn': 'Retry failed turn',
};

export function Term2CommandMenu({
  disabled,
  pending,
  notice,
  onCommand,
}: {
  disabled: boolean;
  pending: boolean;
  notice: { tone: 'neutral' | 'error'; message: string } | null;
  onCommand: (commandId: Term2CommandId) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {TERM2_COMMAND_IDS.map((commandId) => (
        <button
          key={commandId}
          type="button"
          disabled={disabled}
          onClick={() => onCommand(commandId)}
          className="rounded-lg border border-zinc-200 px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
        >
          {COMMAND_LABELS[commandId]}
        </button>
      ))}
      {pending && <span className="text-xs text-zinc-500">Running…</span>}
      {notice && (
        <p
          role="status"
          className={`text-xs ${notice.tone === 'error' ? 'text-red-700 dark:text-red-400' : 'text-zinc-500'}`}
        >
          {notice.message}
        </p>
      )}
    </div>
  );
}
