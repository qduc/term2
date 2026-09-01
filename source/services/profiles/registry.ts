import fs from 'node:fs';
import path from 'node:path';
import type {
  BlockKind,
  ContextBlock,
  EnforcementPolicyDefinition,
  IntegrationDefinition,
  InstructionsBlock,
  ProfileDefinition,
  ProfileRegistry,
  RegisteredBlock,
  ToolsBlock,
} from './types.js';

const prompt = (name: string): string =>
  fs.readFileSync(path.join(import.meta.dirname, '../../prompts', name), 'utf8').trim();

/** Stable source kinds owned by the application. Profile data cannot invent one. */
export const BUILTIN_CONTEXT_SOURCES = [
  'environment',
  'workspace',
  'project-instructions',
  'skills-catalog',
  'memory',
  'session-browser',
  'repository-guidance',
  'profile-document',
] as const;

export const BUILTIN_TOOL_CAPABILITIES = [
  'filesystem-read-workspace',
  'filesystem-read-external',
  'filesystem-write',
  'shell',
  'web',
  'memory',
  'sessions',
  'skills',
  'mentor',
  'subagents',
  'background-tasks',
  'user-interaction',
  'code-context',
] as const;

export const BUILTIN_ENFORCEMENT_POLICIES = [
  'builtin:enforcement/normal',
  'builtin:enforcement/plan-read-only',
] as const;

export const BUILTIN_INTEGRATIONS = [
  'builtin:integration/mentor',
  'builtin:integration/async-subagents',
  'builtin:integration/background-task-control',
] as const;

const standardContext: ContextBlock = {
  kind: 'context',
  sources: BUILTIN_CONTEXT_SOURCES.filter((source) => source !== 'profile-document').map((source) => ({
    id: source,
    source,
  })),
};
const liteContext: ContextBlock = {
  kind: 'context',
  sources: standardContext.sources.map((source) =>
    source.source === 'project-instructions' ? { ...source, enabled: false } : source,
  ),
};
const standardTools: ToolsBlock = { kind: 'tools', include: [...BUILTIN_TOOL_CAPABILITIES] };
const liteTools: ToolsBlock = {
  kind: 'tools',
  include: [...BUILTIN_TOOL_CAPABILITIES],
  exclude: ['mentor', 'subagents'],
};

const builtinInstructionBlock = (id: string, entry: InstructionsBlock): RegisteredBlock => ({
  id,
  kind: 'instructions',
  definition: entry,
});

export const builtinBlocks: readonly RegisteredBlock[] = [
  builtinInstructionBlock('builtin:instructions/lite', {
    kind: 'instructions',
    identity: { content: prompt('lite.md') },
  }),
  builtinInstructionBlock('builtin:instructions/plan', {
    kind: 'instructions',
    workflow: { content: prompt('plan-mode-info.md') },
  }),
  builtinInstructionBlock('builtin:instructions/mentor', {
    kind: 'instructions',
    workflow: { content: prompt('mentor-addon.md') },
  }),
  builtinInstructionBlock('builtin:instructions/orchestrator', {
    kind: 'instructions',
    workflow: { content: prompt('orchestrator.md') },
  }),
  { id: 'builtin:context/standard', kind: 'context', definition: standardContext },
  { id: 'builtin:context/lite', kind: 'context', definition: liteContext },
  { id: 'builtin:tools/standard', kind: 'tools', definition: standardTools },
  { id: 'builtin:tools/lite', kind: 'tools', definition: liteTools },
];

export const builtinPolicies: readonly EnforcementPolicyDefinition[] = [
  { id: BUILTIN_ENFORCEMENT_POLICIES[0], kind: 'enforcement', denials: [] },
  {
    id: BUILTIN_ENFORCEMENT_POLICIES[1],
    kind: 'enforcement',
    denials: ['filesystem-mutation', 'shell-mutation', 'delegated-write', 'unknown-delegated-role'],
    handoffRestriction: 'plan-read-only',
  },
];

