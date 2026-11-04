/**
 * Legacy app.tsx's intent host, for the intents the ported menus issue. Legacy
 * wrote settings through its settings service; next has no client-side
 * settings writer, so each change becomes the command a user would type and
 * the command's answer is the legacy system message.
 */
import type { IntentHost, IntentResult } from './menu-types.js';
import type { MenuActions } from './menu-services.js';

/** The typed command that applies one setting change. */
function settingCommand(key: string, value: unknown): string {
  if (key === 'agent.modelSelection' && value && typeof value === 'object') {
    const { model, provider } = value as { model?: string; provider?: string | null };
    return `/model ${model ?? ''}${provider ? ` --provider=${provider}` : ''}`;
  }
  return `/settings ${key} ${typeof value === 'string' ? value : JSON.stringify(value)}`;
}

export function menuIntentHost(latest: () => MenuActions): IntentHost {
  return async ({ intentRequest }): Promise<IntentResult | void> => {
    const actions = latest();
    const { id, sourceFrameId, intent } = intentRequest;
    if (intent.type === 'submit-prompt') {
      actions.runCommand(intent.text);
      return;
    }
    if (intent.type !== 'apply-settings') return;
    const fieldErrors: Record<string, string> = {};
    for (const change of intent.changes) {
      try {
        const { message } = await actions.command(settingCommand(change.key, change.value));
        // Legacy reported only changes that wait for a restart; a runtime change shows in place.
        if (message && change.persistence !== 'runtime') actions.notice(message);
      } catch (error) {
        fieldErrors[change.key] = error instanceof Error ? error.message : String(error);
      }
    }
    if (Object.keys(fieldErrors).length === 0) return { id, sourceFrameId, ok: true };
    return {
      id,
      sourceFrameId,
      ok: false,
      message: Object.values(fieldErrors).join(' '),
      fieldErrors,
    };
  };
}
