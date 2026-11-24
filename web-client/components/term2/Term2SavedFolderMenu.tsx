'use client';

import { useState } from 'react';
import { MoreHorizontal, Plus, Trash2 } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { Term2ApiError, term2Client } from '../../lib/api/term2';
import type { WorkspaceAlias } from '../../lib/term2/types';

export type SavedFolderChange =
  | { kind: 'access'; workspace: WorkspaceAlias }
  | { kind: 'removed'; workspaceId: string };

/**
 * Per-folder actions for a saved folder: start a chat there (optional), change its
 * access, or remove it. The gateway closes the folder's live chats either way. After
 * a change a chat reopens with the narrower of the access it started with and the
 * folder's new access, so it never gains access; after removal its chats do not open.
 */
export function Term2SavedFolderMenu({
  workspace,
  displayName,
  allowWrite,
  onChanged,
  onNewChat,
  className,
}: {
  workspace: WorkspaceAlias;
  /** Short folder name for labels; defaults to the workspace label. */
  displayName?: string;
  /** False when the server refuses read & write; widening is then disabled. */
  allowWrite: boolean;
  onChanged: (change: SavedFolderChange) => void;
  onNewChat?: () => void;
  className?: string;
}) {
  const name = displayName || workspace.label;
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<SavedFolderChange>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      onChanged(await action());
      return true;
    } catch (reason) {
      setError(reason instanceof Term2ApiError ? reason.message : 'Could not update this folder');
      return false;
    } finally {
      setBusy(false);
    }
  }

  const changeAccess = async (access: WorkspaceAlias['access']) => {
    if (access === workspace.access) return;
    const ok = await run(async () => ({
      kind: 'access',
      workspace: await term2Client.changeWorkspaceAccess(workspace.workspaceId, access),
    }));
    if (ok) setMenuOpen(false);
  };

  const remove = async () => {
    const ok = await run(async () => {
      await term2Client.removeWorkspace(workspace.workspaceId);
      return { kind: 'removed', workspaceId: workspace.workspaceId };
    });
    if (ok) setConfirmingRemove(false);
  };

  return (
    <>
      <DropdownMenu
        modal={false}
        open={menuOpen}
        onOpenChange={(open) => {
          setMenuOpen(open);
          if (open) setError(null);
        }}
      >
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`Folder options for ${name}`}
            title="Folder options"
            className={cn('text-muted-foreground', className)}
          >
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          {onNewChat && (
            <>
              <DropdownMenuItem onSelect={onNewChat}>
                <Plus aria-hidden />
                New chat here
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuLabel className="text-xs text-muted-foreground">Access</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={workspace.access}>
            <DropdownMenuRadioItem
              value="read_write"
              disabled={busy || (!allowWrite && workspace.access !== 'read_write')}
              title={!allowWrite ? 'The server was started with --read-only' : undefined}
              onSelect={(event) => {
                event.preventDefault();
                void changeAccess('read_write');
              }}
            >
              Read and write
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem
              value="read"
              disabled={busy}
              onSelect={(event) => {
                event.preventDefault();
                void changeAccess('read');
              }}
            >
              Read only
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
          <p className="px-2 pb-1.5 pt-1 text-xs leading-snug text-muted-foreground">
            Open chats in this folder restart. Existing chats never get more access than they started with.
          </p>
          {error && !confirmingRemove && <p className="px-2 pb-1.5 text-xs text-destructive">{error}</p>}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            disabled={busy}
            onSelect={() => {
              setError(null);
              setConfirmingRemove(true);
            }}
          >
            <Trash2 aria-hidden />
            Remove folder…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={confirmingRemove} onOpenChange={(open) => !busy && setConfirmingRemove(open)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its chats will no longer open, even if you add the folder again. Files in the folder aren&apos;t touched.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={(event) => {
                event.preventDefault();
                void remove();
              }}
            >
              {busy ? 'Removing…' : 'Remove folder'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