export const builtinIntegrations: readonly IntegrationDefinition[] = [
  { id: BUILTIN_INTEGRATIONS[0], kind: 'integrations', availableByDefault: false },
  { id: BUILTIN_INTEGRATIONS[1], kind: 'integrations', availableByDefault: true },
  { id: BUILTIN_INTEGRATIONS[2], kind: 'integrations', availableByDefault: true },
];

const builtinProfile = (id: string, blocks: ProfileDefinition['blocks'], extendsId?: string): ProfileDefinition => ({
  schemaVersion: 1,
  id,
  version: '1.0.0',
  name: id[0].toUpperCase() + id.slice(1),
  blocks,
  ...(extendsId ? { extends: extendsId } : {}),
});

export const builtinProfiles: readonly ProfileDefinition[] = [
  builtinProfile('standard', {
    instructions: { kind: 'instructions', identity: { systemOwned: 'model-family-base' } },
    context: { use: 'builtin:context/standard', kind: 'context' },
    tools: { use: 'builtin:tools/standard', kind: 'tools' },
    enforcement: { kind: 'enforcement', policies: [BUILTIN_ENFORCEMENT_POLICIES[0]] },
    presentation: { kind: 'presentation', displayName: 'Standard', label: 'STD', color: 'white' },
  }),
  builtinProfile(
    'lite',
    {
      instructions: { kind: 'instructions', identity: { use: 'builtin:instructions/lite' } },
      context: { use: 'builtin:context/lite', kind: 'context' },
      tools: { use: 'builtin:tools/lite', kind: 'tools' },
      presentation: { kind: 'presentation', displayName: 'Lite', label: 'LITE', color: 'cyan' },
    },
    'builtin:standard',
  ),
  builtinProfile(
    'plan',
    {
      instructions: { kind: 'instructions', workflow: { use: 'builtin:instructions/plan' } },
      enforcement: { kind: 'enforcement', policies: [BUILTIN_ENFORCEMENT_POLICIES[1]] },
      presentation: { kind: 'presentation', displayName: 'Plan', label: 'PLAN', color: 'yellow' },
    },
    'builtin:standard',
  ),
  builtinProfile(
    'mentor',
    {
      instructions: { kind: 'instructions', workflow: { use: 'builtin:instructions/mentor' } },
      integrations: { kind: 'integrations', integrations: [{ use: BUILTIN_INTEGRATIONS[0], required: false }] },
      presentation: { kind: 'presentation', displayName: 'Mentor', label: 'MENTOR', color: 'magenta' },
    },
    'builtin:standard',
  ),
  builtinProfile(
    'orchestrator',
    {
      instructions: { kind: 'instructions', workflow: { use: 'builtin:instructions/orchestrator' } },
      integrations: { kind: 'integrations', integrations: [{ use: BUILTIN_INTEGRATIONS[1], required: true }] },
      presentation: { kind: 'presentation', displayName: 'Orchestrator', label: 'ORCH', color: 'blue' },
    },
    'builtin:standard',
  ),
];

const mapById = <T extends { id: string }>(values: readonly T[]): ReadonlyMap<string, T> =>
  new Map(values.map((value) => [value.id, value]));

export const builtinProfileRegistry: ProfileRegistry = {
  profiles: new Map(builtinProfiles.map((profile) => [`builtin:${profile.id}`, profile])),
  blocks: mapById(builtinBlocks),
  policies: mapById(builtinPolicies),
  integrations: mapById(builtinIntegrations),
};

/** Convenience lookup for consumers that only need reusable built-in blocks. */
export const builtinBlockRegistry = builtinProfileRegistry.blocks;

export const isBuiltinContextSource = (value: string): boolean =>
  (BUILTIN_CONTEXT_SOURCES as readonly string[]).includes(value);
export const isBuiltinToolCapability = (value: string): boolean =>
  (BUILTIN_TOOL_CAPABILITIES as readonly string[]).includes(value);
export const isBuiltinBlockKind = (value: string): value is BlockKind =>
  ['instructions', 'context', 'tools', 'enforcement', 'integrations', 'presentation', 'requirements'].includes(value);
