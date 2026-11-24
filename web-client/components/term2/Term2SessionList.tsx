'use client';
import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, Folder, Plus, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { SessionListItem, WorkspaceAlias } from '../../lib/term2/types';

const RECENT_COUNT = 5;
const COLLAPSED_KEY = 'term2:sidebar:collapsedFolders';

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

function shortTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const minutes = Math.floor((Date.now() - then) / 60000);
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

function sessionTitle(session: SessionListItem, firstMessage: string | undefined, folderName: string): string {
  const best = firstMessage?.trim() || session.title?.trim();
  if (best) {
    const firstLine = best.split('\n')[0];
    return firstLine.length > 44 ? `${firstLine.slice(0, 44)}…` : firstLine;
  }
  return folderName ? `${folderName} chat` : 'New chat';
}

function readCollapsed(): Set<string> {
  try {
    const raw = window.localStorage.getItem(COLLAPSED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}

interface Entry {
  session: SessionListItem;
  title: string;
  folderName: string;
}

function ChatRow({
  entry,
  active,
  meta,
  indent,
  onSelect,
}: {
  entry: Entry;
  active: boolean;
  /** Shown on the right: the folder in Recent, the time inside a folder. */
  meta: 'folder' | 'time';
  indent?: boolean;
  onSelect: (id: string) => void;
}) {
  const { session, title, folderName } = entry;
  const when = relativeTime(session.updatedAt);
  return (
    <li>
      <button
        type="button"
        aria-current={active ? 'page' : undefined}
        aria-label={`${title}, ${folderName ? `${folderName}, ` : ''}${when}`}
        title={`${title} · ${session.status.replace('_', ' ')} · ${when}`}
        className={cn(
          'flex w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left text-sm transition-colors',
          indent ? 'pl-8' : 'pl-2.5',
          active
            ? 'bg-black/[0.06] font-medium text-foreground dark:bg-white/[0.08]'
            : 'text-muted-foreground hover:bg-black/[0.035] hover:text-foreground dark:hover:bg-white/[0.04]',
        )}
        onClick={() => onSelect(session.id)}
      >
        <span className="min-w-0 flex-1 truncate">{title}</span>
        <StatusDot status={session.status} />
        {meta === 'folder' && folderName ? (
          <span className="max-w-[6rem] shrink-0 truncate rounded bg-black/[0.05] px-1.5 py-px text-xs font-normal text-muted-foreground dark:bg-white/[0.07]">
            {folderName}
          </span>
        ) : (
          <span className="shrink-0 text-xs font-normal tabular-nums text-muted-foreground">
            {shortTime(session.updatedAt)}
          </span>
        )}
      </button>
    </li>
  );
}

/**
 * Sidebar chat navigation: a short "Recent" list across all folders, then every
 * saved folder as a collapsible group of its chats. Searching flattens both into
 * one result list.
 */
export function Term2SessionList({
  sessions,
  selected,
  onSelect,
  onCreate,
  onAddFolder,
  selectedWorkspaceId,
  workspaces,
  workspaceMetadata,
  firstMessages,
  nextCursor = null,
  onNextPage,
}: {
  sessions: SessionListItem[];
  selected: string | null;
  onSelect: (id: string) => void;
  /** Starts a chat in the given folder. */
  onCreate: (workspaceId: string) => void;
  onAddFolder?: () => void;
  selectedWorkspaceId: string | null;
  workspaces: WorkspaceAlias[];
  workspaceMetadata?: Record<string, { displayName: string; fullPath?: string }>;
  firstMessages?: Record<string, string>;
  nextCursor?: string | null;
  onNextPage?: () => void;
}) {
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  useEffect(() => setCollapsed(readCollapsed()), []);

  const toggleFolder = (workspaceId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(workspaceId)) next.delete(workspaceId);
      else next.add(workspaceId);
      try {
        window.localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      } catch {
        // Collapse state is a convenience; ignore storage failures.
      }
      return next;
    });
  };

  const folderName = (workspaceId: string) => {
    const label = workspaceMetadata?.[workspaceId]?.displayName || workspaces.find((w) => w.workspaceId === workspaceId)?.label || '';
    if (!label || label.startsWith('ws_')) return '';
    return label.includes('/') ? label.split('/').filter(Boolean).pop() ?? label : label;
  };

  const entries: Entry[] = useMemo(
    () =>
      [...sessions]
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
        .map((session) => {
          const name = folderName(session.workspaceId);
          return { session, folderName: name, title: sessionTitle(session, firstMessages?.[session.id], name) };
        }),
    // folderName reads workspaces and workspaceMetadata, which are listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessions, firstMessages, workspaces, workspaceMetadata],
  );

  // Saved folders first (in gateway order), then any folder a listed chat uses that isn't saved.
  const folders = useMemo(() => {
    const ids = workspaces.map((w) => w.workspaceId);
    for (const entry of entries) if (!ids.includes(entry.session.workspaceId)) ids.push(entry.session.workspaceId);
    return ids.map((workspaceId) => ({
      workspaceId,
      name: folderName(workspaceId) || 'Unknown folder',
      fullPath: workspaceMetadata?.[workspaceId]?.fullPath,
      access: workspaces.find((w) => w.workspaceId === workspaceId)?.access,
      chats: entries.filter((entry) => entry.session.workspaceId === workspaceId),
    }));
    // folderName reads workspaces and workspaceMetadata, which are listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, workspaces, workspaceMetadata]);

  const needle = query.trim().toLowerCase();
  const matches = needle
    ? entries.filter(
        (entry) => entry.title.toLowerCase().includes(needle) || entry.folderName.toLowerCase().includes(needle),
      )
    : [];
  const recent = entries.slice(0, RECENT_COUNT);

  return (
    <section aria-label="Chats and folders" className="flex min-h-0 flex-1 flex-col">
      {sessions.length > 1 && (
        <label className="mx-1 mb-2 flex items-center gap-2 rounded-md bg-black/[0.04] px-2.5 py-1.5 text-sm transition-colors focus-within:bg-background focus-within:ring-1 focus-within:ring-ring/40 dark:bg-white/[0.05]">
          <Search aria-hidden className="size-3.5 text-muted-foreground" />
          <input
            type="search"
            aria-label="Search chats"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search chats"
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
          />
        </label>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-1 scrollbar-thin">
        {needle ? (
          <>
            <h2 className="px-2.5 pb-1 text-xs font-medium text-muted-foreground">Results</h2>
            {matches.length === 0 ? (
              <p className="px-2.5 py-1 text-sm text-muted-foreground">No matching chats.</p>
            ) : (
              <ul className="space-y-px">
                {matches.map((entry) => (
                  <ChatRow
                    key={entry.session.id}
                    entry={entry}
                    active={selected === entry.session.id}
                    meta="folder"
                    onSelect={onSelect}
                  />
                ))}
              </ul>
            )}
          </>
        ) : (
          <>
            {recent.length > 0 && (
              <div className="mb-4">
                <h2 className="px-2.5 pb-1 text-xs font-medium text-muted-foreground">Recent</h2>
                <ul className="space-y-px">
                  {recent.map((entry) => (
                    <ChatRow
                      key={entry.session.id}
                      entry={entry}
                      active={selected === entry.session.id}
                      meta="folder"
                      onSelect={onSelect}
                    />
                  ))}
                </ul>
              </div>
            )}

            <div className="flex items-center justify-between pb-1 pl-2.5 pr-1">
              <h2 className="text-xs font-medium text-muted-foreground">Folders</h2>
              {onAddFolder && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Add a folder"
                  title="Add a folder"
                  onClick={onAddFolder}
                  className="text-muted-foreground"
                >
                  <Plus />
                </Button>
              )}
            </div>
            {folders.length === 0 && (
              <p className="px-2.5 py-1 text-sm text-muted-foreground">
                {onAddFolder ? 'Add a folder to start chatting.' : 'No folders yet.'}
              </p>
            )}
            <ul className="space-y-px">
              {folders.map((folder) => {
                const open = !collapsed.has(folder.workspaceId);
                const current = folder.workspaceId === selectedWorkspaceId;
                return (
                  <li key={folder.workspaceId}>
                    <div className="group/folder flex items-center rounded-md hover:bg-black/[0.035] dark:hover:bg-white/[0.04]">
                      <button
                        type="button"
                        aria-expanded={open}
                        onClick={() => toggleFolder(folder.workspaceId)}
                        title={folder.fullPath || folder.name}
                        className={cn(
                          'flex min-w-0 flex-1 items-center gap-1.5 py-1.5 pl-1.5 text-left text-sm',
                          current ? 'font-medium text-foreground' : 'text-foreground/80',
                        )}
                      >
                        <ChevronRight
                          aria-hidden
                          className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')}
                        />
                        <Folder aria-hidden className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
                        <span className="truncate">{folder.name}</span>
                        {folder.access && (
                          <span className="shrink-0 rounded bg-black/[0.05] px-1 py-px text-xs font-normal text-muted-foreground dark:bg-white/[0.07]">
                            {folder.access === 'read_write' ? 'R/W' : 'Read'}
                          </span>
                        )}
                      </button>
                      {folder.access && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`New chat in ${folder.name}`}
                          title={`New chat in ${folder.name}`}
                          onClick={() => onCreate(folder.workspaceId)}
                          className="mr-1 text-muted-foreground opacity-0 focus-visible:opacity-100 group-hover/folder:opacity-100"
                        >
                          <Plus />
                        </Button>
                      )}
                    </div>
                    {open && (
                      <ul className="space-y-px">
                        {folder.chats.length === 0 ? (
                          <li className="py-1 pl-8 text-xs text-muted-foreground">No chats yet</li>
                        ) : (
                          folder.chats.map((entry) => (
                            <ChatRow
                              key={entry.session.id}
                              entry={entry}
                              active={selected === entry.session.id}
                              meta="time"
                              indent
                              onSelect={onSelect}
                            />
                          ))
                        )}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
            {onNextPage && nextCursor && (
              <button
                type="button"
                className="mt-2 w-full rounded-md px-2.5 py-1.5 text-left text-xs text-muted-foreground hover:bg-black/[0.04] hover:text-foreground dark:hover:bg-white/[0.05]"
                onClick={onNextPage}
              >
                Load older chats
              </button>
            )}
          </>
        )}
      </div>
    </section>
  );
}
