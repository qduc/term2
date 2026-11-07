/**
 * `/settings`, the mode commands, `/sandbox` and `/auto-approve`. They all write
 * the session's own settings, which save through the app's settings owner what legacy saves. A session's tools read a copy of those once it has
 * been reconfigured, so a change only counts once the Session has rebuilt them:
 * its receipt says whether that happened, and these commands report that receipt
 * rather than the write. Approval mode and sandbox preference also save through
 * the app's global settings owner after application, as their source commands do.
 * Saving a sandbox preference does not add
 * sandbox execution support to the direct executable.
 */
import { isDroppedProfile } from './dropped-profiles.js';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { resolveProfile } from '../config/profiles/resolver.js';
import {
  BARE_PROFILE_ID,
  isLegacyModeSettingKey,
  profileIdFromLegacyModeSetting,
} from '../config/profiles/legacy-adapter.js';
import { SETTING_KEYS } from '../config/settings/settings-schema.js';
import { CATEGORY_KEYS, HIDDEN_SETTINGS, SETTINGS_CATEGORIES } from './settings-completion-config.js';
import { getSettingMetadata } from '../config/settings/settings-ui-metadata.js';
import { createSettingsCommand, parseSettingValue } from './settings-command.js';
import { receiptNotice, sendNativeCommand } from '../clients/tui/commands.js';
import type { TuiConnection, TuiIntegration } from '../clients/tui/integration.js';
import type { WireConfigureRequest, WireSnapshot } from '../protocol/wire.js';
import type { DirectApplication } from './application.js';

type CommandResult = Awaited<ReturnType<TuiIntegration['command']>>;

/** Compact pages avoid overflowing the unscrollable command-notice region. */
function settingsBrowse(
  category: string | undefined,
  pageText: string | undefined,
  read: (key: string) => unknown,
): string {
  if (!category) {
    return [
      'Settings: models · providers · context · safety · tools · ui · hooks',
      'Browse: /settings <category> [page]   Read: /settings <key>',
      'Change: /settings <key> <value>   Reset: /settings reset <key>',
      'Changes apply to this session; settings requiring restart are not changed here.',
    ].join('\n');
  }
  const group = SETTINGS_CATEGORIES.find((entry) => entry.id === category)!;
  const keys = (CATEGORY_KEYS[category] ?? []).filter((key) => !HIDDEN_SETTINGS.has(key));
  const pages = Math.max(1, Math.ceil(keys.length / 3));
  const page = pageText === undefined ? 1 : Number(pageText);
  if (!Number.isInteger(page) || page < 1 || page > pages) return `Use /settings ${category} <page> (1–${pages}).`;
  const rows = keys.slice((page - 1) * 3, page * 3).map((key) => {
    const metadata = getSettingMetadata(key);
    const raw = metadata?.isSecret ? '[hidden]' : JSON.stringify(read(key)) ?? 'unset';
    const value = raw.length > 64 ? `${raw.slice(0, 61)}...` : raw;
    return `${key}: ${value}\n  ${metadata?.description ?? metadata?.label ?? key}`;
  });
  return [
    `${group.label} settings (${page}/${pages}) · /settings ${category} <page>`,
    ...rows,
    'Read: /settings <key>  ·  Change: /settings <key> <value>',
  ].join('\n');
}

// Legacy source/commands/mode-commands.ts and use-app-commands.ts (React modules, so copied, not imported).
const APPROVAL_MODES = ['off', 'advisory', 'auto', 'always'];
const PROFILE_KEY = 'app.activeProfileId';

/** Hidden compatibility inputs can only acknowledge the default experience. */
function acknowledgeProfile(id: string = BARE_PROFILE_ID): CommandResult {
  const target = id.includes(':') ? id : `builtin:${id}`;
  if (isDroppedProfile(target)) throw new Error(`Missing parent or Profile '${target}'`);
  if (resolveProfile(target).identity.id !== BARE_PROFILE_ID) throw new Error(`Profile '${target}' is not selectable.`);
  return { applied: true, message: 'The default experience is already active.' };
}
/** The Session owns these, so a value the settings command saved is also sent to it. */
const SELECTION_KEYS = new Set(['agent.modelSelection', 'agent.reasoningEffort']);

