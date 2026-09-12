import type { ISettingsService } from '../service-interfaces.js';
import type { SubagentDefinition, SupportedSubagentRole } from './types.js';
import { getSubagentPoolSettingKeyForRole } from './subagent-pool-config.js';

export type SubagentPoolEntry = {
  model: string;
  provider?: string;
  reasoningEffort?: string;
};

/**
 * Session-scoped round-robin cursor over each role's model pool
 * (`agent.subagent<Role>Pool`), one cursor per role. `resolveForSpawn` reads
 * the pool live from settings and, when it is non-empty, advances that
 * role's cursor by exactly one and returns a definition with the picked
 * entry's model applied (`provider`/`reasoningEffort` fall back to the base
 * definition's when the entry omits them). An empty or unconfigured pool
 * returns `definition` unchanged and never touches the cursor.
 *
 * Call this exactly once per spawn and thread the result everywhere that
 * spawn's model is needed (execution, status display, tool construction).
 * Calling it more than once per spawn — e.g. once for display and again for
 * execution — silently advances the cursor twice and desyncs what a run is
 * reported to use from what it actually runs on.
 */
export class SubagentRolePoolSelector {
  #cursors = new Map<string, number>();

  constructor(private readonly settings: ISettingsService) {}

  resolveForSpawn(role: SupportedSubagentRole, definition: SubagentDefinition): SubagentDefinition {
    // Mentor fans a question out across every pool entry (MentorRunner); it
    // never round-robins, so this selector must not touch it even though the
    // settings UI keys mentor to the same pool-editor config.
    if (role === 'mentor') return definition;
    const settingKey = getSubagentPoolSettingKeyForRole(role);
    if (!settingKey) return definition;
    const pool = this.settings.getDynamic(settingKey) as SubagentPoolEntry[] | undefined;
    if (!Array.isArray(pool) || pool.length === 0) return definition;

    const cursor = this.#cursors.get(role) ?? 0;
    const entry = pool[cursor % pool.length]!;
    this.#cursors.set(role, cursor + 1);

    return {
      ...definition,
      model: entry.model,
      provider: entry.provider ?? definition.provider,
      reasoningEffort: (entry.reasoningEffort ?? definition.reasoningEffort) as SubagentDefinition['reasoningEffort'],
    };
  }

  /** True when the role has a configured, non-empty pool right now. */
  hasPool(role: SupportedSubagentRole): boolean {
    if (role === 'mentor') return false;
    const settingKey = getSubagentPoolSettingKeyForRole(role);
    if (!settingKey) return false;
    const pool = this.settings.getDynamic(settingKey) as SubagentPoolEntry[] | undefined;
    return Array.isArray(pool) && pool.length > 0;
  }
}
