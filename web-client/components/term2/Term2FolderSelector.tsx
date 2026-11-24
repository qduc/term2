'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  ArrowUp,
  Check,
  ChevronRight,
  Eye,
  EyeOff,
  Folder,
  FolderOpen,
  FolderSymlink,
  Home,
  Loader2,
  Pencil,
  Search,
  X,
} from 'lucide-react';
import { term2Client, Term2ApiError } from '../../lib/api/term2';
import type { BrowseEntry, CandidateValidation, WorkspaceAlias } from '../../lib/term2/types';

export interface SelectedTerm2Workspace {
  workspaceId: string;
  displayName: string;
  access: 'read' | 'read_write';
  fullPath?: string;
}

interface BreadcrumbItem {
  label: string;
  folderPath: string;
  childToken?: string;
}

function cleanUserFacingMessage(msg?: string): string {
  if (!msg) return '';
  return msg.replace(/^[a-z0-9_]+:\s*/iu, '').trim();
}

function baseName(folderPath: string): string {
  const cleaned = folderPath.replace(/\/+$/u, '');
  if (!cleaned) return '/';
  const slash = cleaned.lastIndexOf('/');
  return slash >= 0 ? cleaned.slice(slash + 1) || '/' : cleaned;
}

function parentDirectory(folderPath: string): string | null {
  const cleaned = folderPath.replace(/\/+$/u, '');
  if (!cleaned || cleaned === '/') return null;
  const slash = cleaned.lastIndexOf('/');
  if (slash <= 0) return '/';
  return cleaned.slice(0, slash);
}

function joinPath(base: string, segment: string): string {
  if (base === '/') return `/${segment}`;
  return `${base.replace(/\/+$/u, '')}/${segment}`;
}

function workspaceShortName(label: string): string {
  if (!label) return 'Folder';
  if (label.includes('/')) {
    return baseName(label);
  }
  return label;
}

