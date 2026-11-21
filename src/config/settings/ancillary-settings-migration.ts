import { type SettingsData } from './settings-schema.js';

type Migration = {
  target: string;
  legacy: string[];
  /**
   * Legacy values that only record an old default. Settings files store every value, defaults included,
   * so carrying one of these over would keep the old default in force instead of the target's new one.
   */
  ignoredLegacyValues?: unknown[];
};

const MIGRATIONS: Migration[] = [
  { target: 'agent.smartReasoningEffort', legacy: ['agent.mentorReasoningEffort'] },
  { target: 'agent.balancedReasoningEffort', legacy: ['agent.subagentWorkerReasoningEffort'] },
  {
    target: 'agent.cheapReasoningEffort',
    legacy: ['agent.subagentExplorerReasoningEffort', 'agent.subagentLibrarianReasoningEffort'],
  },
  { target: 'agent.decisionModel', legacy: ['agent.decisionShadowModel', 'agent.autoApproveDecisionShadowModel'] },
  // The limit now bounds every tool result, not only shell output, and its default fell from 40,000 to 20,000.
  { target: 'tools.maxOutputChars', legacy: ['shell.maxOutputChars'], ignoredLegacyValues: [40000] },
];

function getOwnValue(object: unknown, path: string): { found: boolean; value?: unknown } {
  let current = object;
  for (const segment of path.split('.')) {
    if (current == null || typeof current !== 'object' || !Object.hasOwn(current, segment)) {
      return { found: false };
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return { found: true, value: current };
}

function setValue(object: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.');
  let current = object;
  for (const segment of segments.slice(0, -1)) {
    const child = current[segment];
    if (child == null || typeof child !== 'object' || Array.isArray(child)) {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }
  current[segments.at(-1)!] = value;
}

export function migrateLegacyAncillarySettings(
  config: Partial<SettingsData>,
  rawConfig: unknown,
): { config: Partial<SettingsData>; migrated: boolean } {
  const migratedConfig = structuredClone(config) as Record<string, unknown>;
  let migrated = false;

  for (const migration of MIGRATIONS) {
    if (getOwnValue(rawConfig, migration.target).found) continue;

    const legacyValue = migration.legacy
      .map((path) => ({ ...getOwnValue(rawConfig, path), path }))
      .find(
        (candidate) =>
          candidate.found &&
          candidate.value !== undefined &&
          candidate.value !== null &&
          !migration.ignoredLegacyValues?.includes(candidate.value),
      );
    if (!legacyValue) continue;

    setValue(migratedConfig, migration.target, legacyValue.value);
    migrated = true;
  }

  return { config: migratedConfig as Partial<SettingsData>, migrated };
}
