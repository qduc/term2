'use client';

import { useCallback, useEffect, useState } from 'react';
import { Folder, Loader2 } from 'lucide-react';
import { term2Client, Term2ApiError } from '../../lib/api/term2';
import type { BrowseEntry, CandidateValidation } from '../../lib/term2/types';

export interface SelectedTerm2Workspace {
  workspaceId: string;
  displayName: string;
  access: 'read' | 'read_write';
  fullPath?: string;
}

function cleanUserFacingMessage(msg?: string): string {
  if (!msg) return '';
  return msg.replace(/^[a-z0-9_]+:\s*/iu, '').trim();
}

interface BreadcrumbItem {
  label: string;
  folderPath: string;
}

export function Term2FolderSelector({
  homeFolder,
  allowWrite = false,
  onSelected,
}: {
  homeFolder?: string;
  allowWrite?: boolean;
  onSelected?: (workspace: SelectedTerm2Workspace) => void;
}) {
  const [path, setPath] = useState(homeFolder ?? '');
  const [rootPath, setRootPath] = useState<string>('');
  const [validation, setValidation] = useState<CandidateValidation | null>(null);
  const [entries, setEntries] = useState<BrowseEntry[]>([]);
  const [breadcrumbs, setBreadcrumbs] = useState<BreadcrumbItem[]>([]);
  const [access, setAccess] = useState<'read' | 'read_write'>(allowWrite ? 'read_write' : 'read');
  const [boundaryApproved, setBoundaryApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<SelectedTerm2Workspace | null>(null);
  const currentPath = breadcrumbs.at(-1)?.folderPath ?? rootPath;
  const candidateId = validation?.candidateId;

  const showError = (reason: unknown) => {
    setError(reason instanceof Term2ApiError ? cleanUserFacingMessage(reason.message) : 'Workspace operation failed');
  };
  const openFolder = useCallback(async (folder: string, trail: BreadcrumbItem[] = [], start = folder) => {
    setBusy(true);
    setError(null);
    setSelected(null);
    setBoundaryApproved(false);
    setValidation(null);
    setEntries([]);
    setRootPath(start);
    setBreadcrumbs(trail);
    setPath(folder);
    try {
      // A browse response keeps the original candidate ID even when listing a
      // child. Validate the displayed folder itself so selection grants that folder.
      const result = await term2Client.validateCandidate(folder);
      setValidation(result);
      if (result.candidateId && result.valid && result.selectable) {
        setEntries((await term2Client.browseCandidate(result.candidateId)).entries);
      }
    } catch (reason) {
      showError(reason);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (homeFolder) {
      void openFolder(homeFolder);
    }
  }, [homeFolder, openFolder]);

  const select = async () => {
    if (!candidateId || !validation?.valid || !validation.selectable || !boundaryApproved) return;
    setBusy(true);
    setError(null);
    try {
      const effectiveAccess = allowWrite ? access : 'read';
      const result = await term2Client.selectCandidate(candidateId, effectiveAccess);
      const workspace: SelectedTerm2Workspace = {
        workspaceId: result.workspaceId,
        displayName: result.displayName,
        access: result.access,
        fullPath: currentPath,
      };
      setSelected(workspace);
      onSelected?.(workspace);
    } catch (reason) {
      showError(reason);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      aria-labelledby="term2-folder-heading"
      className="space-y-3"
    >
      <p id="term2-folder-heading" className="text-sm text-zinc-600 dark:text-zinc-300">
        Choose the folder with the files you want help with.{' '}
        {!allowWrite && (
          <span>
            This session is currently read-only — launch with{' '}
            <code className="rounded bg-zinc-100 px-1 py-0.5 font-mono text-xs dark:bg-zinc-800">
              term2-web --allow-write
            </code>{' '}
            to allow editing files.
          </span>
        )}
      </p>
      {homeFolder && !currentPath && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void openFolder(homeFolder)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-300 px-3 py-2 text-sm font-medium hover:bg-zinc-50 dark:border-zinc-600 dark:hover:bg-white/[0.06]"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Folder className="h-4 w-4" />}
          Browse home folder
        </button>
      )}
      <details open={!homeFolder || undefined}>
        <summary className="cursor-pointer text-xs font-medium text-teal-700 hover:underline dark:text-teal-400">
          Enter a folder path directly
        </summary>
        <form
          className="mt-2 flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void openFolder(path);
          }}
        >
          <label className="sr-only" htmlFor="term2-folder-path">
            Folder path
          </label>
          <input
            id="term2-folder-path"
            value={path}
            disabled={busy}
            onChange={(event) => setPath(event.target.value)}
            placeholder="/absolute/path/to/folder"
            className="min-w-0 flex-1 rounded-lg border border-zinc-300 bg-transparent px-3 py-2 text-sm dark:border-zinc-600"
          />
          <button
            type="submit"
            disabled={busy || !path.trim()}
            className="rounded-lg bg-zinc-900 px-3 py-2 text-sm text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900"
          >
            Open folder
          </button>
        </form>
      </details>
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
      {validation && (
        <div className="mt-3 space-y-2" aria-live="polite">
          <p className="break-all text-sm font-medium">
            {validation.valid ? `Current folder: ${currentPath}` : 'Could not open this folder'}
          </p>
          {!validation.valid && (
            <details className="text-xs">
              <summary>Folder checks</summary>
              <ul className="space-y-1 text-xs text-zinc-600 dark:text-zinc-400">
                {validation.checks.map((check) => (
                  <li key={check.name}>
                    <span
                      className={
                        check.status === 'ok' ? 'text-emerald-700' : check.status === 'error' ? 'text-red-700' : ''
                      }
                    >
                      {check.status === 'ok' ? '✓' : check.status === 'error' ? '✕' : '·'} {check.name}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {!validation.valid && (
            <div>
              <p className="text-sm text-red-700 dark:text-red-400">
                {cleanUserFacingMessage(validation.reason ?? 'This folder cannot be selected.')}
              </p>
              {validation.checks.some((check) => check.name === 'contained' && check.status === 'error') && (
                <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                  {homeFolder
                    ? 'Choose a folder inside your home folder.'
                    : 'Ask the person who set up term2 which folders you can use.'}
                </p>
              )}
            </div>
          )}
        </div>
      )}
      {(candidateId || breadcrumbs.length > 0) && (
        <div className="mt-3 rounded-lg border border-zinc-200 p-2 dark:border-zinc-700">
          <div className="mb-2 flex flex-wrap items-center gap-1 text-xs text-zinc-500" aria-label="Folder breadcrumbs">
            <button
              type="button"
              onClick={() => void openFolder(rootPath)}
              disabled={busy || breadcrumbs.length === 0}
              className={`rounded px-1 py-0.5 hover:underline ${
                breadcrumbs.length === 0
                  ? 'font-semibold text-zinc-800 dark:text-zinc-200'
                  : 'text-teal-700 dark:text-teal-400'
              }`}
            >
              Starting folder
            </button>
            {breadcrumbs.map((crumb, index) => {
              const isLast = index === breadcrumbs.length - 1;
              return (
                <span key={`${crumb.label}-${index}`} className="flex items-center gap-1">
                  <span>/</span>
                  <button
                    type="button"
                    onClick={() => void openFolder(crumb.folderPath, breadcrumbs.slice(0, index + 1), rootPath)}
                    disabled={busy || isLast}
                    className={`rounded px-1 py-0.5 ${
                      isLast
                        ? 'font-semibold text-zinc-800 dark:text-zinc-200'
                        : 'text-teal-700 hover:underline dark:text-teal-400'
                    }`}
                  >
                    {crumb.label}
                  </button>
                </span>
              );
            })}
          </div>
          {!busy &&
            candidateId &&
            !error &&
            !entries.some((entry) => entry.type !== 'file' && !entry.name.startsWith('.')) && (
              <p className="px-2 py-1 text-sm text-zinc-500">No subfolders to show. You can still use this folder.</p>
            )}
          <ul className="max-h-52 space-y-1 overflow-y-auto">
            {entries
              .filter((entry) => entry.type !== 'file' && !entry.name.startsWith('.'))
              .map((entry) => {
                const cleanReason =
                  entry.rejectionReason && entry.rejectionReason !== 'workspace_not_directory'
                    ? cleanUserFacingMessage(entry.rejectionReason)
                    : null;

                return (
                  <li
                    key={`${entry.name}-${entry.type}`}
                    aria-label={`${entry.type}: ${entry.name}`}
                    className="flex items-center justify-between gap-2 rounded px-2 py-1 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  >
                    <span className="min-w-0 truncate">
                      <span>{entry.name}</span>
                      {entry.targetDisplay && (
                        <span className="ml-2 text-xs text-zinc-500">→ {entry.targetDisplay}</span>
                      )}
                      {cleanReason && (
                        <span className="ml-2 text-xs text-red-700 dark:text-red-400">{cleanReason}</span>
                      )}
                    </span>
                    {entry.selectable && (
                      <button
                        type="button"
                        aria-label={`Open ${entry.name}`}
                        onClick={() => {
                          const relative = entry.targetDisplay ?? entry.name;
                          const folderPath =
                            relative === '.' ? currentPath : `${currentPath.replace(/\/$/, '')}/${relative}`;
                          void openFolder(folderPath, [...breadcrumbs, { label: entry.name, folderPath }], rootPath);
                        }}
                        disabled={busy || !entry.childToken}
                        className="text-xs underline"
                      >
                        Open
                      </button>
                    )}
                    {!entry.selectable && <span className="text-xs text-zinc-500">Unavailable</span>}
                  </li>
                );
              })}
          </ul>
        </div>
      )}
      {validation?.valid && validation.selectable && candidateId && (
        <div className="mt-4 border-t border-zinc-200 pt-3 dark:border-zinc-700">
          <h3 className="break-all text-sm font-semibold">Use {validation.displayName ?? 'this folder'}?</h3>
          <p className="mt-1 text-xs text-zinc-500">Only give access to files you want term2 to work with.</p>
          <label className="mt-2 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={boundaryApproved}
              onChange={(event) => setBoundaryApproved(event.target.checked)}
              disabled={busy}
            />{' '}
            Allow term2 to access files in this folder
          </label>
          {allowWrite && (
            <>
              <label className="mt-2.5 block text-xs font-medium text-zinc-500" htmlFor="term2-folder-access">
                Folder permissions
              </label>
              <select
                id="term2-folder-access"
                value={access}
                onChange={(event) => setAccess(event.target.value as 'read' | 'read_write')}
                className="mt-1 rounded-lg border border-zinc-300 bg-transparent px-2.5 py-1.5 text-sm dark:border-zinc-600"
              >
                <option value="read_write">Read and write (can edit files with approval)</option>
                <option value="read">Read only</option>
              </select>
            </>
          )}
          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              onClick={() => void select()}
              disabled={busy || !boundaryApproved}
              className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-teal-700 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Use this folder
            </button>
          </div>
          {selected && (
            <p className="mt-2 text-sm text-emerald-700" title={selected.fullPath || selected.displayName}>
              Selected workspace: {selected.displayName}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