export function createDirectTuiSettings(app: DirectApplication, latest: () => WireSnapshot) {
  const detailsOf = (sessionId: string) => {
    const { settings, rebuilt } = app.sessionDetails(sessionId);
    if (!settings) throw new Error('This session has no live runtime.');
    return { settings, rebuilt };
  };

  /** One keyed command, sent once. Sending the current model changes nothing but the tool graph. */
  const rebuild = async (
    connection: TuiConnection,
    undo: () => void,
    done: string,
    applied?: () => CommandResult,
  ): Promise<CommandResult> => {
    const command = { type: 'configure', commandId: randomUUID(), configuration: { model: latest().model } } as const;
    const result = await sendNativeCommand(connection, command);
    if (result.kind === 'finished' && result.receipt.outcome?.kind === 'configured')
      return applied ? applied() : { message: done, applied: true };
    // Refused outright, so it must not arrive with some later rebuild. Anything less
    // certain stays written: the Session may well have installed it.
    if (result.kind === 'rejected' || result.kind === 'error') {
      undo();
      throw new Error(receiptNotice(result));
    }
    return { message: receiptNotice(result) };
  };

  /** Most tool gates read settings as they run, so only a reconfigured session has to wait for a rebuild. */
  const write = async (
    connection: TuiConnection,
    apply: () => void,
    undo: () => void,
    done: string,
    key: 'shell.autoApproveMode' | 'sandbox.enabled',
  ): Promise<CommandResult> => {
    apply();
    const save = (): CommandResult => {
      const result = app.saveApprovalPreference(connection.sessionId, key);
      return {
        message: result.status === 'saved' ? done : `${done} Could not save preference (${result.reason}).`,
        applied: true,
      };
    };
    return detailsOf(connection.sessionId).rebuilt ? rebuild(connection, undo, done, save) : save();
  };

  return {
    /** Exact, unadvertised aliases retained for existing typed commands. */
    profile(_connection: TuiConnection, id?: string): Promise<CommandResult> {
      return Promise.resolve(acknowledgeProfile(id));
    },

    async settings(connection: TuiConnection, args: string): Promise<CommandResult> {
      const { settings } = detailsOf(connection.sessionId);
      const [first, ...rest] = args.split(/\s+/).filter(Boolean);
      if (!first) return { message: settingsBrowse(undefined, undefined, (key) => settings.getDynamic(key)) };
      if (SETTINGS_CATEGORIES.some((category) => category.id === first)) {
        if (rest.length > 1) return { message: `Use /settings ${first} [page].` };
        return { message: settingsBrowse(first, rest[0], (key) => settings.getDynamic(key)) };
      }
      const isReset = first === 'reset';
      const key = isReset ? rest[0] : first;
      if (!key) throw new Error('Use /settings reset <key>.');

      const messages: string[] = [];
      const command = createSettingsCommand({
        settingsService: settings,
        addSystemMessage: (message) => messages.push(message),
        replaceInput: () => undefined,
      });
      // Reading a value changes nothing, so the source command answers it as it does today.
      if (!isReset && rest.length === 0) {
        command.action(args);
        return { message: messages.join('\n') };
      }

      if (key === PROFILE_KEY || isLegacyModeSettingKey(key)) {
        const current = String(settings.get(PROFILE_KEY));
        const raw = rest.join(' ');
        const targetId =
          key === PROFILE_KEY
            ? isReset
              ? BARE_PROFILE_ID
              : raw
            : profileIdFromLegacyModeSetting(key, isReset ? false : parseSettingValue(raw), current);
        if (!targetId) return { message: `${key} does not name a profile here.` };
        return acknowledgeProfile(targetId);
      }
      if (SELECTION_KEYS.has(key)) {
        // Legacy's settings command parses, saves and words it; the Session then switches to the saved value.
        const before = settings.getDynamic(key);
        command.action(args);
        const after = settings.getDynamic(key);
        if (isDeepStrictEqual(before, after)) {
          const refused = messages.some((message) => message.startsWith('Error'));
          return { message: messages.join('\n'), ...(refused ? {} : { applied: true }) };
        }
        const selection = after as { readonly provider: string; readonly model: string };
        const configuration: WireConfigureRequest =
          key === 'agent.modelSelection'
            ? { model: { provider: selection.provider, model: selection.model } }
            : { reasoning: after as NonNullable<WireConfigureRequest['reasoning']> };
        const result = await sendNativeCommand(connection, {
          type: 'configure',
          commandId: randomUUID(),
          configuration,
        });
        if (result.kind === 'finished' && result.receipt.outcome?.kind === 'configured')
          return { message: messages.join('\n'), applied: true };
        if (result.kind === 'rejected' || result.kind === 'error') {
          if (before === undefined) settings.reset(key);
          else settings.setDynamic(key, before);
          throw new Error(receiptNotice(result));
        }
        return { message: receiptNotice(result) };
      }
      if (key === SETTING_KEYS.AGENT_TEMPERATURE) {
        if (isReset) return { message: `${key} cannot be cleared on a running session.` };
        const temperature = Number(rest[0]);
        if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
          return { message: `Error: ${key} must be a number between 0 and 2` };
        }
        const configure = { type: 'configure', commandId: randomUUID(), configuration: { temperature } } as const;
        const result = await sendNativeCommand(connection, configure);
        const applied = result.kind === 'finished' && result.receipt.outcome?.kind === 'configured';
        return { message: receiptNotice(result), ...(applied ? { applied } : {}) };
      }
      // Legacy saves a restart-only key (and the hook trust roots) for the next start and says so.
      if (!settings.isRuntimeModifiable(key) || key === SETTING_KEYS.HOOKS_TRUSTED_PROJECT_ROOTS) {
        command.action(args);
        return { message: messages.join('\n'), applied: true };
      }

      const before = settings.getDynamic(key);
      command.action(args);
      if (isDeepStrictEqual(before, settings.getDynamic(key))) {
        // The command refused the value and said why; otherwise the value was already set, which legacy's
        // menus save as a no-op (a pool saved unchanged closes back to the list).
        const refused = messages.some((message) => message.startsWith('Error'));
        return { message: messages.join('\n'), ...(refused ? {} : { applied: true }) };
      }
      // The command saved the value as legacy does; a refused rebuild takes it back on disk as well.
      const undo = () => {
        if (before === undefined) settings.reset(key);
        else settings.setDynamic(key, before);
      };
      return rebuild(connection, undo, messages.join('\n'));
    },

    sandbox(connection: TuiConnection): Promise<CommandResult> {
      const { settings } = detailsOf(connection.sessionId);
      const enabled = settings.get('sandbox.enabled') !== true;
      return write(
        connection,
        () => settings.set('sandbox.enabled', enabled, { persist: false }),
        () => settings.set('sandbox.enabled', !enabled, { persist: false }),
        `Shell sandbox mode ${
          enabled ? 'enabled' : 'disabled'
        } (preference only; direct sandbox execution is unavailable).`,
        'sandbox.enabled',
      );
    },

    autoApprove(connection: TuiConnection, mode: string | undefined): Promise<CommandResult> {
      if (!mode)
        return Promise.resolve({
          message: `Tool auto-approval is ${detailsOf(connection.sessionId).settings.get(
            'shell.autoApproveMode',
          )}. Use /auto-approve <mode>: ${APPROVAL_MODES.join(', ')}.`,
        });
      const { settings } = detailsOf(connection.sessionId);
      const previous = settings.get('shell.autoApproveMode');
      if (!APPROVAL_MODES.includes(mode)) throw new Error(`Use /auto-approve ${APPROVAL_MODES.join('|')}.`);
      return write(
        connection,
        () => settings.set('shell.autoApproveMode', mode as never, { persist: false }),
        () => settings.set('shell.autoApproveMode', previous, { persist: false }),
        `Tool auto-approval set to ${mode}.`,
        'shell.autoApproveMode',
      );
    },
  };
}
