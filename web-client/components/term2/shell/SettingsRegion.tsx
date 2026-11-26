'use client';

import { useStoreSelector } from '../../../hooks/useStoreSelector';
import { closeSettings, navigateSettings } from '../../../lib/term2/navigation';
import { Term2SettingsPage } from '../settings/Term2SettingsPage';
import { useChatFacts, useShell, useShellEnv } from './ShellContext';

/** The settings page, shown instead of the chat while `?settings=` is set. */
export function SettingsRegion() {
  const shell = useShell();
  const { settingsOpen, settingsSection, settingsProvider } = useShellEnv();
  const models = useStoreSelector(shell.data.models, (s) => s.data);
  const modelsLoading = useStoreSelector(shell.data.models, (s) => s.loading);
  const prefs = useStoreSelector(shell.prefs, (p) => p);
  const interactionPending = useChatFacts((f) => f.interactionPending);
  if (!settingsOpen || !settingsSection) return null;
  return (
    <Term2SettingsPage
      section={settingsSection}
      provider={settingsProvider}
      onNavigate={navigateSettings}
      onClose={closeSettings}
      models={models}
      modelsLoading={modelsLoading}
      displayMode={prefs.displayMode}
      onDisplayModeChange={shell.prefs.setDisplayMode}
      notificationsEnabled={prefs.notificationsEnabled}
      onNotificationsChange={shell.prefs.setNotifications}
      showDiagnostics={prefs.showDiagnostics}
      onShowDiagnosticsChange={shell.prefs.setDiagnostics}
      approvalWaiting={interactionPending}
    />
  );
}
