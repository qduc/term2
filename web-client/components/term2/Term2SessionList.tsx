'use client';
import { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import type { SessionListItem } from '../../lib/term2/types';

function dayGroup(iso: string): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return 'Older';
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const days = Math.floor((startOfToday.getTime() - then.getTime()) / 86400000) + 1;
  if (then >= startOfToday) return 'Today';
  if (days <= 1) return 'Yesterday';
  if (days <= 7) return 'Previous 7 days';
  return 'Older';
}
const GROUP_ORDER = ['Today', 'Yesterday', 'Previous 7 days', 'Older'];

function StatusDot({ status }: { status: SessionListItem['status'] }) {
  if (status === 'awaiting_interaction') {
    return <span title="Waiting for approval" className="h-2 w-2 shrink-0 rounded-full bg-amber-500" />;
  }
  if (status === 'running') {
    return <span title="Running" className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-teal-500" />;
  }
  return <span aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-zinc-300 dark:bg-zinc-700" />;
}

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
  const [query, setQuery] = useState('');

  const entries = useMemo(
    () =>
      sessions.map((session) => ({
        session,
        title: getSessionTitle(
          session,
          firstMessages?.[session.id],
          workspaceMap.get(session.workspaceId),
          workspaceMetadata?.[session.workspaceId]?.displayName,
        ),
      })),
    // workspaceMap is rebuilt from `workspaces` each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessions, firstMessages, workspaces, workspaceMetadata],
  );
  const grouped = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const groups = new Map<string, typeof entries>();
    for (const entry of entries) {
      if (needle && !entry.title.toLowerCase().includes(needle)) continue;
      const key = dayGroup(entry.session.updatedAt);
      groups.set(key, [...(groups.get(key) ?? []), entry]);
    }
    return GROUP_ORDER.filter((key) => groups.has(key)).map((key) => ({ key, items: groups.get(key)! }));
  }, [entries, query]);

  return (
    <section aria-labelledby="term2-session-heading" className="flex min-h-0 flex-1 flex-col">
      <div className="mb-3 flex items-center justify-between">
        <h2 id="term2-session-heading" className="font-semibold">
          Agent sessions
        </h2>
        <button
          type="button"
          className="rounded bg-teal-600 px-2 py-1 text-xs text-white hover:bg-teal-700 disabled:opacity-50"
          disabled={!workspaceId}
          onClick={onCreate}
        >
          New agent chat
        </button>
      </div>
      {sessions.length > 4 && (
        <label className="mb-2 flex items-center gap-2 rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-sm focus-within:border-teal-500 dark:border-zinc-700 dark:bg-zinc-900">
          <Search aria-hidden className="h-3.5 w-3.5 text-zinc-400" />
          <input
            type="search"
            aria-label="Search sessions"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search sessions"
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-zinc-400"
          />
        </label>
      )}
      {sessions.length === 0 && <p className="text-sm text-zinc-500">No sessions yet.</p>}
      {sessions.length > 0 && grouped.length === 0 && <p className="text-sm text-zinc-500">No matching sessions.</p>}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {grouped.map(({ key, items }) => (
          <div key={key} className="mb-3">
            <h3 className="px-3 pb-1 text-[11px] font-medium uppercase tracking-wider text-zinc-400">{key}</h3>
            <ul className="space-y-0.5">
              {items.map(({ session, title }) => (
                <li key={session.id}>
                  <button
                    type="button"
                    aria-current={selected === session.id ? 'page' : undefined}
                    aria-label={`${title} ${session.id}`}
                    className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors ${
                      selected === session.id
                        ? 'bg-teal-50 dark:bg-teal-950/30'
                        : 'hover:bg-zinc-100 dark:hover:bg-zinc-900'
                    }`}
                    onClick={() => onSelect(session.id)}
                  >
                    <StatusDot status={session.status} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{title}</span>
                      <span className="text-xs text-zinc-500">
                        {session.status.replace('_', ' ')} ·{' '}
                        {relativeTime(session.updatedAt)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
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
