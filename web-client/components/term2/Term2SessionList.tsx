'use client';
import type { SessionListItem } from '../../lib/term2/types';

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const minutes = Math.floor((Date.now() - then) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function getSessionTitle(
  session: SessionListItem,
  firstMessage?: string,
  workspaceLabel?: string,
  workspaceDisplayName?: string,
): string {
  if (firstMessage && firstMessage.trim().length > 0) {
    const firstLine = firstMessage.trim().split('\n')[0];
    return firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine;
  }
  if (workspaceDisplayName && workspaceDisplayName.trim().length > 0) {
    return `${workspaceDisplayName.trim()} session`;
  }
  if (workspaceLabel && workspaceLabel.trim().length > 0) {
    const label = workspaceLabel.trim();
    if (!label.startsWith('ws_')) {
      const base = label.includes('/') ? label.split('/').filter(Boolean).pop() : label;
      return base ? `${base} session` : 'Agent session';
    }
  }
  return 'Agent session';
}

export function Term2SessionList({
  sessions,
  selected,
  onSelect,
  onCreate,
  workspaceId,
  workspaces,
  workspaceMetadata,
  firstMessages,
  nextCursor = null,
  onNextPage,
}: {
  sessions: SessionListItem[];
  selected: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  workspaceId: string | null;
  workspaces?: Array<{ workspaceId: string; label: string }>;
  workspaceMetadata?: Record<string, { displayName: string; fullPath?: string }>;
  firstMessages?: Record<string, string>;
  nextCursor?: string | null;
  onNextPage?: () => void;
}) {
  const workspaceMap = new Map((workspaces ?? []).map((w) => [w.workspaceId, w.label]));

  return (
    <section aria-labelledby="term2-session-heading" className="flex min-h-0 flex-1 flex-col">
      <div className="mb-3 flex items-center justify-between">
        <h2 id="term2-session-heading" className="font-semibold">
          Agent sessions
        </h2>
        <button
          type="button"
          className="rounded bg-zinc-900 px-2 py-1 text-xs text-white disabled:opacity-50"
          disabled={!workspaceId}
          onClick={onCreate}
        >
          New agent chat
        </button>
      </div>
      {sessions.length === 0 && <p className="text-sm text-zinc-500">No sessions yet.</p>}
      <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto">
        {sessions.map((session) => {
          const firstMsg = firstMessages?.[session.id];
          const wsLabel = workspaceMap.get(session.workspaceId);
          const wsDisplayName = workspaceMetadata?.[session.workspaceId]?.displayName;
          const title = getSessionTitle(session, firstMsg, wsLabel, wsDisplayName);
          const eventCount = session.latestSequence;
          const eventsText = eventCount === 1 ? '1 event' : `${eventCount} events`;

          return (
            <li key={session.id}>
              <button
                type="button"
                aria-current={selected === session.id ? 'page' : undefined}
                aria-label={`${title} ${session.id}`}
                className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                  selected === session.id
                    ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/30'
                    : 'border-transparent hover:border-zinc-200 hover:bg-zinc-50 dark:hover:border-zinc-700 dark:hover:bg-zinc-900'
                }`}
                onClick={() => onSelect(session.id)}
              >
                <span className="block truncate text-sm font-medium">{title}</span>
                <span className="text-xs text-zinc-500">
                  {session.status} · {eventsText}
                </span>
                <span className="block text-[10px] text-zinc-400">created {relativeTime(session.createdAt)}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {onNextPage && (
        <button
          type="button"
          className="mt-3 rounded border px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50"
          disabled={!nextCursor}
          onClick={onNextPage}
        >
          Next agent sessions
        </button>
      )}
    </section>
  );
}
