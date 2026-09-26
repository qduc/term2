import type { ISettingsService } from '../service-interfaces.js';
import type { SubagentDefinition, SupportedSubagentRole } from './types.js';
import { getAncillaryTierForRole, getSubagentPoolSettingKeyForRole } from './subagent-pool-config.js';
import { resolveTierProvider, toTierModelPoolEntries } from '../agent-runtime/model-resolver.js';

/**
 * Session-scoped round-robin cursor over each role's tier model pool (the
 * role's `agent.<tier>Model` setting), one cursor per role.
 * `resolveForSpawn` reads the pool live from settings and, when it is
 * non-empty, advances that role's cursor by exactly one and returns a
 * definition with the picked model applied. An entry that pins a provider
 * runs there; a bare entry runs on the tier's provider. Reasoning effort
 * already resolves through the same tier in `loadRoleDefinition` and is left
 * untouched. An empty or unconfigured pool returns `definition` unchanged and
 * never touches the cursor.
 *
 * Call this exactly once per spawn and thread the result everywhere that
 * spawn's model is needed (execution, status display, tool construction).
 * Calling it more than once per spawn — e.g. once for display and again for
 * execution — silently advances the cursor twice and desyncs what a run is
 * reported to use from what it actually runs on. Tier resolution outside
 * this selector (`resolveAncillaryModelTier`) deliberately picks the first
 * entry so display and one-shot consumers stay stable.
 */
export class SubagentRolePoolSelector {
  #cursors = new Map<string, number>();

  constructor(private readonly settings: ISettingsService) {}

  resolveForSpawn(role: SupportedSubagentRole, definition: SubagentDefinition): SubagentDefinition {
    // Mentor fans a question out across every `agent.mentorPool` entry
    // (MentorRunner); it never round-robins, so this selector must not touch
    // it even though the settings UI keys mentor to the same pool-editor
    // config.
    if (role === 'mentor') return definition;
    const settingKey = getSubagentPoolSettingKeyForRole(role);
    if (!settingKey) return definition;
    const entries = toTierModelPoolEntries(this.settings.getDynamic(settingKey));
    if (entries.length === 0) return definition;

    const cursor = this.#cursors.get(role) ?? 0;
    const entry = entries[cursor % entries.length]!;
    this.#cursors.set(role, cursor + 1);

    // loadRoleDefinition pairs the definition with the first entry, so its
    // provider is the tier's only when that entry is bare.
    const tierProvider =
      entries[0]!.provider === undefined
        ? definition.provider
        : resolveTierProvider(getAncillaryTierForRole(role), this.settings);
    return { ...definition, model: entry.model, provider: entry.provider ?? tierProvider };
  }

  /** True when the role has a configured, non-empty pool right now. */
  hasPool(role: SupportedSubagentRole): boolean {
    if (role === 'mentor') return false;
    const settingKey = getSubagentPoolSettingKeyForRole(role);
    if (!settingKey) return false;
    return toTierModelPoolEntries(this.settings.getDynamic(settingKey)).length > 0;
  }
}
