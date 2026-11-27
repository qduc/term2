'use client';

import { CheckCircle2, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useStoreSelector } from '../../../hooks/useStoreSelector';
import { shallowEqual } from '../../../lib/term2/store';
import { useChatFacts, useShell, useShellEnv, useShellState } from './ShellContext';
import { Wordmark } from './Wordmark';

/** Radix Select reserves the empty string, so the "no folder" option uses a sentinel. */
const NO_WORKSPACE = '__none__';

/** The first-run checklist: shown with no chat and no draft. */
export function WelcomeChecklist() {
  const shell = useShell();
  const { dispatch, ops } = shell;
  const { localControlEnabled } = useShellEnv();
  const sessionId = useChatFacts((f) => f.sessionId);
  const isDraft = useChatFacts((f) => f.isDraft);
  const hasAnyConfiguredProvider = useChatFacts((f) => f.hasAnyConfiguredProvider);
  const selectedWorkspaceId = useChatFacts((f) => f.selectedWorkspaceId);
  const hostWorkspaceId = useChatFacts((f) => f.hostWorkspaceId);
  const selectedWorkspaceKind = useChatFacts((f) => f.selectedWorkspaceKind);
  const selectedWorkspaceInfo = useChatFacts((f) => f.selectedWorkspaceInfo, shallowEqual);
  const startingChat = useChatFacts((f) => f.startingChat);
  const settingsLoaded = useStoreSelector(shell.data.settings, (s) => Boolean(s.data));
  const folders = useStoreSelector(shell.data.folders, (s) => s.data);
  const loadingWorkspaces = useStoreSelector(shell.data.folders, (s) => s.loading);
  const pageError = useShellState((s) => s.pageError);
  if (sessionId || isDraft) return null;
  const openFolderDialog = () => dispatch({ type: 'DIALOG_OPENED', dialog: 'folder' });

  return (
    <div className="t2-enter mx-auto flex max-w-lg flex-col items-center pt-[7vh] text-center">
      <span aria-hidden className="text-[2rem] leading-none">
        <Wordmark />
      </span>
      <h2 className="mt-5 text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
        Work with your files using AI
      </h2>
      <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
        Ask questions, inspect code, and review every action before it runs.
      </p>

      <div className="mt-7 w-full space-y-3 text-left">
        {localControlEnabled && (
          <div className="flex items-start justify-between gap-3 rounded-2xl border border-black/[0.08] bg-zinc-50/70 p-4 dark:border-white/[0.08] dark:bg-white/[0.02]">
            <div className="flex items-start gap-3">
              <span
                className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                  hasAnyConfiguredProvider
                    ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                    : 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
                }`}
              >
                {hasAnyConfiguredProvider ? <CheckCircle2 className="h-4 w-4" /> : '1'}
              </span>
              <div>
                <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                  {!settingsLoaded
                    ? 'AI connection'
                    : hasAnyConfiguredProvider
                    ? 'AI provider connected'
                    : 'Connect an AI service'}
                </h3>
                <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                  {!settingsLoaded
                    ? 'Checking for saved connections…'
                    : hasAnyConfiguredProvider
                    ? 'You can switch models or add more providers anytime in Settings.'
                    : 'Sign in with ChatGPT, use an API key, or connect your own server.'}
                </p>
              </div>
            </div>
            <Button
              type="button"
              size="sm"
              variant={hasAnyConfiguredProvider ? 'outline' : 'default'}
              onClick={ops.openProviderSetup}
              disabled={!settingsLoaded}
            >
              {hasAnyConfiguredProvider ? 'Manage' : 'Connect'}
            </Button>
          </div>
        )}

        <div className="rounded-2xl border border-black/[0.08] bg-zinc-50/70 p-4 dark:border-white/[0.08] dark:bg-white/[0.02]">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <span
                className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                  selectedWorkspaceId
                    ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                    : 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                }`}
              >
                {selectedWorkspaceId ? <CheckCircle2 className="h-4 w-4" /> : '2'}
              </span>
              <div>
                <h3 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                  {selectedWorkspaceId
                    ? selectedWorkspaceKind === 'host'
                      ? `Ready: ${selectedWorkspaceInfo.displayName}`
                      : `Folder ready: ${selectedWorkspaceInfo.displayName}`
                    : 'Choose a folder to work in'}
                </h3>
                <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                  {selectedWorkspaceId
                    ? selectedWorkspaceKind === 'host'
                      ? `${
                          selectedWorkspaceInfo.access === 'read_write'
                            ? 'Read & write access'
                            : 'Read-only access'
                        } · free-roaming mode across any directory you approve.`
                      : `${
                          selectedWorkspaceInfo.access === 'read_write'
                            ? 'Read & write access'
                            : 'Read-only access'
                        } · only files inside this folder are visible to Term2.`
                    : 'Pick a local folder, or start directly on this machine without pinning to one directory.'}
                </p>
              </div>
            </div>
            {localControlEnabled && (
              <div className="flex shrink-0 items-center gap-1.5">
                {!selectedWorkspaceId && hostWorkspaceId && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={startingChat}
                    onClick={() => void ops.createNewChat(hostWorkspaceId)}
                  >
                    This machine (~)
                  </Button>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant={!selectedWorkspaceId && hasAnyConfiguredProvider ? 'default' : 'outline'}
                  onClick={openFolderDialog}
                >
                  {selectedWorkspaceId ? 'Change' : 'Browse'}
                </Button>
              </div>
            )}
          </div>

          {folders.length > 0 && (
            <div className="mt-3 pl-9">
              <label className="sr-only" htmlFor="landing-workspace">
                Saved folders
              </label>
              <Select
                value={selectedWorkspaceId ?? NO_WORKSPACE}
                onValueChange={(value) =>
                  dispatch({ type: 'FOLDER_CHOSEN', workspaceId: value === NO_WORKSPACE ? null : value || null })
                }
              >
                <SelectTrigger id="landing-workspace" size="sm" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper">
                  <SelectItem value={NO_WORKSPACE}>Choose a saved folder…</SelectItem>
                  {folders.map((workspace) => (
                    <SelectItem value={workspace.workspaceId} key={workspace.workspaceId}>
                      {workspace.label} (
                      {workspace.access === 'read_write' ? 'read & write' : 'read only'})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
      </div>

      {loadingWorkspaces ? (
        <p role="status" className="mt-5 text-sm text-zinc-500">
          Loading folders…
        </p>
      ) : (
        selectedWorkspaceId && (
          <Button
            type="button"
            size="lg"
            disabled={startingChat}
            onClick={() => void ops.createNewChat()}
            className="mt-6"
          >
            <Plus aria-hidden />
            {startingChat ? 'Starting chat…' : 'Start a new chat'}
          </Button>
        )
      )}
      {!loadingWorkspaces && !localControlEnabled && folders.length === 0 && !pageError && (
        <p className="mt-4 text-sm text-zinc-500">
          No folders are available yet. Ask the person who set up Term2 to add one.
        </p>
      )}
    </div>
  );
}
