'use client';

import { PanelLeft, SquarePen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useStoreSelector } from '../../../hooks/useStoreSelector';
import { shallowEqual } from '../../../lib/term2/store';
import { Term2SessionList } from '../Term2SessionList';
import { useAllowWrite, useChatFacts, useShell, useShellEnv, useShellState } from './ShellContext';
import { Wordmark } from './Wordmark';

/** The chat history and saved folders. */
export function ChatSidebar() {
  const shell = useShell();
  const { dispatch, ops } = shell;
  const { settingsOpen, localControlEnabled } = useShellEnv();
  const sidebarOpen = useShellState((s) => s.panels.sidebar);
  const sessionId = useChatFacts((f) => f.sessionId);
  const selectedWorkspaceId = useChatFacts((f) => f.selectedWorkspaceId);
  const selectedWorkspaceInfo = useChatFacts((f) => f.selectedWorkspaceInfo, shallowEqual);
  const startingChat = useChatFacts((f) => f.startingChat);
  const firstMessages = useChatFacts((f) => f.firstMessages, shallowEqual);
  const chats = useStoreSelector(shell.data.chats, (s) => s.data);
  const loadingSessions = useStoreSelector(shell.data.chats, (s) => s.loading && !s.loaded);
  const folders = useStoreSelector(shell.data.folders, (s) => s.data);
  const loadingWorkspaces = useStoreSelector(shell.data.folders, (s) => s.loading && !s.loaded);
  const folderDetails = useStoreSelector(shell.data.folderDetails, (s) => s);
  const allowWrite = useAllowWrite();

  return (
    <aside
      aria-label="Chat history and folders"
      inert={sidebarOpen !== true ? true : undefined}
      aria-hidden={sidebarOpen !== true ? 'true' : undefined}
      className={`${
        settingsOpen ? 'hidden! ' : ''
      }fixed inset-y-0 left-0 z-[70] flex w-[17.5rem] flex-col bg-[#f7f7f8] shadow-2xl transition-[transform,margin] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] dark:bg-zinc-950 md:relative md:z-auto md:shadow-none ${
        sidebarOpen === true
          ? 'translate-x-0'
          : sidebarOpen === false
            ? '-translate-x-full invisible pointer-events-none md:-ml-[17.5rem]'
            : // Not measured yet (server render and first paint): open on desktop, closed on small screens.
              '-translate-x-full invisible pointer-events-none md:pointer-events-auto md:visible md:translate-x-0'
      }`}
    >
      <div className="flex h-12 shrink-0 items-center justify-between pl-4 pr-2">
        <button
          type="button"
          onClick={() => {
            dispatch({ type: 'DRAFT_DISCARDED' });
          }}
          className="text-[15px] hover:opacity-80"
          title="Go to welcome screen"
        >
          <Wordmark />
        </button>
        <div className="flex items-center gap-0.5">
          {selectedWorkspaceId && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`New chat in ${selectedWorkspaceInfo.displayName || 'this folder'}`}
              title={`New chat in ${selectedWorkspaceInfo.displayName || 'this folder'}`}
              disabled={startingChat}
              onClick={() => void ops.createNewChat()}
              className="text-muted-foreground"
            >
              <SquarePen strokeWidth={1.75} />
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Close chat history"
            onClick={() => dispatch({ type: 'SIDEBAR_SET', open: false })}
            className="text-muted-foreground"
          >
            <PanelLeft strokeWidth={1.75} />
          </Button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col px-2 pb-2 pt-1">
        {/* Chats and folders arrive separately; drawing the list once both are first in keeps Recent from pushing
            Folders down. A later reload keeps the list on screen. */}
        {loadingSessions || loadingWorkspaces ? (
          <p className="mb-2 px-2.5 text-xs text-muted-foreground">Loading chats…</p>
        ) : (
        <Term2SessionList
          sessions={chats.sessions}
          selected={sessionId}
          selectedWorkspaceId={selectedWorkspaceId}
          workspaces={folders}
          workspaceMetadata={folderDetails}
          firstMessages={firstMessages}
          onSelect={ops.selectChat}
          onCreate={(workspaceId) => void ops.createNewChat(workspaceId)}
          onAddFolder={localControlEnabled ? () => dispatch({ type: 'DIALOG_OPENED', dialog: 'folder' }) : undefined}
          onSavedFolderChanged={localControlEnabled ? (change) => void ops.savedFolderChanged(change) : undefined}
          allowWrite={allowWrite}
          nextCursor={chats.nextCursor}
          onNextPage={() => void shell.data.loadMoreChats()}
        />
        )}
      </div>
    </aside>
  );
}

/** The dimmed backdrop behind the open sidebar on a small screen. */
export function SidebarScrim() {
  const { dispatch } = useShell();
  const { settingsOpen } = useShellEnv();
  const sidebarOpen = useShellState((s) => s.panels.sidebar);
  if (!sidebarOpen || settingsOpen) return null;
  return (
    <button
      type="button"
      aria-label="Dismiss chat history"
      className="fixed inset-0 z-[60] bg-black/30 backdrop-blur-[2px] md:hidden"
      onClick={() => dispatch({ type: 'SIDEBAR_SET', open: false })}
    />
  );
}
