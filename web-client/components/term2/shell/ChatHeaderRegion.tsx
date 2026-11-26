'use client';

import { openSettings } from '../../../lib/term2/navigation';
import { shallowEqual } from '../../../lib/term2/store';
import { ChatHeader } from '../../ChatHeader';
import { useRunningTaskCounts } from './RunningTasksContext';
import { useChatFacts, useShell, useShellEnv, useShellState } from './ShellContext';

export function ChatHeaderRegion() {
  const shell = useShell();
  const { dispatch, ops } = shell;
  const { localControlEnabled } = useShellEnv();
  const sidebarOpen = useShellState((s) => s.panels.sidebar);
  const sessionId = useChatFacts((f) => f.sessionId);
  const streaming = useChatFacts((f) => f.canAbort && f.hasStreamingTurn);
  const sessionTitle = useChatFacts((f) => f.sessionTitle);
  const selectedWorkspaceId = useChatFacts((f) => f.selectedWorkspaceId);
  const selectedWorkspaceInfo = useChatFacts((f) => f.selectedWorkspaceInfo, shallowEqual);
  const tasksPanelVisible = useChatFacts((f) => f.tasksPanelVisible);
  const runningTasks = useRunningTaskCounts();

  return (
    <ChatHeader
      isStreaming={streaming}
      model=""
      onModelChange={() => {}}
      showModelSelector={false}
      title={sessionTitle}
      subtitle={selectedWorkspaceInfo.displayName || undefined}
      subtitleTooltip={selectedWorkspaceInfo.fullPath || undefined}
      onOpenFolder={localControlEnabled ? () => dispatch({ type: 'DIALOG_OPENED', dialog: 'folder' }) : undefined}
      onNewChat={!sidebarOpen && selectedWorkspaceId ? () => void ops.createNewChat() : undefined}
      newChatLabel="New chat"
      onOpenHelp={() => dispatch({ type: 'DIALOG_OPENED', dialog: 'help' })}
      onOpenSettings={() => openSettings()}
      showSettingsButton={localControlEnabled}
      onToggleLeftSidebar={() => dispatch({ type: 'SIDEBAR_SET', open: !shell.store.get().panels.sidebar })}
      showLeftSidebarButton={!sidebarOpen}
      alwaysShowLeftSidebarButton
      leftSidebarToggleLabel="Open chat history"
      showRightSidebarButton={false}
      runningTasks={
        sessionId
          ? {
              count: runningTasks.runningCount,
              needsYou: runningTasks.needsYouCount,
              open: tasksPanelVisible,
              onClick: () => dispatch({ type: 'TASKS_PANEL_TOGGLED' }),
            }
          : undefined
      }
    />
  );
}
