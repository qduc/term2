const MIGRATIONS = [
    { target: 'agent.smartReasoningEffort', legacy: ['agent.mentorReasoningEffort'] },
    { target: 'agent.balancedReasoningEffort', legacy: ['agent.subagentWorkerReasoningEffort'] },
    {
        target: 'agent.cheapReasoningEffort',
        legacy: ['agent.subagentExplorerReasoningEffort', 'agent.subagentLibrarianReasoningEffort'],
    },
    { target: 'agent.decisionModel', legacy: ['agent.decisionShadowModel', 'agent.autoApproveDecisionShadowModel'] },
];
function getOwnValue(object, path) {
    let current = object;
    for (const segment of path.split('.')) {
        if (current == null || typeof current !== 'object' || !Object.hasOwn(current, segment)) {
            return { found: false };
        }
        current = current[segment];
    }
    return { found: true, value: current };
}
function setValue(object, path, value) {
    const segments = path.split('.');
    let current = object;
    for (const segment of segments.slice(0, -1)) {
        const child = current[segment];
        if (child == null || typeof child !== 'object' || Array.isArray(child)) {
            current[segment] = {};
        }
        current = current[segment];
    }
    current[segments.at(-1)] = value;
}
export function migrateLegacyAncillarySettings(config, rawConfig) {
    const migratedConfig = structuredClone(config);
    let migrated = false;
    for (const migration of MIGRATIONS) {
        if (getOwnValue(rawConfig, migration.target).found)
            continue;
        const legacyValue = migration.legacy
            .map((path) => ({ ...getOwnValue(rawConfig, path), path }))
            .find((candidate) => candidate.found && candidate.value !== undefined && candidate.value !== null);
        if (!legacyValue)
            continue;
        setValue(migratedConfig, migration.target, legacyValue.value);
        migrated = true;
    }
    return { config: migratedConfig, migrated };
}
//# sourceMappingURL=ancillary-settings-migration.js.map