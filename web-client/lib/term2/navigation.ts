/**
 * Every write the chat shell makes to the address bar. The address bar owns which chat is open: these change it
 * and the page reports the change back as `URL_CHANGED` (lib/term2/shell-machine.ts). No React here.
 */
import type { SettingsSectionId } from '../../components/term2/settings/settings-catalog';

/** The current URL with the settings page's parameters set (or removed when `section` is null). */
export function settingsUrl(section: SettingsSectionId | null, provider?: string | null): string {
  const url = new URL(window.location.href);
  url.searchParams.delete('settings');
  url.searchParams.delete('provider');
  if (section) {
    url.searchParams.set('settings', section);
    if (provider) url.searchParams.set('provider', provider);
  }
  return url.toString();
}

/** Opens a chat as a new history entry. */
export function openChat(sessionId: string): void {
  const params = new URLSearchParams(window.location.search);
  params.delete('c');
  params.set('term2', '1');
  params.set('agentSession', sessionId);
  window.history.pushState({}, '', `${window.location.pathname}?${params.toString()}`);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

/** Leaves the open chat (back to a draft or the welcome screen) as a new history entry. */
export function leaveChat(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has('agentSession')) return;
  url.searchParams.delete('agentSession');
  window.history.pushState({}, '', url.toString());
  window.dispatchEvent(new PopStateEvent('popstate'));
}

/** Leaves a chat whose folder was removed. */
export function leaveRemovedFolderChat(): void {
  const params = new URLSearchParams(window.location.search);
  params.delete('agentSession');
  window.history.pushState({}, '', `${window.location.pathname}?${params.toString()}`);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

/** Drops the chat from the address bar without a history entry or a popstate (another user signed in). */
export function forgetChatSilently(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has('agentSession')) return;
  url.searchParams.delete('agentSession');
  window.history.replaceState(null, '', url.toString());
}

/** Opens the settings page as a new history entry, so browser Back returns to the chat. */
export function openSettings(section: SettingsSectionId = 'providers', provider?: string | null): void {
  window.history.pushState({ term2Settings: true }, '', settingsUrl(section, provider));
}

/** Moves within settings without adding history entries. */
export function navigateSettings(section: SettingsSectionId, provider?: string | null): void {
  window.history.replaceState(
    { term2Settings: Boolean((window.history.state as { term2Settings?: boolean } | null)?.term2Settings) },
    '',
    settingsUrl(section, provider),
  );
}

export function closeSettings(): void {
  // Opened from the chat: go back to that entry. Opened from a link or a refresh: drop the parameters.
  if ((window.history.state as { term2Settings?: boolean } | null)?.term2Settings) {
    window.history.back();
    return;
  }
  window.history.replaceState({}, '', settingsUrl(null));
}
