'use client';

import { useState } from 'react';
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
  token?: string;
  candidateId?: string;
  folderPath: string;
}

export function Term2FolderSelector({ onSelected }: { onSelected?: (workspace: SelectedTerm2Workspace) => void }) {
  const [path, setPath] = useState('');
  const [candidateId, setCandidateId] = useState<string | null>(null);
  const [rootCandidateId, setRootCandidateId] = useState<string | null>(null);
  const [rootPath, setRootPath] = useState<string>('');
  const [validation, setValidation] = useState<CandidateValidation | null>(null);
  const [entries, setEntries] = useState<BrowseEntry[]>([]);
  const [breadcrumbs, setBreadcrumbs] = useState<BreadcrumbItem[]>([]);
  const [access, setAccess] = useState<'read' | 'read_write'>('read');
  const [boundaryApproved, setBoundaryApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<SelectedTerm2Workspace | null>(null);

  const showError = (reason: unknown) => {
    setError(reason instanceof Term2ApiError ? cleanUserFacingMessage(reason.message) : 'Workspace operation failed');
  };
  const validate = async () => {
    setBusy(true);
    setError(null);
    setSelected(null);
    setBoundaryApproved(false);
    try {
      const result = await term2Client.validateCandidate(path);
      setValidation(result);
      const cid = result.candidateId ?? null;
      setCandidateId(cid);
      setRootCandidateId(cid);
      setRootPath(path.trim());
      setEntries([]);
      setBreadcrumbs([]);
    } catch (reason) {
      showError(reason);
      setValidation(null);
      setCandidateId(null);
      setRootCandidateId(null);
    } finally {
      setBusy(false);
    }
  };
  const browse = async (child?: string, label?: string, targetDisplay?: string) => {
    if (!candidateId) return;
    setBusy(true);
    setError(null);
    try {
      const result = await term2Client.browseCandidate(candidateId, child);
      setCandidateId(result.candidateId);
      setEntries(result.entries);
      if (label) {
        const nextPath = targetDisplay || (path.endsWith('/') ? `${path}${label}` : `${path}/${label}`);
        setBreadcrumbs((current) => [
          ...current,
          { label, token: child, candidateId: result.candidateId, folderPath: nextPath },
        ]);
        setPath(nextPath);
      }
    } catch (reason) {
      showError(reason);
    } finally {
      setBusy(false);
    }
  };
  const navigateToRoot = async () => {
    if (!rootCandidateId) return;
    setBusy(true);
    setError(null);
    try {
      const result = await term2Client.browseCandidate(rootCandidateId);
      setCandidateId(rootCandidateId);
      setEntries(result.entries);
      setBreadcrumbs([]);
      if (rootPath) setPath(rootPath);
    } catch (reason) {
      showError(reason);
    } finally {
      setBusy(false);
    }
  };
  const navigateToCrumb = async (index: number) => {
    const crumb = breadcrumbs[index];
    if (!crumb) return;
    const targetCandidateId = crumb.candidateId ?? rootCandidateId;
    if (!targetCandidateId) return;
    setBusy(true);
    setError(null);
    try {
      const result = await term2Client.browseCandidate(targetCandidateId);
      setCandidateId(result.candidateId);
      setEntries(result.entries);
      setBreadcrumbs((current) => current.slice(0, index + 1));
      setPath(crumb.folderPath);
    } catch (reason) {
      showError(reason);
    } finally {
      setBusy(false);
    }
  };
  const select = async () => {
    if (!candidateId || !validation?.valid || !validation.selectable || !boundaryApproved) return;
    setBusy(true);
    setError(null);
    try {
      const result = await term2Client.selectCandidate(candidateId, access);
      const workspace: SelectedTerm2Workspace = {
        workspaceId: result.workspaceId,
        displayName: result.displayName,
        access: result.access,
        fullPath: rootPath || path,
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
      className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-700 dark:bg-zinc-900"
    >
      <h2 id="term2-folder-heading" className="font-semibold">
        Choose a local workspace
      </h2>
      <p className="mt-1 text-xs text-zinc-500">The server validates the folder and owns the workspace authority.</p>
      <div className="mt-3 flex gap-2">
        <label className="sr-only" htmlFor="term2-folder-path">
          Folder path
        </label>
        <input
          id="term2-folder-path"
          value={path}
          onChange={(event) => setPath(event.target.value)}
          placeholder="/absolute/path/to/folder"
          className="min-w-0 flex-1 rounded-lg border border-zinc-300 bg-transparent px-3 py-2 text-sm dark:border-zinc-600"
        />
        <button
          type="button"
          onClick={() => void validate()}
          disabled={busy || !path.trim()}
          className="rounded-lg bg-zinc-900 px-3 py-2 text-sm text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900"
        >
          Check path
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-700 dark:text-red-400">
          {error}
        </p>
      )}
      {validation && (
        <div className="mt-3 space-y-2" aria-live="polite">
          <p className="text-sm font-medium">{validation.displayName ?? 'Server validation'}</p>
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
          {!validation.valid && (
            <div>
              <p className="text-sm text-red-700 dark:text-red-400">
                {cleanUserFacingMessage(validation.reason ?? 'This folder cannot be selected.')}
              </p>
              {validation.checks.some((check) => check.name === 'contained' && check.status === 'error') && (
                <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                  The server only approves folders it is configured to allow; arbitrary folders are rejected for
                  isolation. Ask the local owner for the approved workspace root.
                </p>
              )}
            </div>
          )}
          {validation.valid && validation.selectable && candidateId && (
            <button type="button" onClick={() => void browse()} disabled={busy} className="text-sm underline">
              Browse this folder
            </button>
          )}
        </div>
      )}
      {candidateId && entries.length > 0 && (
        <div className="mt-3 rounded-lg border border-zinc-200 p-2 dark:border-zinc-700">
          <div className="mb-2 flex flex-wrap items-center gap-1 text-xs text-zinc-500" aria-label="Folder breadcrumbs">
            <button
              type="button"
              onClick={() => void navigateToRoot()}
              disabled={busy || breadcrumbs.length === 0}
              className={`rounded px-1 py-0.5 hover:underline ${
                breadcrumbs.length === 0
                  ? 'font-semibold text-zinc-800 dark:text-zinc-200'
                  : 'text-blue-600 dark:text-blue-400'
              }`}
            >
              Root
            </button>
            {breadcrumbs.map((crumb, index) => {
              const isLast = index === breadcrumbs.length - 1;
              return (
                <span key={`${crumb.label}-${index}`} className="flex items-center gap-1">
                  <span>/</span>
                  <button
                    type="button"
                    onClick={() => void navigateToCrumb(index)}
                    disabled={busy || isLast}
                    className={`rounded px-1 py-0.5 ${
                      isLast
                        ? 'font-semibold text-zinc-800 dark:text-zinc-200'
                        : 'text-blue-600 hover:underline dark:text-blue-400'
                    }`}
                  >
                    {crumb.label}
                  </button>
                </span>
              );
            })}
          </div>
          <ul className="space-y-1">
            {entries.map((entry) => {
              const isFile = entry.type === 'file';
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
                    <span
                      className={`mr-2 text-xs ${
                        isFile ? 'text-zinc-400 dark:text-zinc-500' : 'font-medium text-zinc-500'
                      }`}
                    >
                      {isFile ? 'File' : entry.type}
                    </span>
                    <span className={isFile ? 'text-zinc-500 dark:text-zinc-400' : ''}>{entry.name}</span>
                    {entry.targetDisplay && <span className="ml-2 text-xs text-zinc-500">→ {entry.targetDisplay}</span>}
                    {cleanReason && <span className="ml-2 text-xs text-red-700 dark:text-red-400">{cleanReason}</span>}
                  </span>
                  {entry.type !== 'file' && entry.selectable && (
                    <button
                      type="button"
                      onClick={() => void browse(entry.childToken, entry.name, entry.targetDisplay)}
                      disabled={busy || !entry.childToken}
                      className="text-xs underline"
                    >
                      Open
                    </button>
                  )}
                  {entry.type !== 'file' && !entry.selectable && (
                    <span className="text-xs text-zinc-500">Unavailable</span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {validation?.valid && validation.selectable && candidateId && (
        <div className="mt-4 border-t border-zinc-200 pt-3 dark:border-zinc-700">
          <h3 className="text-sm font-semibold">Workspace boundary</h3>
          <p className="mt-1 text-xs text-zinc-500">
            Selecting a root does not grant shell, tools, writes, or approvals.
          </p>
          <label className="mt-2 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={boundaryApproved}
              onChange={(event) => setBoundaryApproved(event.target.checked)}
            />{' '}
            Confirm this root separately from capabilities
          </label>
          <label className="mt-2 block text-xs text-zinc-500" htmlFor="term2-folder-access">
            Workspace access
          </label>
          <select
            id="term2-folder-access"
            value={access}
            onChange={(event) => setAccess(event.target.value as 'read' | 'read_write')}
            className="mt-1 rounded-lg border border-zinc-300 bg-transparent px-2 py-1 text-sm dark:border-zinc-600"
          >
            <option value="read">Read only</option>
            <option value="read_write">Read and write</option>
          </select>
          <button
            type="button"
            onClick={() => void select()}
            disabled={busy || !boundaryApproved}
            className="ml-2 rounded-lg bg-violet-700 px-3 py-1.5 text-sm text-white disabled:opacity-40"
          >
            Select workspace
          </button>
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
