import fs from 'node:fs';
import path from 'node:path';
const prompt = (name) => fs.readFileSync(path.join(import.meta.dirname, '../../prompts', name), 'utf8').trim();
/** Stable source kinds owned by the application. Profile data cannot invent one. */
const BUILTIN_CONTEXT_SOURCES = [
    'environment',
    'workspace',
    'project-instructions',
    'skills-catalog',
    'memory',
    'session-browser',
    'repository-guidance',
    'profile-document',
];
const BUILTIN_TOOL_CAPABILITIES = [
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
    'mcp',
    'discord-send',
];
const BUILTIN_ENFORCEMENT_POLICIES = ['builtin:enforcement/normal', 'builtin:enforcement/plan-read-only'];
export const BUILTIN_INTEGRATIONS = [
    'builtin:integration/mentor',
    'builtin:integration/async-subagents',
    'builtin:integration/background-task-control',
];
const standardContext = {
    kind: 'context',
    sources: BUILTIN_CONTEXT_SOURCES.filter((source) => source !== 'profile-document').map((source) => ({
        id: source,
        source,
    })),
};
const standardTools = { kind: 'tools', include: [...BUILTIN_TOOL_CAPABILITIES] };
const builtinInstructionBlock = (id, entry) => ({
    id,
    kind: 'instructions',
    definition: entry,
});
const builtinBlocks = [
    builtinInstructionBlock('builtin:instructions/plan', {
        kind: 'instructions',
        workflow: { content: prompt('plan-mode-info.md') },
    }),
    builtinInstructionBlock('builtin:instructions/pair', {
        kind: 'instructions',
        workflow: { content: prompt('pair-mode.md') },
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
    { id: 'builtin:tools/standard', kind: 'tools', definition: standardTools },
];
const builtinPolicies = [
    { id: BUILTIN_ENFORCEMENT_POLICIES[0], kind: 'enforcement', denials: [] },
    {
        id: BUILTIN_ENFORCEMENT_POLICIES[1],
        kind: 'enforcement',
        denials: [
            'discord-send',
            'filesystem-mutation',
            'shell-mutation',
            'mcp',
            'delegated-write',
            'unknown-delegated-role',
        ],
        handoffRestriction: 'plan-read-only',
    },
];
const builtinIntegrations = [
    { id: BUILTIN_INTEGRATIONS[0], kind: 'integrations', availableByDefault: false },
    { id: BUILTIN_INTEGRATIONS[1], kind: 'integrations', availableByDefault: true },
    { id: BUILTIN_INTEGRATIONS[2], kind: 'integrations', availableByDefault: true },
];
const builtinProfile = (id, blocks, extendsId) => ({
    schemaVersion: 1,
    id,
    version: '1.0.0',
    name: id[0].toUpperCase() + id.slice(1),
    blocks,
    ...(extendsId ? { extends: extendsId } : {}),
});
export const builtinProfiles = [
    builtinProfile('standard', {
        instructions: { kind: 'instructions', identity: { systemOwned: 'model-family-base' } },
        context: { use: 'builtin:context/standard', kind: 'context' },
        tools: { use: 'builtin:tools/standard', kind: 'tools' },
        enforcement: { kind: 'enforcement', policies: [BUILTIN_ENFORCEMENT_POLICIES[0]] },
        presentation: { kind: 'presentation', displayName: 'Standard', label: 'STD', color: 'white' },
    }),
    {
        ...builtinProfile('bare', {
            instructions: {
                kind: 'instructions',
                identity: {
                    content: prompt('bare.md'),
                },
            },
            context: {
                kind: 'context',
                sources: [
                    { id: 'project-instructions', source: 'project-instructions' },
                    { id: 'skills-catalog', source: 'skills-catalog' },
                    { id: 'environment', source: 'environment' },
                ],
            },
            // Bare exposes read_file for visual image inspection; other file reads,
            // search, edits, and skill loading (skills supplies only the catalog) go
            // through the shell. web, memory, sessions, and mcp have no shell
            // equivalent; they are run_code script tools, so they add catalogue
            // entries rather than direct schemas. background-tasks adds the shell's
            // background option where a job registry exists; the job get/cancel
            // tools are script-only too.
            tools: {
                kind: 'tools',
                include: [
                    'shell',
                    'skills',
                    'web',
                    'memory',
                    'sessions',
                    'mcp',
                    'background-tasks',
                    'discord-send',
                    'subagents',
                ],
            },
            enforcement: { kind: 'enforcement', policies: [BUILTIN_ENFORCEMENT_POLICIES[0]] },
            presentation: { kind: 'presentation', displayName: 'Bare', label: 'BARE', color: 'cyan' },
        }),
        version: '2.0.0',
    },
    builtinProfile('plan', {
        instructions: { kind: 'instructions', workflow: { use: 'builtin:instructions/plan' } },
        enforcement: { kind: 'enforcement', policies: [BUILTIN_ENFORCEMENT_POLICIES[1]] },
        presentation: { kind: 'presentation', displayName: 'Plan', label: 'PLAN', color: 'yellow' },
    }, 'builtin:standard'),
    builtinProfile('pair', {
        instructions: { kind: 'instructions', workflow: { use: 'builtin:instructions/pair' } },
        presentation: { kind: 'presentation', displayName: 'Pair', label: 'PAIR', color: 'green' },
    }, 'builtin:standard'),
    builtinProfile('mentor', {
        instructions: { kind: 'instructions', workflow: { use: 'builtin:instructions/mentor' } },
        integrations: { kind: 'integrations', integrations: [{ use: BUILTIN_INTEGRATIONS[0], required: false }] },
        presentation: { kind: 'presentation', displayName: 'Mentor', label: 'MENTOR', color: 'magenta' },
    }, 'builtin:standard'),
    builtinProfile('orchestrator', {
        instructions: { kind: 'instructions', workflow: { use: 'builtin:instructions/orchestrator' } },
        integrations: { kind: 'integrations', integrations: [{ use: BUILTIN_INTEGRATIONS[1], required: true }] },
        presentation: { kind: 'presentation', displayName: 'Orchestrator', label: 'ORCH', color: 'blue' },
    }, 'builtin:standard'),
];
const mapById = (values) => new Map(values.map((value) => [value.id, value]));
export const builtinProfileRegistry = {
    profiles: new Map(builtinProfiles.map((profile) => [`builtin:${profile.id}`, profile])),
    blocks: mapById(builtinBlocks),
    policies: mapById(builtinPolicies),
    integrations: mapById(builtinIntegrations),
};
export const isBuiltinContextSource = (value) => BUILTIN_CONTEXT_SOURCES.includes(value);
export const isBuiltinToolCapability = (value) => BUILTIN_TOOL_CAPABILITIES.includes(value);
//# sourceMappingURL=registry.js.map