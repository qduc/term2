'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, MoreHorizontal } from 'lucide-react';
import { Term2ApiError, term2Client } from '../../lib/api/term2';
import type { WorkspaceAlias } from '../../lib/term2/types';

export type SavedFolderChange =
  | { kind: 'access'; workspace: WorkspaceAlias }
  | { kind: 'removed'; workspaceId: string };

const ACCESS_OPTIONS = [
  { value: 'read_write', label: 'Read & write' },
  { value: 'read', label: 'Read only' },
] as const;

/**
 * Per-folder actions for a saved folder: change its access or remove it. The gateway
 * closes the folder's live chats either way. A chat keeps the access it started with,
 * so after a change, chats started with the other access open again only if the
 * access is switched back; after removal they do not open at all.
 */
export function Term2SavedFolderMenu({
  workspace,
  allowWrite,
  onChanged,
}: {
  workspace: WorkspaceAlias;
  /** False when the server refuses read & write; widening is then disabled. */
  allowWrite: boolean;
  onChanged: (change: SavedFolderChange) => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  function close() {
    setOpen(false);
    setConfirmingRemove(false);
    setError(null);
  }

  async function run(action: () => Promise<SavedFolderChange>) {
    setBusy(true);
    setError(null);
    try {
      onChanged(await action());
      close();
    } catch (reason) {
      setError(reason instanceof Term2ApiError ? reason.message : 'Could not update this folder');
    } finally {
      setBusy(false);
    }
  }

  const changeAccess = (access: WorkspaceAlias['access']) => {
    if (access === workspace.access) return close();
    void run(async () => ({
      kind: 'access',
      workspace: await term2Client.changeWorkspaceAccess(workspace.workspaceId, access),
    }));
  };

  const remove = () =>
    void run(async () => {
      await term2Client.removeWorkspace(workspace.workspaceId);
      return { kind: 'removed', workspaceId: workspace.workspaceId };
    });

  return (
    <div ref={rootRef} className="relative inline-flex">
      <button
        type="button"
        aria-label={`Folder options for ${workspace.label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
        className="flex h-7 w-6 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-black/[0.05] hover:text-zinc-700 dark:hover:bg-white/[0.07] dark:hover:text-zinc-200"
      >
        <MoreHorizontal className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute left-0 top-full z-20 mt-1 w-64 rounded-lg border border-black/[0.09] bg-white p-1 text-xs shadow-lg dark:border-white/[0.09] dark:bg-zinc-900"
        >
          {confirmingRemove ? (
            <div className="space-y-2 p-2">
              <p className="text-zinc-700 dark:text-zinc-200">
                Remove this folder? Its chats will no longer open, even if you add the folder again.
              </p>
              <div className="flex justify-end gap-1.5">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setConfirmingRemove(false)}
                  className="rounded-md px-2 py-1 text-zinc-600 hover:bg-black/[0.05] dark:text-zinc-300 dark:hover:bg-white/[0.07]"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={remove}
                  className="rounded-md bg-red-600 px-2 py-1 font-medium text-white hover:bg-red-700 disabled:opacity-60"
                >
                  {busy ? 'Removing…' : 'Remove'}
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="px-2 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-zinc-400">
                Access
              </div>
              {ACCESS_OPTIONS.map((option) => {
                const current = option.value === workspace.access;
                const refused = option.value === 'read_write' && !allowWrite && !current;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={current}
                    disabled={busy || refused}
                    title={refused ? 'The server was started without write access' : undefined}
                    onClick={() => changeAccess(option.value)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-zinc-700 hover:bg-black/[0.05] disabled:cursor-not-allowed disabled:opacity-50 dark:text-zinc-200 dark:hover:bg-white/[0.07]"
                  >
                    <Check className={`h-3.5 w-3.5 ${current ? 'opacity-100' : 'opacity-0'}`} />
                    {option.label}
                  </button>
                );
              })}
              <p className="px-2 pb-1.5 pt-1 text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">
                Changing access stops this folder&apos;s open chats. They open again only if you switch back.
              </p>
              <div className="my-1 border-t border-black/[0.07] dark:border-white/[0.07]" />
              <button
                type="button"
                role="menuitem"
                disabled={busy}
                onClick={() => setConfirmingRemove(true)}
                className="flex w-full items-center rounded-md px-2 py-1.5 text-left text-red-600 hover:bg-red-500/10 dark:text-red-400"
              >
                Remove folder…
              </button>
            </>
          )}
          {error && <p className="px-2 pb-1.5 text-[11px] text-red-600 dark:text-red-400">{error}</p>}
        </div>
      )}
    </div>
  );
}
