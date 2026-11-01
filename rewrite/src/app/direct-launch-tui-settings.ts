/**
 * `/settings`, the mode commands, `/sandbox` and `/auto-approve`. They all write
 * the session's own settings. A session's tools read a copy of those once it has
 * been reconfigured, so a change only counts once the Session has rebuilt them:
 * its receipt says whether that happened, and these commands report that receipt
 * rather than the write. Nothing here reaches settings.json, which the old CLI
 * still owns, so every change lasts for this session only.
 */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { resolveActiveProfile } from '../../../source/services/profiles/active-profile.js';
import {
  BARE_PROFILE_ID,
  isLegacyModeSettingKey,
  profileIdFromLegacyModeSetting,
} from '../../../source/services/profiles/legacy-adapter.js';
import { planProfileTransition } from '../../../source/services/profiles/profile-transition.js';
import { ProfileResolutionError } from '../../../source/services/profiles/types.js';
import { SETTING_KEYS } from '../../../source/services/settings/settings-service.js';
import {
  createSettingsCommand,
  formatSettingsSummary,
  parseSettingValue,
} from '../../../source/utils/settings-command.js';
import { receiptNotice, sendNativeCommand } from '../clients/tui/commands.js';
import type { TuiConnection, TuiIntegration } from '../clients/tui/integration.js';
import type { WireSnapshot } from '../protocol/direct-wire.js';
import type { DirectApplication } from './direct-application.js';

type CommandResult = Awaited<ReturnType<TuiIntegration['command']>>;

const APPROVAL_MODES = ['off', 'advisory', 'auto', 'always'];
const PROFILE_KEY = 'app.activeProfileId';
/** Only the Session can change these, with `/model` and `/effort`. */
const SELECTION_COMMANDS: Readonly<Record<string, string>> = {
  'agent.modelSelection': 'Use /model <provider>/<model>.',
  'agent.reasoningEffort': 'Use /effort <level>.',
};

export function createDirectTuiSettings(app: DirectApplication, latest: () => WireSnapshot) {
  const detailsOf = (sessionId: string) => {
    const { settings, rebuilt } = app.sessionDetails(sessionId);
    if (!settings) throw new Error('This session has no live runtime.');
    return { settings, rebuilt };
  };

  /** One keyed command, sent once. Sending the current model changes nothing but the tool graph. */
  const rebuild = async (connection: TuiConnection, undo: () => void, done: string): Promise<CommandResult> => {
    const command = { type: 'configure', commandId: randomUUID(), configuration: { model: latest().model } } as const;
    const result = await sendNativeCommand(connection, command);
    if (result.kind === 'finished' && result.receipt.outcome?.kind === 'configured') return { message: done };
    // Refused outright, so it must not arrive with some later rebuild. Anything less
    // certain stays written: the Session may well have installed it.
    if (result.kind === 'rejected' || result.kind === 'error') undo();
    return { message: receiptNotice(result) };
  };

  const switchProfile = async (connection: TuiConnection, targetId: string, retry: string): Promise<CommandResult> => {
    const { settings } = detailsOf(connection.sessionId);
    let plan: ReturnType<typeof planProfileTransition>;
    try {
      plan = planProfileTransition(settings, targetId);
    } catch (error) {
      if (error instanceof ProfileResolutionError) return { message: error.message };
      throw error;
    }
    if (plan.class === 'noop') return { message: `${plan.targetId} is already active.` };
    if (plan.class === 'structural' && latest().messages.length > 0) {
      return {
        message: `Cannot switch modes mid-session (tool/context mismatch). Use \`/clear\` first, then \`${retry}\`.`,
      };
    }
    const previous = settings.get(PROFILE_KEY);
    settings.set(PROFILE_KEY, plan.targetId, { persist: false });
    const undo = () => settings.set(PROFILE_KEY, previous, { persist: false });
    return rebuild(connection, undo, `Switched to ${plan.targetId} for this session.`);
  };

  /** Most tool gates read settings as they run, so only a reconfigured session has to wait for a rebuild. */
  const write = async (
    connection: TuiConnection,
    apply: () => void,
    undo: () => void,
    done: string,
  ): Promise<CommandResult> => {
    apply();
    return detailsOf(connection.sessionId).rebuilt ? rebuild(connection, undo, done) : { message: done };
  };

  return {
    /** `/plan`, `/bare`, `/mentor` and `/orchestrator`. A mode that is on turns back to Bare. */
    toggle(connection: TuiConnection, mode: string): Promise<CommandResult> {
      const { settings } = detailsOf(connection.sessionId);
      const target = `builtin:${mode}`;
      const on = resolveActiveProfile(settings).identity.id === target;
      return switchProfile(connection, on ? BARE_PROFILE_ID : target, `/${mode}`);
    },

    profile(connection: TuiConnection, id: string | undefined): Promise<CommandResult> {
      if (!id) throw new Error('Use /profile <id>.');
      return switchProfile(connection, id.includes(':') ? id : `builtin:${id}`, `/profile ${id}`);
    },

    async settings(connection: TuiConnection, args: string): Promise<CommandResult> {
      const { settings } = detailsOf(connection.sessionId);
      const [first, ...rest] = args.split(/\s+/).filter(Boolean);
      if (!first) return { message: formatSettingsSummary(settings.getAll()) };
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
        return switchProfile(
          connection,
          targetId.includes(':') ? targetId : `builtin:${targetId}`,
          `/settings ${args}`,
        );
      }
      const selection = SELECTION_COMMANDS[key];
      if (selection) return { message: selection };
      if (key === SETTING_KEYS.AGENT_TEMPERATURE) {
        if (isReset) return { message: `${key} cannot be cleared on a running session.` };
        const temperature = Number(rest[0]);
        if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
          return { message: `Error: ${key} must be a number between 0 and 2` };
        }
        const configure = { type: 'configure', commandId: randomUUID(), configuration: { temperature } } as const;
        return { message: receiptNotice(await sendNativeCommand(connection, configure)) };
      }
      // The source would save these for the next start, which this executable never reads back.
      if (!settings.isRuntimeModifiable(key) || key === SETTING_KEYS.HOOKS_TRUSTED_PROJECT_ROOTS) {
        return {
          message: `${key} needs a restart and this executable does not save settings, so it cannot change here.`,
        };
      }

      const before = settings.getDynamic(key);
      command.action(args);
      // The command refused the value and said why.
      if (isDeepStrictEqual(before, settings.getDynamic(key))) return { message: messages.join('\n') };
      const undo = () => {
        if (before === undefined) settings.reset(key);
        else settings.setDynamic(key, before, { persist: false });
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
        `Shell sandbox ${enabled ? 'enabled' : 'disabled'} for this session.`,
      );
    },

    autoApprove(connection: TuiConnection, mode: string | undefined): Promise<CommandResult> {
      if (!mode || !APPROVAL_MODES.includes(mode)) throw new Error(`Use /auto-approve ${APPROVAL_MODES.join('|')}.`);
      const { settings } = detailsOf(connection.sessionId);
      const previous = settings.get('shell.autoApproveMode');
      return write(
        connection,
        () => settings.set('shell.autoApproveMode', mode as never, { persist: false }),
        () => settings.set('shell.autoApproveMode', previous, { persist: false }),
        `Tool auto-approval set to ${mode} for this session.`,
      );
    },
  };
}
