'use client';
import { useMemo, useState } from 'react';
import { Plus, Search } from 'lucide-react';
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

/** Only live sessions get a dot; idle ones stay quiet. */
function StatusDot({ status }: { status: SessionListItem['status'] }) {
  if (status === 'awaiting_interaction') {
    return (
      <span title="Waiting for approval" className="relative flex h-2 w-2 shrink-0">
        <span className="absolute inset-0 animate-ping rounded-full bg-amber-400/60" />
        <span className="relative h-2 w-2 rounded-full bg-amber-500" />
      </span>
    );
  }
  if (status === 'running') {
    return <span title="Running" className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-teal-500" />;
  }
  return null;
}

function shortTime(iso: string, precise = false): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const seconds = Math.floor((Date.now() - then) / 1000);
  if (precise && seconds < 3600) {
    if (seconds < 60) return `${Math.max(0, seconds)}s`;
    const minutes = Math.floor(seconds / 60);
    return `${minutes}m ${seconds % 60}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
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
  const bestMessage = firstMessage?.trim() || session.title?.trim();
  if (bestMessage && bestMessage.length > 0) {
    const firstLine = bestMessage.split('\n')[0];
    return firstLine.length > 44 ? `${firstLine.slice(0, 44)}…` : firstLine;
  }
  if (workspaceDisplayName && workspaceDisplayName.trim().length > 0) {
    return `${workspaceDisplayName.trim()} chat`;
  }
  if (workspaceLabel && workspaceLabel.trim().length > 0) {
    const label = workspaceLabel.trim();
    if (!label.startsWith('ws_')) {
      const base = label.includes('/') ? label.split('/').filter(Boolean).pop() : label;
      return base ? `${base} chat` : 'New chat';
    }
  }
  return 'New chat';
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
  const titleCounts = new Map<string, number>();
  for (const entry of entries) titleCounts.set(entry.title, (titleCounts.get(entry.title) ?? 0) + 1);
  const apartFor = (session: SessionListItem, title: string) => {
    const sharedTitle = (titleCounts.get(title) ?? 0) > 1;
    const folder =
      workspaceMetadata?.[session.workspaceId]?.displayName || workspaceMap.get(session.workspaceId) || '';
    const when = shortTime(session.updatedAt, sharedTitle);
    const apart = sharedTitle ? [folder, when].filter(Boolean).join(' · ') : when;
    return { sharedTitle, when, apart };
  };
  const apartCounts = new Map<string, number>();
  for (const entry of entries) {
    const { sharedTitle, apart } = apartFor(entry.session, entry.title);
    if (!sharedTitle) continue;
    const key = `${entry.title}\0${apart}`;
    apartCounts.set(key, (apartCounts.get(key) ?? 0) + 1);
  }
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
      <button
        type="button"
        className="mb-2 flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm font-medium text-zinc-800 transition-colors hover:bg-black/[0.05] disabled:cursor-not-allowed disabled:opacity-50 dark:text-zinc-200 dark:hover:bg-white/[0.06]"
        disabled={!workspaceId}
        onClick={onCreate}
      >
        <span className="flex h-5 w-5 items-center justify-center rounded-md bg-teal-600 text-white dark:bg-teal-500 dark:text-zinc-950">
          <Plus aria-hidden className="h-3.5 w-3.5" strokeWidth={2.25} />
        </span>
        New chat
      </button>
      {sessions.length > 1 && (
        <label className="mb-2 flex items-center gap-2 rounded-lg bg-black/[0.04] px-2.5 py-1.5 text-sm transition-colors focus-within:bg-white focus-within:ring-1 focus-within:ring-black/10 dark:bg-white/[0.05] dark:focus-within:bg-white/[0.07] dark:focus-within:ring-white/10">
          <Search aria-hidden className="h-3.5 w-3.5 text-zinc-400" />
          <input
            type="search"
            aria-label="Search chats"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search chats…"
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-zinc-400 [&::-webkit-search-cancel-button]:hidden"
          />
        </label>
      )}
      <h2 id="term2-session-heading" className="sr-only">
        Chat history
      </h2>
      {sessions.length === 0 && <p className="px-2.5 py-1 text-sm text-zinc-500">No chats yet.</p>}
      {sessions.length > 0 && grouped.length === 0 && (
        <p className="px-2.5 py-1 text-sm text-zinc-500">No matching chats.</p>
      )}
      <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1 scrollbar-thin">
        {grouped.map(({ key, items }) => (
          <div key={key} className="mb-4">
            <h3 className="px-2.5 pb-1 text-xs font-medium text-zinc-400 dark:text-zinc-500">{key}</h3>
            <ul className="space-y-px">
              {items.map(({ session, title }) => {
                const active = selected === session.id;
                const { sharedTitle, when, apart } = apartFor(session, title);
                const tied = sharedTitle && (apartCounts.get(`${title}\0${apart}`) ?? 0) > 1;
                const mark = tied ? `${apart} · ${session.id.slice(-4)}` : apart;
                return (
                  <li key={session.id}>
                    <button
                      type="button"
                      aria-current={active ? 'page' : undefined}
                      aria-label={sharedTitle ? `${title}, ${mark}` : `${title} ${session.id}`}
                      title={`${title} · ${session.status.replace('_', ' ')} · ${relativeTime(session.updatedAt)}`}
                      className={`group/item flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors ${
                        active
                          ? 'bg-black/[0.06] font-medium text-zinc-900 dark:bg-white/[0.08] dark:text-zinc-50'
                          : 'text-zinc-600 hover:bg-black/[0.035] hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-white/[0.04] dark:hover:text-zinc-100'
                      }`}
                      onClick={() => onSelect(session.id)}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{title}</span>
                        {sharedTitle && mark && (
                          <span className="block truncate text-[11px] font-normal text-zinc-400 dark:text-zinc-500">
                            {mark}
                          </span>
                        )}
                      </span>
                      <StatusDot status={session.status} />
                      <span className="shrink-0 text-[11px] tabular-nums text-zinc-400 dark:text-zinc-500">
                        {tied ? session.id.slice(-4) : when}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
      {onNextPage && nextCursor && (
        <button
          type="button"
          className="mt-2 rounded-lg px-2.5 py-1.5 text-left text-xs text-zinc-500 hover:bg-black/[0.04] hover:text-zinc-800 dark:hover:bg-white/[0.05] dark:hover:text-zinc-200"
          onClick={onNextPage}
        >
          Next agent sessions
        </button>
      )}
    </section>
  );
}
