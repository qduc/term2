import { getSubagentPoolSettingKeyForRole } from './subagent-pool-config.js';
import { toTierModelPoolEntries } from '../agent-runtime/model-resolver.js';
export const POOL_ENTRY_COOLDOWN_MS = 10 * 60 * 1000;
const entryKey = (entry) => JSON.stringify([entry.provider, entry.model]);
/**
 * Session-scoped round-robin cursor over each role's tier model pool (the
 * role's `agent.<tier>Model` setting), one cursor per role.
 * `resolveForSpawn` reads the pool live from settings and, when it is
 * non-empty, advances that role's cursor by exactly one and returns a
 * definition with the picked provider/model pair applied. Reasoning effort
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
    settings;
    now;
    #cursors = new Map();
    #unhealthy = new Map();
    constructor(settings, now = Date.now) {
        this.settings = settings;
        this.now = now;
    }
    markUnhealthy(entry, failure) {
        this.#unhealthy.set(entryKey(entry), { until: this.now() + POOL_ENTRY_COOLDOWN_MS, failure });
    }
    resolveForSpawn(role, definition) {
        // Mentor fans a question out across every `agent.mentorPool` entry
        // (MentorRunner); it never round-robins, so this selector must not touch
        // it even though the settings UI keys mentor to the same pool-editor
        // config.
        if (role === 'mentor')
            return definition;
        const settingKey = getSubagentPoolSettingKeyForRole(role);
        if (!settingKey)
            return definition;
        const entries = toTierModelPoolEntries(this.settings.getDynamic(settingKey));
        if (entries.length === 0)
            return definition;
        const cursor = this.#cursors.get(role) ?? 0;
        const failures = [];
        for (let offset = 0; offset < entries.length; offset++) {
            const index = (cursor + offset) % entries.length;
            const entry = entries[index];
            const candidate = { ...definition, ...entry };
            const health = this.#unhealthy.get(entryKey(candidate));
            if (health && health.until > this.now()) {
                failures.push(`${candidate.provider}/${candidate.model}: ${health.failure}`);
                continue;
            }
            this.#cursors.set(role, index + 1);
            return candidate;
        }
        throw new Error(`No healthy model in ${settingKey} pool: ${failures.join('; ')}`);
    }
    /** True when the role has a configured, non-empty pool right now. */
    hasPool(role) {
        if (role === 'mentor')
            return false;
        const settingKey = getSubagentPoolSettingKeyForRole(role);
        if (!settingKey)
            return false;
        return toTierModelPoolEntries(this.settings.getDynamic(settingKey)).length > 0;
    }
}
//# sourceMappingURL=subagent-role-pool-selector.js.map