export function Term2FolderSelector({
  homeFolder,
  allowWrite = false,
  savedWorkspaces = [],
  selectedWorkspaceId = null,
  onSelectExisting,
  onSelected,
}: {
  homeFolder?: string;
  allowWrite?: boolean;
  savedWorkspaces?: WorkspaceAlias[];
  selectedWorkspaceId?: string | null;
  onSelectExisting?: (workspaceId: string) => void;
  onSelected?: (workspace: SelectedTerm2Workspace) => void;
}) {
  const [rootPath, setRootPath] = useState<string>('');
  const [rootCandidateId, setRootCandidateId] = useState<string | null>(null);
  const [breadcrumbs, setBreadcrumbs] = useState<BreadcrumbItem[]>([]);
  const [entries, setEntries] = useState<BrowseEntry[]>([]);
  const [truncated, setTruncated] = useState(false);

  const [editingPath, setEditingPath] = useState(false);
  const [pathDraft, setPathDraft] = useState(homeFolder ?? '');
  const [filter, setFilter] = useState('');
  const [showHidden, setShowHidden] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const [access, setAccess] = useState<'read' | 'read_write'>(allowWrite ? 'read_write' : 'read');
  const [busy, setBusy] = useState(false);
  const [selectingPath, setSelectingPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [failedValidation, setFailedValidation] = useState<CandidateValidation | null>(null);
  const [lastValidRoot, setLastValidRoot] = useState<string>(homeFolder ?? '');

  const pathInputRef = useRef<HTMLInputElement>(null);
  const filterInputRef = useRef<HTMLInputElement>(null);

  const currentPath = breadcrumbs.at(-1)?.folderPath ?? rootPath;
  const currentName = currentPath ? baseName(currentPath) : '';

  useEffect(() => {
    setAccess(allowWrite ? 'read_write' : 'read');
  }, [allowWrite]);

  useEffect(() => {
    if (editingPath) {
      pathInputRef.current?.focus();
      pathInputRef.current?.select();
    }
  }, [editingPath]);

  const showError = useCallback((reason: unknown) => {
    setError(reason instanceof Term2ApiError ? cleanUserFacingMessage(reason.message) : 'Workspace operation failed');
  }, []);

  /** Validate a new root folder and list its contents (consumes 1 candidate slot). */
  const openRoot = useCallback(
    async (folder: string) => {
      const trimmed = folder.trim();
      if (!trimmed) return;
      setBusy(true);
      setError(null);
      setFailedValidation(null);
      setEditingPath(false);
      setFilter('');
      setActiveIndex(0);
      try {
        const result = await term2Client.validateCandidate(trimmed);
        if (!result.valid || !result.selectable || !result.candidateId) {
          setFailedValidation(result);
          setPathDraft(trimmed);
          return;
        }
        const browse = await term2Client.browseCandidate(result.candidateId);
        setRootPath(trimmed);
        setLastValidRoot(trimmed);
        setRootCandidateId(result.candidateId);
        setBreadcrumbs([]);
        setEntries(browse.entries);
        setTruncated(browse.truncated);
        setPathDraft(trimmed);
      } catch (reason) {
        showError(reason);
      } finally {
        setBusy(false);
      }
    },
    [showError],
  );

  useEffect(() => {
    if (homeFolder) {
      void openRoot(homeFolder);
    } else {
      setEditingPath(true);
    }
  }, [homeFolder, openRoot]);

  /** Browse a child or ancestor inside the already-validated root without creating a new candidate. */
  const browseWithinRoot = useCallback(
    async (nextTrail: BreadcrumbItem[], targetPath: string, childToken?: string) => {
      if (!rootCandidateId) {
        await openRoot(targetPath);
        return;
      }
      setBusy(true);
      setError(null);
      setFailedValidation(null);
      setFilter('');
      setActiveIndex(0);
      try {
        const browse = await term2Client.browseCandidate(rootCandidateId, childToken);
        setBreadcrumbs(nextTrail);
        setEntries(browse.entries);
        setTruncated(browse.truncated);
        setPathDraft(targetPath);
      } catch (reason) {
        // Candidate token or root expired after 5 minutes — transparently re-open target as root.
        if (
          reason instanceof Term2ApiError &&
          (reason.code === 'candidate_expired' || reason.code === 'candidate_not_found')
        ) {
          await openRoot(targetPath);
          return;
        }
        showError(reason);
      } finally {
        setBusy(false);
      }
    },
    [openRoot, rootCandidateId, showError],
  );

  const resolveEntryPath = useCallback(
    (entry: BrowseEntry): string => {
      if (entry.type === 'symlink' && entry.targetDisplay) {
        return entry.targetDisplay === '.' ? rootPath : joinPath(rootPath, entry.targetDisplay);
      }
      return joinPath(currentPath, entry.name);
    },
    [currentPath, rootPath],
  );

  const enterDirectory = useCallback(
    (entry: BrowseEntry) => {
      if (busy || !entry.selectable) return;
      const nextPath = resolveEntryPath(entry);
      const nextTrail: BreadcrumbItem[] = [
        ...breadcrumbs,
        { label: entry.name, folderPath: nextPath, childToken: entry.childToken },
      ];
      if (entry.childToken && rootCandidateId) {
        void browseWithinRoot(nextTrail, nextPath, entry.childToken);
      } else {
        void openRoot(nextPath);
      }
    },
    [breadcrumbs, browseWithinRoot, busy, openRoot, resolveEntryPath, rootCandidateId],
  );

  const navigateUp = useCallback(() => {
    if (busy || !currentPath) return;
    if (breadcrumbs.length > 0) {
      const parentTrail = breadcrumbs.slice(0, -1);
      const parentCrumb = parentTrail.at(-1);
      const targetPath = parentCrumb?.folderPath ?? rootPath;
      void browseWithinRoot(parentTrail, targetPath, parentCrumb?.childToken);
      return;
    }
    const parent = parentDirectory(rootPath);
    if (parent && parent !== rootPath) {
      void openRoot(parent);
    }
  }, [breadcrumbs, browseWithinRoot, busy, currentPath, openRoot, rootPath]);

  const selectFolderPath = useCallback(
    async (targetPath: string) => {
      if (!targetPath || busy || selectingPath) return;
      setSelectingPath(targetPath);
      setError(null);
      setFailedValidation(null);
      try {
        const effectiveAccess = allowWrite ? access : 'read';
        let chosenCandidateId: string | undefined;

        if (targetPath === rootPath && rootCandidateId) {
          chosenCandidateId = rootCandidateId;
        } else {
          const validated = await term2Client.validateCandidate(targetPath);
          if (!validated.valid || !validated.selectable || !validated.candidateId) {
            setFailedValidation(validated);
            return;
          }
          chosenCandidateId = validated.candidateId;
        }

        const commitSelection = async (candidate: string) => {
          const result = await term2Client.selectCandidate(candidate, effectiveAccess);
          onSelected?.({
            workspaceId: result.workspaceId,
            displayName: result.displayName,
            access: result.access,
            fullPath: targetPath,
          });
        };

        try {
          await commitSelection(chosenCandidateId);
        } catch (reason) {
          if (
            reason instanceof Term2ApiError &&
            (reason.code === 'candidate_expired' || reason.code === 'candidate_not_found')
          ) {
            const revalidated = await term2Client.validateCandidate(targetPath);
            if (!revalidated.valid || !revalidated.selectable || !revalidated.candidateId) {
              setFailedValidation(revalidated);
              return;
            }
            await commitSelection(revalidated.candidateId);
          } else {
            throw reason;
          }
        }
      } catch (reason) {
        showError(reason);
      } finally {
        setSelectingPath(null);
      }
    },
    [access, allowWrite, busy, onSelected, rootCandidateId, rootPath, selectingPath, showError],
  );

  const directoryEntries = useMemo(() => {
    const dirs = entries.filter((entry) => entry.type !== 'file');
    const visible = showHidden ? dirs : dirs.filter((entry) => !entry.name.startsWith('.'));
    const needle = filter.trim().toLowerCase();
    const matched = needle ? visible.filter((entry) => entry.name.toLowerCase().includes(needle)) : visible;
    return {
      totalVisible: visible.length,
      hiddenCount: dirs.length - visible.length,
      selectable: matched.filter((entry) => entry.selectable),
      unavailable: matched.filter((entry) => !entry.selectable),
    };
  }, [entries, filter, showHidden]);

  const clampedActiveIndex =
    directoryEntries.selectable.length > 0 ? Math.min(activeIndex, directoryEntries.selectable.length - 1) : 0;

  const handleFilterKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' && directoryEntries.selectable.length > 0) {
      event.preventDefault();
      setActiveIndex((prev) => (prev + 1) % directoryEntries.selectable.length);
      return;
    }
    if (event.key === 'ArrowUp' && directoryEntries.selectable.length > 0) {
      event.preventDefault();
      setActiveIndex((prev) => (prev - 1 + directoryEntries.selectable.length) % directoryEntries.selectable.length);
      return;
    }
    if (event.key === 'Enter' && directoryEntries.selectable.length > 0) {
      event.preventDefault();
      const entry = directoryEntries.selectable[clampedActiveIndex];
      if (entry) enterDirectory(entry);
      return;
    }
    if (event.key === 'Backspace' && filter === '' && (breadcrumbs.length > 0 || parentDirectory(rootPath))) {
      event.preventDefault();
      navigateUp();
    }
  };

  const canGoUp = Boolean(currentPath && (breadcrumbs.length > 0 || parentDirectory(rootPath)));
  const isAtHome = Boolean(homeFolder && currentPath === homeFolder);
  const rootLabel = homeFolder && rootPath === homeFolder ? '~' : rootPath ? baseName(rootPath) : '';

  return (
    <section aria-labelledby="term2-folder-heading" className="space-y-3.5">
      <p id="term2-folder-heading" className="text-xs text-zinc-500 dark:text-zinc-400">
        Pick a folder for Term2 to work in. Click a folder to open it, or click <strong className="font-medium text-zinc-700 dark:text-zinc-200">Select</strong> on any subfolder.
      </p>

      {savedWorkspaces.length > 0 && onSelectExisting && (
        <div className="space-y-1.5">
          <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
            Saved folders
          </div>
          <div className="flex flex-wrap gap-1.5">
            {savedWorkspaces.map((workspace) => {
              const active = workspace.workspaceId === selectedWorkspaceId;
              const shortName = workspaceShortName(workspace.label);
              return (
                <button
                  key={workspace.workspaceId}
                  type="button"
                  title={workspace.label}
                  onClick={() => onSelectExisting(workspace.workspaceId)}
                  className={`inline-flex max-w-full items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs transition-colors ${
                    active
                      ? 'border-teal-500/50 bg-teal-500/10 font-medium text-teal-800 dark:border-teal-400/40 dark:bg-teal-500/15 dark:text-teal-200'
                      : 'border-black/[0.08] bg-zinc-50/70 text-zinc-700 hover:border-black/[0.16] hover:bg-zinc-100/80 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-zinc-200 dark:hover:bg-white/[0.06]'
                  }`}
                >
                  <Folder className="h-3.5 w-3.5 shrink-0 text-teal-600 dark:text-teal-400" />
                  <span className="max-w-[12rem] truncate">{shortName}</span>
                  <span className="rounded bg-black/[0.05] px-1 py-0.5 text-[10px] font-normal text-zinc-500 dark:bg-white/[0.07] dark:text-zinc-400">
                    {workspace.access === 'read_write' ? 'R/W' : 'Read'}
                  </span>
                  {active && <Check className="h-3 w-3 shrink-0 text-teal-600 dark:text-teal-400" />}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Main file browser surface */}
      <div className="overflow-hidden rounded-xl border border-black/[0.09] bg-white dark:border-white/[0.09] dark:bg-zinc-950/40">
        {/* Path / breadcrumb navigation header */}
        <div className="flex items-center gap-1 border-b border-black/[0.07] bg-zinc-50/80 px-2 py-1.5 dark:border-white/[0.07] dark:bg-white/[0.02]">
          {homeFolder && (
            <button
              type="button"
              disabled={busy || isAtHome}
              title={`Home folder (${homeFolder})`}
              aria-label="Go to home folder"
              onClick={() => {
                if (rootPath === homeFolder && rootCandidateId) {
                  void browseWithinRoot([], homeFolder, undefined);
                } else {
                  void openRoot(homeFolder);
                }
              }}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-black/[0.05] hover:text-zinc-900 disabled:opacity-35 dark:text-zinc-400 dark:hover:bg-white/[0.07] dark:hover:text-zinc-100"
            >
              <Home className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            type="button"
            disabled={busy || !canGoUp}
            title="Go to parent folder (Backspace)"
            aria-label="Go to parent folder"
            onClick={navigateUp}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-black/[0.05] hover:text-zinc-900 disabled:opacity-35 dark:text-zinc-400 dark:hover:bg-white/[0.07] dark:hover:text-zinc-100"
          >
            <ArrowUp className="h-3.5 w-3.5" />
          </button>

          {editingPath ? (
            <form
              className="flex min-w-0 flex-1 items-center gap-1.5 pl-1"
              onSubmit={(event) => {
                event.preventDefault();
                void openRoot(pathDraft);
              }}
            >
              <label className="sr-only" htmlFor="term2-folder-path">
                Folder path
              </label>
              <input
                ref={pathInputRef}
                id="term2-folder-path"
                value={pathDraft}
                disabled={busy}
                onChange={(event) => setPathDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.stopPropagation();
                    setPathDraft(currentPath);
                    setEditingPath(false);
                  }
                }}
                placeholder="/absolute/path/to/folder"
                className="min-w-0 flex-1 rounded-md border border-teal-500/50 bg-white px-2 py-1 font-mono text-xs text-zinc-900 outline-none ring-2 ring-teal-500/15 dark:bg-zinc-900 dark:text-zinc-100"
              />
              <button
                type="submit"
                disabled={busy || !pathDraft.trim()}
                className="rounded-md bg-zinc-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-zinc-700 disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900"
              >
                Go
              </button>
              {currentPath && (
                <button
                  type="button"
                  aria-label="Cancel path edit"
                  onClick={() => {
                    setPathDraft(currentPath);
                    setEditingPath(false);
                  }}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 hover:bg-black/[0.05] hover:text-zinc-700 dark:hover:bg-white/[0.07]"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </form>
          ) : (
            <div className="flex min-w-0 flex-1 items-center gap-1">
              <nav
                aria-label="Folder breadcrumbs"
                className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto px-1 py-0.5 text-xs scrollbar-thin"
              >
                {rootPath && (
                  <button
                    type="button"
                    disabled={busy || breadcrumbs.length === 0}
                    title={rootPath}
                    onClick={() => void browseWithinRoot([], rootPath, undefined)}
                    className={`shrink-0 rounded px-1.5 py-0.5 transition-colors ${
                      breadcrumbs.length === 0
                        ? 'font-semibold text-zinc-900 dark:text-zinc-100'
                        : 'text-zinc-600 hover:bg-black/[0.05] hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-white/[0.07] dark:hover:text-zinc-100'
                    }`}
                  >
                    {rootLabel}
                  </button>
                )}
                {breadcrumbs.map((crumb, index) => {
                  const isLast = index === breadcrumbs.length - 1;
                  return (
                    <span key={`${crumb.folderPath}-${index}`} className="flex shrink-0 items-center gap-0.5">
                      <ChevronRight aria-hidden className="h-3 w-3 text-zinc-300 dark:text-zinc-600" />
                      <button
                        type="button"
                        disabled={busy || isLast}
                        title={crumb.folderPath}
                        onClick={() =>
                          void browseWithinRoot(breadcrumbs.slice(0, index + 1), crumb.folderPath, crumb.childToken)
                        }
                        className={`max-w-[10rem] truncate rounded px-1.5 py-0.5 transition-colors ${
                          isLast
                            ? 'font-semibold text-zinc-900 dark:text-zinc-100'
                            : 'text-zinc-600 hover:bg-black/[0.05] hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-white/[0.07] dark:hover:text-zinc-100'
                        }`}
                      >
                        {crumb.label}
                      </button>
                    </span>
                  );
                })}
              </nav>
              <button
                type="button"
                title="Type a folder path directly"
                aria-label="Edit folder path"
                onClick={() => {
                  setPathDraft(currentPath);
                  setEditingPath(true);
                }}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-black/[0.05] hover:text-zinc-800 dark:hover:bg-white/[0.07] dark:hover:text-zinc-100"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </div>

        {/* Filter & view options bar */}
        <div className="flex items-center gap-2 border-b border-black/[0.06] px-2.5 py-1.5 text-xs dark:border-white/[0.06]">
          <Search aria-hidden className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
          <input
            ref={filterInputRef}
            type="text"
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={handleFilterKeyDown}
            placeholder="Filter folders… (↑↓ Enter to open)"
            aria-label="Filter folders"
            className="min-w-0 flex-1 bg-transparent text-xs text-zinc-900 outline-none placeholder:text-zinc-400 dark:text-zinc-100 dark:placeholder:text-zinc-500"
          />
          {filter && (
            <button
              type="button"
              aria-label="Clear folder filter"
              onClick={() => {
                setFilter('');
                filterInputRef.current?.focus();
              }}
              className="rounded p-0.5 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
            >
              <X className="h-3 w-3" />
            </button>
          )}
          <button
            type="button"
            onClick={() => setShowHidden((v) => !v)}
            aria-pressed={showHidden}
            title={showHidden ? 'Hide dot-folders' : 'Show hidden dot-folders'}
            className={`inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-[11px] transition-colors ${
              showHidden
                ? 'bg-teal-500/12 font-medium text-teal-700 dark:bg-teal-500/20 dark:text-teal-300'
                : 'text-zinc-500 hover:bg-black/[0.04] hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-white/[0.06]'
            }`}
          >
            {showHidden ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
            Hidden{!showHidden && directoryEntries.hiddenCount > 0 ? ` (${directoryEntries.hiddenCount})` : ''}
          </button>
        </div>

        {/* Error / validation banner */}
        {(error || (failedValidation && !failedValidation.valid)) && (
          <div
            role="alert"
            className="border-b border-red-200 bg-red-50/80 px-3 py-2.5 text-xs text-red-800 dark:border-red-900/50 dark:bg-red-950/35 dark:text-red-200"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 space-y-1">
                <p className="font-medium">
                  {error ?? cleanUserFacingMessage(failedValidation?.reason ?? 'This folder cannot be opened.')}
                </p>
                {failedValidation?.checks.some((check) => check.name === 'contained' && check.status === 'error') && (
                  <p className="text-[11px] text-red-700/80 dark:text-red-300/80">
                    {homeFolder
                      ? `Choose a folder inside ${homeFolder}.`
                      : 'Choose a folder inside the allowed workspace roots.'}
                  </p>
                )}
              </div>
              {(lastValidRoot || homeFolder) && (
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    setFailedValidation(null);
                    const target = lastValidRoot || homeFolder;
                    if (target && target !== currentPath) {
                      void openRoot(target);
                    }
                  }}
                  className="shrink-0 rounded-md border border-red-300 bg-white px-2 py-1 text-[11px] font-medium text-red-800 hover:bg-red-50 dark:border-red-800 dark:bg-zinc-900 dark:text-red-200"
                >
                  Back to {baseName(lastValidRoot || homeFolder || '')}
                </button>
              )}
            </div>
            {failedValidation && !failedValidation.valid && failedValidation.checks.length > 0 && (
              <details className="mt-1.5 text-[11px]">
                <summary className="cursor-pointer opacity-80 hover:opacity-100">Folder checks</summary>
                <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                  {failedValidation.checks.map((check) => (
                    <li key={check.name}>
                      {check.status === 'ok' ? '✓' : '✕'} {check.name}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}

        {/* Directory list */}
        <div className="relative max-h-64 min-h-[12rem] overflow-y-auto scrollbar-thin">
          {busy ? (
            <div className="flex h-48 items-center justify-center gap-2 text-xs text-zinc-500">
              <Loader2 className="h-4 w-4 animate-spin text-teal-600 dark:text-teal-400" />
              Loading folders…
            </div>
          ) : directoryEntries.selectable.length === 0 && directoryEntries.unavailable.length === 0 ? (
            <div className="flex h-48 flex-col items-center justify-center gap-1.5 px-4 text-center">
              <FolderOpen className="h-7 w-7 text-zinc-300 dark:text-zinc-600" strokeWidth={1.5} />
              {filter ? (
                <>
                  <p className="text-xs font-medium text-zinc-600 dark:text-zinc-300">
                    No folders match “{filter}”
                  </p>
                  <button
                    type="button"
                    onClick={() => setFilter('')}
                    className="text-xs text-teal-700 hover:underline dark:text-teal-400"
                  >
                    Clear filter
                  </button>
                </>
              ) : (
                <>
                  <p className="text-xs font-medium text-zinc-600 dark:text-zinc-300">No subfolders here</p>
                  <p className="text-[11px] text-zinc-400 dark:text-zinc-500">
                    {directoryEntries.hiddenCount > 0 && !showHidden
                      ? `${directoryEntries.hiddenCount} hidden folder${directoryEntries.hiddenCount === 1 ? '' : 's'} · click “Use ${currentName || 'this folder'}” below to select it.`
                      : `Click “Use ${currentName || 'this folder'}” below to work in this folder.`}
                  </p>
                </>
              )}
            </div>
          ) : (
            <ul role="listbox" aria-label="Subfolders" className="divide-y divide-black/[0.04] p-1 dark:divide-white/[0.04]">
              {directoryEntries.selectable.map((entry, idx) => {
                const entryPath = resolveEntryPath(entry);
                const isHighlighted = idx === clampedActiveIndex && Boolean(filter);
                const isSelectingThis = selectingPath === entryPath;
                return (
                  <li
                    key={`${entry.name}-${entry.type}`}
                    role="option"
                    aria-selected={isHighlighted}
                    className={`group flex items-center gap-1 rounded-lg transition-colors ${
                      isHighlighted
                        ? 'bg-teal-500/10 dark:bg-teal-500/15'
                        : 'hover:bg-zinc-100/90 dark:hover:bg-white/[0.05]'
                    }`}
                  >
                    <button
                      type="button"
                      disabled={busy || Boolean(selectingPath)}
                      aria-label={`Open ${entry.name}`}
                      onClick={() => enterDirectory(entry)}
                      className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-2 text-left text-[13px] text-zinc-800 dark:text-zinc-200"
                    >
                      {entry.type === 'symlink' ? (
                        <FolderSymlink className="h-4 w-4 shrink-0 text-teal-600/80 dark:text-teal-400/80" />
                      ) : (
                        <Folder className="h-4 w-4 shrink-0 text-amber-500/80 dark:text-amber-400/80" />
                      )}
                      <span className="min-w-0 truncate font-medium">{entry.name}</span>
                      {entry.targetDisplay && (
                        <span className="truncate font-mono text-[11px] text-zinc-400">→ {entry.targetDisplay}</span>
                      )}
                    </button>
                    <button
                      type="button"
                      disabled={busy || Boolean(selectingPath)}
                      aria-label={`Select ${entry.name}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        void selectFolderPath(entryPath);
                      }}
                      className="shrink-0 rounded-md border border-black/[0.09] bg-white px-2 py-1 text-[11px] font-medium text-zinc-700 shadow-xs hover:border-teal-500 hover:text-teal-700 dark:border-white/10 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:border-teal-400 dark:hover:text-teal-300"
                    >
                      {isSelectingThis ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Select'}
                    </button>
                    <ChevronRight
                      aria-hidden
                      className="mr-1.5 h-3.5 w-3.5 shrink-0 text-zinc-300 transition-colors group-hover:text-zinc-500 dark:text-zinc-600 dark:group-hover:text-zinc-400"
                    />
                  </li>
                );
              })}

              {directoryEntries.unavailable.map((entry) => {
                const cleanReason =
                  entry.rejectionReason && entry.rejectionReason !== 'workspace_not_directory'
                    ? cleanUserFacingMessage(entry.rejectionReason)
                    : 'Unavailable';
                return (
                  <li
                    key={`unavail-${entry.name}-${entry.type}`}
                    className="flex items-center justify-between gap-2 px-2.5 py-2 text-xs text-zinc-400 dark:text-zinc-500"
                  >
                    <span className="flex min-w-0 items-center gap-2.5 truncate">
                      <Folder className="h-4 w-4 shrink-0 opacity-50" />
                      <span className="truncate">{entry.name}</span>
                    </span>
                    <span className="shrink-0 text-[11px]">{cleanReason}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Subtle status strip */}
        {currentPath && !busy && (
          <div className="flex items-center justify-between border-t border-black/[0.05] bg-zinc-50/50 px-3 py-1 text-[11px] text-zinc-400 dark:border-white/[0.05] dark:bg-white/[0.015] dark:text-zinc-500">
            <span className="truncate font-mono" title={currentPath}>
              {currentPath}
            </span>
            <span className="ml-2 shrink-0 tabular-nums">
              {directoryEntries.selectable.length} folder{directoryEntries.selectable.length === 1 ? '' : 's'}
              {truncated ? '+' : ''}
            </span>
          </div>
        )}
      </div>

      {/* Action footer */}
      {currentPath && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-black/[0.07] bg-zinc-50/70 px-3.5 py-2.5 dark:border-white/[0.07] dark:bg-white/[0.02]">
          <div className="flex items-center gap-2">
            {allowWrite ? (
              <div
                role="radiogroup"
                aria-label="Folder permissions"
                className="inline-flex rounded-lg border border-black/[0.09] bg-white p-0.5 text-xs dark:border-white/10 dark:bg-zinc-900"
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={access === 'read_write'}
                  onClick={() => setAccess('read_write')}
                  className={`rounded-md px-2.5 py-1 text-[11.5px] font-medium transition-colors ${
                    access === 'read_write'
                      ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                      : 'text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100'
                  }`}
                >
                  Read &amp; write
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={access === 'read'}
                  onClick={() => setAccess('read')}
                  className={`rounded-md px-2.5 py-1 text-[11.5px] font-medium transition-colors ${
                    access === 'read'
                      ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                      : 'text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100'
                  }`}
                >
                  Read only
                </button>
              </div>
            ) : (
              <span
                title="term2-web was started with --read-only. Restart it without that flag to allow editing files."
                className="rounded-md bg-black/[0.05] px-2 py-1 text-[11px] font-medium text-zinc-600 dark:bg-white/[0.07] dark:text-zinc-400"
              >
                Read only
              </span>
            )}
          </div>

          <button
            type="button"
            disabled={busy || Boolean(selectingPath) || !currentPath}
            onClick={() => void selectFolderPath(currentPath)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-teal-600 px-4 py-2 text-xs font-medium text-white shadow-sm transition-colors hover:bg-teal-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {selectingPath === currentPath ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Check className="h-3.5 w-3.5" />
            )}
            Use {currentName || 'this folder'}
          </button>
        </div>
      )}
    </section>
  );
}
