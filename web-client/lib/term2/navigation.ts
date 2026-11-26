/**
 * The settings page's address-bar writes (`?settings=`, `?provider=`). They are not the open chat: the machine keeps
 * no copy of either, so they stay plain functions (docs/plans/web-client/web-shell-decomposition-part2.md, section
 * 5.4). The open chat's writes are in chat-navigation.ts. No React here.
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
