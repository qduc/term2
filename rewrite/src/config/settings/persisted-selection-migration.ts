import deepEqual from 'fast-deep-equal';
import { z } from 'zod';
import { ModelSelectionSchema } from './model-selection.js';

type RecordValue = Record<string, unknown>;
const isRecord = (value: unknown): value is RecordValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const providerSchema = z.string().trim().min(1);
const roles = [
  'efficient',
  'capable',
  'mentor',
  'subagentExplorer',
  'subagentWorker',
  'subagentLibrarian',
  'autoApprove',
];
const tiers = ['smart', 'balanced', 'cheap', 'chore'];

/** File-only compatibility. Runtime writes must continue to use the strict schema.
 * Bind each legacy model to its own provider before applying historical role
 * precedence. Validate even superseded legacy values before removing them.
 */
export function migratePersistedSelections(raw: unknown): { value: unknown; migrated: boolean } {
  if (!isRecord(raw)) return { value: raw, migrated: false };
  const value = structuredClone(raw);
  const agent = isRecord(value.agent) ? value.agent : {};
  const tools = isRecord(value.tools) ? value.tools : {};
  const parentProvider = Object.hasOwn(agent, 'provider')
    ? providerSchema.parse(agent.provider)
    : isRecord(agent.modelSelection) && Object.hasOwn(agent.modelSelection, 'provider')
    ? providerSchema.parse(agent.modelSelection.provider)
    : 'openai';
  if (Object.hasOwn(agent, 'model')) providerSchema.parse(agent.model);
  if (!Object.hasOwn(agent, 'modelSelection') && (Object.hasOwn(agent, 'model') || Object.hasOwn(agent, 'provider'))) {
    agent.modelSelection = ModelSelectionSchema.parse({
      model: Object.hasOwn(agent, 'model') ? agent.model : 'gpt-5.1',
      provider: parentProvider,
    });
  }
  const providerFor = (section: RecordValue, role: string): string =>
    Object.hasOwn(section, `${role}Provider`) ? providerSchema.parse(section[`${role}Provider`]) : parentProvider;
  const bind = (entry: unknown, provider: string): unknown => {
    if (typeof entry === 'string') return { model: entry, provider };
    if (isRecord(entry) && !Object.hasOwn(entry, 'provider')) return { ...entry, provider };
    return entry;
  };
  const selections: RecordValue = {};
  for (const role of roles) {
    const provider = providerFor(agent, role);
    const key = `${role}Model`;
    if (!Object.hasOwn(agent, key)) continue;
    // The old mentor scalar used an empty string to disable consultation.
    if (role === 'mentor' && agent[key] === '') continue;
    selections[role] = ModelSelectionSchema.parse(
      typeof agent[key] === 'string' ? bind(agent[key], provider) : agent[key],
    );
  }
  const healingProvider = providerFor(tools, 'editHealing');
  if (Object.hasOwn(tools, 'editHealingModel')) {
    selections.editHealing = ModelSelectionSchema.parse(
      typeof tools.editHealingModel === 'string'
        ? bind(tools.editHealingModel, healingProvider)
        : tools.editHealingModel,
    );
  }
  for (const tier of tiers) {
    const provider = providerFor(agent, tier);
    const key = `${tier}Model`;
    if (Object.hasOwn(agent, key)) {
      const pool = agent[key];
      agent[key] = (Array.isArray(pool) ? pool : [pool]).map((entry) => bind(entry, provider));
    }
  }
  const aliases: Record<string, string[]> = {
    smart: ['capable', 'mentor'],
    balanced: ['subagentWorker'],
    cheap: ['efficient', 'subagentExplorer', 'subagentLibrarian'],
    chore: ['autoApprove', 'editHealing'],
  };
  for (const [tier, candidates] of Object.entries(aliases)) {
    if (Object.hasOwn(agent, `${tier}Model`)) continue;
    const winner = candidates.find((role) => Object.hasOwn(selections, role));
    if (winner) agent[`${tier}Model`] = [selections[winner]];
  }
  if (Object.hasOwn(agent, 'mentorPool')) {
    if (Array.isArray(agent.mentorPool)) {
      agent.mentorPool = agent.mentorPool.map((entry) => bind(entry, providerFor(agent, 'mentor')));
    }
  } else if (selections.mentor) {
    agent.mentorPool = [selections.mentor];
  }
  for (const role of [...roles, ...tiers]) {
    if (roles.includes(role)) delete agent[`${role}Model`];
    delete agent[`${role}Provider`];
  }
  delete agent.model;
  delete agent.provider;
  delete tools.editHealingModel;
  delete tools.editHealingProvider;
  // Do not repair malformed section containers by replacing them with objects.
  if (isRecord(value.agent)) value.agent = agent;
  else if (!Object.hasOwn(value, 'agent') && Object.keys(agent).length) value.agent = agent;
  return { value, migrated: !deepEqual(raw, value) };
}
