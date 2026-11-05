/**
 * The menus' effect host (legacy app.tsx `controller.setIntentHost`), keyed by
 * intent type so each ported menu adds its own handler. Settings changes run
 * through the session's native commands (`/settings`, `/effort`,
 * `/auto-approve`), which own the receipt semantics; legacy wrote the
 * settings service directly (settings-intent-host.ts), which the TUI cannot.
 */
import type { CommandResult, MenuSettingsService } from '../integration.js';
import type { DomainIntent, IntentHost, IntentRequest, IntentResult } from './menu-types.js';
import { getSettingLabel } from './settings-lib.js';

export type IntentHandlers = {
  readonly [K in DomainIntent['type']]?: (
    request: IntentRequest & { intent: Extract<DomainIntent, { type: K }> },
  ) => Promise<IntentResult | void> | IntentResult | void;
};

export function createIntentHost(handlers: IntentHandlers): IntentHost {
  return ({ intentRequest }) => {
    const handler = handlers[intentRequest.intent.type] as
      | ((request: IntentRequest) => Promise<IntentResult | void> | IntentResult | void)
      | undefined;
    return handler?.(intentRequest);
  };
}

const valueText = (value: unknown): string =>
  typeof value === 'string'
    ? value
    : value !== null && typeof value === 'object'
    ? JSON.stringify(value)
    : String(value);

/** The native command that sets a key; the session refuses model/effort/approval through `/settings`. */
function setCommand(key: string, value: unknown): string {
  if (key === 'agent.modelSelection' && value && typeof value === 'object') {
    const { model, provider } = value as { model?: string; provider?: string | null };
    return `/model ${model ?? ''}${provider ? ` --provider=${provider}` : ''}`;
  }
  if (key === 'agent.reasoningEffort') return `/effort ${valueText(value)}`;
  if (key === 'shell.autoApproveMode') return `/auto-approve ${valueText(value)}`;
  return `/settings ${key} ${valueText(value)}`;
}

/** apply-settings / reset-setting, replacing legacy handleSettingsIntent. */
export function settingsIntentHandlers(options: {
  readonly command: (text: string) => Promise<CommandResult>;
  readonly settings: () => MenuSettingsService;
  readonly notice: (text: string) => void;
}): IntentHandlers {
  const { command, settings, notice } = options;
  const run = async (request: IntentRequest, key: string, text: string, done?: string): Promise<IntentResult> => {
    const { id, sourceFrameId } = request;
    try {
      const result = await command(text);
      if (!result.applied) {
        const message = result.message ?? 'The setting did not change.';
        return { id, sourceFrameId, ok: false, message, fieldErrors: { [key]: message } };
      }
      // Legacy applied runtime changes silently and named only an unsaved one.
      if (result.message?.includes('Could not save')) notice(result.message);
      else if (done) notice(done);
      return { id, sourceFrameId, ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { id, sourceFrameId, ok: false, message, fieldErrors: { [key]: message } };
    }
  };
  return {
    'apply-settings': async (request) => {
      for (const change of request.intent.changes) {
        const result = await run(request, change.key, setCommand(change.key, change.value));
        if (!result.ok) return result;
      }
      return { id: request.id, sourceFrameId: request.sourceFrameId, ok: true };
    },
    'reset-setting': (request) => {
      const { key } = request.intent;
      const done = `Reset ${getSettingLabel(key)} to default`;
      if (key === 'agent.reasoningEffort' || key === 'shell.autoApproveMode')
        return run(request, key, setCommand(key, settings().getDefault(key)), done);
      return run(request, key, `/settings reset ${key}`, done);
    },
  };
}

/** Legacy app.tsx's intent host: a saved model selection finishes first-run setup. */
export function withFirstRunCompletion(handlers: IntentHandlers, complete: () => void): IntentHandlers {
  const apply = handlers['apply-settings'];
  if (!apply) return handlers;
  return {
    ...handlers,
    'apply-settings': async (request) => {
      const result = await apply(request);
      if (result?.ok && request.intent.changes.some((change) => change.key === 'agent.modelSelection')) complete();
      return result;
    },
  };
}
