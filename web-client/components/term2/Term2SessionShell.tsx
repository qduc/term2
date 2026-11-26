'use client';

import { useMemo } from 'react';
import { isTerm2LocalControlEnabled } from './flags';
import { parseSettingsSection } from './settings/settings-catalog';
import { ChatColumn } from './shell/ChatColumn';
import { ChatSidebar, SidebarScrim } from './shell/ChatSidebar';
import { SettingsRegion } from './shell/SettingsRegion';
import { Term2ShellProvider, type ShellEnv } from './shell/ShellContext';
import { FolderDialog, HelpDialog, ProviderDialog, RewindDialog } from './shell/ShellDialogs';
import { TasksPanelRegion } from './shell/TasksPanelRegion';

/**
 * The chat page: layout only. The runtime (lib/term2/shell/shell-runtime.ts) holds the state and its rules; each
 * region under ./shell/ reads what it needs by selector (docs/plans/web-client/web-shell-decomposition.md). The
 * children keep the page's DOM order.
 */
export function Term2SessionShell({
  initialSessionId,
  authUserId,
  homeFolder,
  allowWrite = false,
  settingsSection = null,
  settingsProvider = null,
}: {
  initialSessionId: string | null;
  /** Current authenticated user id (or null). A change resets session selection. */
  authUserId?: string | null;
  homeFolder?: string;
  allowWrite?: boolean;
  /** `?settings=` URL value; when set, the settings page replaces the chat view. */
  settingsSection?: string | null;
  /** `?provider=` URL value: the provider shown on the settings page's Providers section. */
  settingsProvider?: string | null;
}) {
  const localControlEnabled = isTerm2LocalControlEnabled();
  const activeSettingsSection = localControlEnabled ? parseSettingsSection(settingsSection) : null;
  const env = useMemo<ShellEnv>(
    () => ({
      ...(homeFolder !== undefined ? { homeFolder } : {}),
      allowWrite,
      localControlEnabled,
      settingsSection: activeSettingsSection,
      settingsProvider,
      settingsOpen: activeSettingsSection !== null,
    }),
    [homeFolder, allowWrite, localControlEnabled, activeSettingsSection, settingsProvider],
  );
  return (
    <Term2ShellProvider initialSessionId={initialSessionId} authUserId={authUserId ?? null} env={env}>
      <main className="relative flex h-dvh max-h-dvh overflow-hidden bg-[#f7f7f8] text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
        <ChatSidebar />
        <SettingsRegion />
        <ChatColumn />
        <TasksPanelRegion />
        <ProviderDialog />
        <FolderDialog />
        <SidebarScrim />
        <HelpDialog />
        <RewindDialog />
      </main>
    </Term2ShellProvider>
  );
}
