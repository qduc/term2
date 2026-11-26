/**
 * The writes that put the open chat into the address bar. The address bar owns which chat is open: these change it
 * and the page reports the change back as `URL_CHANGED` (lib/term2/shell-machine.ts). Only the shell's command
 * runner (lib/term2/shell/shell-commands.ts) imports this, so every change of chat is a machine transition first
 * (rule web-chat-navigation, scripts/gates/web-shell-rules.mjs). No React here.
 */

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

/** Drops the chat from the address bar without a history entry or a popstate (another user signed in). */
export function forgetChatSilently(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has('agentSession')) return;
  url.searchParams.delete('agentSession');
  window.history.replaceState(null, '', url.toString());
}
